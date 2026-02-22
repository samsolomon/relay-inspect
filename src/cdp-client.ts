import CDP from "chrome-remote-interface";
import { ChildProcess, execSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import treeKill from "tree-kill";
import { launchChrome, isAutoLaunchEnabled } from "./chrome-launcher.js";

// --- Types ---

export interface ConsoleEntry {
  timestamp: string;
  level: string;
  message: string;
}

export interface NetworkEntry {
  id: string;
  url: string;
  method: string;
  status: number | null;
  timing_ms: number | null;
  error: string | null;
  timestamp: string;
}

export interface PageTarget {
  id: string;
  title: string;
  type: string;
  url: string;
}

interface ConnectPageOptions {
  id?: string;
  urlPattern?: string;
  waitForMs?: number;
}

const INTERNAL_TARGET_PREFIXES = ["devtools://", "chrome://", "chrome-extension://", "about:"];

export function isInternalTargetUrl(url: string): boolean {
  return INTERNAL_TARGET_PREFIXES.some((prefix) => url.startsWith(prefix));
}

function isHttpUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}

function isLocalhostHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  } catch {
    return false;
  }
}

function normalizePageTargets(targets: Array<{ id: string; title?: string; type?: string; url?: string }>): PageTarget[] {
  return targets
    .filter((t) => t.type === "page" && typeof t.id === "string")
    .map((t) => ({
      id: t.id,
      title: t.title ?? "",
      type: t.type ?? "page",
      url: t.url ?? "",
    }));
}

export function chooseDefaultTarget(pageTargets: PageTarget[]): PageTarget | undefined {
  if (pageTargets.length === 0) return undefined;

  const nonInternalPages = pageTargets.filter((t) => !isInternalTargetUrl(t.url));
  const httpPages = nonInternalPages.filter((t) => isHttpUrl(t.url));
  const localhostPages = httpPages.filter((t) => isLocalhostHttpUrl(t.url));

  return localhostPages[0] ?? httpPages[0] ?? nonInternalPages[0] ?? pageTargets[0];
}

// --- Circular Buffer ---

export class CircularBuffer<T> {
  private buffer: T[] = [];
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  push(item: T): void {
    this.buffer.push(item);
    if (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }
  }

  drain(): T[] {
    const items = this.buffer;
    this.buffer = [];
    return items;
  }

  drainWhere(predicate: (item: T) => boolean): T[] {
    const matched: T[] = [];
    const remaining: T[] = [];
    for (const item of this.buffer) {
      (predicate(item) ? matched : remaining).push(item);
    }
    this.buffer = remaining;
    return matched;
  }

  peek(): T[] {
    return [...this.buffer];
  }

  get length(): number {
    return this.buffer.length;
  }
}

// --- Config ---

export const config = {
  host: process.env.CHROME_DEBUG_HOST ?? "localhost",
  port: parseInt(process.env.CHROME_DEBUG_PORT ?? "9222", 10),
  consoleBufferSize: parseInt(process.env.CONSOLE_BUFFER_SIZE ?? "500", 10),
  networkBufferSize: parseInt(process.env.NETWORK_BUFFER_SIZE ?? "200", 10),
};

// --- Pending network request tracking ---

interface PendingRequest {
  id: string;
  url: string;
  method: string;
  timestamp: string;
  startTime: number;
}

// --- PID File ---

function pidFilePath(): string {
  return join(tmpdir(), `relay-inspect-chrome-${config.port}.pid`);
}

function writePidFile(pid: number): void {
  try {
    writeFileSync(pidFilePath(), String(pid), "utf-8");
  } catch (err) {
    console.error(`[relay-inspect] Failed to write PID file: ${err instanceof Error ? err.message : err}`);
  }
}

function readPidFile(): number | null {
  try {
    const content = readFileSync(pidFilePath(), "utf-8").trim();
    const pid = parseInt(content, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function deletePidFile(): void {
  try {
    if (existsSync(pidFilePath())) {
      unlinkSync(pidFilePath());
    }
  } catch { /* best-effort */ }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isProcessChrome(pid: number): boolean {
  try {
    const cmd = execSync(`ps -p ${pid} -o comm=`, { encoding: "utf-8", timeout: 2000 }).trim().toLowerCase();
    return cmd.includes("chrome") || cmd.includes("chromium");
  } catch {
    // If we can't determine the process name, don't kill it
    return false;
  }
}

// --- CDP Client ---

const LIVENESS_CHECK_INTERVAL_MS = 30_000;
const PENDING_REQUEST_TTL_MS = 5 * 60 * 1000; // 5 minutes
const PENDING_REQUEST_CLEANUP_INTERVAL_MS = 60_000;

export class CDPClient {
  private client: CDP.Client | null = null;
  private connectingPromise: Promise<CDP.Client> | null = null;
  private launchedProcess: ChildProcess | null = null;
  private preferredTargetId: string | null = null;
  private preferredUrlPattern: string | null = null;
  private onConnectCallback: ((client: CDP.Client) => Promise<void>) | null = null;
  private onNavigateCallback: ((client: CDP.Client) => Promise<void>) | null = null;
  private lastSuccessfulCall = 0;
  private orphanCleanupDone = false;
  private pendingRequestCleanupTimer: ReturnType<typeof setInterval> | null = null;

  readonly consoleLogs: CircularBuffer<ConsoleEntry>;
  readonly networkRequests: CircularBuffer<NetworkEntry>;
  private pendingRequests = new Map<string, PendingRequest>();

  constructor() {
    this.consoleLogs = new CircularBuffer<ConsoleEntry>(config.consoleBufferSize);
    this.networkRequests = new CircularBuffer<NetworkEntry>(config.networkBufferSize);
  }

  /**
   * Register a callback that fires after every successful connection.
   * Used to auto-inject the annotation overlay.
   */
  onConnect(cb: (client: CDP.Client) => Promise<void>): void {
    this.onConnectCallback = cb;
  }

  /**
   * Register a callback that fires after page navigations (frameNavigated).
   * Used to re-inject the annotation overlay after the DOM is replaced.
   */
  onNavigate(cb: (client: CDP.Client) => Promise<void>): void {
    this.onNavigateCallback = cb;
  }

  /**
   * Returns an active CDP client, connecting or reconnecting as needed.
   * Throws if Chrome is unreachable after retries.
   */
  async ensureConnected(): Promise<CDP.Client> {
    // Fast path: existing connection with recent successful call — skip liveness check
    if (this.client) {
      const elapsed = Date.now() - this.lastSuccessfulCall;
      if (elapsed < LIVENESS_CHECK_INTERVAL_MS) {
        return this.client;
      }
      // Stale — verify with a liveness check
      if (await this.isAlive(this.client)) {
        this.lastSuccessfulCall = Date.now();
        return this.client;
      }
      // Dead connection — clean up before reconnecting
      console.error("[relay-inspect] Stale connection detected, reconnecting...");
      this.cleanup();
    }

    // Deduplicate concurrent connection attempts
    if (this.connectingPromise) {
      return this.connectingPromise;
    }

    this.connectingPromise = this.connect();
    try {
      const client = await this.connectingPromise;
      await this.fireOnConnect(client);
      return client;
    } finally {
      this.connectingPromise = null;
    }
  }

  private async fireOnConnect(client: CDP.Client): Promise<void> {
    if (!this.onConnectCallback) return;
    try {
      await this.onConnectCallback(client);
    } catch (err) {
      console.error(`[relay-inspect] onConnect callback error: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async isAlive(client: CDP.Client): Promise<boolean> {
    try {
      await client.Browser.getVersion();
      return true;
    } catch {
      return false;
    }
  }

  private clearPendingRequestTimer(): void {
    if (this.pendingRequestCleanupTimer) {
      clearInterval(this.pendingRequestCleanupTimer);
      this.pendingRequestCleanupTimer = null;
    }
  }

  private cleanup(): void {
    if (this.client) {
      try { this.client.close(); } catch { /* already closed */ }
      this.client = null;
    }
    this.lastSuccessfulCall = 0;
    this.pendingRequests.clear();
    this.clearPendingRequestTimer();
  }

  private async connect(): Promise<CDP.Client> {
    // Clean up any orphaned Chrome from a previous MCP that was killed (once per session)
    if (!this.orphanCleanupDone) {
      this.orphanCleanupDone = true;
      await this.cleanupOrphanedChrome();
    }

    // Fast path: try connecting to an already-running Chrome
    try {
      return await this.connectToExistingChrome();
    } catch (firstErr) {
      // CDP_WS_URL bypasses auto-launch — if it failed, don't try anything else
      if (process.env.CDP_WS_URL) {
        throw firstErr;
      }

      // Chrome not reachable — try auto-launch if enabled
      if (!isAutoLaunchEnabled()) {
        throw firstErr;
      }

      console.error("[relay-inspect] Chrome not reachable, attempting auto-launch...");

      // If we previously launched a Chrome, check if it's still alive
      if (this.launchedProcess?.pid) {
        if (isProcessAlive(this.launchedProcess.pid)) {
          // Alive but CDP failed — stuck process, kill it
          console.error(`[relay-inspect] Previously launched Chrome (PID ${this.launchedProcess.pid}) is stuck, killing...`);
          await this.killProcess(this.launchedProcess.pid);
        }
        this.launchedProcess = null;
      }

      // Launch Chrome
      this.launchedProcess = await launchChrome(config.port, config.host);
      if (this.launchedProcess.pid) {
        writePidFile(this.launchedProcess.pid);
      }

      // Now connect to the freshly launched Chrome
      return await this.connectToExistingChrome();
    }
  }

  private async connectToExistingChrome(): Promise<CDP.Client> {
    const wsUrl = process.env.CDP_WS_URL;
    if (wsUrl) {
      console.error(`[relay-inspect] Connecting directly via CDP_WS_URL: ${wsUrl}`);
      try {
        const client = await CDP({ target: wsUrl });
        this.client = client;
        await this.enableDomains(client);
        this.attachEventHandlers(client);
        this.attachDisconnectHandler(client);
        return client;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Could not connect via CDP_WS_URL (${wsUrl}): ${message}`);
      }
    }

    const maxRetries = 3;
    let delay = 500;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.error(`[relay-inspect] Connecting to Chrome at ${config.host}:${config.port} (attempt ${attempt}/${maxRetries})...`);

        const pageTargets = await this.listPageTargets();
        const preferred = this.selectPageTarget(pageTargets);

        let client: CDP.Client;
        if (preferred) {
          console.error(`[relay-inspect] Selected target: ${preferred.url}`);
          client = await CDP({ host: config.host, port: config.port, target: preferred.id });
        } else {
          console.error(`[relay-inspect] No page targets found, using default target.`);
          client = await CDP({ host: config.host, port: config.port });
        }

        this.client = client;
        this.preferredTargetId = preferred?.id ?? null;
        console.error(`[relay-inspect] Connected to Chrome.`);

        await this.enableDomains(client);
        this.attachEventHandlers(client);
        this.attachDisconnectHandler(client);
        return client;
      } catch (err) {
        // Clean up any partial connection from this attempt
        this.cleanup();

        const message = err instanceof Error ? err.message : String(err);
        console.error(`[relay-inspect] Connection attempt ${attempt} failed: ${message}`);

        if (attempt < maxRetries) {
          await sleep(delay);
          delay = Math.min(delay * 2, 10000);
        }
      }
    }

    throw new Error(
      `Could not connect to Chrome at ${config.host}:${config.port} after ${maxRetries} attempts. ` +
      `Ensure Chrome is running with --remote-debugging-port=${config.port}.`
    );
  }

  async connectToPage(options: ConnectPageOptions): Promise<{ id: string; title: string; url: string }> {
    if (process.env.CDP_WS_URL) {
      throw new Error("Cannot switch page targets when CDP_WS_URL is set.");
    }

    if (this.connectingPromise) {
      await this.connectingPromise.catch(() => undefined);
    }

    this.connectingPromise = this.connectToPageInternal(options);
    try {
      const client = await this.connectingPromise;
      const targetId = this.preferredTargetId;
      if (!targetId) {
        throw new Error("Connected, but no active target ID is available.");
      }
      const targets = await this.listPageTargets();
      const selected = targets.find((t) => t.id === targetId);
      if (!selected) {
        throw new Error("Connected, but could not confirm selected target.");
      }
      await this.fireOnConnect(client);
      return { id: selected.id, title: selected.title, url: selected.url };
    } finally {
      this.connectingPromise = null;
    }
  }

  private async connectToPageInternal(options: ConnectPageOptions): Promise<CDP.Client> {
    const matchById = options.id?.trim();
    const matchByPattern = options.urlPattern?.trim();
    const waitForMs = Math.max(0, options.waitForMs ?? 0);
    const start = Date.now();

    let selectedTarget: PageTarget | undefined;
    let attempts = 0;
    while (!selectedTarget) {
      attempts += 1;
      const pageTargets = await this.listPageTargets();
      if (matchById) {
        selectedTarget = pageTargets.find((t) => t.id === matchById);
      } else if (matchByPattern) {
        selectedTarget = this.findPatternMatch(pageTargets, matchByPattern);
      }

      if (selectedTarget) break;
      if (waitForMs === 0 || Date.now() - start >= waitForMs) break;
      await sleep(Math.min(300, waitForMs));
    }

    if (!selectedTarget) {
      const criteria = matchById ? `id "${matchById}"` : `url pattern "${matchByPattern}"`;
      throw new Error(`No page target found for ${criteria} after ${attempts} checks.`);
    }

    this.cleanup();
    const client = await CDP({ host: config.host, port: config.port, target: selectedTarget.id });
    this.client = client;
    this.preferredTargetId = selectedTarget.id;
    this.preferredUrlPattern = matchByPattern ?? null;

    await this.enableDomains(client);
    this.attachEventHandlers(client);
    this.attachDisconnectHandler(client);
    console.error(`[relay-inspect] Switched to target: ${selectedTarget.url}`);
    return client;
  }

  private async listPageTargets(): Promise<PageTarget[]> {
    const targets = await CDP.List({ host: config.host, port: config.port });
    return normalizePageTargets(targets as Array<{ id: string; title?: string; type?: string; url?: string }>);
  }

  private selectPageTarget(pageTargets: PageTarget[]): PageTarget | undefined {
    const explicitById = this.preferredTargetId
      ? pageTargets.find((t) => t.id === this.preferredTargetId)
      : undefined;
    if (explicitById) return explicitById;

    if (this.preferredUrlPattern) {
      const explicitByPattern = this.findPatternMatch(pageTargets, this.preferredUrlPattern);
      if (explicitByPattern) {
        this.preferredTargetId = explicitByPattern.id;
        return explicitByPattern;
      }
    }

    return chooseDefaultTarget(pageTargets);
  }

  private findPatternMatch(pageTargets: PageTarget[], urlPattern: string): PageTarget | undefined {
    const normalizedPattern = urlPattern.toLowerCase();
    const matches = pageTargets.filter((t) => t.url.toLowerCase().includes(normalizedPattern));
    return chooseDefaultTarget(matches);
  }

  private async cleanupOrphanedChrome(): Promise<void> {
    const pid = readPidFile();
    if (pid === null) return;

    // Don't kill our own launched process — that's handled separately
    if (this.launchedProcess?.pid === pid) return;

    if (isProcessAlive(pid)) {
      // Verify the process is actually Chrome before killing — PIDs can be reused by the OS
      if (!isProcessChrome(pid)) {
        console.error(`[relay-inspect] PID ${pid} from previous session is no longer Chrome, skipping kill.`);
        deletePidFile();
        return;
      }

      console.error(`[relay-inspect] Found orphaned Chrome process (PID ${pid}) from a previous session, killing...`);
      await this.killProcess(pid);
    }

    deletePidFile();
  }

  private killProcess(pid: number): Promise<void> {
    return new Promise((resolve) => {
      treeKill(pid, "SIGTERM", (err) => {
        if (err) {
          console.error(`[relay-inspect] Error killing process ${pid}: ${err.message}`);
        }
        resolve();
      });
    });
  }

  async shutdown(): Promise<void> {
    this.clearPendingRequestTimer();
    this.cleanup();

    if (this.launchedProcess?.pid) {
      const pid = this.launchedProcess.pid;
      console.error(`[relay-inspect] Shutting down auto-launched Chrome (PID ${pid})...`);
      await this.killProcess(pid);
      this.launchedProcess = null;
    }

    deletePidFile();
  }

  /** Synchronous last-resort cleanup for process 'exit' handler */
  shutdownSync(): void {
    deletePidFile();
  }

  private async enableDomains(client: CDP.Client): Promise<void> {
    await Promise.all([
      client.Runtime.enable(),
      client.Network.enable({}),
      client.DOM.enable({}),
      client.Page.enable(),
      client.Log.enable(),
    ]);

    this.lastSuccessfulCall = Date.now();
    console.error("[relay-inspect] CDP domains enabled: Runtime, Network, DOM, Page, Log");
  }

  private cleanupStalePendingRequests(): void {
    const now = Date.now();
    for (const [id, req] of this.pendingRequests) {
      const age = now - new Date(req.timestamp).getTime();
      if (age > PENDING_REQUEST_TTL_MS) {
        console.error(`[relay-inspect] Evicting stale pending request: ${req.method} ${req.url}`);
        this.pendingRequests.delete(id);
      }
    }
  }

  private attachEventHandlers(client: CDP.Client): void {
    // Periodic cleanup of stale pending requests (SSE, WebSocket, long-polls)
    if (this.pendingRequestCleanupTimer) {
      clearInterval(this.pendingRequestCleanupTimer);
    }
    this.pendingRequestCleanupTimer = setInterval(
      () => this.cleanupStalePendingRequests(),
      PENDING_REQUEST_CLEANUP_INTERVAL_MS,
    );

    // Console API calls (console.log, console.warn, console.error, etc.)
    client.Runtime.consoleAPICalled((params) => {
      const message = params.args
        .map((arg) => {
          if (arg.type === "string") return arg.value as string;
          if (arg.type === "undefined") return "undefined";
          if (arg.value !== undefined) return JSON.stringify(arg.value);
          if (arg.description) return arg.description;
          return `[${arg.type}]`;
        })
        .join(" ");

      this.consoleLogs.push({
        timestamp: new Date(params.timestamp).toISOString(),
        level: params.type,
        message,
      });
    });

    // Browser-level log entries
    client.Log.entryAdded((params) => {
      this.consoleLogs.push({
        timestamp: new Date(params.entry.timestamp).toISOString(),
        level: params.entry.level,
        message: `[browser] ${params.entry.text}`,
      });
    });

    // Page load — re-inject overlay after DOM is replaced by navigation/reload
    client.Page.loadEventFired(() => {
      if (!this.onNavigateCallback || !this.client) return;
      this.onNavigateCallback(this.client).catch((err) => {
        console.error(`[relay-inspect] onNavigate callback error: ${err instanceof Error ? err.message : err}`);
      });
    });

    // Network: request will be sent
    client.Network.requestWillBeSent((params) => {
      this.pendingRequests.set(params.requestId, {
        id: params.requestId,
        url: params.request.url,
        method: params.request.method,
        timestamp: new Date(params.wallTime * 1000).toISOString(),
        startTime: params.timestamp,
      });
    });

    // Network: response received
    client.Network.responseReceived((params) => {
      const pending = this.pendingRequests.get(params.requestId);
      if (!pending) return;

      this.pendingRequests.delete(params.requestId);

      const timing_ms = Math.round((params.timestamp - pending.startTime) * 1000 * 100) / 100;

      this.networkRequests.push({
        id: pending.id,
        url: pending.url,
        method: pending.method,
        status: params.response.status,
        timing_ms,
        error: null,
        timestamp: pending.timestamp,
      });
    });

    // Network: loading failed
    client.Network.loadingFailed((params) => {
      const pending = this.pendingRequests.get(params.requestId);
      if (!pending) return;

      this.pendingRequests.delete(params.requestId);

      const timing_ms = Math.round((params.timestamp - pending.startTime) * 1000 * 100) / 100;

      this.networkRequests.push({
        id: pending.id,
        url: pending.url,
        method: pending.method,
        status: null,
        timing_ms,
        error: params.errorText,
        timestamp: pending.timestamp,
      });
    });
  }

  private attachDisconnectHandler(client: CDP.Client): void {
    client.on("disconnect", () => {
      console.error("[relay-inspect] Chrome disconnected.");
      this.client = null;
      this.lastSuccessfulCall = 0;
      this.pendingRequests.clear();
      this.clearPendingRequestTimer();
      // No auto-reconnect — next ensureConnected() call will reconnect lazily
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const cdpClient = new CDPClient();

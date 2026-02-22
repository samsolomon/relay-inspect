/**
 * Component gallery for the annotation overlay UI.
 * Extracts live CSS from annotationOverlay.ts and renders all components.
 *
 * Usage: npx tsx examples/gallery.ts
 * Then open http://localhost:3333
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Extract CSS & SVGs from the overlay source so the gallery always reflects
// the latest styles without duplication.
// ---------------------------------------------------------------------------

function extractFromSource(): { css: string; svgs: Record<string, string> } {
  const source = readFileSync(resolve(ROOT, "src/annotationOverlay.ts"), "utf8");

  // --- CSS ---
  const cssLines: string[] = [];
  let inCSS = false;
  for (const line of source.split("\n")) {
    if (line.includes("styleEl.textContent = [")) {
      inCSS = true;
      continue;
    }
    if (inCSS && line.includes("].join(")) break;
    if (inCSS) {
      const trimmed = line.trim();
      if (trimmed.startsWith("//")) continue;
      const m = trimmed.match(/^'(.*)'[,]?$/);
      if (m) cssLines.push(m[1]);
    }
  }

  // --- SVGs ---
  const svgs: Record<string, string> = {};
  const svgRe = /var\s+(\w+_SVG)\s*=\s*'([^']+)'/g;
  let sm;
  while ((sm = svgRe.exec(source)) !== null) {
    svgs[sm[1]] = sm[2];
  }

  return { css: cssLines.join("\n"), svgs };
}

// ---------------------------------------------------------------------------
// HTML template
// ---------------------------------------------------------------------------

function buildHTML(): string {
  const { css, svgs } = extractFromSource();

  const PENCIL = svgs.PENCIL_SVG ?? "";
  const CLOSE = svgs.CLOSE_SVG ?? "";
  const SEND = svgs.SEND_SVG ?? "";
  const CHECK = svgs.CHECK_SVG ?? "";
  const TRASH = svgs.TRASH_SVG ?? "";
  const SEND_TO_BACK = svgs.SEND_TO_BACK_SVG ?? "";
  const COPY = svgs.COPY_SVG ?? "";

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Relay Inspect — Component Gallery</title>
<style>
/* === Overlay CSS (extracted live from annotationOverlay.ts) === */
${css}

/* === Gallery layout === */
*, *::before, *::after { box-sizing: border-box; }
body {
  margin: 0; padding: 40px 24px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: #f5f5f5; color: #1a1a1a;
  transition: background 0.2s, color 0.2s;
}
body.dark-bg {
  background: #1a1a1a; color: #e5e5e5;
}

.gallery { max-width: 720px; margin: 0 auto; }

.gallery-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 40px; padding-bottom: 16px;
  border-bottom: 1px solid rgba(0,0,0,0.1);
}
body.dark-bg .gallery-header { border-bottom-color: rgba(255,255,255,0.1); }
.gallery-header h1 { font-size: 18px; font-weight: 700; }
.gallery-controls { display: flex; gap: 8px; }
.gallery-controls button {
  padding: 6px 14px; border-radius: 6px; border: 1px solid rgba(0,0,0,0.15);
  cursor: pointer; font-size: 12px; font-weight: 500; font-family: inherit;
  background: #fff; color: #333; transition: all 0.15s;
}
body.dark-bg .gallery-controls button {
  background: #2a2a2a; color: #ddd; border-color: rgba(255,255,255,0.15);
}
.gallery-controls button.active {
  background: #7C3AED; color: #fff; border-color: transparent;
}

.gallery-section { margin-bottom: 48px; }
.gallery-section h2 {
  font-size: 13px; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.05em; color: #888; margin-bottom: 16px;
}

.gallery-row {
  display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap;
  margin-bottom: 16px;
}
.gallery-label {
  font-size: 11px; color: #999; margin-bottom: 4px;
}

.gallery-card {
  padding: 24px; border-radius: 12px; border: 1px solid rgba(0,0,0,0.08);
  background: #fff;
}
body.dark-bg .gallery-card {
  background: #222; border-color: rgba(255,255,255,0.08);
}

/* Override fixed/absolute positioning for gallery display */
.gallery .relay-toolbar-btn {
  position: relative !important;
  z-index: auto !important;
}
.gallery .relay-annotate-popover {
  position: relative !important;
  z-index: auto !important;
}
.gallery .relay-annotate-highlight {
  position: relative !important;
  display: block !important;
  width: 200px; height: 60px;
}
.gallery .relay-annotate-mode-bar {
  position: relative !important;
  opacity: 1 !important;
  width: 240px; height: 160px;
  border-radius: 0 0 10px 10px;
}
.gallery .relay-annotate-pin {
  position: relative !important;
}
.gallery .relay-annotate-modal-backdrop {
  position: relative !important;
  z-index: auto !important;
  border-radius: 12px; overflow: hidden;
}
.gallery .relay-annotate-selection-rect {
  position: relative !important;
  display: block !important;
  width: 200px; height: 80px;
}
/* Force tooltips visible in gallery */
.gallery .relay-toolbar-tooltip {
  display: flex !important;
}
</style>
</head>
<body>
<div class="relay-annotate-root gallery" data-relay-theme="light" id="root">

<div class="gallery-header">
  <h1>Relay Inspect — Component Gallery</h1>
  <div class="gallery-controls">
    <button id="theme-light" class="active" onclick="setTheme('light')">Light Theme</button>
    <button id="theme-dark" onclick="setTheme('dark')">Dark Theme</button>
    <button id="bg-toggle" onclick="toggleBg()">Dark Background</button>
  </div>
</div>

<!-- ============ Toolbar Buttons ============ -->
<div class="gallery-section">
  <h2>Toolbar Buttons</h2>

  <div class="gallery-row">
    <div>
      <div class="gallery-label">Annotate (default)</div>
      <button class="relay-toolbar-btn relay-toolbar-btn--icon">
        ${PENCIL}
        <span class="relay-toolbar-tooltip">
          <kbd>Shift</kbd><kbd>A</kbd>
        </span>
      </button>
    </div>

    <div>
      <div class="gallery-label">Annotate (active)</div>
      <button class="relay-toolbar-btn relay-toolbar-btn--icon">
        ${CLOSE}
        <span class="relay-toolbar-tooltip">
          <kbd>Shift</kbd><kbd>A</kbd>
        </span>
      </button>
    </div>

    <div>
      <div class="gallery-label">Send (default)</div>
      <button class="relay-toolbar-btn">
        ${SEND}
        <span class="relay-send-count">3</span>
        <span class="relay-toolbar-tooltip">
          <kbd>Shift</kbd><kbd>S</kbd>
        </span>
      </button>
    </div>

    <div>
      <div class="gallery-label">Send (sent)</div>
      <button class="relay-toolbar-btn sent">
        ${CHECK}
        <span class="relay-send-count">3</span>
        <span class="relay-toolbar-tooltip">
          <kbd>Shift</kbd><kbd>S</kbd>
        </span>
      </button>
    </div>

    <div>
      <div class="gallery-label">Enable sending</div>
      <button class="relay-toolbar-btn">
        <span style="display:flex">${SEND_TO_BACK}</span>
        <span>Enable sending</span>
        <span class="relay-toolbar-tooltip">
          <kbd>Shift</kbd><kbd>S</kbd>
        </span>
      </button>
    </div>
  </div>
</div>

<!-- ============ Pin Badges ============ -->
<div class="gallery-section">
  <h2>Pin Badges</h2>
  <div class="gallery-row">
    <div class="relay-annotate-pin">1</div>
    <div class="relay-annotate-pin">2</div>
    <div class="relay-annotate-pin">3</div>
    <div class="relay-annotate-pin" style="width: 22px; height: 22px;">12</div>
  </div>
</div>

<!-- ============ Selection Highlight ============ -->
<div class="gallery-section">
  <h2>Selection Highlight</h2>
  <div class="gallery-row">
    <div>
      <div class="gallery-label">Hover highlight</div>
      <div class="relay-annotate-highlight"></div>
    </div>
    <div>
      <div class="gallery-label">Drag selection rect</div>
      <div class="relay-annotate-selection-rect"></div>
    </div>
  </div>
</div>

<!-- ============ Popovers ============ -->
<div class="gallery-section">
  <h2>Popovers</h2>
  <div class="gallery-row" style="align-items: flex-start;">

    <div>
      <div class="gallery-label">Create annotation</div>
      <div class="relay-annotate-popover">
        <textarea placeholder="Add your feedback..."></textarea>
        <div class="relay-annotate-popover-actions">
          <button>Cancel</button>
          <button class="primary">Save</button>
        </div>
      </div>
    </div>

    <div>
      <div class="gallery-label">Edit annotation</div>
      <div class="relay-annotate-popover">
        <textarea>The button color doesn't match the design spec.</textarea>
        <div class="relay-annotate-popover-actions">
          <button class="ghost-icon">${TRASH}</button>
          <button>Cancel</button>
          <button class="primary">Save</button>
        </div>
      </div>
    </div>

    <div>
      <div class="gallery-label">Multi-element</div>
      <div class="relay-annotate-popover">
        <div class="relay-annotate-selector-info">3 elements selected</div>
        <textarea placeholder="Add your feedback..."></textarea>
        <div class="relay-annotate-popover-actions">
          <button>Cancel</button>
          <button class="primary">Save</button>
        </div>
      </div>
    </div>

  </div>
</div>

<!-- ============ Mode Bar ============ -->
<div class="gallery-section">
  <h2>Mode Bar (Selection Border)</h2>
  <div class="gallery-row">
    <div>
      <div class="gallery-label">Active annotation mode</div>
      <div class="relay-annotate-mode-bar active" style="background: var(--relay-btn-bg, #f9f9f9);"></div>
    </div>
  </div>
</div>

<!-- ============ Modal ============ -->
<div class="gallery-section">
  <h2>Onboarding Modal</h2>
  <div class="gallery-row">
    <div class="relay-annotate-modal-backdrop" style="width: 420px; padding: 24px;">
      <div class="relay-annotate-modal">
        <h3>Send annotations to your AI</h3>
        <p>In your terminal, ask the agent to listen for annotations. For example:</p>
        <div class="relay-annotate-modal-code">
          <code>Listen for my annotations</code>
          <button>${COPY}</button>
        </div>
        <p>Once listening, you can send feedback directly from the browser. To ask a question, interrupt the agent first.</p>
        <button>OK</button>
      </div>
    </div>
  </div>
</div>

<!-- ============ Tokens Reference ============ -->
<div class="gallery-section">
  <h2>Design Tokens</h2>
  <div class="gallery-card">
    <table style="width: 100%; font-size: 13px; border-collapse: collapse;">
      <tr style="text-align: left; border-bottom: 1px solid rgba(128,128,128,0.2);">
        <th style="padding: 6px 12px 6px 0;">Token</th>
        <th style="padding: 6px 12px 6px 0;">Value</th>
        <th style="padding: 6px 0;">Usage</th>
      </tr>
      <tr><td style="padding: 6px 12px 6px 0; font-family: monospace; font-size: 12px;">--relay-radius-sm</td><td style="padding: 6px 12px 6px 0;">4px</td><td style="padding: 6px 0; color: #888;">Buttons, tooltips, inputs, small elements</td></tr>
      <tr><td style="padding: 6px 12px 6px 0; font-family: monospace; font-size: 12px;">--relay-radius-lg</td><td style="padding: 6px 12px 6px 0;">8px</td><td style="padding: 6px 0; color: #888;">Popovers, modals</td></tr>
    </table>
  </div>
</div>

</div>

<script>
function setTheme(theme) {
  document.getElementById('root').setAttribute('data-relay-theme', theme);
  document.getElementById('theme-light').classList.toggle('active', theme === 'light');
  document.getElementById('theme-dark').classList.toggle('active', theme === 'dark');
}
function toggleBg() {
  document.body.classList.toggle('dark-bg');
  var btn = document.getElementById('bg-toggle');
  btn.textContent = document.body.classList.contains('dark-bg') ? 'Light Background' : 'Dark Background';
}
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT ?? "3333", 10);

const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
  // Re-extract on every request so edits to annotationOverlay.ts are
  // reflected on browser refresh without restarting the server.
  try {
    const html = buildHTML();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(String(err));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Component gallery → http://localhost:${PORT}`);
  console.log("Edit src/annotationOverlay.ts and refresh to see changes.");
});

/**
 * Builds a self-contained IIFE string for injection into the browser via Runtime.evaluate.
 * Targets ES2017 (V8). No imports, no external dependencies.
 * All DOM created via document.createElement (never innerHTML with user content).
 */
export function buildOverlayScript(port: number): string {
  return `(function() {
  'use strict';

  // --- Idempotency guard ---
  if (window.__relayAnnotationsLoaded) {
    // Re-injection: refresh badges and return
    if (typeof window.__relayAnnotateRefresh === 'function') {
      window.__relayAnnotateRefresh();
    }
    return 'overlay already loaded — refreshed';
  }
  window.__relayAnnotationsLoaded = true;

  // --- Config ---
  var API = 'http://127.0.0.1:${port}';

  // --- Background luminance detection ---
  function detectDarkBackground() {
    // Walk up from the element at the center of the viewport,
    // checking computed backgroundColor until we find a non-transparent one.
    var el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    var maxDepth = 20;
    while (el && maxDepth-- > 0) {
      var bg = getComputedStyle(el).backgroundColor;
      if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') {
        var match = bg.match(/\\d+/g);
        if (match && match.length >= 3) {
          var r = parseInt(match[0], 10);
          var g = parseInt(match[1], 10);
          var b = parseInt(match[2], 10);
          // Simple perceived brightness (0-255)
          var brightness = (r * 299 + g * 587 + b * 114) / 1000;
          return brightness < 128;
        }
      }
      el = el.parentElement;
    }
    return false; // default: assume light site
  }

  var isDarkSite = detectDarkBackground();

  // --- Root wrapper ---
  var rootEl = document.createElement('div');
  rootEl.className = 'relay-annotate-root';
  rootEl.setAttribute('data-relay-ignore', 'true');
  rootEl.setAttribute('data-relay-theme', isDarkSite ? 'dark' : 'light');
  rootEl.style.display = 'contents';
  document.body.appendChild(rootEl);

  // --- State ---
  var annotationMode = false;
  var annotations = [];
  var badgeElements = [];
  var nextBadgeNumber = 1;
  var highlightEl = null;
  var popoverEl = null;
  var modeBarEl = null;
  var toggleBtn = null;
  var hoveredEl = null;
  var currentPath = location.pathname;
  var dragState = null; // { startX, startY, dragging }
  var selectionRectEl = null;
  var dragHighlighted = []; // elements with .relay-annotate-drag-match
  var dragHighlightTimer = null;
  var sentUntil = 0; // timestamp — don't reset sent state until this expires
  var sendingEnabled = false; // one-time onboarding gate for Send button
  var processingState = 'idle'; // 'idle' | 'processing' | 'done'
  var processingTimer = null;
  var PROCESSING_TIMEOUT_MS = 120000; // 2min safety reset

  // --- Styles ---
  var styleEl = document.createElement('style');
  styleEl.setAttribute('data-relay-ignore', 'true');
  styleEl.textContent = [
    // --- Design tokens ---
    '.relay-annotate-root { --relay-radius-xs: 4px; --relay-radius-sm: 20px; --relay-radius-lg: 12px; }',
    // --- Theme variables ---
    '.relay-annotate-root[data-relay-theme="light"] {',
    '  --relay-bg: rgba(10, 10, 10, 0.75);',
    '  --relay-bg-solid: #1e1e1e;',
    '  --relay-text: rgba(255, 255, 255, 0.95);',
    '  --relay-text-secondary: rgba(255, 255, 255, 0.4);',
    '  --relay-text-hint: rgba(255, 255, 255, 0.3);',
    '  --relay-border: rgba(255, 255, 255, 0.12);',
    '  --relay-border-subtle: rgba(255, 255, 255, 0.1);',
    '  --relay-input-bg: rgba(255, 255, 255, 0.06);',
    '  --relay-btn-bg: rgba(255, 255, 255, 0.06);',
    '  --relay-btn-text: rgba(255, 255, 255, 0.7);',
    '  --relay-btn-hover: rgba(255, 255, 255, 0.12);',
    '  --relay-shadow: rgba(0, 0, 0, 0.4);',
    '  --relay-placeholder: rgba(255, 255, 255, 0.3);',
    '  --relay-pin-border: rgba(255, 255, 255, 0.2);',
    '  --relay-pin-shadow: rgba(0, 0, 0, 0.3);',
    '}',
    '.relay-annotate-root[data-relay-theme="dark"] {',
    '  --relay-bg: rgba(255, 255, 255, 0.88);',
    '  --relay-bg-solid: #f0f0f0;',
    '  --relay-text: rgba(0, 0, 0, 0.88);',
    '  --relay-text-secondary: rgba(0, 0, 0, 0.45);',
    '  --relay-text-hint: rgba(0, 0, 0, 0.35);',
    '  --relay-border: rgba(0, 0, 0, 0.12);',
    '  --relay-border-subtle: rgba(0, 0, 0, 0.1);',
    '  --relay-input-bg: rgba(0, 0, 0, 0.04);',
    '  --relay-btn-bg: rgba(0, 0, 0, 0.04);',
    '  --relay-btn-text: rgba(0, 0, 0, 0.6);',
    '  --relay-btn-hover: rgba(0, 0, 0, 0.08);',
    '  --relay-shadow: rgba(0, 0, 0, 0.15);',
    '  --relay-placeholder: rgba(0, 0, 0, 0.3);',
    '  --relay-pin-border: rgba(255, 255, 255, 0.3);',
    '  --relay-pin-shadow: rgba(0, 0, 0, 0.15);',
    '}',
    // --- Toolbar button (shared base) ---
    '.relay-toolbar-btn {',
    '  position: fixed; height: 40px; border-radius: var(--relay-radius-sm);',
    '  border: 1px solid var(--relay-border); cursor: pointer; z-index: 999997; overflow: visible;',
    '  display: flex; align-items: center; justify-content: center; gap: 6px;',
    '  padding: 0 14px 0 12px;',
    '  box-shadow: 0 2px 12px var(--relay-shadow);',
    '  transition: background 0.15s, border-color 0.15s;',
    '  background: var(--relay-bg); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);',
    '  color: var(--relay-text); touch-action: none;',
    '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;',
    '  font-size: 13px; font-weight: 500; white-space: nowrap;',
    '}',
    '.relay-toolbar-btn svg { width: 18px; height: 18px; flex-shrink: 0; }',
    '.relay-toolbar-btn--icon { width: 40px; padding: 0; cursor: grab; }',
    '.relay-toolbar-btn.sent {',
    '  background: #059669; color: #fff; border-color: rgba(5, 150, 105, 0.5);',
    '}',
    '.relay-toolbar-tooltip {',
    '  position: absolute; bottom: calc(100% + 8px); left: 50%; transform: translateX(-50%);',
    '  display: none; align-items: center; gap: 4px;',
    '  padding: 4px 8px; border-radius: var(--relay-radius-xs);',
    '  background: var(--relay-bg-solid); color: var(--relay-text-secondary);',
    '  font-size: 12px; font-weight: 400; white-space: nowrap;',
    '  box-shadow: 0 2px 8px var(--relay-shadow); border: 1px solid var(--relay-border);',
    '  pointer-events: none;',
    '}',
    '.relay-toolbar-btn:hover .relay-toolbar-tooltip { display: flex; }',
    '.relay-toolbar-btn.dragging .relay-toolbar-tooltip { display: none; }',
    '.relay-toolbar-tooltip kbd {',
    '  padding: 1px 4px; border-radius: var(--relay-radius-xs);',
    '  border: 1px solid var(--relay-border); background: var(--relay-input-bg);',
    '  color: var(--relay-text); font-family: inherit; font-size: 11px; line-height: 1.2;',
    '}',
    '.relay-annotate-mode-bar {',
    '  position: fixed; top: 0; left: 0; right: 0; bottom: 0;',
    '  border: 3px solid #7C3AED; border-radius: 0 0 20px 20px;',
    '  z-index: 999998; pointer-events: none;',
    '  transition: opacity 0.15s; opacity: 0;',
    '}',
    '.relay-annotate-mode-bar.active { opacity: 1; }',
    '.relay-annotate-highlight {',
    '  position: fixed; pointer-events: none; z-index: 999996;',
    '  outline: 2px dashed #7C3AED; outline-offset: -1px; border-radius: var(--relay-radius-xs); background: rgba(124, 58, 237, 0.08);',
    '  transition: all 0.05s; display: none;',
    '}',
    '.relay-annotate-popover {',
    '  position: fixed; width: 280px; border-radius: var(--relay-radius-lg);',
    '  background: var(--relay-bg); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);',
    '  border: 1px solid var(--relay-border-subtle);',
    '  box-shadow: 0 4px 24px var(--relay-shadow); z-index: 999999;',
    '  padding: 12px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;',
    '  font-size: 13px; color: var(--relay-text);',
    '}',
    '.relay-annotate-popover textarea {',
    '  width: 100%; min-height: 60px; border: none; border-radius: 0;',
    '  padding: 0; font-size: 13px; font-family: inherit; resize: none;',
    '  box-sizing: border-box; outline: none;',
    '  background: transparent; color: var(--relay-text);',
    '}',
    '.relay-annotate-popover textarea::placeholder { color: var(--relay-placeholder); }',
    '.relay-annotate-popover-actions {',
    '  display: flex; gap: 6px; margin: 8px -12px 0; padding: 8px 12px 0; justify-content: flex-end;',
    '  border-top: 1px solid var(--relay-border-subtle);',
    '}',
    '.relay-annotate-popover-actions button {',
    '  height: 32px; padding: 0 14px; border-radius: var(--relay-radius-sm); border: 1px solid var(--relay-border);',
    '  cursor: pointer; font-size: 12px; font-weight: 500; font-family: inherit;',
    '  transition: background 0.15s, border-color 0.15s;',
    '  background: var(--relay-bg); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);',
    '  color: var(--relay-text);',
    '}',
    '.relay-annotate-popover-actions button:hover { background: var(--relay-btn-hover); }',
    '.relay-annotate-popover-actions button:disabled { opacity: 0.4; cursor: default; }',
    '.relay-annotate-popover-actions button.primary {',
    '  background: #7C3AED; color: #fff; border-color: transparent; font-weight: 600;',
    '}',
    '.relay-annotate-popover-actions button.primary:hover { background: #6D28D9; }',
    '.relay-annotate-popover-actions button.ghost-icon {',
    '  width: 32px; padding: 0; margin-right: auto; border: none;',
    '  display: flex; align-items: center; justify-content: center;',
    '  background: transparent; color: var(--relay-text-secondary);',
    '}',
    '.relay-annotate-popover-actions button.ghost-icon:hover { background: var(--relay-btn-hover); color: #f87171; }',
    '.relay-annotate-popover-actions button.ghost-icon svg { width: 16px; height: 16px; }',
    '.relay-annotate-pin {',
    '  position: fixed; width: 20px; height: 20px; border-radius: 50%;',
    '  background: rgba(124, 58, 237, 0.85); color: #fff; font-size: 10px; font-weight: 700;',
    '  display: flex; align-items: center; justify-content: center;',
    '  cursor: pointer; z-index: 999997;',
    '  border: 1px solid var(--relay-pin-border); box-shadow: 0 2px 8px var(--relay-pin-shadow);',
    '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;',
    '  user-select: none; line-height: 1;',
    '}',
    '.relay-annotate-selector-info {',
    '  font-size: 11px; color: var(--relay-text-secondary); margin-bottom: 6px;',
    '}',
    '.relay-annotate-selection-rect {',
    '  position: fixed; border: 2px solid #7C3AED; background: rgba(124, 58, 237, 0.10);',
    '  border-radius: var(--relay-radius-xs); z-index: 999996; pointer-events: none; display: none;',
    '}',
    '.relay-annotate-drag-match {',
    '  outline: 2px solid #7C3AED !important; outline-offset: -1px;',
    '  background-color: rgba(124, 58, 237, 0.08) !important;',
    '}',
    '.relay-send-count {',
    '  display: inline-flex; align-items: center; justify-content: center;',
    '  min-width: 18px; height: 18px; border-radius: 9px; padding: 0 5px;',
    '  background: var(--relay-border); font-size: 11px; font-weight: 700; line-height: 1;',
    '}',
    '.relay-toolbar-btn.sent .relay-send-count { background: rgba(255,255,255,0.25); }',
    // --- Modal styles ---
    '.relay-annotate-modal-backdrop {',
    '  position: fixed; top: 0; left: 0; right: 0; bottom: 0;',
    '  background: rgba(0, 0, 0, 0.5); display: flex; align-items: center; justify-content: center;',
    '  z-index: 1000000;',
    '}',
    '.relay-annotate-modal {',
    '  width: 340px; border-radius: var(--relay-radius-lg); padding: 24px;',
    '  background: var(--relay-bg-solid); color: var(--relay-text);',
    '  border: 1px solid var(--relay-border); box-shadow: 0 8px 32px var(--relay-shadow);',
    '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;',
    '}',
    '.relay-annotate-modal h3 {',
    '  font-size: 15px; font-weight: 700; margin: 0 0 12px;',
    '}',
    '.relay-annotate-modal p {',
    '  font-size: 13px; color: var(--relay-text-secondary); line-height: 1.5; margin: 0 0 12px;',
    '}',
    '.relay-annotate-modal-code {',
    '  display: flex; align-items: center; gap: 8px; padding: 8px 8px 8px 12px;',
    '  border-radius: var(--relay-radius-xs); margin: 0 0 12px;',
    '  background: var(--relay-input-bg); border: 1px solid var(--relay-border-subtle);',
    '}',
    '.relay-annotate-modal-code code {',
    '  flex: 1; font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;',
    '  font-size: 12px; color: var(--relay-text);',
    '}',
    '.relay-annotate-modal-code button {',
    '  flex-shrink: 0; width: 28px; height: 28px; padding: 0; border-radius: var(--relay-radius-xs);',
    '  border: 1px solid var(--relay-border-subtle); cursor: pointer;',
    '  background: transparent; color: var(--relay-text-secondary);',
    '  display: flex; align-items: center; justify-content: center;',
    '  transition: background 0.15s, color 0.15s;',
    '}',
    '.relay-annotate-modal-code button:hover {',
    '  background: var(--relay-btn-hover); color: var(--relay-text);',
    '}',
    '.relay-annotate-modal-code button svg { width: 14px; height: 14px; }',
    '.relay-annotate-modal > button {',
    '  width: 100%; height: 36px; border-radius: var(--relay-radius-sm); border: none; cursor: pointer;',
    '  background: #7C3AED; color: #fff; font-size: 13px; font-weight: 600;',
    '  font-family: inherit; transition: background 0.15s;',
    '}',
    '.relay-annotate-modal > button:hover { background: #6D28D9; }',
    // --- Shortcuts table ---
    '.relay-shortcuts-table {',
    '  width: 100%; border-collapse: collapse; margin: 0 0 16px;',
    '}',
    '.relay-shortcuts-table td {',
    '  padding: 6px 0; font-size: 13px; vertical-align: middle;',
    '  border-bottom: 1px solid var(--relay-border-subtle);',
    '}',
    '.relay-shortcuts-table tr:last-child td { border-bottom: none; }',
    '.relay-shortcuts-table td:first-child {',
    '  width: 120px; white-space: nowrap;',
    '}',
    '.relay-shortcuts-table td:last-child {',
    '  color: var(--relay-text-secondary);',
    '}',
    '.relay-shortcuts-table kbd {',
    '  padding: 2px 6px; border-radius: var(--relay-radius-xs);',
    '  border: 1px solid var(--relay-border); background: var(--relay-btn-bg);',
    '  font-family: inherit; font-size: 12px; line-height: 1.3;',
    '}',
    // --- Processing state spinner ---
    '@keyframes relay-spin { to { transform: rotate(360deg); } }',
    '.relay-toolbar-btn.processing {',
    '  pointer-events: none;',
    '}',
    '.relay-processing-spinner {',
    '  width: 16px; height: 16px; border: 2px solid var(--relay-border);',
    '  border-top-color: var(--relay-text); border-radius: 50%;',
    '  animation: relay-spin 0.6s linear infinite; flex-shrink: 0;',
    '}',
    '.relay-toolbar-btn.done {',
    '  background: #059669; color: #fff; border-color: rgba(5, 150, 105, 0.5);',
    '  pointer-events: none;',
    '}',
  ].join('\\n');
  document.head.appendChild(styleEl);

  // --- Pencil SVG / Close SVG ---
  var PENCIL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg>';
  var CLOSE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  var SEND_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/></svg>';
  var CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  var TRASH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
  var SEND_TO_BACK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="14" y="14" width="8" height="8" rx="2"/><rect x="2" y="2" width="8" height="8" rx="2"/><path d="M7 14v1a2 2 0 0 0 2 2h1"/><path d="M14 7h1a2 2 0 0 1 2 2v1"/></svg>';
  var COPY_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

  // --- Selector generator ---
  var MAX_SELECTOR_DEPTH = 10;
  function generateSelector(el, depth) {
    depth = depth || 0;
    if (depth >= MAX_SELECTOR_DEPTH) {
      return { selector: el.tagName.toLowerCase(), confidence: 'fragile' };
    }
    // Priority 1: id
    if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) {
      return { selector: '#' + CSS.escape(el.id), confidence: 'stable' };
    }
    // Priority 2: data-testid / data-cy
    for (var attr of ['data-testid', 'data-cy']) {
      var val = el.getAttribute(attr);
      if (val) {
        var sel = '[' + attr + '="' + CSS.escape(val) + '"]';
        if (document.querySelectorAll(sel).length === 1) {
          return { selector: sel, confidence: 'stable' };
        }
      }
    }
    // Priority 3: aria-label on interactive elements
    var interactiveTags = ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'];
    var ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && interactiveTags.indexOf(el.tagName) !== -1) {
      var sel = el.tagName.toLowerCase() + '[aria-label="' + CSS.escape(ariaLabel) + '"]';
      if (document.querySelectorAll(sel).length === 1) {
        return { selector: sel, confidence: 'stable' };
      }
    }
    // Priority 4: semantic class
    var classes = Array.from(el.classList).filter(function(c) {
      return !/^[a-z]{5,}[A-Z]/.test(c) && !/^_/.test(c) && !/^css-/.test(c) && c.length < 40;
    });
    if (classes.length > 0) {
      var sel = el.tagName.toLowerCase() + '.' + classes.map(function(c) { return CSS.escape(c); }).join('.');
      if (document.querySelectorAll(sel).length === 1) {
        return { selector: sel, confidence: 'stable' };
      }
    }
    // Fallback: tag + nth-of-type
    var parent = el.parentElement;
    if (parent) {
      var tag = el.tagName.toLowerCase();
      var siblings = Array.from(parent.children).filter(function(c) { return c.tagName === el.tagName; });
      var index = siblings.indexOf(el) + 1;
      var parentSel = generateSelector(parent, depth + 1);
      return { selector: parentSel.selector + ' > ' + tag + ':nth-of-type(' + index + ')', confidence: 'fragile' };
    }
    return { selector: el.tagName.toLowerCase(), confidence: 'fragile' };
  }

  // --- React fiber source detection ---
  function getReactSource(el) {
    // Find the React fiber key on the DOM node (__reactFiber$... or __reactInternalInstance$...)
    var fiberKey = null;
    var keys = Object.keys(el);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].indexOf('__reactFiber$') === 0 || keys[i].indexOf('__reactInternalInstance$') === 0) {
        fiberKey = keys[i];
        break;
      }
    }
    if (!fiberKey) return null;

    // Walk up the fiber tree to find a component with source info
    var fiber = el[fiberKey];
    var maxDepth = 20;
    while (fiber && maxDepth-- > 0) {
      // Skip host fibers (div, span, etc.) — we want user components
      if (typeof fiber.type === 'function' || (typeof fiber.type === 'object' && fiber.type !== null)) {
        var name = fiber.type.displayName || fiber.type.name || null;
        var source = fiber._debugSource || null;
        if (name) {
          var result = { component: name };
          if (source && source.fileName) {
            result.source = source.fileName + (source.lineNumber ? ':' + source.lineNumber : '');
          }
          return result;
        }
      }
      fiber = fiber.return;
    }
    return null;
  }

  // --- API helpers ---
  function fetchAnnotations() {
    return fetch(API + '/annotations').then(function(r) { return r.json(); });
  }
  function createAnnotation(data) {
    return fetch(API + '/annotations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    }).then(function(r) { return r.json(); });
  }
  function updateAnnotation(id, data) {
    return fetch(API + '/annotations/' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    }).then(function(r) { return r.json(); });
  }
  function deleteAnnotation(id) {
    return fetch(API + '/annotations/' + encodeURIComponent(id), {
      method: 'DELETE'
    }).then(function(r) { return r.json(); });
  }

  // --- Create UI elements ---

  // Mode bar
  modeBarEl = document.createElement('div');
  modeBarEl.className = 'relay-annotate-mode-bar';
  modeBarEl.setAttribute('data-relay-ignore', 'true');
  rootEl.appendChild(modeBarEl);

  // Highlight overlay
  highlightEl = document.createElement('div');
  highlightEl.className = 'relay-annotate-highlight';
  highlightEl.setAttribute('data-relay-ignore', 'true');
  rootEl.appendChild(highlightEl);

  // Selection rectangle
  selectionRectEl = document.createElement('div');
  selectionRectEl.className = 'relay-annotate-selection-rect';
  selectionRectEl.setAttribute('data-relay-ignore', 'true');
  rootEl.appendChild(selectionRectEl);

  // Toggle button
  toggleBtn = document.createElement('button');
  toggleBtn.className = 'relay-toolbar-btn relay-toolbar-btn--icon';
  toggleBtn.setAttribute('data-relay-ignore', 'true');
  toggleBtn.innerHTML = PENCIL_SVG;
  var toggleTooltip = document.createElement('span');
  toggleTooltip.className = 'relay-toolbar-tooltip';
  toggleTooltip.innerHTML = '<kbd>Shift</kbd><kbd>A</kbd>';
  toggleBtn.appendChild(toggleTooltip);
  rootEl.appendChild(toggleBtn);

  // Send to AI button
  var sendBtn = document.createElement('button');
  sendBtn.className = 'relay-toolbar-btn';
  sendBtn.style.display = 'none';
  sendBtn.setAttribute('data-relay-ignore', 'true');
  var sendIconSpan = document.createElement('span');
  sendIconSpan.innerHTML = SEND_SVG;
  sendIconSpan.style.display = 'flex';
  sendBtn.appendChild(sendIconSpan);
  var sendLabel = document.createElement('span');
  sendLabel.textContent = 'Send';
  sendBtn.appendChild(sendLabel);
  var sendCountBadge = document.createElement('span');
  sendCountBadge.className = 'relay-send-count';
  sendCountBadge.textContent = '0';
  sendBtn.appendChild(sendCountBadge);
  var sendTooltip = document.createElement('span');
  sendTooltip.className = 'relay-toolbar-tooltip';
  sendTooltip.innerHTML = '<kbd>Shift</kbd><kbd>S</kbd>';
  sendBtn.appendChild(sendTooltip);
  rootEl.appendChild(sendBtn);

  // "Enable sending" button (onboarding gate — shown instead of sendBtn until dismissed)
  var enableSendBtn = document.createElement('button');
  enableSendBtn.className = 'relay-toolbar-btn';
  enableSendBtn.style.display = 'none';
  enableSendBtn.setAttribute('data-relay-ignore', 'true');
  var enableSendIcon = document.createElement('span');
  enableSendIcon.innerHTML = SEND_TO_BACK_SVG;
  enableSendIcon.style.display = 'flex';
  enableSendBtn.appendChild(enableSendIcon);
  var enableSendLabel = document.createElement('span');
  enableSendLabel.textContent = 'Enable sending';
  enableSendBtn.appendChild(enableSendLabel);
  var enableSendTooltip = document.createElement('span');
  enableSendTooltip.className = 'relay-toolbar-tooltip';
  enableSendTooltip.innerHTML = '<kbd>Shift</kbd><kbd>S</kbd>';
  enableSendBtn.appendChild(enableSendTooltip);
  rootEl.appendChild(enableSendBtn);

  // --- Instructional modal ---
  var modalBackdrop = document.createElement('div');
  modalBackdrop.className = 'relay-annotate-modal-backdrop';
  modalBackdrop.setAttribute('data-relay-ignore', 'true');
  modalBackdrop.style.display = 'none';
  var modalCard = document.createElement('div');
  modalCard.className = 'relay-annotate-modal';
  var modalH3 = document.createElement('h3');
  modalH3.textContent = 'Send annotations to your AI';
  modalCard.appendChild(modalH3);
  var modalP1 = document.createElement('p');
  modalP1.textContent = 'In your terminal, ask the agent to listen for annotations. For example:';
  modalCard.appendChild(modalP1);
  var EXAMPLE_PROMPT = 'Listen for my annotations';
  var modalCodeWrap = document.createElement('div');
  modalCodeWrap.className = 'relay-annotate-modal-code';
  var modalCode = document.createElement('code');
  modalCode.textContent = EXAMPLE_PROMPT;
  modalCodeWrap.appendChild(modalCode);
  var modalCopyBtn = document.createElement('button');
  modalCopyBtn.innerHTML = COPY_SVG;
  modalCopyBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    navigator.clipboard.writeText(EXAMPLE_PROMPT).then(function() {
      modalCopyBtn.innerHTML = CHECK_SVG;
      setTimeout(function() { modalCopyBtn.innerHTML = COPY_SVG; }, 1500);
    });
  });
  modalCodeWrap.appendChild(modalCopyBtn);
  modalCard.appendChild(modalCodeWrap);
  var modalP2 = document.createElement('p');
  modalP2.textContent = 'Once listening, you can send feedback directly from the browser. To ask a question, interrupt the agent first.';
  modalCard.appendChild(modalP2);
  var modalOkBtn = document.createElement('button');
  modalOkBtn.textContent = 'OK';
  modalCard.appendChild(modalOkBtn);
  modalCard.addEventListener('click', function(e) { e.stopPropagation(); });
  modalBackdrop.appendChild(modalCard);
  rootEl.appendChild(modalBackdrop);

  function showModal() {
    modalBackdrop.style.display = 'flex';
  }
  function dismissModal() {
    sendingEnabled = true;
    modalBackdrop.style.display = 'none';
    renderBadges();
  }
  modalOkBtn.addEventListener('click', dismissModal);
  modalBackdrop.addEventListener('click', dismissModal);

  enableSendBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    showModal();
  });

  // --- Theme toggle ---
  function toggleTheme() {
    var current = rootEl.getAttribute('data-relay-theme');
    rootEl.setAttribute('data-relay-theme', current === 'dark' ? 'light' : 'dark');
  }

  // --- Shortcuts modal ---
  var shortcutsBackdrop = document.createElement('div');
  shortcutsBackdrop.className = 'relay-annotate-modal-backdrop';
  shortcutsBackdrop.setAttribute('data-relay-ignore', 'true');
  shortcutsBackdrop.style.display = 'none';
  var shortcutsCard = document.createElement('div');
  shortcutsCard.className = 'relay-annotate-modal';
  var shortcutsH3 = document.createElement('h3');
  shortcutsH3.textContent = 'Keyboard Shortcuts';
  shortcutsCard.appendChild(shortcutsH3);
  var shortcutsTable = document.createElement('table');
  shortcutsTable.className = 'relay-shortcuts-table';
  var shortcuts = [
    ['Shift', 'A', 'Toggle annotation mode'],
    ['Shift', 'S', 'Send to AI'],
    ['Shift', 'D', 'Toggle light / dark'],
    ['Esc', null, 'Dismiss / exit'],
    ['?', null, 'Show shortcuts'],
  ];
  shortcuts.forEach(function(s) {
    var tr = document.createElement('tr');
    var tdKeys = document.createElement('td');
    tdKeys.innerHTML = s[1]
      ? '<kbd>' + s[0] + '</kbd> + <kbd>' + s[1] + '</kbd>'
      : '<kbd>' + s[0] + '</kbd>';
    tr.appendChild(tdKeys);
    var tdDesc = document.createElement('td');
    tdDesc.textContent = s[2];
    tr.appendChild(tdDesc);
    shortcutsTable.appendChild(tr);
  });
  shortcutsCard.appendChild(shortcutsTable);
  var shortcutsCloseBtn = document.createElement('button');
  shortcutsCloseBtn.textContent = 'Close';
  shortcutsCard.appendChild(shortcutsCloseBtn);
  shortcutsCard.addEventListener('click', function(e) { e.stopPropagation(); });
  shortcutsBackdrop.appendChild(shortcutsCard);
  rootEl.appendChild(shortcutsBackdrop);

  function showShortcuts() {
    shortcutsBackdrop.style.display = 'flex';
  }
  function dismissShortcuts() {
    shortcutsBackdrop.style.display = 'none';
  }
  shortcutsCloseBtn.addEventListener('click', dismissShortcuts);
  shortcutsBackdrop.addEventListener('click', dismissShortcuts);

  // Set initial position via JS (top/left) so drag can update them
  var BTN_SIZE = 40;
  var BTN_MARGIN = 8;
  toggleBtn.style.top = (window.innerHeight - BTN_SIZE - BTN_MARGIN) + 'px';
  toggleBtn.style.left = (window.innerWidth - BTN_SIZE - BTN_MARGIN) + 'px';

  // --- Position toolbar buttons relative to toggle button ---
  function positionToolbarBtn(btn) {
    var toggleLeft = parseFloat(toggleBtn.style.left) || 0;
    var toggleTop = parseFloat(toggleBtn.style.top) || 0;
    var btnWidth = btn.offsetWidth || 100;
    var left = toggleLeft - btnWidth - 8;
    if (left < BTN_MARGIN) left = toggleLeft + BTN_SIZE + 8;
    btn.style.left = left + 'px';
    btn.style.top = toggleTop + 'px';
  }
  function positionSendBtn() { positionToolbarBtn(sendBtn); }
  function positionEnableSendBtn() { positionToolbarBtn(enableSendBtn); }

  // --- Toggle annotation mode ---
  function setAnnotationMode(active) {
    annotationMode = active;
    toggleBtn.innerHTML = active ? CLOSE_SVG : PENCIL_SVG;
    toggleBtn.appendChild(toggleTooltip);
    modeBarEl.classList.toggle('active', active);
    document.documentElement.style.cursor = active ? 'crosshair' : '';
    if (!active) {
      highlightEl.style.display = 'none';
      hoveredEl = null;
      dragState = null;
      selectionRectEl.style.display = 'none';
      clearDragHighlights();
      closePopover();
    }
  }

  // --- Draggable toggle button ---
  var btnDrag = null; // { startX, startY, offsetX, offsetY, dragging }
  var BTN_DRAG_THRESHOLD = 5;

  toggleBtn.addEventListener('pointerdown', function(e) {
    e.stopPropagation();
    toggleBtn.setPointerCapture(e.pointerId);
    var rect = toggleBtn.getBoundingClientRect();
    btnDrag = {
      startX: e.clientX,
      startY: e.clientY,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      dragging: false
    };
  });

  toggleBtn.addEventListener('pointermove', function(e) {
    if (!btnDrag) return;
    var dx = e.clientX - btnDrag.startX;
    var dy = e.clientY - btnDrag.startY;
    if (!btnDrag.dragging && Math.sqrt(dx * dx + dy * dy) > BTN_DRAG_THRESHOLD) {
      btnDrag.dragging = true;
      toggleBtn.style.cursor = 'grabbing';
      toggleBtn.classList.add('dragging');
    }
    if (btnDrag.dragging) {
      var newLeft = e.clientX - btnDrag.offsetX;
      var newTop = e.clientY - btnDrag.offsetY;
      // Clamp within viewport with margin
      newLeft = Math.max(BTN_MARGIN, Math.min(newLeft, window.innerWidth - BTN_SIZE - BTN_MARGIN));
      newTop = Math.max(BTN_MARGIN, Math.min(newTop, window.innerHeight - BTN_SIZE - BTN_MARGIN));
      toggleBtn.style.left = newLeft + 'px';
      toggleBtn.style.top = newTop + 'px';
      positionSendBtn();
      positionEnableSendBtn();
    }
  });

  toggleBtn.addEventListener('pointerup', function(e) {
    if (!btnDrag) return;
    var wasDrag = btnDrag.dragging;
    btnDrag = null;
    toggleBtn.style.cursor = '';
    toggleBtn.classList.remove('dragging');
    toggleBtn.releasePointerCapture(e.pointerId);
    if (!wasDrag) {
      setAnnotationMode(!annotationMode);
    }
  });

  // Clamp button back into view on window resize
  window.addEventListener('resize', function() {
    var left = parseFloat(toggleBtn.style.left) || 0;
    var top = parseFloat(toggleBtn.style.top) || 0;
    toggleBtn.style.left = Math.max(BTN_MARGIN, Math.min(left, window.innerWidth - BTN_SIZE - BTN_MARGIN)) + 'px';
    toggleBtn.style.top = Math.max(BTN_MARGIN, Math.min(top, window.innerHeight - BTN_SIZE - BTN_MARGIN)) + 'px';
    positionSendBtn();
    positionEnableSendBtn();
  });

  // --- Highlight on hover (used when not dragging) ---
  function updateHighlight(clientX, clientY) {
    var target = document.elementFromPoint(clientX, clientY);
    if (!target || target.closest('[data-relay-ignore]')) {
      highlightEl.style.display = 'none';
      hoveredEl = null;
      return;
    }
    hoveredEl = target;
    var rect = target.getBoundingClientRect();
    highlightEl.style.display = 'block';
    highlightEl.style.left = rect.left + 'px';
    highlightEl.style.top = rect.top + 'px';
    highlightEl.style.width = rect.width + 'px';
    highlightEl.style.height = rect.height + 'px';
  }

  // --- Popover helpers ---
  function closePopover() {
    if (popoverEl) {
      popoverEl.remove();
      popoverEl = null;
    }
  }

  function positionPopover(popover, anchorRect) {
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var left = anchorRect.right + 8;
    var top = anchorRect.top;

    // Adjust if off-screen right
    if (left + 290 > vw) {
      left = anchorRect.left - 290;
    }
    if (left < 4) left = 4;

    // Adjust if off-screen bottom
    if (top + 200 > vh) {
      top = vh - 210;
    }
    if (top < 4) top = 4;

    popover.style.left = left + 'px';
    popover.style.top = top + 'px';
  }

  // --- Create popover (new annotation) ---
  function showCreatePopover(targetEl) {
    closePopover();

    var rect = targetEl.getBoundingClientRect();
    var selectorResult = generateSelector(targetEl);
    var reactSource = getReactSource(targetEl);

    var popover = document.createElement('div');
    popover.className = 'relay-annotate-popover';
    popover.setAttribute('data-relay-ignore', 'true');

    var textarea = document.createElement('textarea');
    textarea.placeholder = 'Add feedback...';
    popover.appendChild(textarea);

    var actions = document.createElement('div');
    actions.className = 'relay-annotate-popover-actions';

    var cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', function(e) { e.stopPropagation(); closePopover(); });

    var saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save';
    saveBtn.className = 'primary';

    textarea.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        saveBtn.click();
      }
    });

    saveBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      var text = textarea.value.trim();
      if (!text) return;
      saveBtn.disabled = true;
      createAnnotation({
        url: location.pathname,
        selector: selectorResult.selector,
        selectorConfidence: selectorResult.confidence,
        text: text,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        reactSource: reactSource,
        elementRect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      }).then(function() {
        closePopover();
        refreshAnnotations();
      }).catch(function(err) { console.error('Annotation save failed:', err); saveBtn.disabled = false; });
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);
    popover.appendChild(actions);

    rootEl.appendChild(popover);
    popoverEl = popover;
    positionPopover(popover, rect);
    textarea.focus();
  }

  // --- Edit popover (existing annotation) ---
  function showEditPopover(annotation, pinEl) {
    closePopover();

    var rect = pinEl.getBoundingClientRect();
    var popover = document.createElement('div');
    popover.className = 'relay-annotate-popover';
    popover.setAttribute('data-relay-ignore', 'true');

    var textarea = document.createElement('textarea');
    textarea.value = annotation.text;
    popover.appendChild(textarea);

    var actions = document.createElement('div');
    actions.className = 'relay-annotate-popover-actions';

    var saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save';
    saveBtn.className = 'primary';

    textarea.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        saveBtn.click();
      }
    });

    var deleteBtn = document.createElement('button');
    deleteBtn.innerHTML = TRASH_SVG;
    deleteBtn.className = 'ghost-icon';
    deleteBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      deleteBtn.disabled = true;
      deleteAnnotation(annotation.id).then(function() {
        closePopover();
        refreshAnnotations();
      }).catch(function(err) { console.error('Annotation delete failed:', err); deleteBtn.disabled = false; });
    });

    var cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', function(e) { e.stopPropagation(); closePopover(); });

    saveBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      var text = textarea.value.trim();
      if (!text) return;
      saveBtn.disabled = true;
      updateAnnotation(annotation.id, { text: text }).then(function() {
        closePopover();
        refreshAnnotations();
      }).catch(function(err) { console.error('Annotation update failed:', err); saveBtn.disabled = false; });
    });

    actions.appendChild(deleteBtn);
    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);
    popover.appendChild(actions);

    rootEl.appendChild(popover);
    popoverEl = popover;
    positionPopover(popover, rect);
    textarea.focus();
  }

  // --- Find elements in a rectangle ---
  var SKIP_TAGS = ['HTML', 'HEAD', 'BODY', 'SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'BR', 'HR'];
  var MAX_DRAG_ELEMENTS = 50;

  function rectsIntersect(a, b) {
    return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
  }

  function findElementsInRect(selRect) {
    var all = document.querySelectorAll('*');
    var matched = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.hasAttribute('data-relay-ignore')) continue;
      if (SKIP_TAGS.indexOf(el.tagName) !== -1) continue;
      var r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // Check visibility
      if (typeof el.checkVisibility === 'function') {
        if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      }
      if (!rectsIntersect(selRect, r)) continue;
      matched.push(el);
    }
    // Remove ancestors: keep only leaf-most elements
    var filtered = matched.filter(function(el) {
      for (var j = 0; j < matched.length; j++) {
        if (matched[j] !== el && el.contains(matched[j])) return false;
      }
      return true;
    });
    return filtered.slice(0, MAX_DRAG_ELEMENTS);
  }

  function clearDragHighlights() {
    for (var i = 0; i < dragHighlighted.length; i++) {
      dragHighlighted[i].classList.remove('relay-annotate-drag-match');
    }
    dragHighlighted = [];
    if (dragHighlightTimer) {
      clearTimeout(dragHighlightTimer);
      dragHighlightTimer = null;
    }
  }

  function updateDragHighlights(selRect) {
    if (dragHighlightTimer) return; // throttle
    dragHighlightTimer = setTimeout(function() {
      dragHighlightTimer = null;
      // Remove old highlights
      for (var i = 0; i < dragHighlighted.length; i++) {
        dragHighlighted[i].classList.remove('relay-annotate-drag-match');
      }
      // Find and highlight new matches
      dragHighlighted = findElementsInRect(selRect);
      for (var i = 0; i < dragHighlighted.length; i++) {
        dragHighlighted[i].classList.add('relay-annotate-drag-match');
      }
    }, 60);
  }

  // --- Multi-element popover (drag selection) ---
  function showMultiCreatePopover(elements, anchorRect, releasePoint) {
    closePopover();

    var popover = document.createElement('div');
    popover.className = 'relay-annotate-popover';
    popover.setAttribute('data-relay-ignore', 'true');

    var info = document.createElement('div');
    info.className = 'relay-annotate-selector-info';
    info.textContent = elements.length + ' element' + (elements.length !== 1 ? 's' : '') + ' selected';
    popover.appendChild(info);

    var textarea = document.createElement('textarea');
    textarea.placeholder = 'Add feedback...';
    popover.appendChild(textarea);

    var actions = document.createElement('div');
    actions.className = 'relay-annotate-popover-actions';

    var cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', function(e) { e.stopPropagation(); closePopover(); });

    var saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save (' + elements.length + ')';
    saveBtn.className = 'primary';

    textarea.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        saveBtn.click();
      }
    });

    saveBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      var text = textarea.value.trim();
      if (!text) return;
      saveBtn.disabled = true;
      // Build per-element details
      var elDetails = elements.map(function(el) {
        var rect = el.getBoundingClientRect();
        var selectorResult = generateSelector(el);
        var reactSource = getReactSource(el);
        return {
          selector: selectorResult.selector,
          selectorConfidence: selectorResult.confidence,
          reactSource: reactSource,
          elementRect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        };
      });
      // Use first element's selector as the primary
      var primary = elDetails[0];
      createAnnotation({
        url: location.pathname,
        selector: primary.selector,
        selectorConfidence: primary.selectorConfidence,
        text: text,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        reactSource: primary.reactSource,
        elementRect: {
          x: Math.round(anchorRect.left),
          y: Math.round(anchorRect.top),
          width: Math.round(anchorRect.right - anchorRect.left),
          height: Math.round(anchorRect.bottom - anchorRect.top),
        },
        elements: elDetails,
        anchorPoint: { x: releasePoint.x, y: releasePoint.y },
      }).then(function() {
        closePopover();
        refreshAnnotations();
      }).catch(function(err) { console.error('Multi-annotation save failed:', err); saveBtn.disabled = false; });
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);
    popover.appendChild(actions);

    rootEl.appendChild(popover);
    popoverEl = popover;
    positionPopover(popover, anchorRect);
    textarea.focus();
  }

  // --- Event handlers for annotation mode ---
  // --- Unified pointer event system for click + drag ---
  var DRAG_THRESHOLD = 5; // px — movement beyond this = drag

  document.addEventListener('pointerdown', function(e) {
    if (!annotationMode) return;
    if (e.target.closest('[data-relay-ignore]')) return;
    e.preventDefault();
    e.stopPropagation();
    dragState = { startX: e.clientX, startY: e.clientY, dragging: false };
  }, true);

  document.addEventListener('pointermove', function(e) {
    if (!annotationMode) return;
    if (e.target.closest && !e.target.closest('[data-relay-ignore]')) {
      e.preventDefault();
    }
    if (dragState) {
      var dx = e.clientX - dragState.startX;
      var dy = e.clientY - dragState.startY;
      if (!dragState.dragging && Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD) {
        dragState.dragging = true;
        highlightEl.style.display = 'none';
        hoveredEl = null;
      }
      if (dragState.dragging) {
        var left = Math.min(dragState.startX, e.clientX);
        var top = Math.min(dragState.startY, e.clientY);
        var width = Math.abs(e.clientX - dragState.startX);
        var height = Math.abs(e.clientY - dragState.startY);
        selectionRectEl.style.display = 'block';
        selectionRectEl.style.left = left + 'px';
        selectionRectEl.style.top = top + 'px';
        selectionRectEl.style.width = width + 'px';
        selectionRectEl.style.height = height + 'px';
        updateDragHighlights({ left: left, top: top, right: left + width, bottom: top + height });
        return;
      }
    }
    // Not dragging — do single-element highlight
    updateHighlight(e.clientX, e.clientY);
  }, true);

  document.addEventListener('pointerup', function(e) {
    if (!annotationMode) return;
    if (e.target.closest('[data-relay-ignore]') && !dragState) return;
    e.preventDefault();
    e.stopPropagation();

    if (dragState && dragState.dragging) {
      // Drag completed — find elements in selection rectangle
      var selRect = {
        left: Math.min(dragState.startX, e.clientX),
        top: Math.min(dragState.startY, e.clientY),
        right: Math.max(dragState.startX, e.clientX),
        bottom: Math.max(dragState.startY, e.clientY),
      };
      selectionRectEl.style.display = 'none';
      clearDragHighlights();
      dragState = null;
      var elements = findElementsInRect(selRect);
      if (elements.length === 0) return;
      if (elements.length === 1) {
        showCreatePopover(elements[0]);
      } else {
        showMultiCreatePopover(elements, selRect, { x: e.clientX, y: e.clientY });
      }
    } else {
      // Click — single element
      dragState = null;
      var target = document.elementFromPoint(e.clientX, e.clientY);
      if (!target || target.closest('[data-relay-ignore]')) return;
      showCreatePopover(target);
    }
  }, true);

  // Block mousedown/touchstart/click to prevent app from reacting
  function blockEventInAnnotationMode(e) {
    if (!annotationMode) return;
    if (e.target.closest('[data-relay-ignore]')) return;
    e.preventDefault();
    e.stopPropagation();
  }
  document.addEventListener('mousedown', blockEventInAnnotationMode, true);
  document.addEventListener('touchstart', blockEventInAnnotationMode, true);
  document.addEventListener('click', blockEventInAnnotationMode, true);

  // --- Pin rendering ---
  function clearBadges() {
    badgeElements.forEach(function(b) { b.remove(); });
    badgeElements = [];
  }

  function renderBadges() {
    clearBadges();
    nextBadgeNumber = 1;

    // Track positions for collision avoidance
    var positions = [];

    // Only show annotations for the current page
    var pageAnnotations = annotations.filter(function(ann) {
      return ann.url === currentPath;
    });

    pageAnnotations.forEach(function(ann) {
      var pin = document.createElement('div');
      pin.className = 'relay-annotate-pin';
      pin.setAttribute('data-relay-ignore', 'true');
      pin.setAttribute('data-relay-annotation-id', ann.id);
      pin.textContent = String(nextBadgeNumber);
      pin.__relayAnn = ann;
      nextBadgeNumber++;

      pin.addEventListener('click', function(e) {
        e.stopPropagation();
        showEditPopover(ann, pin);
      });

      rootEl.appendChild(pin);
      badgeElements.push(pin);
    });

    repositionBadges();

    // Update Send / Enable-sending button visibility
    var openCount = annotations.filter(function(a) { return a.status === 'open'; }).length;

    // Processing/done states override normal button appearance
    if (processingState === 'processing') {
      enableSendBtn.style.display = 'none';
      sendBtn.style.display = 'flex';
      sendBtn.classList.remove('sent');
      sendBtn.classList.add('processing');
      sendBtn.classList.remove('done');
      sendIconSpan.innerHTML = '<div class="relay-processing-spinner"></div>';
      sendLabel.textContent = 'Working...';
      sendCountBadge.style.display = 'none';
      sendBtn.style.pointerEvents = 'none';
      positionSendBtn();
    } else if (processingState === 'done') {
      enableSendBtn.style.display = 'none';
      sendBtn.style.display = 'flex';
      sendBtn.classList.remove('sent');
      sendBtn.classList.remove('processing');
      sendBtn.classList.add('done');
      sendIconSpan.innerHTML = CHECK_SVG;
      sendLabel.textContent = 'Done!';
      sendCountBadge.style.display = 'none';
      sendBtn.style.pointerEvents = 'none';
      positionSendBtn();
    } else if (openCount > 0) {
      sendBtn.classList.remove('processing');
      sendBtn.classList.remove('done');
      sendCountBadge.style.display = '';
      if (sendingEnabled) {
        enableSendBtn.style.display = 'none';
        sendBtn.style.display = 'flex';
        sendCountBadge.textContent = String(openCount);
        // Only reset sent state after the animation window expires
        if (Date.now() >= sentUntil) {
          sendBtn.classList.remove('sent');
          sendIconSpan.innerHTML = SEND_SVG;
          sendLabel.textContent = 'Send';
          sendBtn.style.pointerEvents = '';
        }
        positionSendBtn();
      } else {
        sendBtn.style.display = 'none';
        enableSendBtn.style.display = 'flex';
        positionEnableSendBtn();
      }
    } else {
      sendBtn.classList.remove('processing');
      sendBtn.classList.remove('done');
      sendCountBadge.style.display = '';
      sendBtn.style.display = 'none';
      enableSendBtn.style.display = 'none';
    }
  }

  // --- Reposition pins without recreating DOM (used on scroll) ---
  function repositionBadges() {
    var positions = [];
    for (var i = 0; i < badgeElements.length; i++) {
      var pin = badgeElements[i];
      var ann = pin.__relayAnn;
      if (!ann) continue;
      var baseTop, baseLeft;
      if (ann.anchorPoint) {
        baseTop = ann.anchorPoint.y - 10;
        baseLeft = ann.anchorPoint.x - 10;
      } else {
        var targetEl = null;
        try { targetEl = document.querySelector(ann.selector); } catch(e) { /* invalid selector */ }
        if (!targetEl) { pin.style.display = 'none'; continue; }
        if (typeof targetEl.checkVisibility === 'function') {
          if (!targetEl.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
            pin.style.display = 'none'; continue;
          }
        }
        var rect = targetEl.getBoundingClientRect();
        baseTop = rect.top - 10;
        baseLeft = rect.right - 10;
      }
      // Collision avoidance
      var offsetY = 0;
      for (var j = 0; j < positions.length; j++) {
        var p = positions[j];
        if (Math.abs(p.left - baseLeft) < 20 && Math.abs(p.top + p.offsetY - baseTop - offsetY) < 20) {
          offsetY += 24;
        }
      }
      positions.push({ left: baseLeft, top: baseTop, offsetY: offsetY });
      pin.style.display = '';
      pin.style.top = (baseTop + offsetY) + 'px';
      pin.style.left = baseLeft + 'px';
    }
  }

  // Smooth scroll tracking via rAF
  var scrollRAF = null;
  window.addEventListener('scroll', function() {
    if (badgeElements.length === 0) return;
    if (scrollRAF) return;
    scrollRAF = requestAnimationFrame(function() {
      scrollRAF = null;
      repositionBadges();
    });
  }, true);

  // --- Send to AI click handler ---
  function triggerSend() {
    if (sendBtn.classList.contains('sent')) return;
    sentUntil = Date.now() + 3000;
    sendBtn.classList.add('sent');
    sendIconSpan.innerHTML = CHECK_SVG;
    sendLabel.textContent = 'Sent!';
    sendBtn.style.pointerEvents = 'none';
    fetch(API + '/annotations/send', { method: 'POST' }).catch(function(err) {
      console.error('Send to AI failed:', err);
    });
    // Revert after 3s if there are still open annotations
    setTimeout(function() {
      var openCount = annotations.filter(function(a) { return a.status === 'open'; }).length;
      if (openCount > 0) {
        sendBtn.classList.remove('sent');
        sendIconSpan.innerHTML = SEND_SVG;
        sendLabel.textContent = 'Send';
        sendBtn.style.pointerEvents = '';
      }
    }, 3000);
  }
  sendBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    triggerSend();
  });

  // --- Refresh function ---
  function refreshAnnotations() {
    currentPath = location.pathname;
    fetchAnnotations().then(function(data) {
      annotations = data;
      renderBadges();
    }).catch(function(err) {
      console.error('Failed to fetch annotations:', err);
    });
  }

  // Expose globally for MCP tools
  window.__relayAnnotateRefresh = refreshAnnotations;

  // Processing state control — called by MCP via CDP Runtime.evaluate
  window.__relaySetProcessingState = function(state) {
    processingState = state;
    if (processingTimer) { clearTimeout(processingTimer); processingTimer = null; }

    if (state === 'processing') {
      // Auto-reset after 2 min (handles AI crash/disconnect)
      processingTimer = setTimeout(function() {
        processingState = 'idle';
        renderBadges();
      }, PROCESSING_TIMEOUT_MS);
    } else if (state === 'done') {
      // Show "Done!" for 3s, then reset
      processingTimer = setTimeout(function() {
        processingState = 'idle';
        renderBadges();
      }, 3000);
    }

    renderBadges();
  };

  // --- URL change detection (SPA navigation) ---
  function onUrlChange() {
    var newPath = location.pathname;
    if (newPath !== currentPath) {
      currentPath = newPath;
      closePopover();
      renderBadges();
    }
  }

  // Intercept pushState/replaceState for SPA routers
  var origPushState = history.pushState;
  history.pushState = function() {
    origPushState.apply(this, arguments);
    onUrlChange();
  };
  var origReplaceState = history.replaceState;
  history.replaceState = function() {
    origReplaceState.apply(this, arguments);
    onUrlChange();
  };
  window.addEventListener('popstate', onUrlChange);

  // --- DOM mutation observer (modals, dialogs, drawers) ---
  var renderDebounceTimer = null;
  function debouncedRenderBadges() {
    if (renderDebounceTimer) return;
    renderDebounceTimer = setTimeout(function() {
      renderDebounceTimer = null;
      renderBadges();
    }, 150);
  }

  var observer = new MutationObserver(function(mutations) {
    // Only re-render if there are annotations to show
    if (annotations.length === 0) return;
    // Check if any mutation is relevant (skip our own badge changes)
    for (var i = 0; i < mutations.length; i++) {
      var target = mutations[i].target;
      if (target.nodeType === 1 && target.hasAttribute && target.hasAttribute('data-relay-ignore')) continue;
      debouncedRenderBadges();
      return;
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'open', 'hidden', 'aria-hidden'],
  });

  // --- Keyboard handlers ---
  function isEditingText() {
    var el = document.activeElement;
    if (!el) return false;
    var tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    return !!el.isContentEditable;
  }

  document.addEventListener('keydown', function(e) {
    // Shift+A to toggle
    if (e.shiftKey && e.key === 'A' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (isEditingText()) return;
      e.preventDefault();
      setAnnotationMode(!annotationMode);
    }
    // Shift+S to send to AI (or open onboarding modal)
    if (e.shiftKey && e.key === 'S' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (isEditingText()) return;
      if (enableSendBtn.style.display !== 'none') {
        e.preventDefault();
        showModal();
      } else if (sendBtn.style.display !== 'none') {
        e.preventDefault();
        triggerSend();
      }
    }
    // Shift+D to toggle theme
    if (e.shiftKey && e.key === 'D' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (isEditingText()) return;
      e.preventDefault();
      toggleTheme();
    }
    // ? to show shortcuts
    if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (isEditingText()) return;
      e.preventDefault();
      if (shortcutsBackdrop.style.display !== 'none') {
        dismissShortcuts();
      } else {
        showShortcuts();
      }
    }
    // Escape: dismiss modal > cancel drag > close popover > exit mode
    if (e.key === 'Escape') {
      if (shortcutsBackdrop.style.display !== 'none') {
        dismissShortcuts();
      } else if (modalBackdrop.style.display !== 'none') {
        dismissModal();
      } else if (dragState && dragState.dragging) {
        dragState = null;
        selectionRectEl.style.display = 'none';
        clearDragHighlights();
      } else if (popoverEl) {
        closePopover();
      } else if (annotationMode) {
        setAnnotationMode(false);
      }
    }
  });

  // --- Init ---
  refreshAnnotations();

  return 'overlay injected';
})();`;
}

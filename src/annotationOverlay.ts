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
    var samples = [document.documentElement, document.body];
    for (var i = 0; i < samples.length; i++) {
      if (!samples[i]) continue;
      var bg = getComputedStyle(samples[i]).backgroundColor;
      if (!bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') continue;
      var match = bg.match(/\\d+/g);
      if (!match || match.length < 3) continue;
      var r = parseInt(match[0], 10) / 255;
      var g = parseInt(match[1], 10) / 255;
      var b = parseInt(match[2], 10) / 255;
      // sRGB → linear
      r = r <= 0.03928 ? r / 12.92 : Math.pow((r + 0.055) / 1.055, 2.4);
      g = g <= 0.03928 ? g / 12.92 : Math.pow((g + 0.055) / 1.055, 2.4);
      b = b <= 0.03928 ? b / 12.92 : Math.pow((b + 0.055) / 1.055, 2.4);
      var luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      return luminance < 0.4;
    }
    return false; // default: assume light site (browser default white)
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

  // --- Styles ---
  var styleEl = document.createElement('style');
  styleEl.setAttribute('data-relay-ignore', 'true');
  styleEl.textContent = [
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
    // --- Component styles ---
    '.relay-annotate-btn {',
    '  position: fixed; width: 40px; height: 40px;',
    '  border-radius: 50%; border: 1px solid var(--relay-border); cursor: grab; z-index: 999997;',
    '  display: flex; align-items: center; justify-content: center;',
    '  box-shadow: 0 2px 12px var(--relay-shadow); transition: background 0.15s;',
    '  background: var(--relay-bg-solid); color: var(--relay-text); touch-action: none;',
    '}',
    '.relay-annotate-btn.active {',
    '  background: rgba(124, 58, 237, 0.8); border-color: rgba(124, 58, 237, 0.5); color: #fff;',
    '}',
    '.relay-annotate-btn svg { width: 20px; height: 20px; }',
    '.relay-annotate-mode-bar {',
    '  position: fixed; top: 0; left: 0; right: 0; height: 3px;',
    '  background: #7C3AED; z-index: 999998; pointer-events: none;',
    '  transition: opacity 0.15s; opacity: 0;',
    '}',
    '.relay-annotate-mode-bar.active { opacity: 1; }',
    '.relay-annotate-highlight {',
    '  position: fixed; pointer-events: none; z-index: 999996;',
    '  outline: 2px dashed #7C3AED; background: rgba(124, 58, 237, 0.08);',
    '  transition: all 0.05s; display: none;',
    '}',
    '.relay-annotate-popover {',
    '  position: fixed; width: 280px; border-radius: 8px;',
    '  background: var(--relay-bg); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);',
    '  border: 1px solid var(--relay-border-subtle);',
    '  box-shadow: 0 4px 24px var(--relay-shadow); z-index: 999999;',
    '  padding: 12px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;',
    '  font-size: 13px; color: var(--relay-text);',
    '}',
    '.relay-annotate-popover textarea {',
    '  width: 100%; min-height: 60px; border: 1px solid var(--relay-border-subtle); border-radius: 4px;',
    '  padding: 8px; font-size: 13px; font-family: inherit; resize: vertical;',
    '  box-sizing: border-box; outline: none;',
    '  background: var(--relay-input-bg); color: var(--relay-text);',
    '}',
    '.relay-annotate-popover textarea:focus { border-color: rgba(124, 58, 237, 0.6); }',
    '.relay-annotate-popover textarea::placeholder { color: var(--relay-placeholder); }',
    '.relay-annotate-popover-actions {',
    '  display: flex; gap: 6px; margin-top: 8px; justify-content: flex-end;',
    '}',
    '.relay-annotate-popover-actions button {',
    '  padding: 4px 12px; border-radius: 4px; border: 1px solid var(--relay-border);',
    '  cursor: pointer; font-size: 12px; font-family: inherit; transition: background 0.15s, border-color 0.15s;',
    '  background: var(--relay-btn-bg); color: var(--relay-btn-text);',
    '}',
    '.relay-annotate-popover-actions button:hover { background: var(--relay-btn-hover); }',
    '.relay-annotate-popover-actions button:disabled { opacity: 0.4; cursor: default; }',
    '.relay-annotate-popover-actions button.primary {',
    '  background: rgba(124, 58, 237, 0.8); color: #fff; border-color: rgba(124, 58, 237, 0.5);',
    '}',
    '.relay-annotate-popover-actions button.primary:hover { background: rgba(124, 58, 237, 0.95); }',
    '.relay-annotate-popover-actions button.danger {',
    '  color: #f87171; border-color: rgba(248, 113, 113, 0.4); background: rgba(248, 113, 113, 0.1);',
    '}',
    '.relay-annotate-popover-actions button.danger:hover { background: rgba(248, 113, 113, 0.2); }',
    '.relay-annotate-pin {',
    '  position: absolute; width: 20px; height: 20px; border-radius: 50%;',
    '  background: rgba(124, 58, 237, 0.85); color: #fff; font-size: 10px; font-weight: 700;',
    '  display: flex; align-items: center; justify-content: center;',
    '  cursor: pointer; z-index: 999997;',
    '  border: 1px solid var(--relay-pin-border); box-shadow: 0 2px 8px var(--relay-pin-shadow);',
    '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;',
    '  user-select: none; line-height: 1;',
    '}',
    '.relay-annotate-selector-info {',
    '  font-size: 11px; color: var(--relay-text-secondary); margin-bottom: 6px; word-break: break-all;',
    '}',
    '.relay-annotate-hint {',
    '  font-size: 11px; color: var(--relay-text-hint); margin-top: 4px;',
    '}',
    '.relay-annotate-selection-rect {',
    '  position: fixed; border: 2px solid #7C3AED; background: rgba(124, 58, 237, 0.10);',
    '  z-index: 999996; pointer-events: none; display: none;',
    '}',
    '.relay-annotate-drag-match {',
    '  outline: 2px solid #7C3AED !important; outline-offset: -1px;',
    '  background-color: rgba(124, 58, 237, 0.08) !important;',
    '}',
    '.relay-annotate-send-btn {',
    '  position: fixed; height: 40px; border-radius: 20px; border: 1px solid var(--relay-border);',
    '  cursor: pointer; z-index: 999997; display: none; align-items: center; gap: 6px;',
    '  padding: 0 14px 0 12px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;',
    '  font-size: 13px; font-weight: 500; white-space: nowrap; touch-action: none;',
    '  box-shadow: 0 2px 12px var(--relay-shadow); transition: background 0.15s, border-color 0.15s;',
    '  background: #7C3AED; color: #fff; border-color: rgba(124, 58, 237, 0.5);',
    '}',
    '.relay-annotate-send-btn:hover { background: #6D28D9; }',
    '.relay-annotate-send-btn.sent {',
    '  background: #059669; border-color: rgba(5, 150, 105, 0.5); pointer-events: none;',
    '}',
    '.relay-annotate-send-btn svg { width: 16px; height: 16px; flex-shrink: 0; }',
    '.relay-send-count {',
    '  display: inline-flex; align-items: center; justify-content: center;',
    '  min-width: 18px; height: 18px; border-radius: 9px; padding: 0 5px;',
    '  background: rgba(255,255,255,0.25); font-size: 11px; font-weight: 700; line-height: 1;',
    '}',
  ].join('\\n');
  document.head.appendChild(styleEl);

  // --- Pencil SVG / Close SVG ---
  var PENCIL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg>';
  var CLOSE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  var SEND_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/></svg>';
  var CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

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
  toggleBtn.className = 'relay-annotate-btn';
  toggleBtn.setAttribute('data-relay-ignore', 'true');
  toggleBtn.setAttribute('title', 'Toggle annotation mode (Shift+A)');
  toggleBtn.innerHTML = PENCIL_SVG;
  rootEl.appendChild(toggleBtn);

  // Send to AI button
  var sendBtn = document.createElement('button');
  sendBtn.className = 'relay-annotate-send-btn';
  sendBtn.setAttribute('data-relay-ignore', 'true');
  sendBtn.setAttribute('title', 'Send annotations to AI (Shift+S)');
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
  rootEl.appendChild(sendBtn);

  // Set initial position via JS (top/left) so drag can update them
  var BTN_SIZE = 40;
  var BTN_MARGIN = 8;
  toggleBtn.style.top = (window.innerHeight - BTN_SIZE - BTN_MARGIN) + 'px';
  toggleBtn.style.left = (window.innerWidth - BTN_SIZE - BTN_MARGIN) + 'px';

  // --- Position send button relative to toggle button ---
  function positionSendBtn() {
    var toggleLeft = parseFloat(toggleBtn.style.left) || 0;
    var toggleTop = parseFloat(toggleBtn.style.top) || 0;
    var sendWidth = sendBtn.offsetWidth || 100;
    var left = toggleLeft - sendWidth - 8;
    if (left < BTN_MARGIN) left = toggleLeft + BTN_SIZE + 8;
    sendBtn.style.left = left + 'px';
    sendBtn.style.top = toggleTop + 'px';
  }

  // --- Toggle annotation mode ---
  function setAnnotationMode(active) {
    annotationMode = active;
    toggleBtn.classList.toggle('active', active);
    toggleBtn.innerHTML = active ? CLOSE_SVG : PENCIL_SVG;
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
    }
  });

  toggleBtn.addEventListener('pointerup', function(e) {
    if (!btnDrag) return;
    var wasDrag = btnDrag.dragging;
    btnDrag = null;
    toggleBtn.style.cursor = '';
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

    var info = document.createElement('div');
    info.className = 'relay-annotate-selector-info';
    info.textContent = selectorResult.selector.length > 60
      ? selectorResult.selector.slice(0, 60) + '...'
      : selectorResult.selector;
    popover.appendChild(info);

    var textarea = document.createElement('textarea');
    textarea.placeholder = 'Add feedback...';
    popover.appendChild(textarea);

    var hint = document.createElement('div');
    hint.className = 'relay-annotate-hint';
    hint.textContent = 'Enter to save, Shift+Enter for new line';
    popover.appendChild(hint);

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

    var info = document.createElement('div');
    info.className = 'relay-annotate-selector-info';
    info.textContent = annotation.selector.length > 60
      ? annotation.selector.slice(0, 60) + '...'
      : annotation.selector;
    popover.appendChild(info);

    var textarea = document.createElement('textarea');
    textarea.value = annotation.text;
    popover.appendChild(textarea);

    var hint = document.createElement('div');
    hint.className = 'relay-annotate-hint';
    hint.textContent = 'Enter to save, Shift+Enter for new line';
    popover.appendChild(hint);

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
    deleteBtn.textContent = 'Delete';
    deleteBtn.className = 'danger';
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

    var hint = document.createElement('div');
    hint.className = 'relay-annotate-hint';
    hint.textContent = 'Enter to save, Shift+Enter for new line';
    popover.appendChild(hint);

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
      var baseTop, baseLeft;

      if (ann.anchorPoint) {
        // Multi-element annotation: position badge at the saved anchor point
        baseTop = ann.anchorPoint.y + window.scrollY - 10;
        baseLeft = ann.anchorPoint.x + window.scrollX - 10;
      } else {
        // Single-element annotation: position at the element
        var targetEl = null;
        try { targetEl = document.querySelector(ann.selector); } catch(e) { /* invalid selector */ }
        if (!targetEl) return;

        // Skip hidden elements (closed dialogs, display:none modals, etc.)
        if (typeof targetEl.checkVisibility === 'function') {
          if (!targetEl.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return;
        }

        var rect = targetEl.getBoundingClientRect();
        baseTop = rect.top + window.scrollY - 10;
        baseLeft = rect.right + window.scrollX - 10;
      }

      var pin = document.createElement('div');
      pin.className = 'relay-annotate-pin';
      pin.setAttribute('data-relay-ignore', 'true');
      pin.setAttribute('data-relay-annotation-id', ann.id);
      pin.textContent = String(nextBadgeNumber);
      nextBadgeNumber++;

      // Collision avoidance: offset overlapping badges by 24px
      var offsetY = 0;
      for (var i = 0; i < positions.length; i++) {
        var p = positions[i];
        if (Math.abs(p.left - baseLeft) < 20 && Math.abs(p.top + p.offsetY - baseTop - offsetY) < 20) {
          offsetY += 24;
        }
      }
      positions.push({ left: baseLeft, top: baseTop, offsetY: offsetY });

      pin.style.top = (baseTop + offsetY) + 'px';
      pin.style.left = baseLeft + 'px';

      pin.addEventListener('click', function(e) {
        e.stopPropagation();
        showEditPopover(ann, pin);
      });

      rootEl.appendChild(pin);
      badgeElements.push(pin);
    });

    // Update Send button visibility and count
    var openCount = annotations.filter(function(a) { return a.status === 'open'; }).length;
    if (openCount > 0) {
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
    }
  }

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
  document.addEventListener('keydown', function(e) {
    // Shift+A to toggle
    if (e.shiftKey && e.key === 'A' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Don't toggle if focus is in a text input
      var tag = (document.activeElement || {}).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      e.preventDefault();
      setAnnotationMode(!annotationMode);
    }
    // Shift+S to send to AI
    if (e.shiftKey && e.key === 'S' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      var tag2 = (document.activeElement || {}).tagName;
      if (tag2 === 'INPUT' || tag2 === 'TEXTAREA' || tag2 === 'SELECT') return;
      if (sendBtn.style.display !== 'none') {
        e.preventDefault();
        triggerSend();
      }
    }
    // Escape: cancel drag > close popover > exit mode
    if (e.key === 'Escape') {
      if (dragState && dragState.dragging) {
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

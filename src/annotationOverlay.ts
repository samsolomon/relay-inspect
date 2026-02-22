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

  // --- Styles ---
  var styleEl = document.createElement('style');
  styleEl.setAttribute('data-relay-ignore', 'true');
  styleEl.textContent = [
    '.relay-annotate-btn {',
    '  position: fixed; bottom: 20px; right: 20px; width: 40px; height: 40px;',
    '  border-radius: 50%; border: none; cursor: pointer; z-index: 999997;',
    '  display: flex; align-items: center; justify-content: center;',
    '  box-shadow: 0 2px 8px rgba(0,0,0,0.2); transition: background 0.15s;',
    '  background: #fff; color: #7C3AED;',
    '}',
    '.relay-annotate-btn.active { background: #7C3AED; color: #fff; }',
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
    '  position: fixed; width: 280px; background: #fff; border-radius: 8px;',
    '  box-shadow: 0 4px 20px rgba(0,0,0,0.18); z-index: 999999;',
    '  padding: 12px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;',
    '  font-size: 13px; color: #1a1a1a;',
    '}',
    '.relay-annotate-popover textarea {',
    '  width: 100%; min-height: 60px; border: 1px solid #ddd; border-radius: 4px;',
    '  padding: 8px; font-size: 13px; font-family: inherit; resize: vertical;',
    '  box-sizing: border-box; outline: none;',
    '}',
    '.relay-annotate-popover textarea:focus { border-color: #7C3AED; }',
    '.relay-annotate-popover-actions {',
    '  display: flex; gap: 6px; margin-top: 8px; justify-content: flex-end;',
    '}',
    '.relay-annotate-popover-actions button {',
    '  padding: 4px 12px; border-radius: 4px; border: 1px solid #ddd;',
    '  cursor: pointer; font-size: 12px; font-family: inherit; background: #fff;',
    '}',
    '.relay-annotate-popover-actions button.primary {',
    '  background: #7C3AED; color: #fff; border-color: #7C3AED;',
    '}',
    '.relay-annotate-popover-actions button.danger {',
    '  color: #DC2626; border-color: #DC2626;',
    '}',
    '.relay-annotate-pin {',
    '  position: absolute; width: 20px; height: 20px; border-radius: 50%;',
    '  background: #7C3AED; color: #fff; font-size: 10px; font-weight: 700;',
    '  display: flex; align-items: center; justify-content: center;',
    '  cursor: pointer; z-index: 999997; box-shadow: 0 1px 4px rgba(0,0,0,0.2);',
    '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;',
    '  user-select: none; line-height: 1;',
    '}',
    '.relay-annotate-selector-info {',
    '  font-size: 11px; color: #888; margin-bottom: 6px; word-break: break-all;',
    '}',
  ].join('\\n');
  document.head.appendChild(styleEl);

  // --- Pencil SVG / Close SVG ---
  var PENCIL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>';
  var CLOSE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

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
  document.body.appendChild(modeBarEl);

  // Highlight overlay
  highlightEl = document.createElement('div');
  highlightEl.className = 'relay-annotate-highlight';
  highlightEl.setAttribute('data-relay-ignore', 'true');
  document.body.appendChild(highlightEl);

  // Toggle button
  toggleBtn = document.createElement('button');
  toggleBtn.className = 'relay-annotate-btn';
  toggleBtn.setAttribute('data-relay-ignore', 'true');
  toggleBtn.setAttribute('title', 'Toggle annotation mode (Shift+A)');
  toggleBtn.innerHTML = PENCIL_SVG;
  document.body.appendChild(toggleBtn);

  // --- Toggle annotation mode ---
  function setAnnotationMode(active) {
    annotationMode = active;
    toggleBtn.classList.toggle('active', active);
    toggleBtn.innerHTML = active ? CLOSE_SVG : PENCIL_SVG;
    modeBarEl.classList.toggle('active', active);
    if (!active) {
      highlightEl.style.display = 'none';
      hoveredEl = null;
      closePopover();
    }
  }

  toggleBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    setAnnotationMode(!annotationMode);
  });

  // --- Highlight on hover ---
  document.addEventListener('mousemove', function(e) {
    if (!annotationMode) return;
    var target = document.elementFromPoint(e.clientX, e.clientY);
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
  }, true);

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
    textarea.placeholder = 'Add feedback... (Enter to save, Shift+Enter for new line)';
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

    document.body.appendChild(popover);
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
    var confirmingDelete = false;
    deleteBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      if (!confirmingDelete) {
        confirmingDelete = true;
        deleteBtn.textContent = 'Confirm?';
        return;
      }
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

    document.body.appendChild(popover);
    popoverEl = popover;
    positionPopover(popover, rect);
    textarea.focus();
  }

  // --- Event handlers for annotation mode ---
  // Block mousedown/pointerdown in capture phase to prevent the app from
  // reacting (e.g. closing modals) before our click handler fires.
  function blockEventInAnnotationMode(e) {
    if (!annotationMode) return;
    if (e.target.closest('[data-relay-ignore]')) return;
    e.preventDefault();
    e.stopPropagation();
  }
  document.addEventListener('pointerdown', blockEventInAnnotationMode, true);
  document.addEventListener('mousedown', blockEventInAnnotationMode, true);
  document.addEventListener('touchstart', blockEventInAnnotationMode, true);

  document.addEventListener('click', function(e) {
    if (!annotationMode) return;
    var target = e.target;

    // Ignore clicks on our own UI
    if (target.closest('[data-relay-ignore]')) return;

    e.preventDefault();
    e.stopPropagation();
    showCreatePopover(target);
  }, true);

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
      var targetEl = null;
      try { targetEl = document.querySelector(ann.selector); } catch(e) { /* invalid selector */ }
      if (!targetEl) return;

      // Skip hidden elements (closed dialogs, display:none modals, etc.)
      if (typeof targetEl.checkVisibility === 'function') {
        if (!targetEl.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return;
      }

      var pin = document.createElement('div');
      pin.className = 'relay-annotate-pin';
      pin.setAttribute('data-relay-ignore', 'true');
      pin.setAttribute('data-relay-annotation-id', ann.id);
      pin.textContent = String(nextBadgeNumber);
      nextBadgeNumber++;

      // Position at top-right of element
      var rect = targetEl.getBoundingClientRect();
      var baseTop = rect.top + window.scrollY - 10;
      var baseLeft = rect.right + window.scrollX - 10;

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

      document.body.appendChild(pin);
      badgeElements.push(pin);
    });
  }

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
    // Escape to exit mode or close popover
    if (e.key === 'Escape') {
      if (popoverEl) {
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

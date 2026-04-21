/**
 * FamilyHub v2.0 — core/router.js
 * View routing, navigation history, breadcrumbs, URL hash
 * Blueprint §4.1
 *
 * Public API:
 *   import { navigate, back, forward, getCurrentView, getHistory } from './router.js';
 */

import { emit, EVENTS } from './events.js';

// ── Constants ────────────────────────────────────────────── //

/** All routable view keys */
export const VIEW_KEYS = Object.freeze({
  DAILY:            'daily',
  KANBAN:           'kanban',
  CALENDAR:         'calendar',
  FAMILY_WALL:      'family-wall',
  FAMILY_MATTERS:   'family-matters',
  NOTES:            'notes',
  PROJECTS:         'projects',
  GRAPH:            'graph',
  BUDGET:           'budget',
  RECIPES:          'recipes',
  DOCUMENTS:        'documents',
  CONTACTS:         'contacts',
  GALLERY:          'gallery',
  SETTINGS:         'settings',
  // Generic entity-type view
  ENTITY_TYPE:      'entity-type',
});

/** Human-readable labels for breadcrumbs */
const VIEW_LABELS = {
  'daily':           'Daily Review',
  'kanban':          'Tasks',
  'calendar':        'Calendar',
  'family-wall':     'Family Wall',
  'family-matters':  'Family Matters',
  'notes':           'Notes',
  'projects':        'Projects',
  'graph':           'Knowledge Graph',
  'budget':          'Budget',
  'recipes':         'Recipes',
  'documents':       'Documents',
  'contacts':        'Contacts',
  'gallery':         'Gallery',
  'settings':        'Settings',
  'entity-type':     'Entities',
};

// ── Router State ─────────────────────────────────────────── //

/**
 * @typedef {Object} HistoryEntry
 * @property {string} viewKey       - e.g. 'kanban', 'entity-type'
 * @property {Object} params        - e.g. { entityType: 'idea' }
 * @property {string} label         - Human-readable label for breadcrumb
 */

/** @type {HistoryEntry[]} */
let _history = [];

/** Current position in _history (0 = oldest, _history.length-1 = newest) */
let _cursor = -1;

/** Registered view render functions: { [viewKey]: (params) => void } */
const _renderers = new Map();

// ── Registration ─────────────────────────────────────────── //

/**
 * Register a view's render function.
 * Called by each view module during initialisation.
 * @param {string} viewKey
 * @param {Function} renderFn - Receives params object
 */
export function registerView(viewKey, renderFn) {
  if (typeof renderFn !== 'function') {
    throw new TypeError(`[router] renderFn for "${viewKey}" must be a function`);
  }
  _renderers.set(viewKey, renderFn);
}

// ── Navigation ───────────────────────────────────────────── //

/**
 * Navigate to a view, optionally with params.
 * Pushes to history stack and updates URL hash.
 *
 * @param {string} viewKey        - e.g. 'kanban' or 'entity-type'
 * @param {Object} [params={}]    - e.g. { entityType: 'idea' }
 * @param {string} [label]        - Override breadcrumb label
 * @param {boolean} [replace=false] - Replace current history entry instead of pushing
 */
export function navigate(viewKey, params = {}, label, replace = false) {
  const resolvedLabel = label || _resolveLabel(viewKey, params);

  const entry = { viewKey, params, label: resolvedLabel };

  if (replace && _cursor >= 0) {
    // Replace current position
    _history[_cursor] = entry;
  } else {
    // Truncate forward history, then push
    _history = _history.slice(0, _cursor + 1);
    _history.push(entry);
    _cursor = _history.length - 1;
  }

  _applyView(entry);
  _updateHash(viewKey, params);
  _renderBreadcrumbs();

  emit(EVENTS.VIEW_CHANGED, { viewKey, params, label: resolvedLabel });
}

/**
 * Navigate to an entity panel view via URL deep link.
 * Hash pattern: #entity/{type}/{id}
 * @param {string} entityType
 * @param {string} entityId
 */
export function navigateToEntity(entityType, entityId) {
  // Don't push a view navigation — just update hash and fire panel:opened
  window.location.hash = `entity/${entityType}/${entityId}`;
  emit(EVENTS.PANEL_OPENED, { entityType, entityId });
}

/**
 * Navigate back one step in history.
 * @returns {boolean} Whether navigation happened
 */
export function back() {
  if (_cursor <= 0) return false;
  _cursor--;
  const entry = _history[_cursor];
  _applyView(entry);
  _updateHash(entry.viewKey, entry.params);
  _renderBreadcrumbs();
  emit(EVENTS.VIEW_CHANGED, { viewKey: entry.viewKey, params: entry.params, label: entry.label });
  return true;
}

/**
 * Navigate forward one step in history.
 * @returns {boolean} Whether navigation happened
 */
export function forward() {
  if (_cursor >= _history.length - 1) return false;
  _cursor++;
  const entry = _history[_cursor];
  _applyView(entry);
  _updateHash(entry.viewKey, entry.params);
  _renderBreadcrumbs();
  emit(EVENTS.VIEW_CHANGED, { viewKey: entry.viewKey, params: entry.params, label: entry.label });
  return true;
}

/**
 * Returns the current view entry.
 * @returns {HistoryEntry|null}
 */
export function getCurrentView() {
  return _cursor >= 0 ? _history[_cursor] : null;
}

/**
 * Returns the full history stack (read-only copy).
 * @returns {HistoryEntry[]}
 */
export function getHistory() {
  return [..._history];
}

/** @returns {boolean} */
export function canGoBack()    { return _cursor > 0; }
/** @returns {boolean} */
export function canGoForward() { return _cursor < _history.length - 1; }

// ── Internal Helpers ─────────────────────────────────────── //

/**
 * Show the correct view div and call its render function.
 * @param {HistoryEntry} entry
 */
function _applyView(entry) {
  const { viewKey, params } = entry;

  // Hide all views
  document.querySelectorAll('.view').forEach(el => {
    el.classList.remove('active');
  });

  // Remove graph-active from main (Blueprint §9.2)
  const main = document.getElementById('main');
  if (main) main.classList.remove('graph-active');

  // Show target view
  const viewEl = document.getElementById(`view-${viewKey}`);
  if (viewEl) {
    viewEl.classList.add('active');
  }

  // Graph view triggers special layout (Blueprint §9.2)
  if (viewKey === VIEW_KEYS.GRAPH && main) {
    main.classList.add('graph-active');
  }

  // Update active nav item
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.remove('active');
    if (el.dataset.view === viewKey) {
      // Check params too for entity-type views
      if (viewKey === 'entity-type') {
        if (el.dataset.entityType === params.entityType) {
          el.classList.add('active');
        }
      } else {
        el.classList.add('active');
      }
    }
  });

  // Call registered renderer if available
  if (_renderers.has(viewKey)) {
    try {
      _renderers.get(viewKey)(params);
    } catch (err) {
      console.error(`[router] Error rendering view "${viewKey}":`, err);
    }
  }
}

/**
 * Update the browser URL hash without triggering hashchange listener.
 */
function _updateHash(viewKey, params) {
  let hash = viewKey;
  if (viewKey === 'entity-type' && params.entityType) {
    hash = `entity-type/${params.entityType}`;
  }
  // Use replaceState-style approach — just set hash directly.
  // We skip the hashchange listener when we set this.
  _suppressHashChange = true;
  window.location.hash = hash;
  _suppressHashChange = false;
}

let _suppressHashChange = false;

/**
 * Render the breadcrumb row from current history state.
 * Blueprint §4.1 — "Home > Project > Entity chain"
 */
function _renderBreadcrumbs() {
  const row = document.getElementById('breadcrumb-row');
  if (!row) return;

  const backBtn = document.getElementById('breadcrumb-back-btn');
  if (backBtn) {
    backBtn.disabled = !canGoBack();
  }

  // Build breadcrumb trail — show last 4 entries max
  const trail = _history.slice(Math.max(0, _cursor - 3), _cursor + 1);
  const trailContainer = document.getElementById('breadcrumb-trail');
  if (!trailContainer) return;

  trailContainer.innerHTML = '';

  trail.forEach((entry, i) => {
    const isLast = i === trail.length - 1;
    const isClickable = !isLast;

    // Separator before (except first)
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'breadcrumb-sep';
      sep.textContent = '›';
      trailContainer.appendChild(sep);
    }

    const item = document.createElement('span');
    item.className = `breadcrumb-item${isLast ? ' active' : ''}`;
    item.textContent = entry.label;

    if (isClickable) {
      const targetCursor = _cursor - (trail.length - 1 - i);
      item.addEventListener('click', () => {
        const diff = targetCursor - _cursor;
        if (diff < 0) {
          for (let j = 0; j < Math.abs(diff); j++) back();
        } else if (diff > 0) {
          for (let j = 0; j < diff; j++) forward();
        }
      });
    }

    trailContainer.appendChild(item);
  });
}

/**
 * Resolve a human-readable label for a nav entry.
 */
function _resolveLabel(viewKey, params) {
  if (viewKey === 'entity-type' && params.entityType) {
    // Capitalise entity type key — will be overridden by graph-engine when available
    return params.entityTypeLabel || _capitalise(params.entityType);
  }
  return VIEW_LABELS[viewKey] || _capitalise(viewKey);
}

function _capitalise(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// ── Hash-Based Deep Linking ───────────────────────────────── //

/**
 * Parse the current URL hash and navigate accordingly.
 * Handles: #daily, #kanban, #entity-type/idea, #entity/task/abc123
 */
export function handleInitialHash() {
  const hash = window.location.hash.slice(1); // strip '#'
  if (!hash) return false;

  // Entity panel deep link: #entity/{type}/{id}
  const entityMatch = hash.match(/^entity\/([^/]+)\/([^/]+)$/);
  if (entityMatch) {
    const [, entityType, entityId] = entityMatch;
    // Navigate to appropriate view first, then open panel
    navigate(VIEW_KEYS.DAILY);
    emit(EVENTS.PANEL_OPENED, { entityType, entityId });
    return true;
  }

  // Entity type view: #entity-type/{typeKey}
  const typeMatch = hash.match(/^entity-type\/([^/]+)$/);
  if (typeMatch) {
    navigate(VIEW_KEYS.ENTITY_TYPE, { entityType: typeMatch[1] });
    return true;
  }

  // Standard view: #daily, #kanban, etc.
  if (Object.values(VIEW_KEYS).includes(hash)) {
    navigate(hash);
    return true;
  }

  return false;
}

/**
 * Listen for browser back/forward (popstate-equivalent via hashchange).
 */
window.addEventListener('hashchange', () => {
  if (_suppressHashChange) return;
  handleInitialHash();
});

// ── Sidebar Nav Click Wiring ──────────────────────────────── //

/**
 * Wire all .nav-item elements in the sidebar to the router.
 * Called by index.html after DOM ready.
 */
export function wireNavItems() {
  document.querySelectorAll('.nav-item[data-view]').forEach(el => {
    el.addEventListener('click', () => {
      const view = el.dataset.view;
      const entityType = el.dataset.entityType;
      const label = el.dataset.label || el.querySelector('.nav-item-label')?.textContent;

      if (view === 'entity-type' && entityType) {
        navigate(view, { entityType }, label);
      } else {
        navigate(view, {}, label);
      }

      // Close mobile sidebar on nav
      const sidebar = document.getElementById('sidebar');
      const overlay = document.getElementById('sidebar-overlay');
      if (sidebar) sidebar.classList.remove('open');
      if (overlay) overlay.classList.remove('visible');
    });
  });

  // Back button
  const backBtn = document.getElementById('breadcrumb-back-btn');
  if (backBtn) {
    backBtn.addEventListener('click', () => back());
  }
}

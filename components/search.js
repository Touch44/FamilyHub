/**
 * FamilyHub v2.0 — components/search.js
 * Global search overlay + command palette.
 * Blueprint §5.4, Phase 1-D
 *
 * Public API:
 *   initSearch()    — wire all search behaviour; call once after DOM ready
 *   openSearch()    — open and focus the search overlay
 *   closeSearch()   — close the overlay
 */

import { getAllEntityTypes, getEntityTypeConfig } from '../core/graph-engine.js';
import { getEntitiesByType, getSetting, setSetting } from '../core/db.js';
import { navigate, VIEW_KEYS }                         from '../core/router.js';
import { emit, on, EVENTS }                        from '../core/events.js';
import { openForm }                                from './entity-form.js';

// ── DOM refs ──────────────────────────────────────────────── //
let _overlay, _input, _results;

// ── State ─────────────────────────────────────────────────── //
let _selectedIndex  = -1;
let _currentItems   = [];   // flat list of rendered result items for keyboard nav
let _searchTimeout  = null;

// ── Recent entities key ───────────────────────────────────── //
const RECENT_KEY    = 'recentEntities';
const RECENT_MAX    = 10;

// ════════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════════

export function initSearch() {
  _overlay = document.getElementById('search-overlay');
  _input   = document.getElementById('search-input');
  _results = document.getElementById('search-results');

  if (!_overlay || !_input || !_results) {
    console.warn('[search] Search DOM not found — skipping init.');
    return;
  }

  // ── Search button in topbar ──────────────────────────────
  document.getElementById('topbar-search-btn')
    ?.addEventListener('click', openSearch);

  // ── Click outside palette closes overlay ─────────────────
  _overlay.addEventListener('click', (e) => {
    if (e.target === _overlay) closeSearch();
  });

  // ── Input: trigger search or command mode ─────────────────
  _input.addEventListener('input', () => {
    clearTimeout(_searchTimeout);
    // Command mode (starts with >) renders immediately — no debounce needed
    if (_input.value.trimStart().startsWith('>')) {
      _render();
    } else {
      _searchTimeout = setTimeout(_render, 120);
    }
  });

  // ── Keyboard navigation ───────────────────────────────────
  _input.addEventListener('keydown', _handleInputKey);

  // ── Global: Cmd+K opens search ───────────────────────────
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      _overlay.classList.contains('open') ? closeSearch() : openSearch();
    }
    if (e.key === 'Escape' && _overlay.classList.contains('open')) {
      closeSearch();
    }
  });

  // ── Track opened entities for recents ────────────────────
  on(EVENTS.PANEL_OPENED, ({ entityId } = {}) => {
    if (entityId) _trackRecent(entityId);
  });

  console.log('[search] Initialised.');
}

// ════════════════════════════════════════════════════════════
// OPEN / CLOSE
// ════════════════════════════════════════════════════════════

export function openSearch() {
  if (!_overlay) return;
  _overlay.classList.add('open');
  _overlay.setAttribute('aria-hidden', 'false');
  _overlay.removeAttribute('inert');
  _input.value = '';
  _selectedIndex = -1;
  _render();
  // Small delay so animation starts before focus
  setTimeout(() => _input.focus(), 30);
}

export function closeSearch() {
  if (!_overlay) return;
  _overlay.classList.remove('open');
  _overlay.setAttribute('aria-hidden', 'true');
  _overlay.setAttribute('inert', '');
  _selectedIndex = -1;
  _currentItems  = [];
}

// ════════════════════════════════════════════════════════════
// RENDER DISPATCHER
// ════════════════════════════════════════════════════════════

async function _render() {
  const query = _input.value.trim();

  if (_input.value.trimStart().startsWith('>')) {
    _renderCommands(query.replace(/^>/, '').trim());
  } else if (query.length === 0) {
    await _renderRecents();
  } else {
    await _renderSearchResults(query);
  }
}

// ════════════════════════════════════════════════════════════
// RECENT ENTITIES
// ════════════════════════════════════════════════════════════

async function _renderRecents() {
  _results.innerHTML = '';
  _currentItems      = [];
  _selectedIndex     = -1;

  let recents = [];
  try {
    recents = (await getSetting(RECENT_KEY)) || [];
  } catch { recents = []; }

  if (recents.length === 0) {
    _results.innerHTML = `
      <div style="padding: var(--space-4) var(--space-5); color: var(--color-text-muted);
                  font-size: var(--text-sm); text-align: center;">
        Start typing to search, or type <kbd>></kbd> for commands
      </div>`;
    return;
  }

  const section = _makeSection('Recent');
  _results.appendChild(section.header);

  for (const rec of recents) {
    const cfg  = getEntityTypeConfig(rec.type);
    const item = _makeResultItem({
      icon:      cfg?.icon || '📎',
      title:     rec.title || 'Untitled',
      detail:    cfg?.label || rec.type,
      color:     cfg?.color,
      onActivate: () => {
        closeSearch();
        emit(EVENTS.PANEL_OPENED, { entityId: rec.id });
      },
    });
    _results.appendChild(item.el);
    _currentItems.push(item);
  }
}

// ════════════════════════════════════════════════════════════
// ENTITY SEARCH
// ════════════════════════════════════════════════════════════

async function _renderSearchResults(query) {
  _results.innerHTML = `
    <div style="padding: var(--space-3) var(--space-5); color: var(--color-text-muted);
                font-size: var(--text-xs);">Searching…</div>`;
  _currentItems  = [];
  _selectedIndex = -1;

  const lq       = query.toLowerCase();
  const types    = getAllEntityTypes();
  const groups   = new Map();   // typeKey → [{entity, config}]

  // Search all types in parallel
  await Promise.all(types.map(async (cfg) => {
    let entities = [];
    try { entities = await getEntitiesByType(cfg.key); } catch { return; }

    const titleField   = cfg.fields.find(f => f.isTitle);
    const detailFields = cfg.fields.filter(f =>
      !f.isTitle && ['text', 'select', 'date', 'email', 'phone', 'url'].includes(f.type)
    ).slice(0, 2);

    const matches = entities.filter(e => {
      if (e.deleted) return false;
      const titleKey = titleField?.key || 'title';
      const title    = (e[titleKey] || '').toLowerCase();
      if (title.includes(lq)) return true;
      // Also search secondary text fields
      return detailFields.some(f => (e[f.key] || '').toString().toLowerCase().includes(lq));
    }).slice(0, 5);

    if (matches.length > 0) {
      groups.set(cfg.key, matches.map(e => ({ entity: e, config: cfg })));
    }
  }));

  _results.innerHTML = '';

  if (groups.size === 0) {
    _results.innerHTML = `
      <div style="padding: var(--space-6) var(--space-5); color: var(--color-text-muted);
                  font-size: var(--text-sm); text-align: center;">
        No results for "<strong>${_esc(query)}</strong>"
      </div>`;
    return;
  }

  // Render each group
  for (const [typeKey, hits] of groups) {
    const cfg = hits[0].config;

    const section = _makeSection(`${cfg.icon} ${cfg.labelPlural || cfg.label} (${hits.length})`);
    _results.appendChild(section.header);

    for (const { entity, config } of hits) {
      const titleField  = config.fields.find(f => f.isTitle);
      const titleKey    = titleField?.key || 'title';
      const title       = entity[titleKey] || 'Untitled';
      const detailField = config.fields.find(f =>
        !f.isTitle && ['date', 'select', 'text', 'email'].includes(f.type) && entity[f.key]
      );
      const detail = detailField
        ? `${detailField.label}: ${_formatFieldValue(entity[detailField.key], detailField.type)}`
        : '';

      const item = _makeResultItem({
        icon:      config.icon,
        title,
        detail,
        color:     config.color,
        onActivate: () => {
          closeSearch();
          emit(EVENTS.PANEL_OPENED, { entityId: entity.id });
        },
      });
      _results.appendChild(item.el);
      _currentItems.push(item);
    }
  }
}

// ════════════════════════════════════════════════════════════
// COMMAND MODE  (input starts with ">")
// ════════════════════════════════════════════════════════════

const COMMANDS = [
  {
    label:   'Daily Review',
    detail:  'Go to Daily Review',
    icon:    '📋',
    keys:    ['daily', 'review'],
    action:  () => { closeSearch(); navigate(VIEW_KEYS.DAILY); },
  },
  {
    label:   'Kanban / Tasks',
    detail:  'Go to Kanban board',
    icon:    '✅',
    keys:    ['kanban', 'task', 'tasks'],
    action:  () => { closeSearch(); navigate(VIEW_KEYS.KANBAN); },
  },
  {
    label:   'Calendar',
    detail:  'Go to Calendar',
    icon:    '📅',
    keys:    ['calendar', 'events'],
    action:  () => { closeSearch(); navigate(VIEW_KEYS.CALENDAR); },
  },
  {
    label:   'Knowledge Graph',
    detail:  'Go to Knowledge Graph',
    icon:    '🕸️',
    keys:    ['graph', 'knowledge'],
    action:  () => { closeSearch(); navigate(VIEW_KEYS.GRAPH); },
  },
  {
    label:   'Family Wall',
    detail:  'Go to Family Wall',
    icon:    '🏡',
    keys:    ['family', 'wall', 'post'],
    action:  () => { closeSearch(); navigate(VIEW_KEYS.FAMILY_WALL); },
  },
  {
    label:   'Settings',
    detail:  'Open Settings',
    icon:    '⚙️',
    keys:    ['settings', 'preferences'],
    action:  () => { closeSearch(); navigate(VIEW_KEYS.SETTINGS); },
  },
  {
    label:   'New Task',
    detail:  'Open new task form',
    icon:    '✅',
    keys:    ['new task', 'task', 'create task', 'add task'],
    action:  () => { closeSearch(); openForm('task'); },
  },
  {
    label:   'New Note',
    detail:  'Open new note form',
    icon:    '📝',
    keys:    ['new note', 'note', 'create note'],
    action:  () => { closeSearch(); openForm('note'); },
  },
  {
    label:   'New Event',
    detail:  'Open new event form',
    icon:    '📅',
    keys:    ['new event', 'event', 'create event'],
    action:  () => { closeSearch(); openForm('event'); },
  },
  {
    label:   'New Person',
    detail:  'Open new person form',
    icon:    '👤',
    keys:    ['new person', 'person', 'add person', 'add member'],
    action:  () => { closeSearch(); openForm('person'); },
  },
  {
    label:   'Sync Now',
    detail:  'Trigger Notion sync',
    icon:    '🔄',
    keys:    ['sync', 'notion', 'sync now'],
    action:  () => { closeSearch(); emit(EVENTS.SYNC_TRIGGER); },
  },
  {
    label:   'Dark Mode',
    detail:  'Toggle dark / light theme',
    icon:    '🌙',
    keys:    ['dark', 'light', 'theme', 'mode'],
    action:  () => {
      closeSearch();
      const current = document.documentElement.getAttribute('data-theme') || 'light';
      const next    = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('fh_theme', next);
      emit(EVENTS.THEME_CHANGED, { theme: next });
    },
  },
  {
    label:   'Keyboard Shortcuts',
    detail:  'Show all keyboard shortcuts',
    icon:    '⌨️',
    keys:    ['shortcuts', 'keyboard', 'help', 'keys'],
    action:  () => {
      closeSearch();
      const so = document.getElementById('shortcuts-overlay');
      if (so) {
        so.classList.add('open');
        so.setAttribute('aria-hidden', 'false');
        so.removeAttribute('inert');
      }
    },
  },
];

function _renderCommands(query) {
  _results.innerHTML = '';
  _currentItems      = [];
  _selectedIndex     = -1;

  const lq = query.toLowerCase();

  const matches = query.length === 0
    ? COMMANDS
    : COMMANDS.filter(cmd =>
        cmd.label.toLowerCase().includes(lq) ||
        cmd.keys.some(k => k.includes(lq))
      );

  if (matches.length === 0) {
    _results.innerHTML = `
      <div style="padding: var(--space-4) var(--space-5); color: var(--color-text-muted);
                  font-size: var(--text-sm);">No commands match "<strong>${_esc(query)}</strong>"</div>`;
    return;
  }

  const section = _makeSection('Commands');
  _results.appendChild(section.header);

  for (const cmd of matches) {
    const item = _makeResultItem({
      icon:       cmd.icon,
      title:      cmd.label,
      detail:     cmd.detail,
      onActivate: cmd.action,
    });
    _results.appendChild(item.el);
    _currentItems.push(item);
  }
}

// ════════════════════════════════════════════════════════════
// KEYBOARD NAVIGATION
// ════════════════════════════════════════════════════════════

function _handleInputKey(e) {
  switch (e.key) {
    case 'Escape':
      e.preventDefault();
      closeSearch();
      break;

    case 'ArrowDown':
      e.preventDefault();
      _moveSelection(1);
      break;

    case 'ArrowUp':
      e.preventDefault();
      _moveSelection(-1);
      break;

    case 'Enter':
      e.preventDefault();
      if (_selectedIndex >= 0 && _currentItems[_selectedIndex]) {
        _currentItems[_selectedIndex].activate();
      } else if (_currentItems.length > 0) {
        _currentItems[0].activate();
      }
      break;

    case 'Tab':
      e.preventDefault();
      _moveSelection(e.shiftKey ? -1 : 1);
      break;
  }
}

function _moveSelection(delta) {
  const count = _currentItems.length;
  if (count === 0) return;

  // Deselect current
  if (_selectedIndex >= 0 && _currentItems[_selectedIndex]) {
    _currentItems[_selectedIndex].deselect();
  }

  _selectedIndex = (_selectedIndex + delta + count) % count;
  _currentItems[_selectedIndex].select();
  _currentItems[_selectedIndex].el.scrollIntoView({ block: 'nearest' });
}

// ════════════════════════════════════════════════════════════
// DOM HELPERS
// ════════════════════════════════════════════════════════════

function _makeSection(label) {
  const header = document.createElement('div');
  header.style.cssText = `
    padding: var(--space-2) var(--space-5) var(--space-1);
    font-size: var(--text-xs); font-weight: var(--weight-semibold);
    color: var(--color-text-muted); text-transform: uppercase;
    letter-spacing: 0.06em; border-top: 1px solid var(--color-border);
    margin-top: var(--space-1);
  `;
  // First section has no top border
  if (_results.children.length === 0) {
    header.style.borderTop = 'none';
    header.style.marginTop = '0';
  }
  header.textContent = label;
  return { header };
}

/**
 * Create a single clickable result row.
 * Returns { el, select(), deselect(), activate() }
 */
function _makeResultItem({ icon, title, detail, color, onActivate }) {
  const el = document.createElement('div');
  el.setAttribute('role', 'option');
  el.style.cssText = `
    display: flex; align-items: center; gap: var(--space-3);
    padding: var(--space-2-5) var(--space-5);
    cursor: pointer; transition: background var(--transition-fast);
    border-radius: 0;
  `;

  // Icon
  const iconEl = document.createElement('span');
  iconEl.textContent = icon;
  iconEl.style.cssText = 'font-size: 1rem; flex-shrink: 0; width: 20px; text-align: center;';
  el.appendChild(iconEl);

  // Text block
  const textEl = document.createElement('div');
  textEl.style.cssText = 'flex: 1; min-width: 0;';

  const titleEl = document.createElement('div');
  titleEl.textContent = title;
  titleEl.style.cssText = `
    font-size: var(--text-sm); font-weight: var(--weight-medium);
    color: var(--color-text); overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap;
  `;
  textEl.appendChild(titleEl);

  if (detail) {
    const detailEl = document.createElement('div');
    detailEl.textContent = detail;
    detailEl.style.cssText = `
      font-size: var(--text-xs); color: var(--color-text-muted);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    `;
    textEl.appendChild(detailEl);
  }
  el.appendChild(textEl);

  // Color dot (for entity results)
  if (color) {
    const dot = document.createElement('span');
    dot.style.cssText = `
      width: 8px; height: 8px; border-radius: var(--radius-full);
      background: ${color}; flex-shrink: 0;
    `;
    el.appendChild(dot);
  }

  const activate = () => { if (onActivate) onActivate(); };

  el.addEventListener('click', activate);
  el.addEventListener('mouseenter', () => {
    el.style.background = 'var(--color-surface-2)';
  });
  el.addEventListener('mouseleave', () => {
    // Only un-highlight if not keyboard-selected
    if (!el.classList.contains('sr-selected')) {
      el.style.background = 'none';
    }
  });

  const select = () => {
    el.classList.add('sr-selected');
    el.style.background = 'var(--color-surface-2)';
    el.setAttribute('aria-selected', 'true');
  };

  const deselect = () => {
    el.classList.remove('sr-selected');
    el.style.background = 'none';
    el.setAttribute('aria-selected', 'false');
  };

  return { el, select, deselect, activate };
}

// ════════════════════════════════════════════════════════════
// RECENT ENTITIES TRACKING
// ════════════════════════════════════════════════════════════

async function _trackRecent(entityId) {
  if (!entityId) return;
  try {
    // We need a minimal record — fetch from any available entity data
    // We rely on the panel having the entity; search for it across all types
    const types  = getAllEntityTypes();
    let found    = null;

    for (const cfg of types) {
      if (found) break;
      try {
        const entities = await getEntitiesByType(cfg.key);
        const match    = entities.find(e => e.id === entityId && !e.deleted);
        if (match) {
          const titleField = cfg.fields.find(f => f.isTitle);
          found = {
            id:    match.id,
            type:  match.type,
            title: titleField ? (match[titleField.key] || 'Untitled') : 'Untitled',
          };
        }
      } catch { /* skip */ }
    }

    if (!found) return;

    let recents = [];
    try { recents = (await getSetting(RECENT_KEY)) || []; } catch { recents = []; }

    // Remove if already in list, add to front
    recents = recents.filter(r => r.id !== entityId);
    recents.unshift(found);
    recents = recents.slice(0, RECENT_MAX);

    await setSetting(RECENT_KEY, recents);
  } catch (err) {
    console.warn('[search] _trackRecent failed:', err);
  }
}

// ════════════════════════════════════════════════════════════
// UTIL
// ════════════════════════════════════════════════════════════

function _esc(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _formatFieldValue(value, type) {
  if (!value) return '';
  if (type === 'date' || type === 'datetime') {
    try {
      return new Date(value).toLocaleDateString(undefined, {
        month: 'short', day: 'numeric', year: 'numeric',
      });
    } catch { return value; }
  }
  return String(value);
}

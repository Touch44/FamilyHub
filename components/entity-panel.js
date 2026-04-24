/**
 * FamilyHub v2.0 — components/entity-panel.js
 * Universal entity detail panel — slide-in from right (desktop) / drawer from bottom (mobile)
 * Blueprint §5.1 (entity panel), Phase 1-B
 *
 * Public API:
 *   openPanel(entityId)   — loads entity, renders, slides panel in
 *   closePanel()          — slides panel out, cleans up
 *   initEntityPanel()     — wires panel events (call once during boot)
 */

import { getEntity, saveEntity, deleteEntity, getEdgesFrom, getEdgesTo,
         saveEdge, deleteEdge, getSetting, setSetting, getEntitiesByType } from '../core/db.js';
import { getEntityTypeConfig, getAllEntityTypes,
         getNeighbors, convertEntity } from '../core/graph-engine.js';
import { on, emit, EVENTS } from '../core/events.js';
import { initGraph, destroyGraph, setFocusId, refreshGraph, setActiveTypes, getActiveNodeTypes } from './graph-canvas.js';
import { navigate, VIEW_KEYS } from '../core/router.js';

// ── Graph view state ──────────────────────────────────────── //
let _graphViewActive = false;
let _graphPreviousView = null;   // viewKey to restore on exit
let _graphTypeFilters = new Set(); // entity types currently shown in graph

// ── Entity type → native view mapping ─────────────────────── //
const TYPE_VIEW_MAP = {
  task:         'kanban',
  event:        'calendar',
  note:         'notes',
  project:      'projects',
  post:         'family-wall',
  budgetEntry:  'budget',
  recipe:       'recipes',
  document:     'documents',
  contact:      'contacts',
  mealPlan:     'recipes',
  shoppingItem: 'kanban',
  appointment:  'calendar',
  dateEntity:   'calendar',
  person:       'contacts',
  // Generic entity types → entity-type view
  idea:         'entity-type/idea',
  research:     'entity-type/research',
  book:         'entity-type/book',
  trip:         'entity-type/trip',
  place:        'entity-type/place',
  weblink:      'entity-type/weblink',
  goal:         'entity-type/goal',
  habit:        'entity-type/habit',
  medication:   'entity-type/medication',
  // Daily Review → daily view
  dailyReview:  'daily',
};

// ── DOM refs (cached once on init) ───────────────────────── //
let _panel, _panelBody, _panelTitle, _panelTypeBadge, _panelClose, _savingIndicator, _headerActions;

// ── State ────────────────────────────────────────────────── //
let _entity     = null;   // currently open entity
let _config     = null;   // its EntityTypeConfig
let _activeTab  = 'properties';
let _saving     = false;
let _dirty      = false;

// ════════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════════

/**
 * Wire panel events. Call once during app boot after DOM is ready.
 */
export function initEntityPanel() {
  _panel     = document.getElementById('entity-panel');
  _panelBody = document.getElementById('entity-panel-body');

  if (!_panel || !_panelBody) {
    console.warn('[entity-panel] Panel DOM not found — skipping init.');
    return;
  }

  // Esc key closes panel
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _panel.classList.contains('open')) {
      closePanel();
    }
  });

  // Listen for open requests from anywhere
  on(EVENTS.PANEL_OPENED, ({ entityId, entityType } = {}) => {
    if (entityId) openPanel(entityId, entityType);
  });

  // Refresh if entity we're showing got saved elsewhere
  on(EVENTS.ENTITY_SAVED, ({ entity } = {}) => {
    if (entity && _entity && entity.id === _entity.id && !_saving) {
      _entity = entity;
      _renderActiveTab();
    }
  });

  // Close if entity got deleted
  on(EVENTS.ENTITY_DELETED, ({ id } = {}) => {
    if (_entity && id === _entity.id) closePanel();
  });

  // Graph canvas: single-click updates panel (in graph mode only)
  on('graph:nodeSelected', ({ id } = {}) => {
    if (id) _handleGraphNodeSelected(id);
  });

  // Graph canvas: double-click drills focus + updates panel
  on('graph:nodeFocused', ({ id } = {}) => {
    if (id) _handleGraphNodeFocused(id);
  });

  console.log('[entity-panel] Initialised.');

  // ── One-time repair for entities corrupted by type-field collision ──
  // Events/appointments with type set to a subtype value (e.g. 'Work', 'School')
  // instead of 'event'/'appointment' need repair.
  _repairCorruptedTypes();

  // ── One-time migration: clean up stale daily-review edges and fix DR titles ──
  _migrateDailyReviewEdges();
}

/**
 * Scan for entities whose .type doesn't match any registered entity type
 * but whose field values suggest they belong to a known type.
 * Repairs them by moving the corrupted type to ._subtype and restoring the correct type.
 */
async function _repairCorruptedTypes() {
  try {
    const { getEntitiesByType: _gbt } = await import('../core/db.js');
    const allTypes = getAllEntityTypes({ includeArchived: true });
    const knownKeys = new Set(allTypes.map(t => t.key));

    // Build a map of subtype values → parent type key
    // e.g. 'Work' → 'event', 'School' → 'event', 'Medical' → 'appointment'
    const subtypeMap = new Map();
    for (const tc of allTypes) {
      for (const field of tc.fields || []) {
        if (field.key === 'type' && field.options) {
          for (const opt of field.options) {
            subtypeMap.set(opt, tc.key);
          }
        }
      }
    }

    // Scan all entities — find ones with unrecognised type
    const db = await import('../core/db.js');
    const allEntities = await db.queryEntities({ includeDeleted: false });
    let repairCount = 0;

    for (const entity of allEntities) {
      if (knownKeys.has(entity.type)) continue;

      // Try to identify the correct type from the subtype map
      const correctType = subtypeMap.get(entity.type);
      if (correctType) {
        entity._subtype = entity.type;
        entity.type = correctType;
        await db.saveEntity(entity);
        repairCount++;
      }
    }

    if (repairCount > 0) {
      console.info(`[entity-panel] Repaired ${repairCount} entities with corrupted type field.`);
    }
  } catch (err) {
    console.warn('[entity-panel] Type repair scan failed:', err);
  }
}

/**
 * One-time migration (runs every boot, idempotent):
 *
 * 1. Fix Daily Review entity titles: old format 'Daily Review — YYYY-MM-DD'
 *    → new format 'Daily Review — MM-DD-YYYY'. Matched by .date field.
 *
 * 2. Delete ALL stale daily-review edges (relation = 'daily review' or 'contains'
 *    where fromType or toType = 'dailyReview'). These were created by old code
 *    that used wrong dates (createdAt instead of dueDate, etc.).
 *    Fresh correct edges will be created on next panel open or daily view load.
 *
 * Non-blocking — errors are logged but never crash the app.
 */
async function _migrateDailyReviewEdges() {
  try {
    // ── Step 1: Fix Daily Review entity titles (YYYY-MM-DD → MM-DD-YYYY) ─
    const drEntities = await getEntitiesByType('dailyReview');
    let titleFixed = 0;
    for (const dr of drEntities) {
      if (!dr.date || dr.deleted) continue;
      const correctTitle = `Daily Review — ${_formatDateForTitle(dr.date)}`;
      if (dr.title !== correctTitle) {
        try { await saveEntity({ ...dr, title: correctTitle }); titleFixed++; } catch { /* skip */ }
      }
    }
    if (titleFixed > 0) {
      console.info(`[entity-panel] [migration] Fixed ${titleFixed} DR titles to MM-DD-YYYY.`);
    }

    // ── Step 2: PURGE only stale OLD-relation-name edges (once only) ─────
    // Only delete edges with OLD relation names ('in daily review', 'daily review').
    // NEVER delete 'contains' edges — those are intentionally created by users
    // and by _createAndLink / _syncDailyReviewLinks in the current version.
    //
    // Guard: skip if this migration has already run (stored in a DB setting).
    const migDoneKey = 'migration_dr_edges_v2_done';
    const alreadyMigrated = await getSetting(migDoneKey).catch(() => null);
    if (alreadyMigrated) {
      // Migration already ran — skip entirely
    } else {
      const allTypes = ['task','event','appointment','note','post','dateEntity',
                        'mealPlan','trip','idea','research','book',
                        'person','project','contact','place','weblink',
                        'recipe','medication','shoppingItem','habit','goal','dailyReview'];

      let edgeDeleted = 0;

      for (const typeName of allTypes) {
        try {
          const entities = await getEntitiesByType(typeName);
          for (const entity of entities) {
            if (entity.deleted) continue;
            // Only delete OLD relation-name edges (not 'contains')
            for (const rel of ['daily review', 'in daily review']) {
              const edges = await getEdgesFrom(entity.id, rel);
              for (const edge of edges) {
                try { await deleteEdge(edge.id); edgeDeleted++; } catch { /* skip */ }
              }
            }
          }
        } catch { /* skip type */ }
      }

      // Mark migration as done so it never runs again
      await setSetting(migDoneKey, true).catch(() => {});

      if (edgeDeleted > 0) {
        console.info(`[entity-panel] [migration] Purged ${edgeDeleted} stale old-relation-name DR edges.`);
      }
    }

  } catch (err) {
    console.warn('[entity-panel] [migration] _migrateDailyReviewEdges failed (non-fatal):', err);
  }
}

/**
 * Return the Set of correct YYYY-MM-DD dates for an entity's Daily Review links,
 * or null if we can't determine (e.g. unknown type). Used by migration.
 */
function _getCorrectDatesForEntity(entity) {
  const SKIP = new Set(['dailyReview','tag','note','budgetEntry','person','project',
                        'contact','place','weblink','recipe','medication','shoppingItem','habit','goal']);
  if (SKIP.has(entity.type)) return new Set(); // should have zero links

  const dates = new Set();
  switch (entity.type) {
    case 'task':
      if (entity.dueDate) { const d = _isoToLocalDate(entity.dueDate); if (d) dates.add(d); }
      break;
    case 'event': {
      const startD = _isoToLocalDate(entity.date);
      const endD   = _isoToLocalDate(entity.endDate);
      if (startD) {
        dates.add(startD);
        if (endD && endD > startD) {
          let cur = new Date(startD + 'T00:00:00');
          const stop = new Date(endD + 'T00:00:00');
          let safety = 0;
          while (cur <= stop && safety++ < 90) {
            const y = cur.getFullYear(), m = String(cur.getMonth()+1).padStart(2,'0'), dy = String(cur.getDate()).padStart(2,'0');
            dates.add(`${y}-${m}-${dy}`);
            cur.setDate(cur.getDate() + 1);
          }
        }
      }
      break;
    }
    case 'appointment': case 'dateEntity': case 'mealPlan':
      if (entity.date) { const d = _isoToLocalDate(entity.date); if (d) dates.add(d); }
      break;
    case 'trip':
      if (entity.startDate) { const d = _isoToLocalDate(entity.startDate); if (d) dates.add(d); }
      break;
    default:
      if (entity.createdAt) { const d = _isoToLocalDate(entity.createdAt); if (d) dates.add(d); }
      break;
  }
  return dates;
}

// ════════════════════════════════════════════════════════════
// OPEN / CLOSE
// ════════════════════════════════════════════════════════════

/**
 * Open the entity panel for a given entity ID.
 * @param {string} entityId
 * @param {string} [entityTypeHint] - fallback type key if entity.type is corrupted
 */
export async function openPanel(entityId, entityTypeHint) {
  if (!_panel || !_panelBody) return;

  try {
    const entity = await getEntity(entityId);
    if (!entity) {
      console.warn(`[entity-panel] Entity "${entityId}" not found.`);
      return;
    }

    let config = getEntityTypeConfig(entity.type);

    // If config not found, the entity.type may have been corrupted by a
    // field named 'type' (e.g. event subtype 'Work' overwrote 'event').
    // Try the entityTypeHint or scan for a matching type by field shape.
    if (!config && entityTypeHint) {
      config = getEntityTypeConfig(entityTypeHint);
      if (config) {
        // Repair: move corrupted type to _subtype, restore structural type
        entity._subtype = entity.type;
        entity.type = entityTypeHint;
        // Persist the repair so it doesn't recur
        try { await saveEntity(entity); } catch { /* best effort */ }
        console.info(`[entity-panel] Repaired entity "${entityId}": type "${entity._subtype}" → "${entityTypeHint}"`);
      }
    }

    if (!config) {
      console.warn(`[entity-panel] No config for type "${entity.type}".`);
      return;
    }

    _entity    = entity;
    _config    = config;
    // Content-first types default to 'content' view; others to 'properties'
    _activeTab = CONTENT_FIRST_TYPES.has(entity.type) ? 'content' : 'properties';
    _dirty     = false;

    // Auto-link entity to its Daily Note(s) in background
    _ensureDailyLinks(entity).catch(() => {});

    _renderHeader();
    _renderActiveTab();

    _panel.classList.add('open');
    _panel.setAttribute('aria-hidden', 'false');

  } catch (err) {
    console.error('[entity-panel] openPanel failed:', err);
  }
}

/**
 * Close the panel and clean up.
 * In graph view mode, closing the panel also exits the graph view.
 */
export function closePanel() {
  if (!_panel) return;

  // If in graph view mode, close the entire graph view
  if (_graphViewActive) {
    _closeGraphView();
    return;
  }

  _panel.classList.remove('open');
  _panel.setAttribute('aria-hidden', 'true');

  _entity = null;
  _config = null;
  _dirty  = false;

  // Clear body after transition
  setTimeout(() => {
    if (!_entity && _panelBody) _panelBody.innerHTML = '';
  }, 420);

  emit(EVENTS.PANEL_CLOSED);
}

// ════════════════════════════════════════════════════════════
// HEADER
// ════════════════════════════════════════════════════════════

function _renderHeader() {
  if (!_entity || !_config) return;

  const headerEl = document.getElementById('entity-panel-header');
  if (!headerEl) return;
  headerEl.innerHTML = '';
  headerEl.style.cssText = '';  // Let CSS classes control layout

  // ── Row 1: type badge · saving indicator · icon toolbar · close ──
  const topRow = document.createElement('div');
  topRow.style.cssText = 'display:flex;align-items:center;gap:8px;width:100%;';

  // Type badge (click → navigate to entity's native view)
  const badge = document.createElement('span');
  badge.id = 'entity-panel-type-badge';
  badge.className = 'type-badge';
  badge.setAttribute('aria-hidden', 'true');
  badge.textContent = `${_config.icon} ${_config.label}`;
  badge.style.background = _config.color;
  badge.style.cursor = 'pointer';
  badge.title = `Go to ${_config.labelPlural || _config.label} view`;
  badge.addEventListener('click', () => _navigateToEntityView(_entity, _config));
  topRow.appendChild(badge);
  _panelTypeBadge = badge;

  // Saving indicator
  const savingInd = document.createElement('span');
  savingInd.id = 'panel-saving-indicator';
  savingInd.className = 'panel-saving-indicator hidden';
  savingInd.setAttribute('aria-live', 'polite');
  savingInd.textContent = 'Saving…';
  topRow.appendChild(savingInd);
  _savingIndicator = savingInd;

  // ── Icon toolbar (right-aligned) ─────────────────────────
  const toolbar = document.createElement('div');
  toolbar.style.cssText = 'display:flex;align-items:center;gap:2px;margin-left:auto;';

  // Action buttons (complete, duplicate, archive, add-to-project, convert, delete)
  const actionsDiv = document.createElement('div');
  actionsDiv.id = 'entity-panel-header-actions';
  actionsDiv.style.cssText = 'display:flex;gap:2px;align-items:center;';
  toolbar.appendChild(actionsDiv);
  _headerActions = actionsDiv;

  // Separator
  const sep1 = document.createElement('div');
  sep1.className = 'panel-icon-btn-sep';
  toolbar.appendChild(sep1);

  // View icon buttons: only show 'content' if entity has a content field
  const hasContent = _getContentField(_entity, _config) !== null;
  const visibleViews = VIEW_DEFS.filter(v => v.key !== 'content' || hasContent);

  for (const view of visibleViews) {
    const btn = document.createElement('button');
    btn.className = 'panel-icon-btn' + (_activeTab === view.key ? ' active' : '');
    btn.title = view.title;
    btn.setAttribute('aria-label', view.title);
    btn.setAttribute('data-view', view.key);
    btn.textContent = view.icon;
    btn.addEventListener('click', () => {
      _activeTab = view.key;
      toolbar.querySelectorAll('.panel-icon-btn[data-view]').forEach(b => {
        b.classList.toggle('active', b.dataset.view === view.key);
      });
      _renderActiveTab();
    });
    toolbar.appendChild(btn);
  }

  // ── Graph: direct-action button (opens graph view immediately) ──
  const graphBtn = document.createElement('button');
  graphBtn.className = 'panel-icon-btn';
  graphBtn.title = 'Open Graph';
  graphBtn.setAttribute('aria-label', 'Open Graph');
  graphBtn.textContent = '◎';
  graphBtn.style.cssText = 'color: var(--color-accent); font-size: 1rem;';
  graphBtn.addEventListener('click', () => {
    if (_entity?.id) _openGraphView(_entity.id);
  });
  toolbar.appendChild(graphBtn);

  // Separator before close
  const sep2 = document.createElement('div');
  sep2.className = 'panel-icon-btn-sep';
  toolbar.appendChild(sep2);

  // Close button
  const closeBtn = document.createElement('button');
  closeBtn.id = 'entity-panel-close';
  closeBtn.className = 'panel-icon-btn';
  closeBtn.setAttribute('aria-label', 'Close entity panel');
  closeBtn.innerHTML = '✕';
  closeBtn.addEventListener('click', closePanel);
  toolbar.appendChild(closeBtn);
  _panelClose = closeBtn;

  topRow.appendChild(toolbar);
  headerEl.appendChild(topRow);

  // ── Row 2: entity title ──────────────────────────────────
  const titleRow = document.createElement('div');
  titleRow.style.cssText = 'display:flex;align-items:flex-start;width:100%;';

  const titleField = _config.fields.find(f => f.isTitle);
  const titleVal   = _getDisplayTitle(_entity);

  const titleSpan = document.createElement('span');
  titleSpan.id = 'entity-panel-title';
  titleSpan.textContent = titleVal;
  titleSpan.title = 'Click to edit title';
  titleSpan.style.cssText = 'font-family:var(--font-heading,Georgia,serif);font-size:var(--text-2xl,1.5rem);font-weight:700;color:var(--color-text);cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;line-height:1.25;';
  if (titleField) titleSpan.addEventListener('click', () => _makeTitleEditable(titleField));
  titleRow.appendChild(titleSpan);
  _panelTitle = titleSpan;

  headerEl.appendChild(titleRow);

  // ── Populate action buttons ──────────────────────────────
  _renderHeaderActions();
}
function _makeTitleEditable(titleField) {
  if (!_panelTitle || !titleField) return;

  const current = _entity[titleField.key] || '';
  const input   = document.createElement('input');
  input.type        = 'text';
  input.value       = current;
  input.className   = 'input';
  input.style.cssText = 'font-family: var(--font-heading); font-weight: var(--weight-bold); font-size: var(--text-xl); flex: 1; padding: var(--space-1) var(--space-2);';

  _panelTitle.replaceWith(input);
  input.focus();
  input.select();

  const commit = async () => {
    const val = input.value.trim();
    if (val !== current) {
      _entity[titleField.key] = val;
      await _save();
    }
    // Rebuild title span — CSS handles styling via #entity-panel-title
    const span = document.createElement('span');
    span.id          = 'entity-panel-title';
    span.textContent = val || 'Untitled';
    span.title       = 'Click to edit title';
    input.replaceWith(span);
    _panelTitle = span;
    span.addEventListener('click', () => _makeTitleEditable(titleField));
  };

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = current; input.blur(); }
  });
}

// ════════════════════════════════════════════════════════════
// HEADER ACTION BUTTONS
// ════════════════════════════════════════════════════════════

function _renderHeaderActions() {
  if (!_headerActions || !_entity || !_config) return;

  _headerActions.innerHTML = '';
  const actions = _config.actions || [];

  const mkBtn = (icon, title, danger = false) => {
    const btn = document.createElement('button');
    btn.className = 'panel-icon-btn';
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.textContent = icon;
    if (danger) btn.style.color = 'var(--color-danger)';
    return btn;
  };

  // ── PRIMARY: Complete (tasks only) ──────────────────────
  if (_entity.type === 'task' && _entity.status !== 'Done') {
    const btn = mkBtn('✓', 'Mark complete');
    btn.style.color = 'var(--color-success-text, #15803d)';
    btn.style.fontWeight = '600';
    btn.addEventListener('click', async () => {
      _entity.status = 'Done';
      await _save();
      _renderHeader();
      _renderActiveTab();
    });
    _headerActions.appendChild(btn);
  }

  // ── PRIMARY: Archive / Unarchive ────────────────────────
  if (actions.includes('archive') || actions.includes('edit')) {
    const isArchived = _entity.status === 'Archived' || _entity.archived;
    const btn = mkBtn(isArchived ? '↑' : '⊟', isArchived ? 'Unarchive' : 'Archive');
    btn.addEventListener('click', async () => {
      if (_entity.status !== undefined) {
        _entity.status = isArchived ? 'Active' : 'Archived';
      } else {
        _entity.archived = !isArchived;
      }
      await _save();
      _renderHeader();
      _renderActiveTab();
    });
    _headerActions.appendChild(btn);
  }

  // ── PRIMARY: Delete ─────────────────────────────────────
  if (actions.includes('delete')) {
    const btn = mkBtn('⊗', 'Delete', true);
    btn.addEventListener('click', () => _confirmDelete());
    _headerActions.appendChild(btn);
  }

  // ── OVERFLOW MENU: Duplicate · Add to Project · Convert ─
  const overflowItems = [];
  if (actions.includes('duplicate'))     overflowItems.push({ label: 'Duplicate',       fn: _duplicateEntity });
  if (_entity.type !== 'project')        overflowItems.push({ label: 'Add to Project',  fn: _showProjectPicker });
  if (actions.includes('convert'))       overflowItems.push({ label: 'Convert to…',     fn: _showConvertDropdown });

  if (overflowItems.length > 0) {
    const moreBtn = mkBtn('···', 'More actions');
    moreBtn.style.cssText = 'letter-spacing: -1px; font-size: 0.7rem; position: relative;';
    let _menu = null;

    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (_menu && document.contains(_menu)) { _menu.remove(); _menu = null; return; }

      _menu = document.createElement('div');
      _menu.style.cssText = `
        position: absolute; top: calc(100% + 4px); right: 0; z-index: 999;
        background: var(--color-bg); border: 1px solid var(--color-border);
        border-radius: var(--radius-sm); box-shadow: var(--shadow-md);
        padding: var(--space-1); min-width: 160px;
      `;
      for (const item of overflowItems) {
        const row = document.createElement('button');
        row.style.cssText = `
          display: block; width: 100%; text-align: left;
          padding: var(--space-1-5) var(--space-3); border: none; background: none;
          font-size: var(--text-sm); color: var(--color-text); cursor: pointer;
          border-radius: var(--radius-sm);
        `;
        row.textContent = item.label;
        row.addEventListener('mouseenter', () => row.style.background = 'var(--color-surface-2)');
        row.addEventListener('mouseleave', () => row.style.background = 'none');
        row.addEventListener('click', () => { _menu?.remove(); _menu = null; item.fn(); });
        _menu.appendChild(row);
      }

      // Append directly to moreBtn (which is position:relative)
      moreBtn.appendChild(_menu);

      const close = (ev) => {
        if (!_menu?.contains(ev.target) && ev.target !== moreBtn) {
          _menu?.remove(); _menu = null;
          document.removeEventListener('click', close);
        }
      };
      setTimeout(() => document.addEventListener('click', close), 0);
    });
    _headerActions.appendChild(moreBtn);
  }
}

async function _duplicateEntity() {
  if (!_entity) return;
  const dup = { ..._entity };
  delete dup.id; delete dup.createdAt; delete dup.updatedAt;
  const titleK = _getTitleKey(dup.type);
  if (titleK && dup[titleK]) dup[titleK] += ' (copy)';
  const saved = await saveEntity(dup);
  openPanel(saved.id);
}

/** Show a dropdown to pick a project and link this entity to it */
async function _showProjectPicker() {
  if (!_entity) return;

  // Create dropdown below the header actions
  const existing = document.querySelector('.panel-project-picker');
  if (existing) { existing.remove(); return; }

  const { getEntitiesByType } = await import('../core/db.js');
  const projects = (await getEntitiesByType('project')).filter(p => !p.deleted);

  const dropdown = document.createElement('div');
  dropdown.className = 'panel-project-picker';
  dropdown.style.cssText = `
    position: absolute; top: 100%; right: var(--space-4); z-index: 10;
    background: var(--color-bg); border: 1px solid var(--color-border);
    border-radius: var(--radius-md); box-shadow: var(--shadow-lg);
    padding: var(--space-2); min-width: 180px; max-height: 200px;
    overflow-y: auto;
  `;

  if (projects.length === 0) {
    dropdown.innerHTML = '<div style="font-size: var(--text-xs); color: var(--color-text-muted); padding: var(--space-2);">No projects yet</div>';
  } else {
    for (const proj of projects) {
      const item = document.createElement('div');
      item.style.cssText = `
        display: flex; align-items: center; gap: var(--space-2);
        padding: var(--space-1-5) var(--space-2); border-radius: var(--radius-sm);
        cursor: pointer; font-size: var(--text-sm);
        transition: background var(--transition-fast);
      `;
      item.textContent = `📁 ${proj.name || 'Untitled'}`;
      item.addEventListener('mouseenter', () => { item.style.background = 'var(--color-surface-2)'; });
      item.addEventListener('mouseleave', () => { item.style.background = 'none'; });
      item.addEventListener('click', async () => {
        await saveEdge({
          fromId:   _entity.id,
          fromType: _entity.type,
          toId:     proj.id,
          toType:   'project',
          relation: 'project',
        });
        dropdown.remove();
        _renderActiveTab();
      });
      dropdown.appendChild(item);
    }
  }

  // Position relative to header
  const header = document.getElementById('entity-panel-header');
  if (header) {
    header.style.position = 'relative';
    header.appendChild(dropdown);
  }

  // Close on outside click
  const closeHandler = (e) => {
    if (!dropdown.contains(e.target)) {
      dropdown.remove();
      document.removeEventListener('click', closeHandler, true);
    }
  };
  setTimeout(() => document.addEventListener('click', closeHandler, true), 10);
}

/** Show convert type dropdown from header */
function _showConvertDropdown() {
  const existing = document.querySelector('.panel-convert-picker');
  if (existing) { existing.remove(); return; }

  const dropdown = document.createElement('div');
  dropdown.className = 'panel-convert-picker';
  dropdown.style.cssText = `
    position: absolute; top: 100%; right: var(--space-4); z-index: 10;
    background: var(--color-bg); border: 1px solid var(--color-border);
    border-radius: var(--radius-md); box-shadow: var(--shadow-lg);
    padding: var(--space-2); min-width: 180px; max-height: 250px;
    overflow-y: auto; display: flex; flex-wrap: wrap; gap: var(--space-1);
  `;

  const types = getAllEntityTypes();
  for (const t of types) {
    if (t.key === _entity.type) continue;
    const btn = document.createElement('button');
    btn.className   = 'btn btn-ghost btn-xs';
    btn.textContent = `${t.icon} ${t.label}`;
    btn.style.fontSize = 'var(--text-xs)';
    btn.addEventListener('click', async () => {
      try {
        const converted = await convertEntity(_entity.id, t.key);
        dropdown.remove();
        openPanel(converted.id);
      } catch (err) {
        console.error('[entity-panel] Convert failed:', err);
      }
    });
    dropdown.appendChild(btn);
  }

  const header = document.getElementById('entity-panel-header');
  if (header) {
    header.style.position = 'relative';
    header.appendChild(dropdown);
  }

  const closeHandler = (e) => {
    if (!dropdown.contains(e.target)) {
      dropdown.remove();
      document.removeEventListener('click', closeHandler, true);
    }
  };
  setTimeout(() => document.addEventListener('click', closeHandler, true), 10);
}

// ════════════════════════════════════════════════════════════
// TABS
// ════════════════════════════════════════════════════════════

// ── Content-first entity types ────────────────────────────── //
// These types open in 'content' view by default (body/richtext prominent).
// All others open in 'properties' view.
const CONTENT_FIRST_TYPES = new Set([
  'note', 'idea', 'research', 'book', 'document', 'weblink',
  'trip', 'goal', 'habit', 'recipe', 'post',
]);

// ── View definitions (icon toolbar) ──────────────────────── //
// 'graph' is NOT in this list — it gets its own direct-action button below
const VIEW_DEFS = [
  { key: 'content',    icon: '≡',  title: 'Content' },
  { key: 'properties', icon: '⊞',  title: 'Properties' },
  { key: 'relations',  icon: '⌥',  title: 'Relations' },
  { key: 'activity',   icon: '◷',  title: 'Activity' },
];

// ════════════════════════════════════════════════════════════
// VIEW RENDERING (no tab bar — views driven by icon toolbar)
// ════════════════════════════════════════════════════════════

/**
 * Get the primary content/richtext field for an entity, or null.
 * Used to decide whether to show the Content view icon and whether
 * to render content-first.
 */
function _getContentField(entity, config) {
  if (!entity || !config) return null;
  // Find the first richtext field that is NOT the title
  const field = config.fields.find(f => f.type === 'richtext' && !f.isTitle);
  if (!field) return null;
  return field;
}

function _renderActiveTab() {
  if (!_panelBody) return;
  _panelBody.innerHTML = '';

  const container = document.createElement('div');
  container.className = 'panel-view-container';
  container.style.cssText = 'padding: var(--space-5) var(--space-6); min-height: 200px;';
  _panelBody.appendChild(container);

  switch (_activeTab) {
    case 'content':    _renderContentView(container);    break;
    case 'properties': _renderPropertiesTab(container);  break;
    case 'relations':  _renderRelationsTab(container);   break;
    case 'activity':   _renderActivityTab(container);    break;
    default:           _renderPropertiesTab(container);  break;
  }
}

/**
 * Content view — renders the primary richtext/body field prominently,
 * plus all non-title non-richtext fields as a compact property strip below.
 */
function _renderContentView(container) {
  if (!_entity || !_config) return;

  const contentField = _getContentField(_entity, _config);
  if (!contentField) {
    // Fallback: show properties if no content field
    _renderPropertiesTab(container);
    return;
  }

  // ── Content editor ───────────────────────────────────────
  const editorWrap = document.createElement('div');
  editorWrap.style.cssText = 'margin-bottom: var(--space-6);';

  const value = _entity[contentField.key];

  const editor = document.createElement('div');
  editor.contentEditable = 'true';
  editor.setAttribute('role', 'textbox');
  editor.setAttribute('aria-multiline', 'true');
  editor.setAttribute('aria-label', contentField.label);
  editor.setAttribute('data-placeholder', `Start writing ${contentField.label.toLowerCase()}…`);
  editor.style.cssText = `
    min-height: 220px;
    font-size: var(--text-sm);
    line-height: 1.75;
    color: var(--color-text);
    outline: none;
    white-space: pre-wrap;
    word-break: break-word;
  `;
  editor.innerHTML = value || '';

  editor.className = 'panel-content-editor';

  // Inject placeholder style once — guard against duplicates
  if (!document.getElementById('panel-content-editor-style')) {
    const editorStyle = document.createElement('style');
    editorStyle.id = 'panel-content-editor-style';
    editorStyle.textContent = `
      .panel-content-editor:empty:before {
        content: attr(data-placeholder);
        color: var(--color-text-muted);
        pointer-events: none;
      }
    `;
    document.head.appendChild(editorStyle);
  }

  let _saveDebounce = null;
  const schedSave = () => {
    clearTimeout(_saveDebounce);
    _saveDebounce = setTimeout(async () => {
      _entity[contentField.key] = editor.innerHTML;
      await _save();
    }, 800);
  };
  editor.addEventListener('input', schedSave);
  editor.addEventListener('blur', async () => {
    clearTimeout(_saveDebounce);
    _entity[contentField.key] = editor.innerHTML;
    await _save();
  });

  editorWrap.appendChild(editor);
  container.appendChild(editorWrap);

  // ── Compact property strip (non-title fields, excluding the content field itself) ──
  const otherFields = _config.fields.filter(f =>
    !f.isTitle && f.key !== contentField.key
  );

  if (otherFields.length > 0) {
    const strip = document.createElement('div');
    strip.style.cssText = `
      border-top: 1px solid var(--color-border);
      padding-top: var(--space-4);
      display: flex;
      flex-direction: column;
      gap: 0;
    `;

    for (const field of otherFields) {
      const row = _createFieldRow(field);
      strip.appendChild(row);
    }

    // Metadata
    const meta = document.createElement('div');
    meta.style.cssText = 'margin-top: var(--space-4); padding-top: var(--space-3); border-top: 1px solid var(--color-border);';
    meta.innerHTML = `
      <div style="font-size: var(--text-xs); color: var(--color-text-muted); display: flex; flex-direction: column; gap: var(--space-1);">
        <span>Created: ${_formatTimestamp(_entity.createdAt)}</span>
        <span>Updated: ${_formatTimestamp(_entity.updatedAt)}</span>
        <span style="opacity:0.5;">ID: ${_entity.id}</span>
      </div>
    `;
    strip.appendChild(meta);
    container.appendChild(strip);
  }
}

// ════════════════════════════════════════════════════════════
// PROPERTIES TAB
// ════════════════════════════════════════════════════════════

function _renderPropertiesTab(container) {
  if (!_entity || !_config) return;

  const list = document.createElement('div');
  list.className = 'panel-props';

  for (const field of _config.fields) {
    if (field.isTitle) continue; // Title is in header
    const row = _createFieldRow(field);
    list.appendChild(row);
  }

  // Metadata footer
  const meta = document.createElement('div');
  meta.className = 'panel-meta';
  meta.style.cssText = 'margin-top: var(--space-6); padding-top: var(--space-4); border-top: 1px solid var(--color-border);';
  meta.innerHTML = `
    <div style="font-size: var(--text-xs); color: var(--color-text-muted); display: flex; flex-direction: column; gap: var(--space-1);">
      <span>Created: ${_formatTimestamp(_entity.createdAt)}</span>
      <span>Updated: ${_formatTimestamp(_entity.updatedAt)}</span>
      <span style="opacity: 0.6;">ID: ${_entity.id}</span>
    </div>
  `;

  container.appendChild(list);
  container.appendChild(meta);
}

/**
 * Create a single field row: label + inline-editable value.
 */
function _createFieldRow(field) {
  const row = document.createElement('div');
  row.className = 'panel-field-row';
  row.style.cssText = `
    display: flex; align-items: flex-start; gap: var(--space-3);
    padding: var(--space-2) 0;
    border-bottom: 1px solid color-mix(in srgb, var(--color-border) 50%, transparent);
    min-height: 36px;
  `;

  // Label
  const label = document.createElement('label');
  label.className   = 'panel-field-label';
  label.textContent = field.label;
  label.style.cssText = `
    width: 110px; flex-shrink: 0;
    font-size: var(--text-xs); font-weight: var(--weight-medium);
    color: var(--color-text-muted); padding-top: var(--space-1-5);
    text-transform: uppercase; letter-spacing: 0.04em;
  `;

  // Value area
  const valueWrap = document.createElement('div');
  valueWrap.className = 'panel-field-value';
  valueWrap.style.cssText = 'flex: 1; min-width: 0;';

  _renderFieldValue(valueWrap, field);

  row.appendChild(label);
  row.appendChild(valueWrap);
  return row;
}

/**
 * Render the display state of a field value.
 * Click turns it into an editable input.
 */
function _renderFieldValue(wrap, field) {
  wrap.innerHTML = '';
  // GUARD: For field named 'type', read from _subtype to avoid collision
  const value = field.key === 'type' ? (_entity._subtype ?? _entity[field.key]) : _entity[field.key];

  switch (field.type) {

    // ── SELECT ──────────────────────────────────────────── //
    case 'select': {
      const display = document.createElement('span');
      display.className = 'panel-field-display';
      display.style.cssText = `
        cursor: pointer; padding: var(--space-1) var(--space-2);
        border-radius: var(--radius-sm); font-size: var(--text-sm);
        display: inline-block; min-width: 60px;
        transition: background var(--transition-fast);
      `;
      display.textContent = value || '—';
      if (value) {
        display.style.background = 'var(--color-surface-2)';
        display.style.color      = 'var(--color-text)';
      } else {
        display.style.color = 'var(--color-text-muted)';
      }

      display.addEventListener('click', () => {
        _editSelect(wrap, field);
      });
      wrap.appendChild(display);
      break;
    }

    // ── RELATION ────────────────────────────────────────── //
    case 'relation': {
      _renderRelationChips(wrap, field);
      break;
    }

    // ── TAGS ────────────────────────────────────────────── //
    case 'tags': {
      _renderTagChips(wrap, field);
      break;
    }

    // ── CHECKBOX ────────────────────────────────────────── //
    case 'checkbox': {
      const cb = document.createElement('input');
      cb.type    = 'checkbox';
      cb.checked = !!value;
      cb.style.cssText = 'cursor: pointer; width: 18px; height: 18px; accent-color: var(--color-accent);';
      cb.addEventListener('change', async () => {
        _entity[field.key] = cb.checked;
        await _save();
      });
      wrap.appendChild(cb);
      break;
    }

    // ── RICHTEXT ────────────────────────────────────────── //
    case 'richtext': {
      const display = document.createElement('div');
      display.className = 'panel-field-display';
      display.style.cssText = `
        cursor: pointer; padding: var(--space-1-5) var(--space-2);
        border-radius: var(--radius-sm); font-size: var(--text-sm);
        color: ${value ? 'var(--color-text)' : 'var(--color-text-muted)'};
        white-space: pre-wrap; word-break: break-word; max-height: 120px;
        overflow: hidden; line-height: var(--leading-relaxed);
        transition: background var(--transition-fast);
      `;
      display.textContent = value || 'Click to edit…';

      display.addEventListener('click', () => {
        _editRichtext(wrap, field);
      });
      wrap.appendChild(display);
      break;
    }

    // ── NUMBER ──────────────────────────────────────────── //
    case 'number': {
      const display = document.createElement('span');
      display.className = 'panel-field-display';
      display.style.cssText = `
        cursor: pointer; padding: var(--space-1) var(--space-2);
        border-radius: var(--radius-sm); font-size: var(--text-sm);
        display: inline-block;
      `;
      display.textContent = value != null ? String(value) : '—';
      display.style.color = value != null ? 'var(--color-text)' : 'var(--color-text-muted)';

      display.addEventListener('click', () => {
        _editText(wrap, field, 'number');
      });
      wrap.appendChild(display);
      break;
    }

    // ── DATE / DATETIME ─────────────────────────────────── //
    case 'date': {
      const display = document.createElement('span');
      display.className = 'panel-field-display';
      display.style.cssText = `
        cursor: pointer; padding: var(--space-1) var(--space-2);
        border-radius: var(--radius-sm); font-size: var(--text-sm);
        display: inline-block;
      `;
      display.textContent = value ? _formatDate(value) : '—';
      display.style.color = value ? 'var(--color-text)' : 'var(--color-text-muted)';

      display.addEventListener('click', () => {
        _editDate(wrap, field);
      });
      wrap.appendChild(display);
      break;
    }

    case 'datetime': {
      const display = document.createElement('span');
      display.className = 'panel-field-display';
      display.style.cssText = `
        cursor: pointer; padding: var(--space-1) var(--space-2);
        border-radius: var(--radius-sm); font-size: var(--text-sm);
        display: inline-block;
      `;
      // Show date + time for datetime fields
      display.textContent = value
        ? new Date(value).toLocaleString(undefined, {
            year: 'numeric', month: 'short', day: 'numeric',
            hour: 'numeric', minute: '2-digit', hour12: true,
          })
        : '—';
      display.style.color = value ? 'var(--color-text)' : 'var(--color-text-muted)';

      display.addEventListener('click', () => {
        _editDate(wrap, field);
      });
      wrap.appendChild(display);
      break;
    }

    // ── TIME ────────────────────────────────────────────── //
    case 'time': {
      const display = document.createElement('span');
      display.className = 'panel-field-display';
      display.style.cssText = `
        cursor: pointer; padding: var(--space-1) var(--space-2);
        border-radius: var(--radius-sm); font-size: var(--text-sm);
        display: inline-block;
      `;

      // Format "HH:MM" → "6:00 AM" for display
      if (value) {
        const [hh, mm] = value.split(':').map(Number);
        const ampm = hh >= 12 ? 'PM' : 'AM';
        const h12  = hh === 0 ? 12 : hh > 12 ? hh - 12 : hh;
        display.textContent = `${h12}:${String(mm).padStart(2,'0')} ${ampm}`;
        display.style.color = 'var(--color-text)';
      } else {
        display.textContent = '—';
        display.style.color = 'var(--color-text-muted)';
      }

      display.addEventListener('click', () => _editTime(wrap, field));
      wrap.appendChild(display);
      break;
    }

    // ── URL ──────────────────────────────────────────────── //
    case 'url': {
      if (value) {
        const link = document.createElement('a');
        link.href        = value;
        link.target       = '_blank';
        link.rel          = 'noopener noreferrer';
        link.textContent  = _truncate(value, 40);
        link.style.cssText = 'font-size: var(--text-sm); color: var(--color-text-link); word-break: break-all;';
        wrap.appendChild(link);

        const editBtn = document.createElement('button');
        editBtn.textContent = '✎';
        editBtn.className   = 'btn-icon btn-xs';
        editBtn.style.cssText = 'margin-left: var(--space-1); font-size: var(--text-xs);';
        editBtn.addEventListener('click', () => _editText(wrap, field, 'url'));
        wrap.appendChild(editBtn);
      } else {
        const display = document.createElement('span');
        display.textContent = '—';
        display.style.cssText = 'cursor: pointer; font-size: var(--text-sm); color: var(--color-text-muted); padding: var(--space-1) var(--space-2);';
        display.addEventListener('click', () => _editText(wrap, field, 'url'));
        wrap.appendChild(display);
      }
      break;
    }

    // ── TEXT / EMAIL / PHONE / DEFAULT ───────────────────── //
    default: {
      const display = document.createElement('span');
      display.className = 'panel-field-display';
      display.style.cssText = `
        cursor: pointer; padding: var(--space-1) var(--space-2);
        border-radius: var(--radius-sm); font-size: var(--text-sm);
        display: inline-block; word-break: break-word;
      `;
      display.textContent = value || '—';
      display.style.color = value ? 'var(--color-text)' : 'var(--color-text-muted)';

      const inputType = field.type === 'email' ? 'email' : field.type === 'phone' ? 'tel' : 'text';
      display.addEventListener('click', () => {
        _editText(wrap, field, inputType);
      });
      wrap.appendChild(display);
      break;
    }
  }
}

// ── Inline edit helpers ──────────────────────────────────── //

function _editText(wrap, field, inputType = 'text') {
  const current = _entity[field.key] ?? '';
  wrap.innerHTML = '';

  const input = document.createElement('input');
  input.type      = inputType;
  input.value     = current;
  input.className = 'input';
  input.style.cssText = 'padding: var(--space-1) var(--space-2); font-size: var(--text-sm);';
  wrap.appendChild(input);
  input.focus();

  const commit = async () => {
    let val = input.value.trim();
    if (inputType === 'number') val = val === '' ? null : Number(val);
    if (val !== current) {
      _entity[field.key] = val || null;
      await _save();
    }
    _renderFieldValue(wrap, field);
  };

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = current; input.blur(); }
  });
}

function _editSelect(wrap, field) {
  // GUARD: For field named 'type', use _subtype
  const current = field.key === 'type' ? (_entity._subtype ?? '') : (_entity[field.key] ?? '');
  wrap.innerHTML = '';

  const select = document.createElement('select');
  select.className = 'select';
  select.style.cssText = 'padding: var(--space-1) var(--space-2); font-size: var(--text-sm);';

  // Empty option
  const emptyOpt   = document.createElement('option');
  emptyOpt.value   = '';
  emptyOpt.textContent = '— None —';
  select.appendChild(emptyOpt);

  for (const opt of (field.options || [])) {
    const o = document.createElement('option');
    o.value       = opt;
    o.textContent = opt;
    if (opt === current) o.selected = true;
    select.appendChild(o);
  }

  wrap.appendChild(select);
  select.focus();

  const commit = async () => {
    const val = select.value;
    if (val !== current) {
      if (field.key === 'type') {
        _entity._subtype = val || null;
      } else {
        _entity[field.key] = val || null;
      }
      await _save();
    }
    _renderFieldValue(wrap, field);
  };

  select.addEventListener('blur', commit);
  select.addEventListener('change', () => select.blur());
  select.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { select.value = current; select.blur(); }
  });
}

function _editDate(wrap, field) {
  const current = _entity[field.key] ?? '';
  wrap.innerHTML = '';

  const input = document.createElement('input');
  input.type      = field.type === 'datetime' ? 'datetime-local' : 'date';
  input.className = 'input';
  input.style.cssText = 'padding: var(--space-1) var(--space-2); font-size: var(--text-sm);';

  // Convert ISO to input-friendly format
  if (current) {
    if (field.type === 'datetime') {
      input.value = current.slice(0, 16); // 'YYYY-MM-DDTHH:mm'
    } else {
      input.value = current.slice(0, 10); // 'YYYY-MM-DD'
    }
  }

  wrap.appendChild(input);
  input.focus();

  const commit = async () => {
    const val = input.value;
    const isoVal = val ? (field.type === 'datetime' ? new Date(val).toISOString() : val) : null;
    if (isoVal !== current) {
      _entity[field.key] = isoVal;
      await _save();
    }
    _renderFieldValue(wrap, field);
  };

  input.addEventListener('blur', commit);
  input.addEventListener('change', () => input.blur());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { input.value = current; input.blur(); }
  });
}

function _editTime(wrap, field) {
  // Guard: dueTime requires dueDate — without it the task disappears from calendar
  if (field.key === 'dueTime' && !_entity.dueDate) {
    wrap.innerHTML = '';
    const msg = document.createElement('span');
    msg.style.cssText = 'font-size:var(--text-sm);color:var(--color-warning-text);padding:var(--space-1) var(--space-2);';
    msg.textContent = '⚠ Set a Due Date first';
    wrap.appendChild(msg);
    // Auto-clear after 2.5s
    setTimeout(() => _renderFieldValue(wrap, field), 2500);
    return;
  }

  const current = _entity[field.key] ?? '06:00';
  wrap.innerHTML = '';

  const input = document.createElement('input');
  input.type      = 'time';
  input.className = 'input';
  input.step      = '600'; // 10-minute increments
  input.value     = current.slice(0, 5); // 'HH:MM'
  input.style.cssText = 'padding: var(--space-1) var(--space-2); font-size: var(--text-sm); width: 130px;';
  wrap.appendChild(input);
  input.focus();

  const commit = async () => {
    const val = input.value || '06:00';
    if (val !== current) {
      _entity[field.key] = val;
      // Update _dateTimeISO so calendar immediately reflects the new time
      if (field.key === 'dueTime' && _entity.dueDate) {
        _entity._dateTimeISO = `${_entity.dueDate}T${val}:00`;
      }
      await _save();
    }
    _renderFieldValue(wrap, field);
  };

  input.addEventListener('blur', commit);
  input.addEventListener('change', () => input.blur());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { input.value = current; input.blur(); }
  });
}

function _editRichtext(wrap, field) {
  const current = _entity[field.key] ?? '';
  wrap.innerHTML = '';

  const textarea = document.createElement('textarea');
  textarea.className = 'textarea';
  textarea.value     = current;
  textarea.style.cssText = 'padding: var(--space-2); font-size: var(--text-sm); min-height: 100px; resize: vertical;';
  wrap.appendChild(textarea);
  textarea.focus();

  const commit = async () => {
    const val = textarea.value.trim();
    if (val !== current) {
      _entity[field.key] = val || null;
      await _save();
    }
    _renderFieldValue(wrap, field);
  };

  textarea.addEventListener('blur', commit);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); textarea.value = current; textarea.blur(); }
    // Allow Enter for newlines in richtext — no commit on Enter
  });
}

// ── Relation chips ───────────────────────────────────────── //

async function _renderRelationChips(wrap, field) {
  wrap.innerHTML = '';

  const chipContainer = document.createElement('div');
  chipContainer.style.cssText = 'display: flex; flex-wrap: wrap; gap: var(--space-1); align-items: center;';

  // Get edges from this entity for this relation field
  const edges = await getEdgesFrom(_entity.id, field.key);

  for (const edge of edges) {
    const linked = await getEntity(edge.toId);
    if (!linked) continue;

    const linkedConfig = getEntityTypeConfig(linked.type);
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.style.cssText = 'cursor: pointer; display: inline-flex; align-items: center; gap: var(--space-1);';
    chip.innerHTML = `<span>${linkedConfig?.icon || '📎'}</span> <span>${_getDisplayTitle(linked)}</span>`;

    // Click to navigate — smart: dailyReview → exact date, task → kanban+panel
    chip.addEventListener('click', () => {
      _navigateToLinkedEntity(linked);
    });

    // Remove button
    const removeBtn = document.createElement('span');
    removeBtn.textContent = '×';
    removeBtn.style.cssText = 'cursor: pointer; margin-left: var(--space-1); color: var(--color-text-muted); font-weight: bold;';
    removeBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteEdge(edge.id);
      _renderRelationChips(wrap, field);
    });
    chip.appendChild(removeBtn);

    chipContainer.appendChild(chip);
  }

  // Add button
  const addBtn = document.createElement('button');
  addBtn.className   = 'btn btn-ghost btn-xs';
  addBtn.textContent = '+ Add';
  addBtn.style.cssText = 'font-size: var(--text-xs); padding: var(--space-0-5) var(--space-2);';
  addBtn.addEventListener('click', () => {
    _showRelationPicker(wrap, field);
  });
  chipContainer.appendChild(addBtn);

  wrap.appendChild(chipContainer);
}

// ── Tag chips ────────────────────────────────────────────── //

function _renderTagChips(wrap, field) {
  wrap.innerHTML = '';
  const tags = _entity[field.key] || [];

  const chipContainer = document.createElement('div');
  chipContainer.style.cssText = 'display: flex; flex-wrap: wrap; gap: var(--space-1); align-items: center;';

  for (let i = 0; i < tags.length; i++) {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';

    const text = document.createElement('span');
    text.textContent = tags[i];
    chip.appendChild(text);

    const remove = document.createElement('span');
    remove.textContent = '×';
    remove.style.cssText = 'cursor: pointer; margin-left: var(--space-1); color: var(--color-text-muted); font-weight: bold;';
    const idx = i;
    remove.addEventListener('click', async () => {
      const arr = [...(_entity[field.key] || [])];
      arr.splice(idx, 1);
      _entity[field.key] = arr;
      await _save();
      _renderTagChips(wrap, field);
    });
    chip.appendChild(remove);

    chipContainer.appendChild(chip);
  }

  // Add button
  const addBtn = document.createElement('button');
  addBtn.className   = 'btn btn-ghost btn-xs';
  addBtn.textContent = '+ Tag';
  addBtn.style.cssText = 'font-size: var(--text-xs); padding: var(--space-0-5) var(--space-2);';
  addBtn.addEventListener('click', () => {
    _showTagInput(wrap, field, chipContainer);
  });
  chipContainer.appendChild(addBtn);

  wrap.appendChild(chipContainer);
}

function _showTagInput(wrap, field, chipContainer) {
  // Remove add button temporarily
  const addBtn = chipContainer.querySelector('.btn');
  if (addBtn) addBtn.remove();

  const input = document.createElement('input');
  input.type        = 'text';
  input.className   = 'input';
  input.placeholder = 'Tag name…';
  input.style.cssText = 'width: 100px; padding: var(--space-0-5) var(--space-2); font-size: var(--text-xs);';
  chipContainer.appendChild(input);
  input.focus();

  const commit = async () => {
    const val = input.value.trim();
    if (val) {
      const arr = [...(_entity[field.key] || [])];
      if (!arr.includes(val)) {
        arr.push(val);
        _entity[field.key] = arr;
        await _save();
      }
    }
    _renderTagChips(wrap, field);
  };

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = ''; input.blur(); }
  });
}

// ── Relation picker ──────────────────────────────────────── //

async function _showRelationPicker(wrap, field) {
  wrap.innerHTML = '';

  const picker = document.createElement('div');
  picker.style.cssText = 'display: flex; flex-direction: column; gap: var(--space-2);';

  const input = document.createElement('input');
  input.type        = 'text';
  input.className   = 'input';
  input.placeholder = `Search ${field.relatesTo || 'entity'}…`;
  input.style.cssText = 'padding: var(--space-1-5) var(--space-2); font-size: var(--text-sm);';
  picker.appendChild(input);

  const results = document.createElement('div');
  results.style.cssText = 'max-height: 150px; overflow-y: auto; display: flex; flex-direction: column; gap: var(--space-1);';
  picker.appendChild(results);

  wrap.appendChild(picker);
  input.focus();

  const { getEntitiesByType } = await import('../core/db.js');

  const doSearch = async () => {
    const query   = input.value.toLowerCase().trim();
    const relType = field.relatesTo || null;

    let candidates = [];
    if (relType) {
      candidates = await getEntitiesByType(relType);
    }

    // Filter by search, exclude self, exclude deleted
    const filtered = candidates.filter(e => {
      if (e.id === _entity.id) return false;
      if (e.deleted) return false;
      const t = _getDisplayTitle(e).toLowerCase();
      return !query || t.includes(query);
    }).slice(0, 10);

    results.innerHTML = '';

    if (filtered.length === 0) {
      results.innerHTML = '<div style="font-size: var(--text-xs); color: var(--color-text-muted); padding: var(--space-2);">No results</div>';
      return;
    }

    for (const candidate of filtered) {
      const cfg     = getEntityTypeConfig(candidate.type);

      const item = document.createElement('div');
      item.style.cssText = `
        display: flex; align-items: center; gap: var(--space-2);
        padding: var(--space-1-5) var(--space-2); border-radius: var(--radius-sm);
        cursor: pointer; font-size: var(--text-sm);
        transition: background var(--transition-fast);
      `;
      item.innerHTML = `<span>${cfg?.icon || '📎'}</span> <span>${_getDisplayTitle(candidate)}</span>`;

      item.addEventListener('mouseenter', () => { item.style.background = 'var(--color-surface-2)'; });
      item.addEventListener('mouseleave', () => { item.style.background = 'none'; });

      item.addEventListener('click', async () => {
        // Create edge
        await saveEdge({
          fromId:   _entity.id,
          fromType: _entity.type,
          toId:     candidate.id,
          toType:   candidate.type,
          relation: field.key,
        });
        _renderRelationChips(wrap, field);
      });

      results.appendChild(item);
    }
  };

  // Initial populate
  doSearch();

  input.addEventListener('input', doSearch);

  // Cancel on Escape
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      _renderRelationChips(wrap, field);
    }
  });

  input.addEventListener('blur', () => {
    // Small delay so click on result registers first
    setTimeout(() => {
      if (wrap.contains(picker)) {
        _renderRelationChips(wrap, field);
      }
    }, 200);
  });
}

// ════════════════════════════════════════════════════════════
// RELATIONS TAB
// ════════════════════════════════════════════════════════════

// ── Daily Review link system ──────────────────────────────────
// Entities with temporal dates auto-link to their Daily Review entity.

/**
 * Format a YYYY-MM-DD dateStr to MM-DD-YYYY for display.
 * e.g. '2026-04-20' → '04-20-2026'
 */
function _formatDateForTitle(dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  const [y, m, d] = dateStr.split('-');
  return `${m}-${d}-${y}`;
}

/**
 * Find or create the Daily Review entity (type:'dailyReview') for a date.
 * @param {string} dateStr  — 'YYYY-MM-DD'
 * @returns {Promise<object>} the dailyReview entity
 */
async function _getOrCreateDailyReview(dateStr) {
  if (!dateStr) return null;
  try {
    const existing = await getEntitiesByType('dailyReview');
    const found = existing.find(dr => dr.date === dateStr && !dr.deleted);
    if (found) return found;
    return await saveEntity({
      type:  'dailyReview',
      title: `Daily Review — ${_formatDateForTitle(dateStr)}`,
      date:  dateStr,
    });
  } catch (err) {
    console.warn('[entity-panel] _getOrCreateDailyReview failed:', dateStr, err);
    return null;
  }
}

/**
 * Ensure the entity is linked to Daily Review entities for its temporal dates.
 * Idempotent — checks existing edges before creating. Non-blocking.
 * @param {object} entity
 */
async function _ensureDailyLinks(entity) {
  if (!entity?.id || !entity?.type) return;

  // Skip types that are containers or lack temporal meaning
  const SKIP_TYPES = new Set(['dailyReview', 'tag', 'note', 'budgetEntry', 'person',
                               'project', 'contact', 'place', 'weblink', 'recipe',
                               'medication', 'shoppingItem', 'habit', 'goal']);
  if (SKIP_TYPES.has(entity.type)) return;

  const datesToLink = new Set();

  // Each type uses its canonical date ONLY — never mix createdAt with dedicated date fields
  switch (entity.type) {
    case 'task':
      // Tasks link ONLY to their due date
      if (entity.dueDate) { const d = _isoToLocalDate(entity.dueDate); if (d) datesToLink.add(d); }
      break;

    case 'event': {
      // Events link to every date they span (startDate through endDate inclusive)
      const startD = _isoToLocalDate(entity.date);
      const endD   = _isoToLocalDate(entity.endDate);
      if (startD) {
        datesToLink.add(startD);
        if (endD && endD > startD) {
          let cur = new Date(startD + 'T00:00:00');
          const stop = new Date(endD + 'T00:00:00');
          let safety = 0;
          while (cur <= stop && safety++ < 90) {
            const y = cur.getFullYear();
            const m = String(cur.getMonth() + 1).padStart(2, '0');
            const dy = String(cur.getDate()).padStart(2, '0');
            datesToLink.add(`${y}-${m}-${dy}`);
            cur.setDate(cur.getDate() + 1);
          }
        }
      }
      break;
    }

    case 'appointment':
    case 'dateEntity':
    case 'mealPlan':
      if (entity.date) { const d = _isoToLocalDate(entity.date); if (d) datesToLink.add(d); }
      break;

    case 'trip':
      if (entity.startDate) { const d = _isoToLocalDate(entity.startDate); if (d) datesToLink.add(d); }
      break;

    default:
      // Other types (idea, research, post, book, etc.) use createdAt
      if (entity.createdAt) { const d = _isoToLocalDate(entity.createdAt); if (d) datesToLink.add(d); }
      break;
  }

  if (datesToLink.size === 0) return;

  const existingEdges = await getEdgesFrom(entity.id, 'in daily review');
  const linkedIds = new Set(existingEdges.map(e => e.toId));

  for (const dateStr of datesToLink) {
    try {
      const dr = await _getOrCreateDailyReview(dateStr);
      if (!dr || linkedIds.has(dr.id)) continue;
      await saveEdge({
        fromId:   entity.id,
        fromType: entity.type,
        toId:     dr.id,
        toType:   'dailyReview',
        relation: 'in daily review',
      });
    } catch (err) {
      console.warn('[entity-panel] _ensureDailyLinks failed for date:', dateStr, err);
    }
  }
}

/** Parse ISO string or date-only string to local YYYY-MM-DD */
function _isoToLocalDate(isoStr) {
  if (!isoStr) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(isoStr)) return isoStr;
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dy = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dy}`;
}

// ── Relations Tab — comprehensive connection system ───────────

async function _renderRelationsTab(container) {
  if (!_entity) return;

  container.innerHTML = '';

  // Run daily linking silently in background
  _ensureDailyLinks(_entity).catch(() => {});

  // ── Section: Add New Connection ────────────────────────────
  const addSection = document.createElement('div');
  addSection.style.cssText = 'border-bottom: 1px solid var(--color-border); padding-bottom: var(--space-4); margin-bottom: var(--space-4);';
  container.appendChild(addSection);

  const addHeader = document.createElement('div');
  addHeader.style.cssText = 'font-size: var(--text-xs); font-weight: var(--weight-semibold); color: var(--color-text-muted); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: var(--space-2);';
  addHeader.textContent = '＋ Add Connection';
  addSection.appendChild(addHeader);

  // Relation type selector + search bar row
  const addRow = document.createElement('div');
  addRow.style.cssText = 'display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap;';
  addSection.appendChild(addRow);

  // Relation label input
  const relationInput = document.createElement('input');
  relationInput.type = 'text';
  relationInput.className = 'input';
  relationInput.placeholder = 'Relation label (e.g. "related to")';
  relationInput.value = 'related to';
  relationInput.style.cssText = 'width: 160px; font-size: var(--text-xs); padding: var(--space-1-5) var(--space-2);';
  addRow.appendChild(relationInput);

  // Quick relation presets
  const presets = ['related to', 'part of', 'blocked by', 'assigned to', 'daily review', 'belongs to', 'see also'];
  const presetRow = document.createElement('div');
  presetRow.style.cssText = 'display: flex; flex-wrap: wrap; gap: var(--space-1); margin-top: var(--space-1-5);';
  for (const p of presets) {
    const chip = document.createElement('button');
    chip.textContent = p;
    chip.style.cssText = `
      font-size: 10px; padding: 2px 8px; border-radius: 99px;
      border: 1px solid var(--color-border); background: var(--color-surface);
      color: var(--color-text-muted); cursor: pointer;
      transition: all 0.12s ease;
    `;
    chip.addEventListener('click', () => {
      relationInput.value = p;
      chip.style.background = 'var(--color-accent)';
      chip.style.color = '#fff';
      chip.style.borderColor = 'var(--color-accent)';
      // Reset siblings
      presetRow.querySelectorAll('button').forEach(b => {
        if (b !== chip) { b.style.background = ''; b.style.color = ''; b.style.borderColor = ''; }
      });
    });
    presetRow.appendChild(chip);
  }
  addSection.appendChild(presetRow);

  // ── Live search box ───────────────────────────────────────
  const searchWrap = document.createElement('div');
  searchWrap.style.cssText = 'position: relative; margin-top: var(--space-2);';
  addSection.appendChild(searchWrap);

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'input';
  searchInput.placeholder = '🔍 Search all entities — type to filter…';
  searchInput.setAttribute('aria-label', 'Search entities to link');
  searchInput.style.cssText = 'width: 100%; font-size: var(--text-sm); padding: var(--space-2) var(--space-3);';
  searchWrap.appendChild(searchInput);

  const resultsList = document.createElement('div');
  resultsList.style.cssText = `
    display: none;
    position: absolute; top: 100%; left: 0; right: 0; z-index: 100;
    background: var(--color-bg); border: 1px solid var(--color-border);
    border-radius: var(--radius-md); box-shadow: var(--shadow-panel);
    max-height: 320px; overflow-y: auto;
    margin-top: 2px;
  `;
  searchWrap.appendChild(resultsList);

  // Load ALL entities sorted by updatedAt desc (most recent first)
  let _allEntities = [];
  let _searchDebounce = null;

  const loadAllEntities = async () => {
    try {
      const allTypes = getAllEntityTypes();
      const arrays = await Promise.all(allTypes.map(t => getEntitiesByType(t.key).catch(() => [])));
      _allEntities = arrays.flat()
        .filter(e => !e.deleted && e.id !== _entity.id)
        .sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''));
    } catch (err) {
      console.warn('[entity-panel] loadAllEntities failed:', err);
    }
  };

  await loadAllEntities();

  // Get set of already-linked entity IDs
  const getLinkedIds = async () => {
    const [out, inc] = await Promise.all([
      getEdgesFrom(_entity.id),
      getEdgesTo(_entity.id),
    ]);
    return new Set([...out.map(e => e.toId), ...inc.map(e => e.fromId)]);
  };

  let _linkedIds = await getLinkedIds();

  const renderSearchResults = (query) => {
    resultsList.innerHTML = '';
    const q = query.trim().toLowerCase();

    let candidates = _allEntities;
    if (q) {
      candidates = _allEntities.filter(e => {
        const title = _getDisplayTitle(e).toLowerCase();
        const type  = (e.type || '').toLowerCase();
        return title.includes(q) || type.includes(q);
      });
    }

    // Cap at 40 results
    const results = candidates.slice(0, 40);

    if (results.length === 0) {
      resultsList.innerHTML = `<div style="padding: var(--space-3); font-size: var(--text-xs); color: var(--color-text-muted); text-align: center;">No entities found${q ? ` matching "${q}"` : ''}</div>`;
      resultsList.style.display = 'block';
      return;
    }

    for (const ent of results) {
      const cfg      = getEntityTypeConfig(ent.type);
      const title    = _getDisplayTitle(ent);
      const isLinked = _linkedIds.has(ent.id);

      const item = document.createElement('div');
      item.style.cssText = `
        display: flex; align-items: center; gap: var(--space-2);
        padding: var(--space-2) var(--space-3); cursor: pointer;
        transition: background 0.1s; border-bottom: 1px solid var(--color-border);
        ${isLinked ? 'opacity: 0.45;' : ''}
      `;

      const timeAgo = _relativeTime(ent.updatedAt || ent.createdAt);

      item.innerHTML = `
        <span style="font-size: 1rem; flex-shrink: 0;">${cfg?.icon || '📎'}</span>
        <div style="flex: 1; min-width: 0;">
          <div style="font-size: var(--text-sm); font-weight: var(--weight-medium); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${_escHtml(title)}</div>
          <div style="font-size: 10px; color: var(--color-text-muted);">${_escHtml(cfg?.label || ent.type)} · ${_escHtml(timeAgo)}</div>
        </div>
        <span style="font-size: 10px; padding: 2px 6px; border-radius: 99px; background: ${cfg?.color || '#94a3b8'}22; color: ${cfg?.color || '#94a3b8'}; font-weight: 600; flex-shrink: 0;">${isLinked ? '✓ linked' : '+ link'}</span>
      `;

      item.addEventListener('mouseenter', () => { if (!isLinked) item.style.background = 'var(--color-surface)'; });
      item.addEventListener('mouseleave', () => { item.style.background = ''; });

      item.addEventListener('click', async () => {
        if (isLinked) return;
        try {
          const relation = relationInput.value.trim() || 'related to';
          await saveEdge({
            fromId:   _entity.id,
            fromType: _entity.type,
            toId:     ent.id,
            toType:   ent.type,
            relation,
          });
          _linkedIds.add(ent.id);
          // Mark as linked in result
          item.style.opacity = '0.45';
          const pill = item.querySelector('span:last-child');
          if (pill) { pill.textContent = '✓ linked'; }
          // Refresh connections list
          await _renderConnectionsList(connContainer);
        } catch (err) {
          console.error('[entity-panel] saveEdge failed:', err);
        }
      });

      resultsList.appendChild(item);
    }

    resultsList.style.display = 'block';
  };

  searchInput.addEventListener('focus', () => {
    renderSearchResults(searchInput.value);
  });

  searchInput.addEventListener('input', () => {
    clearTimeout(_searchDebounce);
    _searchDebounce = setTimeout(() => renderSearchResults(searchInput.value), 120);
  });

  // Close results on click outside — store ref so we can remove it
  const _closeResultsOnOutsideClick = (e) => {
    if (!searchWrap.contains(e.target)) {
      resultsList.style.display = 'none';
    }
  };
  document.addEventListener('click', _closeResultsOnOutsideClick);

  // Clean up when the panel body is replaced (next tab switch or close)
  const _cleanupRelationsTab = () => {
    document.removeEventListener('click', _closeResultsOnOutsideClick);
  };
  // Use a MutationObserver to detect when searchWrap is removed from DOM
  const _relObserver = new MutationObserver(() => {
    if (!document.contains(searchWrap)) {
      _cleanupRelationsTab();
      _relObserver.disconnect();
    }
  });
  _relObserver.observe(document.body, { childList: true, subtree: true });

  // ── Existing connections list ──────────────────────────────
  const connHeader = document.createElement('div');
  connHeader.style.cssText = 'font-size: var(--text-xs); font-weight: var(--weight-semibold); color: var(--color-text-muted); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: var(--space-2);';
  connHeader.textContent = 'Connections';
  container.appendChild(connHeader);

  const connContainer = document.createElement('div');
  container.appendChild(connContainer);

  await _renderConnectionsList(connContainer);
}

/**
 * Render the list of all existing connections for _entity,
 * grouped by relation label, sorted most-recent-first.
 * Each row has: icon · title · type badge · direction · remove button
 */
async function _renderConnectionsList(container) {
  if (!_entity) return;

  container.innerHTML = '<div style="font-size: var(--text-xs); color: var(--color-text-muted); padding: var(--space-2);">Loading…</div>';

  try {
    const [outgoing, incoming] = await Promise.all([
      getEdgesFrom(_entity.id),
      getEdgesTo(_entity.id),
    ]);

    // Resolve all linked entities and sort by updatedAt desc
    const items = [];

    for (const edge of outgoing) {
      const linked = await getEntity(edge.toId);
      if (!linked || linked.deleted) continue;
      items.push({ edge, linked, direction: 'out', sortKey: linked.updatedAt || linked.createdAt || '' });
    }
    for (const edge of incoming) {
      const linked = await getEntity(edge.fromId);
      if (!linked || linked.deleted) continue;
      items.push({ edge, linked, direction: 'in', sortKey: linked.updatedAt || linked.createdAt || '' });
    }

    // Sort by most recent first
    items.sort((a, b) => b.sortKey.localeCompare(a.sortKey));

    container.innerHTML = '';

    if (items.length === 0) {
      container.innerHTML = `
        <div style="padding: var(--space-6) var(--space-2); text-align: center; color: var(--color-text-muted); font-size: var(--text-sm);">
          <div style="font-size: 2rem; margin-bottom: var(--space-2);">🔗</div>
          <div>No connections yet</div>
          <div style="font-size: var(--text-xs); margin-top: var(--space-1);">Search above to add connections</div>
        </div>
      `;
      return;
    }

    // Group by relation label
    const groups = new Map();
    for (const item of items) {
      const relation = item.edge.relation || 'related to';
      const dir      = item.direction === 'out' ? '→' : '←';
      const key      = `${dir} ${relation}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }

    for (const [groupLabel, groupItems] of groups) {
      const section = document.createElement('div');
      section.style.cssText = 'margin-bottom: var(--space-3);';

      const header = document.createElement('div');
      header.style.cssText = `
        font-size: 10px; font-weight: var(--weight-semibold);
        color: var(--color-text-muted); text-transform: uppercase;
        letter-spacing: 0.05em; padding: var(--space-1) 0 var(--space-1);
        border-bottom: 1px solid var(--color-border); margin-bottom: var(--space-1);
        display: flex; align-items: center; justify-content: space-between;
      `;
      header.innerHTML = `
        <span>${_escHtml(groupLabel)}</span>
        <span style="font-weight:400; text-transform:none; letter-spacing:0;">${groupItems.length} item${groupItems.length !== 1 ? 's' : ''}</span>
      `;
      section.appendChild(header);

      for (const { edge, linked, direction } of groupItems) {
        const cfg      = getEntityTypeConfig(linked.type);
        const title    = _getDisplayTitle(linked);
        const timeAgo  = _relativeTime(linked.updatedAt || linked.createdAt);

        const row = document.createElement('div');
        row.dataset.edgeId = edge.id;
        row.style.cssText = `
          display: flex; align-items: center; gap: var(--space-2);
          padding: var(--space-2) var(--space-1-5);
          border-radius: var(--radius-sm);
          transition: background var(--transition-fast);
          cursor: pointer;
        `;

        const dirArrow = direction === 'out'
          ? `<span style="color: var(--color-accent); font-size: 10px; flex-shrink:0;">→</span>`
          : `<span style="color: var(--color-text-muted); font-size: 10px; flex-shrink:0;">←</span>`;

        row.innerHTML = `
          ${dirArrow}
          <span style="font-size: 1rem; flex-shrink: 0;">${cfg?.icon || '📎'}</span>
          <div style="flex: 1; min-width: 0;">
            <div style="font-size: var(--text-sm); font-weight: var(--weight-medium); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${_escHtml(title)}</div>
            <div style="font-size: 10px; color: var(--color-text-muted);">${_escHtml(cfg?.label || linked.type)} · ${_escHtml(timeAgo)}</div>
          </div>
          <span class="type-badge" style="background: ${cfg?.color || '#94a3b8'}; font-size: 9px; padding: 1px 6px; flex-shrink:0;">${_escHtml(cfg?.label || linked.type)}</span>
          <button class="rel-remove-btn" title="Remove connection" style="
            background: none; border: none; cursor: pointer; padding: 2px 4px;
            color: var(--color-text-muted); font-size: 0.85rem; border-radius: var(--radius-sm);
            flex-shrink: 0; line-height: 1; opacity: 0.5; transition: opacity 0.1s, color 0.1s;
          ">✕</button>
        `;

        row.addEventListener('mouseenter', () => {
          row.style.background = 'var(--color-surface-2)';
          row.querySelector('.rel-remove-btn').style.opacity = '1';
        });
        row.addEventListener('mouseleave', () => {
          row.style.background = '';
          row.querySelector('.rel-remove-btn').style.opacity = '0.5';
        });

        // Click row → smart navigation based on linked entity type
        row.addEventListener('click', (e) => {
          if (e.target.classList.contains('rel-remove-btn')) return;
          _navigateToLinkedEntity(linked);
        });

        // Remove button
        row.querySelector('.rel-remove-btn').addEventListener('click', async (e) => {
          e.stopPropagation();
          row.querySelector('.rel-remove-btn').style.color = 'var(--color-danger)';
          try {
            await deleteEdge(edge.id);
            row.style.opacity = '0';
            row.style.transition = 'opacity 0.2s';
            setTimeout(() => {
              row.remove();
              // Update group count
              const remaining = section.querySelectorAll('[data-edge-id]').length;
              if (remaining === 0) section.remove();
              else header.querySelector('span:last-child').textContent =
                `${remaining} item${remaining !== 1 ? 's' : ''}`;
            }, 220);
          } catch (err) {
            console.error('[entity-panel] deleteEdge failed:', err);
          }
        });

        section.appendChild(row);
      }

      container.appendChild(section);
    }

    // Total count at bottom
    const total = document.createElement('div');
    total.style.cssText = 'font-size: 10px; color: var(--color-text-muted); text-align: center; padding: var(--space-2); margin-top: var(--space-1);';
    total.textContent = `${items.length} total connection${items.length !== 1 ? 's' : ''}`;
    container.appendChild(total);

  } catch (err) {
    console.error('[entity-panel] _renderConnectionsList failed:', err);
    container.innerHTML = '<div style="color: var(--color-danger); font-size: var(--text-sm); padding: var(--space-3);">Failed to load connections.</div>';
  }
}

/**
 * Smart navigation when a linked entity is clicked in the Relations tab.
 * - dailyReview  → navigate to that specific date in Daily Review view
 * - task         → navigate to Kanban and open the task panel
 * - anything else → just open the entity panel
 * @param {object} linked  the linked entity object (must have .id, .type, .date)
 */
function _navigateToLinkedEntity(linked) {
  if (!linked) return;

  if (linked.type === 'dailyReview' && linked.date) {
    // Navigate to that specific date in the Daily Review view
    navigate('daily', { date: linked.date }, `Daily Review — ${_formatDateForTitle(linked.date)}`);
    return;
  }

  if (linked.type === 'task') {
    // Navigate to Kanban view, then open the task panel
    navigate('kanban', {}, 'Tasks');
    setTimeout(() => openPanel(linked.id), 150);
    return;
  }

  if (linked.type === 'event' || linked.type === 'appointment') {
    navigate('calendar', {}, 'Calendar');
    setTimeout(() => openPanel(linked.id), 150);
    return;
  }

  // Default: just open the entity panel
  openPanel(linked.id);
}

/** Human-readable relative time: "2h ago", "3 days ago", "just now" */
function _relativeTime(isoStr) {
  if (!isoStr) return '';
  try {
    const diff = Date.now() - new Date(isoStr).getTime();
    const s = Math.floor(diff / 1000);
    if (s < 60)     return 'just now';
    if (s < 3600)   return `${Math.floor(s / 60)}m ago`;
    if (s < 86400)  return `${Math.floor(s / 3600)}h ago`;
    if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
    return new Date(isoStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch { return ''; }
}

/** HTML escape helper */
function _escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ════════════════════════════════════════════════════════════
// ACTIVITY TAB
// ════════════════════════════════════════════════════════════

async function _renderActivityTab(container) {
  if (!_entity) return;

  container.innerHTML = '<div style="font-size: var(--text-xs); color: var(--color-text-muted); padding: var(--space-2);">Loading activity…</div>';

  try {
    const [rec, authData] = await Promise.all([
      getSetting('auditLog'),
      getSetting('auth'),
    ]);
    const log = Array.isArray(rec) ? rec : [];

    // Build accountId → display name map via memberId → person entity
    const accountMap = new Map();
    for (const acct of (authData?.accounts || [])) {
      if (acct.memberId) {
        const person = await getEntity(acct.memberId);
        accountMap.set(acct.id, person?.name || person?.title || acct.username || acct.id);
      } else {
        accountMap.set(acct.id, acct.username || acct.id);
      }
    }

    // Filter to this entity, newest first
    const entries = log
      .filter(e => e.entityId === _entity.id)
      .reverse()
      .slice(0, 50);

    container.innerHTML = '';

    if (entries.length === 0) {
      container.innerHTML = `
        <div class="empty-state" style="padding: var(--space-8);">
          <div class="empty-state-icon">📋</div>
          <div class="empty-state-title">No activity yet</div>
          <div class="empty-state-desc">Changes to this ${_config.label.toLowerCase()} will appear here.</div>
        </div>
      `;
      return;
    }

    const list = document.createElement('div');
    list.style.cssText = 'display: flex; flex-direction: column; gap: var(--space-1);';

    for (const entry of entries) {
      const item = document.createElement('div');
      item.style.cssText = `
        display: flex; flex-direction: column; gap: var(--space-1); padding: var(--space-2);
        border-bottom: 1px solid color-mix(in srgb, var(--color-border) 50%, transparent);
        font-size: var(--text-xs);
      `;

      const icon = entry.action === 'create' ? '✨'
                 : entry.action === 'delete' ? '🗑️'
                 : entry.action === 'link'   ? '🔗'
                 : entry.action === 'unlink' ? '🔓'
                 : '✏️';

      // Resolve old/new values — if they look like entity IDs, try to fetch display names
      let oldDisplay = entry.oldValue != null ? String(entry.oldValue) : null;
      let newDisplay = entry.newValue != null ? String(entry.newValue) : null;

      // Resolve old/new values — if they look like entity IDs, try to fetch display names
      // An ID is any value: length > 8, no spaces, not a date/number/boolean
      const _looksLikeId = (v) => v && v.length > 8 && !v.includes(' ') &&
        !/^\d{4}-\d{2}-\d{2}/.test(v) && isNaN(Number(v));

      if (_looksLikeId(oldDisplay)) {
        const resolved = await getEntity(oldDisplay).catch(() => null);
        if (resolved) oldDisplay = resolved.name || resolved.title || oldDisplay;
      }
      if (_looksLikeId(newDisplay)) {
        const resolved = await getEntity(newDisplay).catch(() => null);
        if (resolved) newDisplay = resolved.name || resolved.title || newDisplay;
      }

      let desc = `${icon} ${_capitalize(entry.action || 'updated')}`;
      if (entry.field) {
        desc += ` — ${entry.field}`;
        if (oldDisplay != null || newDisplay != null) {
          const old = oldDisplay != null ? `"${_truncate(oldDisplay, 25)}"` : 'empty';
          const nw  = newDisplay != null ? `"${_truncate(newDisplay, 25)}"` : 'empty';
          desc += `: ${old} → ${nw}`;
        }
      }

      // Resolve byAccountId to display name
      const byName = entry.byAccountId ? accountMap.get(entry.byAccountId) : null;

      const topRow = document.createElement('div');
      topRow.style.cssText = 'display: flex; gap: var(--space-2); align-items: flex-start;';
      topRow.innerHTML = `
        <div style="flex: 1; color: var(--color-text);">${desc}</div>
        <div style="flex-shrink: 0; color: var(--color-text-muted); white-space: nowrap;">${_formatDateShort(entry.at)}</div>
      `;
      item.appendChild(topRow);

      if (byName) {
        const byRow = document.createElement('div');
        byRow.style.cssText = 'color: var(--color-text-muted); font-size: var(--text-xs); padding-left: var(--space-1);';
        byRow.textContent = `by ${byName}`;
        item.appendChild(byRow);
      }

      list.appendChild(item);
    }

    container.appendChild(list);

  } catch (err) {
    console.error('[entity-panel] Activity tab error:', err);
    container.innerHTML = '<div style="color: var(--color-danger); font-size: var(--text-sm); padding: var(--space-4);">Failed to load activity.</div>';
  }
}

// ════════════════════════════════════════════════════════════
// GRAPH VIEW — side-by-side: graph (left) + entity panel (right)
// ════════════════════════════════════════════════════════════

/**
 * Open the full side-by-side graph view.
 * Graph canvas fills #view-graph (left), entity panel stays open (right).
 * Single-click a node → update panel to that entity.
 * Double-click a node → drill focus + update panel.
 * "Exit Graph" button → close graph, return to previous view.
 */
async function _openGraphView(entityId) {
  if (!entityId) return;

  const main    = document.getElementById('main');
  const viewEl  = document.getElementById('view-graph');
  if (!main || !viewEl) return;

  // ── Remember current view so we can restore on exit ─────
  const currentActiveView = document.querySelector('.view.active');
  _graphPreviousView = currentActiveView?.id?.replace('view-', '') || 'kanban';

  // ── Hide all views, show graph view ─────────────────────
  document.querySelectorAll('.view').forEach(el => {
    el.classList.remove('active');
    el.setAttribute('aria-hidden', 'true');
  });
  viewEl.classList.add('active');
  viewEl.setAttribute('aria-hidden', 'false');
  main.classList.add('graph-active');

  // ── Build the graph view DOM ────────────────────────────
  viewEl.innerHTML = '';

  // Graph canvas column (fills the main area)
  const graphCol = document.createElement('div');
  graphCol.id = 'graph-canvas-column';
  graphCol.style.cssText = `
    position: relative;
    grid-column: 1 / -1;
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    background: var(--color-surface);
  `;

  // ── Toolbar ─────────────────────────────────────────────
  const toolbar = document.createElement('div');
  toolbar.style.cssText = `
    display: flex; align-items: center; gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--color-border);
    background: var(--color-bg);
    flex-shrink: 0;
    z-index: 2;
  `;

  // Title
  const titleEl = document.createElement('span');
  titleEl.id = 'graph-view-title';
  titleEl.style.cssText = 'font-family: var(--font-heading); font-size: var(--text-sm); font-weight: var(--weight-semibold); white-space: nowrap;';
  titleEl.textContent = '🔮 Knowledge Graph';
  toolbar.appendChild(titleEl);

  // Spacer
  const spacer = document.createElement('span');
  spacer.style.flex = '1';
  toolbar.appendChild(spacer);

  // Hint (short)
  const hintEl = document.createElement('span');
  hintEl.style.cssText = 'font-size: 10px; color: var(--color-text-muted); white-space: nowrap;';
  hintEl.textContent = 'Click: select · Dbl-click: drill · Scroll: zoom';
  toolbar.appendChild(hintEl);

  // Exit button — prominent, always visible
  const exitBtn = document.createElement('button');
  exitBtn.className = 'btn btn-sm';
  exitBtn.style.cssText = `
    display: flex; align-items: center; gap: var(--space-1); flex-shrink: 0;
    background: var(--color-danger); color: #fff; border: none;
    padding: var(--space-1) var(--space-3); border-radius: var(--radius-sm);
    font-size: var(--text-xs); font-weight: 600; cursor: pointer;
  `;
  exitBtn.innerHTML = '✕ Exit Graph';
  exitBtn.addEventListener('click', _closeGraphView);
  toolbar.appendChild(exitBtn);

  graphCol.appendChild(toolbar);

  // ── Type filter toggles row ─────────────────────────────
  const filterRow = document.createElement('div');
  filterRow.id = 'graph-type-filters';
  filterRow.style.cssText = `
    display: flex; align-items: center; gap: var(--space-1-5);
    padding: var(--space-1-5) var(--space-3);
    border-bottom: 1px solid var(--color-border);
    background: var(--color-bg);
    flex-shrink: 0;
    flex-wrap: wrap;
    z-index: 2;
  `;
  const filterLabel = document.createElement('span');
  filterLabel.style.cssText = 'font-size: 10px; color: var(--color-text-muted); margin-right: var(--space-1);';
  filterLabel.textContent = 'Filter:';
  filterRow.appendChild(filterLabel);
  // Filter chips are populated after graph builds (see _buildGraphTypeFilters)
  graphCol.appendChild(filterRow);

  // ── Canvas ──────────────────────────────────────────────
  const canvasWrap = document.createElement('div');
  canvasWrap.style.cssText = 'flex: 1; position: relative; overflow: hidden;';

  const canvas = document.createElement('canvas');
  canvas.id = 'graph-main-canvas';
  canvas.style.cssText = 'display: block; width: 100%; height: 100%;';
  canvasWrap.appendChild(canvas);
  graphCol.appendChild(canvasWrap);

  viewEl.appendChild(graphCol);

  // ── Ensure entity panel is open ─────────────────────────
  _graphViewActive = true;
  // Mark panel as graph-mode so CSS positions it in the grid column
  if (_panel) _panel.classList.add('graph-mode');
  await openPanel(entityId);

  // ── Force panel to properties tab in graph mode ─────────
  _activeTab = 'properties';
  _renderActiveTab();

  // ── Launch graph canvas ─────────────────────────────────
  // Small delay to ensure canvas has layout dimensions
  await new Promise(r => setTimeout(r, 50));

  await initGraph(canvas, {
    mini: false,
    focusEntityId: entityId,
  });

  // ── Populate type filter toggles ─────────────────────────
  _buildGraphTypeFilters();

  console.log('[entity-panel] [minor] Graph view opened for', entityId);
}

/**
 * Close the side-by-side graph view, restore previous view.
 */
function _closeGraphView() {
  destroyGraph();
  _graphViewActive = false;

  // Remove graph-mode panel class so it returns to modal behavior
  if (_panel) _panel.classList.remove('graph-mode');

  const main   = document.getElementById('main');
  const viewEl = document.getElementById('view-graph');
  if (main)   main.classList.remove('graph-active');
  if (viewEl) {
    viewEl.classList.remove('active');
    viewEl.setAttribute('aria-hidden', 'true');
    viewEl.innerHTML = '';
  }

  // Restore previous view
  const prevViewEl = document.getElementById('view-' + (_graphPreviousView || 'kanban'));
  if (prevViewEl) {
    prevViewEl.classList.add('active');
    prevViewEl.setAttribute('aria-hidden', 'false');
  }

  // Update sidebar active state
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.view === _graphPreviousView);
  });

  _graphPreviousView = null;
  closePanel();

  console.log('[entity-panel] [minor] Graph view closed.');
}

/**
 * Build entity type filter toggle chips in the graph toolbar.
 * ONLY shows types that are actually present as nodes in the current graph —
 * not all types in the DB. Uses getActiveNodeTypes() from graph-canvas.
 */
function _buildGraphTypeFilters() {
  const filterRow = document.getElementById('graph-type-filters');
  if (!filterRow) return;

  // Remove old chips (keep the "Filter:" label)
  filterRow.querySelectorAll('.graph-filter-chip').forEach(c => c.remove());

  // Get types currently in the graph (not all types in DB)
  const presentTypes = getActiveNodeTypes(); // Set<string> of type keys in _nodes
  if (presentTypes.size === 0) return;

  const allTypes = getAllEntityTypes();
  const typesInGraph = allTypes.filter(cfg => presentTypes.has(cfg.key));

  // Initialize filters — all types ON
  _graphTypeFilters = new Set(typesInGraph.map(c => c.key));

  for (const cfg of typesInGraph) {
    const chip = document.createElement('button');
    chip.className = 'graph-filter-chip';
    chip.dataset.typeKey = cfg.key;
    chip.style.cssText = `
      display: inline-flex; align-items: center; gap: 3px;
      padding: 2px 8px; border-radius: 99px;
      font-size: 10px; cursor: pointer;
      border: 1.5px solid ${cfg.color};
      background: ${cfg.color}22;
      color: ${cfg.color};
      font-weight: 600;
      transition: all 0.15s ease;
      line-height: 1.4;
    `;
    chip.textContent = `${cfg.icon} ${cfg.labelPlural || cfg.label}`;
    chip.title = `Toggle ${cfg.labelPlural || cfg.label}`;

    const setActive = (active) => {
      if (active) {
        chip.style.background = cfg.color + '22';
        chip.style.color = cfg.color;
        chip.style.borderColor = cfg.color;
        chip.style.opacity = '1';
      } else {
        chip.style.background = 'transparent';
        chip.style.color = 'var(--color-text-muted)';
        chip.style.borderColor = 'var(--color-border)';
        chip.style.opacity = '0.5';
      }
    };
    setActive(true);

    chip.addEventListener('click', () => {
      const isOn = _graphTypeFilters.has(cfg.key);
      if (isOn && _graphTypeFilters.size <= 1) return; // can't turn off last
      if (isOn) _graphTypeFilters.delete(cfg.key);
      else      _graphTypeFilters.add(cfg.key);
      setActive(!isOn);
      setActiveTypes(new Set(_graphTypeFilters));
    });

    filterRow.appendChild(chip);
  }
}


/**
 * When a node is single-clicked in graph mode, update the panel to show
 * that entity's properties — but do NOT drill down or navigate away.
 */
/**
 * Single-click on graph node → update panel to show that entity.
 */
function _handleGraphNodeSelected(id) {
  if (!_graphViewActive || !id) return;
  openPanel(id).then(() => {
    _activeTab = 'properties';
    _renderActiveTab();
  });
}

/**
 * Double-click on graph node → toggle panel detail:
 * - Panel closed or showing different entity → open/replace with this entity
 * - Panel showing THIS entity → clear panel content (stay in graph mode)
 */
function _handleGraphNodeFocused(id) {
  if (!_graphViewActive || !id) return;

  const panelIsOpen = _panel?.classList.contains('open');
  const sameEntity  = panelIsOpen && _entity?.id === id;

  if (sameEntity) {
    // Collapse panel content but stay in graph mode — clear body, keep panel visible
    _entity = null;
    _config = null;
    if (_panelBody) _panelBody.innerHTML = '';
    const headerEl = document.getElementById('entity-panel-header');
    if (headerEl) headerEl.innerHTML = '';
    // Keep .open and .graph-mode classes intact — panel column stays in layout
  } else {
    openPanel(id).then(() => {
      _activeTab = 'properties';
      _renderActiveTab();
    });
  }
}


// ════════════════════════════════════════════════════════════
// DELETE CONFIRMATION
// ════════════════════════════════════════════════════════════

async function _confirmDelete() {
  if (!_entity) return;

  const confirmed = confirm(`Delete this ${_config?.label || 'entity'}? This action cannot be undone.`);
  if (!confirmed) return;

  try {
    await deleteEntity(_entity.id);
    closePanel();
  } catch (err) {
    console.error('[entity-panel] Delete failed:', err);
  }
}

// ════════════════════════════════════════════════════════════
// SAVE
// ════════════════════════════════════════════════════════════

async function _save() {
  if (!_entity || _saving) return;
  _saving = true;

  // Show saving indicator
  if (_savingIndicator) _savingIndicator.classList.remove('hidden');

  try {
    // GUARD: If the entity has a field named 'type' that overwrote the structural
    // entity type (e.g. appointment subtype "Medical" replaced "appointment"),
    // restore the correct structural type from _config.
    if (_config && _entity.type !== _config.key) {
      _entity._subtype = _entity.type;
      _entity.type = _config.key;
    }
    _entity = await saveEntity(_entity);
  } catch (err) {
    console.error('[entity-panel] Save failed:', err);
  } finally {
    _saving = false;
    if (_savingIndicator) _savingIndicator.classList.add('hidden');
  }
}

// ════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════

/**
 * Navigate to the native view for an entity type, then open the entity panel.
 * e.g. task → kanban, note → notes, event → calendar, idea → entity-type/idea
 */
function _navigateToEntityView(entity, config) {
  if (!entity || !config) return;

  // Close graph view if active
  if (_graphViewActive) _closeGraphView();

  const viewPath = TYPE_VIEW_MAP[entity.type];
  if (!viewPath) return;

  // dailyReview: navigate to that specific date, not just the daily view home
  if (entity.type === 'dailyReview' && entity.date) {
    navigate('daily', { date: entity.date },
      `Daily Review — ${_formatDateForTitle(entity.date)}`);
    return;
  }

  if (viewPath.startsWith('entity-type/')) {
    const typeKey = viewPath.split('/')[1];
    navigate(VIEW_KEYS.ENTITY_TYPE, { entityType: typeKey }, config.labelPlural || config.label);
  } else {
    navigate(viewPath);
  }

  // Re-open panel after a tick so the view renders first
  setTimeout(() => {
    openPanel(entity.id);
  }, 100);
}

/** Get the title field key for a given entity type */
function _getTitleKey(type) {
  const cfg = getEntityTypeConfig(type);
  if (!cfg) return 'title';
  const tf = cfg.fields.find(f => f.isTitle);
  return tf ? tf.key : 'title';
}

/**
 * Get a human-readable display title for any entity.
 * For types with an isTitle field (task, person, etc.) → use that field.
 * For types without one (post) → derive from body/first text field, truncated.
 * @param {object} entity
 * @param {string} [type] — entity.type override
 * @returns {string}
 */
function _getDisplayTitle(entity, type) {
  if (!entity) return 'Untitled';
  const t   = type || entity.type;
  const cfg = getEntityTypeConfig(t);
  if (!cfg) return entity.title || entity.name || 'Untitled';

  // 1. Try isTitle field
  const tf = cfg.fields.find(f => f.isTitle);
  if (tf) {
    const val = entity[tf.key];
    return val ? String(val) : 'Untitled';
  }

  // 2. No isTitle field — derive from body / first text/richtext field
  const bodyField = cfg.fields.find(f =>
    f.type === 'richtext' || f.type === 'text'
  );
  if (bodyField) {
    const raw = entity[bodyField.key];
    if (raw) {
      // Strip HTML tags, collapse whitespace, truncate
      const plain = String(raw).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
      if (plain.length > 40) return plain.slice(0, 40) + '…';
      if (plain) return plain;
    }
  }

  // 3. Last resort fallbacks
  return entity.title || entity.name || entity.label || 'Untitled';
}

/** Format ISO date string for display */
/** Format ISO date string for display in date fields (date-only, no time) */
function _formatDate(iso) {
  if (!iso) return '';
  try {
    // Date-only strings (YYYY-MM-DD) must be parsed as LOCAL midnight.
    // new Date('2026-04-20') treats the string as UTC midnight, which
    // shifts the displayed date by -1 day in timezones west of UTC.
    // Appending T00:00:00 (no Z) forces local-time interpretation.
    const normalized = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso + 'T00:00:00' : iso;
    const d = new Date(normalized);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}

/**
 * Format a full ISO timestamp for Created/Updated footers.
 * Shows date + time + timezone offset so the user knows exactly when.
 * e.g. "Apr 21, 2026, 2:34 PM (UTC+8)"
 */
function _formatTimestamp(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    // Date + time in user's locale
    const base = d.toLocaleString(undefined, {
      year:   'numeric',
      month:  'short',
      day:    'numeric',
      hour:   'numeric',
      minute: '2-digit',
      hour12: true,
    });
    // Timezone offset string e.g. "UTC+8" or "UTC-5"
    const offsetMin = -d.getTimezoneOffset();
    const sign      = offsetMin >= 0 ? '+' : '-';
    const absH      = Math.floor(Math.abs(offsetMin) / 60);
    const absM      = Math.abs(offsetMin) % 60;
    const tzLabel   = absM === 0
      ? `UTC${sign}${absH}`
      : `UTC${sign}${absH}:${String(absM).padStart(2, '0')}`;
    return `${base} (${tzLabel})`;
  } catch {
    return iso;
  }
}

/** Short date format for activity log */
function _formatDateShort(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now - d;
    const diffMin = Math.floor(diffMs / 60000);

    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffMin < 1440) return `${Math.floor(diffMin / 60)}h ago`;
    if (diffMin < 10080) return `${Math.floor(diffMin / 1440)}d ago`;

    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}

/** Truncate string to max length */
function _truncate(str, max) {
  if (!str || str.length <= max) return str;
  return str.slice(0, max) + '…';
}

/** Capitalize first letter */
function _capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

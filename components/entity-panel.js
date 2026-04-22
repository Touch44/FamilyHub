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
         saveEdge, deleteEdge, getSetting } from '../core/db.js';
import { getEntityTypeConfig, getAllEntityTypes,
         getNeighbors, convertEntity } from '../core/graph-engine.js';
import { on, emit, EVENTS } from '../core/events.js';
import { initGraph, destroyGraph, setFocusId, refreshGraph } from './graph-canvas.js';

// ── Graph view state ──────────────────────────────────────── //
let _graphViewActive = false;
let _graphPreviousView = null;   // viewKey to restore on exit

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
    _activeTab = 'properties';
    _dirty     = false;

    _renderHeader();
    _renderTabs();
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
  // All layout via inline styles — works regardless of which CSS version is cached
  headerEl.style.display        = 'flex';
  headerEl.style.flexDirection  = 'column';
  headerEl.style.gap            = '8px';
  headerEl.style.padding        = '12px 16px';
  headerEl.style.borderBottom   = '1px solid var(--color-border)';
  headerEl.style.flexShrink     = '0';

  // ── Row 1: type badge · saving indicator · actions · close ──
  const topRow = document.createElement('div');
  topRow.style.display    = 'flex';
  topRow.style.alignItems = 'center';
  topRow.style.gap        = '8px';
  topRow.style.width      = '100%';

  const badge = document.createElement('span');
  badge.id = 'entity-panel-type-badge';
  badge.className = 'type-badge';
  badge.setAttribute('aria-hidden', 'true');
  badge.textContent = `${_config.icon} ${_config.label}`;
  badge.style.background = _config.color;
  topRow.appendChild(badge);
  _panelTypeBadge = badge;

  const savingInd = document.createElement('span');
  savingInd.id = 'panel-saving-indicator';
  savingInd.className = 'panel-saving-indicator hidden';
  savingInd.setAttribute('aria-live', 'polite');
  savingInd.textContent = 'Saving…';
  topRow.appendChild(savingInd);
  _savingIndicator = savingInd;

  const actionsDiv = document.createElement('div');
  actionsDiv.id = 'entity-panel-header-actions';
  actionsDiv.style.display    = 'flex';
  actionsDiv.style.gap        = '4px';
  actionsDiv.style.alignItems = 'center';
  actionsDiv.style.marginLeft = 'auto';
  topRow.appendChild(actionsDiv);
  _headerActions = actionsDiv;

  const closeBtn = document.createElement('button');
  closeBtn.id = 'entity-panel-close';
  closeBtn.setAttribute('aria-label', 'Close entity panel');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = 'background:none;border:none;cursor:pointer;color:var(--color-text-muted);font-size:1rem;padding:4px;border-radius:4px;line-height:1;flex-shrink:0;';
  closeBtn.addEventListener('click', closePanel);
  topRow.appendChild(closeBtn);
  _panelClose = closeBtn;

  headerEl.appendChild(topRow);

  // ── Row 2: entity title — full width on its own line ───────
  const titleRow = document.createElement('div');
  titleRow.style.display    = 'flex';
  titleRow.style.alignItems = 'center';
  titleRow.style.width      = '100%';
  titleRow.style.minHeight  = '32px';

  const titleField = _config.fields.find(f => f.isTitle);
  const titleVal   = _getDisplayTitle(_entity);

  const titleSpan = document.createElement('span');
  titleSpan.id = 'entity-panel-title';
  titleSpan.textContent = titleVal;
  titleSpan.title = 'Click to edit title';
  titleSpan.style.cssText = 'font-family:var(--font-heading,Georgia,serif);font-size:1.3125rem;font-weight:700;color:var(--color-text);cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;line-height:1.3;';
  titleSpan.addEventListener('click', () => _makeTitleEditable(titleField));
  titleRow.appendChild(titleSpan);
  _panelTitle = titleSpan;

  headerEl.appendChild(titleRow);

  // ── Populate action buttons ────────────────────────────────
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
  const btnStyle = 'font-size: var(--text-xs); padding: 2px var(--space-2); min-width: 0;';

  // Complete (tasks only)
  if (_entity.type === 'task' && _entity.status !== 'Done') {
    const btn = document.createElement('button');
    btn.className   = 'btn btn-primary btn-xs';
    btn.textContent = '✓';
    btn.title       = 'Mark complete';
    btn.style.cssText = btnStyle;
    btn.addEventListener('click', async () => {
      _entity.status = 'Done';
      await _save();
      _renderHeader();
      _renderActiveTab();
    });
    _headerActions.appendChild(btn);
  }

  // Duplicate
  if (actions.includes('duplicate')) {
    const btn = document.createElement('button');
    btn.className   = 'btn btn-ghost btn-xs';
    btn.textContent = '⧉';
    btn.title       = 'Duplicate';
    btn.style.cssText = btnStyle;
    btn.addEventListener('click', async () => {
      const dup = { ..._entity };
      delete dup.id;
      delete dup.createdAt;
      delete dup.updatedAt;
      const titleK = _getTitleKey(dup.type);
      if (titleK && dup[titleK]) dup[titleK] += ' (copy)';
      const saved = await saveEntity(dup);
      openPanel(saved.id);
    });
    _headerActions.appendChild(btn);
  }

  // Archive
  if (actions.includes('archive') || actions.includes('edit')) {
    const isArchived = _entity.status === 'Archived' || _entity.archived;
    const btn = document.createElement('button');
    btn.className   = 'btn btn-ghost btn-xs';
    btn.textContent = isArchived ? '📂' : '📦';
    btn.title       = isArchived ? 'Unarchive' : 'Archive';
    btn.style.cssText = btnStyle;
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

  // Add to Project
  if (_entity.type !== 'project') {
    const btn = document.createElement('button');
    btn.className   = 'btn btn-ghost btn-xs';
    btn.textContent = '📁';
    btn.title       = 'Add to project';
    btn.style.cssText = btnStyle;
    btn.addEventListener('click', () => {
      _showProjectPicker();
    });
    _headerActions.appendChild(btn);
  }

  // Convert
  if (actions.includes('convert')) {
    const btn = document.createElement('button');
    btn.className   = 'btn btn-ghost btn-xs';
    btn.textContent = '↺';
    btn.title       = 'Convert to…';
    btn.style.cssText = btnStyle;
    btn.addEventListener('click', () => {
      _showConvertDropdown();
    });
    _headerActions.appendChild(btn);
  }

  // Delete
  if (actions.includes('delete')) {
    const btn = document.createElement('button');
    btn.className   = 'btn btn-ghost btn-xs';
    btn.textContent = '🗑';
    btn.title       = 'Delete';
    btn.style.cssText = btnStyle + ' color: var(--color-danger);';
    btn.addEventListener('click', () => {
      _confirmDelete();
    });
    _headerActions.appendChild(btn);
  }
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

const TAB_DEFS = [
  { key: 'properties', label: 'Properties' },
  { key: 'relations',  label: 'Relations' },
  { key: 'activity',   label: 'Activity' },
  { key: 'graph',      label: 'Graph' },
];

function _renderTabs() {
  // Find or create tab bar
  let tabBar = _panelBody.querySelector('.panel-tabs');
  if (!tabBar) {
    _panelBody.innerHTML = '';
    tabBar = document.createElement('div');
    tabBar.className = 'tabs panel-tabs';
    _panelBody.appendChild(tabBar);

    // Content container
    const content = document.createElement('div');
    content.className = 'panel-tab-content';
    content.style.cssText = 'flex: 1; overflow-y: auto; padding: var(--space-4) 0 var(--space-8);';
    _panelBody.appendChild(content);
  }

  tabBar.innerHTML = '';
  for (const t of TAB_DEFS) {
    const btn = document.createElement('button');
    btn.className   = 'tab' + (t.key === _activeTab ? ' active' : '');
    btn.textContent = t.label;
    btn.dataset.tab = t.key;
    btn.addEventListener('click', () => {
      _activeTab = t.key;
      _renderTabs();
      _renderActiveTab();
    });
    tabBar.appendChild(btn);
  }
}

function _renderActiveTab() {
  const container = _panelBody.querySelector('.panel-tab-content');
  if (!container) return;

  container.innerHTML = '';

  switch (_activeTab) {
    case 'properties': _renderPropertiesTab(container); break;
    case 'relations':  _renderRelationsTab(container);  break;
    case 'activity':   _renderActivityTab(container);   break;
    case 'graph':      _renderGraphTab(container);      break;
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

    // Click to navigate
    chip.addEventListener('click', () => {
      openPanel(linked.id);
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

async function _renderRelationsTab(container) {
  if (!_entity) return;

  container.innerHTML = '<div style="font-size: var(--text-xs); color: var(--color-text-muted); padding: var(--space-2);">Loading relations…</div>';

  try {
    const [outgoing, incoming] = await Promise.all([
      getEdgesFrom(_entity.id),
      getEdgesTo(_entity.id),
    ]);

    container.innerHTML = '';

    if (outgoing.length === 0 && incoming.length === 0) {
      container.innerHTML = `
        <div class="empty-state" style="padding: var(--space-8);">
          <div class="empty-state-icon">🔗</div>
          <div class="empty-state-title">No relations yet</div>
          <div class="empty-state-desc">Link this ${_config.label.toLowerCase()} to other entities using relation fields in Properties.</div>
        </div>
      `;
      return;
    }

    // Group edges by relation
    const groups = new Map();

    for (const edge of outgoing) {
      const label = edge.relation || 'linked';
      if (!groups.has(`→ ${label}`)) groups.set(`→ ${label}`, []);
      groups.get(`→ ${label}`).push({ entityId: edge.toId, edgeId: edge.id });
    }

    for (const edge of incoming) {
      const label = edge.relation || 'linked';
      if (!groups.has(`← ${label}`)) groups.set(`← ${label}`, []);
      groups.get(`← ${label}`).push({ entityId: edge.fromId, edgeId: edge.id });
    }

    for (const [groupLabel, items] of groups) {
      const section = document.createElement('div');
      section.style.cssText = 'margin-bottom: var(--space-4);';

      const header = document.createElement('div');
      header.textContent = groupLabel;
      header.style.cssText = `
        font-size: var(--text-xs); font-weight: var(--weight-semibold);
        color: var(--color-text-muted); text-transform: uppercase;
        letter-spacing: 0.04em; padding: var(--space-1) 0; margin-bottom: var(--space-1);
      `;
      section.appendChild(header);

      for (const item of items) {
        const linked = await getEntity(item.entityId);
        if (!linked || linked.deleted) continue;

        const cfg    = getEntityTypeConfig(linked.type);

        const row = document.createElement('div');
        row.style.cssText = `
          display: flex; align-items: center; gap: var(--space-2);
          padding: var(--space-2); border-radius: var(--radius-sm);
          cursor: pointer; transition: background var(--transition-fast);
        `;

        row.innerHTML = `
          <span>${cfg?.icon || '📎'}</span>
          <span style="flex: 1; font-size: var(--text-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${_getDisplayTitle(linked)}</span>
          <span class="type-badge" style="background: ${cfg?.color || '#94A3B8'}; font-size: 0.55rem; padding: 1px var(--space-1-5);">${cfg?.label || linked.type}</span>
        `;

        row.addEventListener('mouseenter', () => { row.style.background = 'var(--color-surface-2)'; });
        row.addEventListener('mouseleave', () => { row.style.background = 'none'; });
        row.addEventListener('click', () => openPanel(linked.id));

        section.appendChild(row);
      }

      container.appendChild(section);
    }

  } catch (err) {
    console.error('[entity-panel] Relations tab error:', err);
    container.innerHTML = '<div style="color: var(--color-danger); font-size: var(--text-sm); padding: var(--space-4);">Failed to load relations.</div>';
  }
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
 * Graph tab renders a prompt + button to launch the full side-by-side
 * graph view, or shows a connection summary if already in graph mode.
 */
async function _renderGraphTab(container) {
  if (!_entity) return;

  try {
    const neighbors = await getNeighbors(_entity.id);
    container.innerHTML = '';

    // ── Connection summary header ──────────────────────────
    const header = document.createElement('div');
    header.style.cssText = 'text-align: center; padding: var(--space-3) 0 var(--space-2); color: var(--color-text-muted); font-size: var(--text-xs);';
    header.textContent = `${neighbors.length} connection${neighbors.length !== 1 ? 's' : ''}`;
    container.appendChild(header);

    if (neighbors.length === 0) {
      container.innerHTML += `
        <div class="empty-state" style="padding: var(--space-8);">
          <div class="empty-state-icon">🕸️</div>
          <div class="empty-state-title">No connections</div>
          <div class="empty-state-desc">Link this ${_config.label.toLowerCase()} to other entities to see its graph.</div>
        </div>
      `;
      return;
    }

    // ── Launch button ────────────────────────────────────────
    const launchBtn = document.createElement('button');
    launchBtn.className = 'btn btn-primary w-full';
    launchBtn.style.cssText = 'margin: var(--space-3) 0; display: flex; align-items: center; justify-content: center; gap: var(--space-2);';
    launchBtn.innerHTML = '<span>🔮</span><span>Open Graph View</span>';
    launchBtn.addEventListener('click', () => _openGraphView(_entity.id));
    container.appendChild(launchBtn);

    // ── Legend list ───────────────────────────────────────────
    const legend = document.createElement('div');
    legend.style.cssText = 'display: flex; flex-direction: column; gap: var(--space-1); padding-top: var(--space-2);';

    const count = Math.min(neighbors.length, 12);
    for (let i = 0; i < count; i++) {
      const neighbor = neighbors[i];
      const entity   = await getEntity(neighbor.entityId);
      if (!entity || entity.deleted) continue;

      const nConfig = getEntityTypeConfig(entity.type);
      const row = document.createElement('div');
      row.style.cssText = `
        display: flex; align-items: center; gap: var(--space-2);
        padding: var(--space-1-5) var(--space-2); border-radius: var(--radius-sm);
        cursor: pointer; font-size: var(--text-xs);
        transition: background var(--transition-fast);
      `;
      row.innerHTML = `
        <span style="width: 10px; height: 10px; border-radius: var(--radius-full); background: ${nConfig?.color || '#94A3B8'}; flex-shrink: 0;"></span>
        <span style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${_getDisplayTitle(entity)}</span>
        <span style="color: var(--color-text-muted);">${nConfig?.label || entity.type}</span>
      `;
      row.addEventListener('mouseenter', () => { row.style.background = 'var(--color-surface-2)'; });
      row.addEventListener('mouseleave', () => { row.style.background = 'none'; });
      row.addEventListener('click', () => openPanel(entity.id));
      legend.appendChild(row);
    }

    if (neighbors.length > 12) {
      const more = document.createElement('div');
      more.style.cssText = 'font-size: var(--text-xs); color: var(--color-text-muted); padding: var(--space-2); text-align: center;';
      more.textContent = `+ ${neighbors.length - 12} more connections`;
      legend.appendChild(more);
    }

    container.appendChild(legend);

  } catch (err) {
    console.error('[entity-panel] Graph tab error:', err);
    container.innerHTML = '<div style="color: var(--color-danger); font-size: var(--text-sm); padding: var(--space-4);">Failed to load graph.</div>';
  }
}

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
    display: flex; align-items: center; gap: var(--space-3);
    padding: var(--space-2) var(--space-4);
    border-bottom: 1px solid var(--color-border);
    background: var(--color-bg);
    flex-shrink: 0;
    z-index: 2;
  `;

  // Title
  const titleEl = document.createElement('span');
  titleEl.id = 'graph-view-title';
  titleEl.style.cssText = 'font-family: var(--font-heading); font-size: var(--text-base); font-weight: var(--weight-semibold); flex: 1;';
  titleEl.textContent = '🔮 Knowledge Graph';
  toolbar.appendChild(titleEl);

  // Hint
  const hintEl = document.createElement('span');
  hintEl.style.cssText = 'font-size: var(--text-xs); color: var(--color-text-muted);';
  hintEl.textContent = 'Click: select · Double-click: drill in · Scroll: zoom · Drag: move';
  toolbar.appendChild(hintEl);

  // Exit button
  const exitBtn = document.createElement('button');
  exitBtn.className = 'btn btn-ghost btn-sm';
  exitBtn.style.cssText = 'display: flex; align-items: center; gap: var(--space-1); flex-shrink: 0;';
  exitBtn.innerHTML = '<span>✕</span><span>Exit Graph</span>';
  exitBtn.addEventListener('click', _closeGraphView);
  toolbar.appendChild(exitBtn);

  graphCol.appendChild(toolbar);

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

  console.log('[entity-panel] [minor] Graph view opened for', entityId);
}

/**
 * Close the side-by-side graph view, restore previous view.
 */
function _closeGraphView() {
  destroyGraph();
  _graphViewActive = false;

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
 * When a node is single-clicked in graph mode, update the panel to show
 * that entity's properties — but do NOT drill down or navigate away.
 */
function _handleGraphNodeSelected(id) {
  if (!_graphViewActive || !id) return;
  // Update panel to this entity, keep on properties tab
  openPanel(id).then(() => {
    _activeTab = 'properties';
    _renderActiveTab();
  });
}

/**
 * When a node is double-clicked (focus drilled), update the panel too.
 */
function _handleGraphNodeFocused(id) {
  if (!_graphViewActive || !id) return;
  openPanel(id).then(() => {
    _activeTab = 'properties';
    _renderActiveTab();
  });
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
    const d = new Date(iso);
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

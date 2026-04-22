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
         saveEdge, deleteEdge, getSetting, uid } from '../core/db.js';
import { getEntityTypeConfig, getAllEntityTypes, getBacklinks,
         getNeighbors, convertEntity } from '../core/graph-engine.js';
import { on, off, emit, EVENTS } from '../core/events.js';

// ── DOM refs (cached once on init) ───────────────────────── //
let _panel, _panelBody, _panelTitle, _panelTypeBadge, _panelClose, _savingIndicator;

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
  _panel          = document.getElementById('entity-panel');
  _panelBody      = document.getElementById('entity-panel-body');
  _panelTitle     = document.getElementById('entity-panel-title');
  _panelTypeBadge = document.getElementById('entity-panel-type-badge');
  _panelClose     = document.getElementById('entity-panel-close');
  _savingIndicator= document.getElementById('panel-saving-indicator');

  if (!_panel || !_panelBody) {
    console.warn('[entity-panel] Panel DOM not found — skipping init.');
    return;
  }

  // Close button
  _panelClose?.addEventListener('click', closePanel);

  // Esc key closes panel
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _panel.classList.contains('open')) {
      closePanel();
    }
  });

  // Listen for open requests from anywhere
  on(EVENTS.PANEL_OPENED, ({ entityId } = {}) => {
    if (entityId) openPanel(entityId);
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

  console.log('[entity-panel] Initialised.');
}

// ════════════════════════════════════════════════════════════
// OPEN / CLOSE
// ════════════════════════════════════════════════════════════

/**
 * Open the entity panel for a given entity ID.
 * @param {string} entityId
 */
export async function openPanel(entityId) {
  if (!_panel || !_panelBody) return;

  try {
    const entity = await getEntity(entityId);
    if (!entity) {
      console.warn(`[entity-panel] Entity "${entityId}" not found.`);
      return;
    }

    const config = getEntityTypeConfig(entity.type);
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
 */
export function closePanel() {
  if (!_panel) return;

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

  // Type badge
  if (_panelTypeBadge) {
    _panelTypeBadge.textContent = `${_config.icon} ${_config.label}`;
    _panelTypeBadge.style.background = _config.color;
  }

  // Title — editable on click
  if (_panelTitle) {
    const titleField = _config.fields.find(f => f.isTitle);
    const titleVal   = titleField ? (_entity[titleField.key] || '') : (_entity.title || _entity.name || '');

    _panelTitle.textContent = titleVal || 'Untitled';
    _panelTitle.title       = 'Click to edit title';
    _panelTitle.style.cursor = 'pointer';

    // Remove old listener by cloning
    const newTitle = _panelTitle.cloneNode(true);
    _panelTitle.replaceWith(newTitle);
    _panelTitle = newTitle;

    _panelTitle.addEventListener('click', () => {
      _makeTitleEditable(titleField);
    });
  }
}

function _makeTitleEditable(titleField) {
  if (!_panelTitle || !titleField) return;

  const current = _entity[titleField.key] || '';
  const input   = document.createElement('input');
  input.type        = 'text';
  input.value       = current;
  input.className   = 'input';
  input.style.cssText = 'font-weight: var(--weight-semibold); font-size: var(--text-base); flex: 1; padding: var(--space-1) var(--space-2);';

  _panelTitle.replaceWith(input);
  input.focus();
  input.select();

  const commit = async () => {
    const val = input.value.trim();
    if (val !== current) {
      _entity[titleField.key] = val;
      await _save();
    }
    // Rebuild title span
    const span = document.createElement('span');
    span.id               = 'entity-panel-title';
    span.textContent      = val || 'Untitled';
    span.title            = 'Click to edit title';
    span.style.cssText    = 'font-weight: var(--weight-semibold); flex: 1; font-size: var(--text-base); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer;';
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
// TABS
// ════════════════════════════════════════════════════════════

const TAB_DEFS = [
  { key: 'properties', label: 'Properties' },
  { key: 'relations',  label: 'Relations' },
  { key: 'activity',   label: 'Activity' },
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
  }

  // Action row always at the bottom
  _renderActionRow(container);
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
      <span>Created: ${_formatDate(_entity.createdAt)}</span>
      <span>Updated: ${_formatDate(_entity.updatedAt)}</span>
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
  const value = _entity[field.key];

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
    case 'date':
    case 'datetime': {
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
  const current = _entity[field.key] ?? '';
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
      _entity[field.key] = val || null;
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
    chip.innerHTML = `<span>${linkedConfig?.icon || '📎'}</span> <span>${linked[_getTitleKey(linked.type)] || 'Untitled'}</span>`;

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
      const titleKey = _getTitleKey(e.type);
      const t = (e[titleKey] || '').toLowerCase();
      return !query || t.includes(query);
    }).slice(0, 10);

    results.innerHTML = '';

    if (filtered.length === 0) {
      results.innerHTML = '<div style="font-size: var(--text-xs); color: var(--color-text-muted); padding: var(--space-2);">No results</div>';
      return;
    }

    for (const candidate of filtered) {
      const cfg     = getEntityTypeConfig(candidate.type);
      const titleK  = _getTitleKey(candidate.type);

      const item = document.createElement('div');
      item.style.cssText = `
        display: flex; align-items: center; gap: var(--space-2);
        padding: var(--space-1-5) var(--space-2); border-radius: var(--radius-sm);
        cursor: pointer; font-size: var(--text-sm);
        transition: background var(--transition-fast);
      `;
      item.innerHTML = `<span>${cfg?.icon || '📎'}</span> <span>${candidate[titleK] || 'Untitled'}</span>`;

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
        const titleK = _getTitleKey(linked.type);

        const row = document.createElement('div');
        row.style.cssText = `
          display: flex; align-items: center; gap: var(--space-2);
          padding: var(--space-2); border-radius: var(--radius-sm);
          cursor: pointer; transition: background var(--transition-fast);
        `;

        row.innerHTML = `
          <span>${cfg?.icon || '📎'}</span>
          <span style="flex: 1; font-size: var(--text-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${linked[titleK] || 'Untitled'}</span>
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
    const rec = await getSetting('auditLog');
    const log = Array.isArray(rec) ? rec : [];

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
        display: flex; gap: var(--space-2); padding: var(--space-2);
        border-bottom: 1px solid color-mix(in srgb, var(--color-border) 50%, transparent);
        font-size: var(--text-xs);
      `;

      const icon = entry.action === 'create' ? '✨' : entry.action === 'delete' ? '🗑️' : '✏️';

      let desc = `${icon} ${_capitalize(entry.action || 'updated')}`;
      if (entry.field) {
        desc += ` — ${entry.field}`;
        if (entry.oldValue != null || entry.newValue != null) {
          const old = entry.oldValue != null ? `"${_truncate(String(entry.oldValue), 20)}"` : 'empty';
          const nw  = entry.newValue != null ? `"${_truncate(String(entry.newValue), 20)}"` : 'empty';
          desc += `: ${old} → ${nw}`;
        }
      }

      item.innerHTML = `
        <div style="flex: 1; color: var(--color-text);">${desc}</div>
        <div style="flex-shrink: 0; color: var(--color-text-muted);">${_formatDateShort(entry.at)}</div>
      `;

      list.appendChild(item);
    }

    container.appendChild(list);

  } catch (err) {
    console.error('[entity-panel] Activity tab error:', err);
    container.innerHTML = '<div style="color: var(--color-danger); font-size: var(--text-sm); padding: var(--space-4);">Failed to load activity.</div>';
  }
}

// ════════════════════════════════════════════════════════════
// ACTION ROW
// ════════════════════════════════════════════════════════════

function _renderActionRow(container) {
  if (!_entity || !_config) return;

  const row = document.createElement('div');
  row.style.cssText = `
    display: flex; flex-wrap: wrap; gap: var(--space-2);
    padding-top: var(--space-4); margin-top: var(--space-4);
    border-top: 1px solid var(--color-border);
  `;

  const actions = _config.actions || [];

  // Complete (tasks only)
  if (_entity.type === 'task' && _entity.status !== 'Done') {
    _addActionBtn(row, '✓ Complete', 'btn-primary btn-xs', async () => {
      _entity.status = 'Done';
      await _save();
      _renderActiveTab();
    });
  }

  // Duplicate
  if (actions.includes('duplicate')) {
    _addActionBtn(row, '⧉ Duplicate', 'btn-secondary btn-xs', async () => {
      const dup = { ..._entity };
      delete dup.id;
      delete dup.createdAt;
      delete dup.updatedAt;
      const titleK = _getTitleKey(dup.type);
      if (titleK && dup[titleK]) dup[titleK] += ' (copy)';
      const saved = await saveEntity(dup);
      openPanel(saved.id);
    });
  }

  // Convert
  if (actions.includes('convert')) {
    _addActionBtn(row, '↺ Convert', 'btn-secondary btn-xs', () => {
      _showConvertPicker(row);
    });
  }

  // Delete
  if (actions.includes('delete')) {
    _addActionBtn(row, '🗑 Delete', 'btn-danger btn-xs', () => {
      _confirmDelete();
    });
  }

  container.appendChild(row);
}

function _addActionBtn(parent, label, classes, handler) {
  const btn = document.createElement('button');
  btn.className   = `btn ${classes}`;
  btn.textContent = label;
  btn.addEventListener('click', handler);
  parent.appendChild(btn);
}

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

function _showConvertPicker(row) {
  // Remove existing picker if any
  const existing = row.querySelector('.convert-picker');
  if (existing) { existing.remove(); return; }

  const picker = document.createElement('div');
  picker.className = 'convert-picker';
  picker.style.cssText = `
    display: flex; flex-wrap: wrap; gap: var(--space-1);
    padding: var(--space-2); background: var(--color-surface);
    border-radius: var(--radius-sm); border: 1px solid var(--color-border);
    width: 100%; margin-top: var(--space-2);
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
        openPanel(converted.id);
      } catch (err) {
        console.error('[entity-panel] Convert failed:', err);
      }
    });
    picker.appendChild(btn);
  }

  row.appendChild(picker);
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

/** Format ISO date string for display */
function _formatDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
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

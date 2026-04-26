/**
 * FamilyHub v2.0 — components/entity-form.js
 * Universal create/edit form — modal on desktop, full-screen on mobile.
 * Blueprint §5.2 (entity form), Phase 1-C
 *
 * Public API:
 *   openForm(typeKey, prefillProps?, onSave?)  — open form for new entity
 *   openEditForm(entity, onSave?)              — open form to edit existing entity
 *   closeForm()                                — close and discard draft
 *   initEntityForm()                           — wire FAB events (call once on boot)
 */

import { saveEntity, saveEdge, getEntitiesByType } from '../core/db.js';
import { getEntityTypeConfig, getAllEntityTypes }        from '../core/graph-engine.js';
import { emit, EVENTS }                                from '../core/events.js';

// ── Module-level state ────────────────────────────────────── //

/** @type {HTMLElement|null} */
let _overlay = null;

/** @type {object|null} draft form values {fieldKey: value} */
let _draft = null;

/** @type {string|null} current type key */
let _typeKey = null;

/** @type {object|null} entity being edited (null = create mode) */
let _editEntity = null;

/** @type {Function|null} */
let _onSave = null;

/** @type {Map<string, string[]>} relation field → array of entity IDs selected */
const _relationValues = new Map();

/** @type {Map<string, string[]>} tags field → array of tag strings */
const _tagValues = new Map();

// ════════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════════

/**
 * Wire FAB and keyboard events. Call once during app boot.
 */
export function initEntityForm() {
  // fab:create is handled exclusively by fab.js, which calls openForm() directly.
  // No listener here — a second listener caused every FAB action to open the form twice.

  // Global Cmd+Enter to save if form is open
  document.addEventListener('keydown', (e) => {
    if (!_overlay) return;

    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      _submitForm();
      return;
    }

    if (e.key === 'Escape') {
      // If focus is inside a form input/select/textarea, let the input
      // handle its own Esc first (clear value, blur) — only close the
      // form if focus is on the overlay itself or a non-editable element
      const active = document.activeElement;
      const isInsideInput = active &&
        _overlay.contains(active) &&
        (active.tagName === 'INPUT' ||
         active.tagName === 'TEXTAREA' ||
         active.tagName === 'SELECT' ||
         active.isContentEditable);

      if (!isInsideInput) {
        e.preventDefault();
        closeForm();
      }
      // If inside an input: let the input's own Esc handler fire,
      // then a second Esc (after blur) will hit this branch and close.
    }
  });

  console.log('[entity-form] Initialised.');
}

// ════════════════════════════════════════════════════════════
// PUBLIC API
// ════════════════════════════════════════════════════════════

/**
 * Open the form to create a new entity.
 * @param {string}   typeKey      - entity type key (e.g. 'task', 'note')
 * @param {object}   [prefill]    - field values to pre-populate
 * @param {Function} [onSave]     - callback(entity) after successful save
 */
export function openForm(typeKey, prefill = {}, onSave = null) {
  const config = getEntityTypeConfig(typeKey);
  if (!config) {
    console.warn(`[entity-form] Unknown type "${typeKey}"`);
    return;
  }

  _typeKey    = typeKey;
  _editEntity = null;
  _onSave     = onSave;
  _draft      = { ...prefill };
  _relationValues.clear();
  _tagValues.clear();

  _buildAndMount(config);
}

/**
 * Open the form to edit an existing entity.
 * @param {object}   entity
 * @param {Function} [onSave]
 */
export function openEditForm(entity, onSave = null) {
  const config = getEntityTypeConfig(entity.type);
  if (!config) {
    console.warn(`[entity-form] Unknown type "${entity.type}"`);
    return;
  }

  _typeKey    = entity.type;
  _editEntity = entity;
  _onSave     = onSave;
  _draft      = { ...entity };
  _relationValues.clear();
  _tagValues.clear();

  // Pre-populate tag fields from entity
  for (const field of config.fields) {
    if (field.type === 'tags' && Array.isArray(entity[field.key])) {
      _tagValues.set(field.key, [...entity[field.key]]);
    }
  }

  _buildAndMount(config);
}

/**
 * Close and discard the form.
 */
export function closeForm() {
  if (!_overlay) return;
  _overlay.classList.add('ef-closing');
  setTimeout(() => {
    _overlay?.remove();
    _overlay    = null;
    _draft      = null;
    _typeKey    = null;
    _editEntity = null;
    _onSave     = null;
    _relationValues.clear();
    _tagValues.clear();
  }, 200);
}

// ════════════════════════════════════════════════════════════
// BUILD & MOUNT
// ════════════════════════════════════════════════════════════

function _buildAndMount(config) {
  // Remove any existing form
  document.querySelector('.ef-overlay')?.remove();

  // ── Overlay ──────────────────────────────────────────── //
  _overlay = document.createElement('div');
  _overlay.className   = 'modal-overlay ef-overlay';
  _overlay.setAttribute('role', 'dialog');
  _overlay.setAttribute('aria-modal', 'true');
  _overlay.setAttribute('aria-label', `${_editEntity ? 'Edit' : 'New'} ${config.label}`);

  // Click outside to close
  _overlay.addEventListener('click', (e) => {
    if (e.target === _overlay) closeForm();
  });

  // ── Modal shell ──────────────────────────────────────── //
  const modal = document.createElement('div');
  modal.className = 'modal ef-modal';
  modal.style.cssText = 'max-width: 560px;';

  // ── Header ───────────────────────────────────────────── //
  const header = document.createElement('div');
  // All layout via inline styles — immune to stale CSS cache
  header.style.cssText = 'display:flex;flex-direction:column;gap:8px;padding:12px 16px;border-bottom:1px solid var(--color-border);flex-shrink:0;';

  // ── Header top row: type selector + close button ────── //
  const headerTop = document.createElement('div');
  headerTop.style.cssText = 'display:flex;align-items:center;gap:8px;width:100%;';

  // Type selector
  const typeSelect = document.createElement('select');
  typeSelect.className  = 'select ef-type-select';
  typeSelect.style.cssText = 'width: auto; padding: var(--space-1) var(--space-2); font-size: var(--text-sm); border-color: transparent; background: var(--color-surface-2); cursor: pointer;';
  typeSelect.setAttribute('aria-label', 'Entity type');

  const allTypes = getAllEntityTypes();
  for (const t of allTypes) {
    const opt = document.createElement('option');
    opt.value       = t.key;
    opt.textContent = `${t.icon} ${t.label}`;
    if (t.key === _typeKey) opt.selected = true;
    typeSelect.appendChild(opt);
  }

  typeSelect.addEventListener('change', () => {
    // Preserve title/name across type switch
    _saveDraftFromForm();
    const oldTitleField = config.fields.find(f => f.isTitle);
    const oldTitle = oldTitleField ? _draft[oldTitleField.key] : null;

    _typeKey = typeSelect.value;
    const newConfig = getEntityTypeConfig(_typeKey);
    if (!newConfig) return;

    const newTitleField = newConfig.fields.find(f => f.isTitle);
    if (oldTitle && newTitleField) {
      _draft[newTitleField.key] = oldTitle;
    }

    _relationValues.clear();
    _tagValues.clear();
    _rebuildBody(newConfig, body);
    _updateHeader(header, newConfig, typeSelect);
  });

  headerTop.appendChild(typeSelect);

  const closeBtn = document.createElement('button');
  closeBtn.style.cssText = 'background:none;border:none;cursor:pointer;color:var(--color-text-muted);font-size:1rem;padding:4px;border-radius:4px;margin-left:auto;';
  closeBtn.textContent = '✕';
  closeBtn.setAttribute('aria-label', 'Close form');
  closeBtn.addEventListener('click', closeForm);
  headerTop.appendChild(closeBtn);

  header.appendChild(headerTop);

  // ── Header title row ────────────────────────────────── //
  const titleRow = document.createElement('div');
  titleRow.style.cssText = 'display:flex;align-items:center;width:100%;min-height:32px;padding-top:2px;';

  const title = document.createElement('h2');
  title.className = 'ef-modal-title';
  title.style.cssText = 'font-family:var(--font-heading,Georgia,serif);font-size:1.3125rem;font-weight:700;color:var(--color-text);margin:0;line-height:1.3;';
  title.textContent = _editEntity ? `Edit ${config.label}` : `New ${config.label}`;
  titleRow.appendChild(title);
  header.appendChild(titleRow);

  // ── Body ─────────────────────────────────────────────── //
  const body = document.createElement('div');
  body.className = 'modal-body ef-body';
  _rebuildBody(config, body);

  // ── Footer ───────────────────────────────────────────── //
  const footer = document.createElement('div');
  footer.className = 'modal-footer';

  const cancelBtn = document.createElement('button');
  cancelBtn.className   = 'btn btn-secondary';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', closeForm);

  const saveBtn = document.createElement('button');
  saveBtn.className   = 'btn btn-primary ef-save-btn';
  saveBtn.textContent = _editEntity ? 'Save changes' : `Create ${config.label}`;
  saveBtn.addEventListener('click', _submitForm);

  const hint = document.createElement('span');
  hint.style.cssText  = 'font-size: var(--text-xs); color: var(--color-text-muted); margin-right: auto;';
  hint.textContent    = '⌘↩ to save';

  footer.appendChild(hint);
  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);

  modal.appendChild(header);
  modal.appendChild(body);
  modal.appendChild(footer);
  _overlay.appendChild(modal);
  document.body.appendChild(_overlay);

  // Focus the title field
  setTimeout(() => {
    const titleInput = modal.querySelector('.ef-title-field');
    titleInput?.focus();
  }, 60);
}

/** Update header title text when type changes */
function _updateHeader(header, config, typeSelect) {
  const title = header.querySelector('.ef-modal-title');
  if (title) title.textContent = `New ${config.label}`;
}

/** Rebuild the form body for a given config */
function _rebuildBody(config, body) {
  body.innerHTML = '';

  const fields = config.fields;
  for (const field of fields) {
    const group = _buildFieldGroup(field, config);
    if (group) body.appendChild(group);
  }
}

// ════════════════════════════════════════════════════════════
// FIELD RENDERING
// ════════════════════════════════════════════════════════════

function _buildFieldGroup(field, config) {
  const group = document.createElement('div');
  group.className     = 'form-group';
  group.dataset.field = field.key;
  group.style.marginBottom = 'var(--space-4)';

  // ── endDate: initially hidden with toggle ──
  const isEndDate = field.key === 'endDate';
  const hasExisting = isEndDate && _draft[field.key];

  if (isEndDate && !hasExisting) {
    // Show as a toggle link instead of the full field
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'btn btn-ghost btn-xs';
    toggle.style.cssText = 'color: var(--color-text-accent); padding: var(--space-1) 0;';
    toggle.textContent = '+ Add end date/time';
    toggle.addEventListener('click', () => {
      toggle.style.display = 'none';
      group.style.display = '';
    });
    // Insert toggle before group, hide the group
    const wrapper = document.createElement('div');
    wrapper.dataset.field = field.key;
    wrapper.appendChild(toggle);

    // Still build the group but hide it
    group.style.display = 'none';

    // Label
    const label = document.createElement('label');
    label.className   = 'form-label';
    label.htmlFor     = `ef-field-${field.key}`;
    label.textContent = field.label;
    group.appendChild(label);

    const control = _buildFieldControl(field, config);
    if (control) group.appendChild(control);

    const err = document.createElement('span');
    err.className       = 'form-error ef-field-error';
    err.style.display   = 'none';
    err.setAttribute('role', 'alert');
    group.appendChild(err);

    wrapper.appendChild(group);
    return wrapper;
  }

  // Label — skip for isTitle (title gets special styling)
  if (!field.isTitle) {
    const label = document.createElement('label');
    label.className   = `form-label${field.required ? ' required' : ''}`;
    label.htmlFor     = `ef-field-${field.key}`;
    label.textContent = field.label;
    group.appendChild(label);
  }

  const control = _buildFieldControl(field, config);
  if (control) group.appendChild(control);

  // Error container
  const err = document.createElement('span');
  err.className       = 'form-error ef-field-error';
  err.style.display   = 'none';
  err.setAttribute('role', 'alert');
  group.appendChild(err);

  return group;
}

function _buildFieldControl(field, config) {
  // GUARD: For fields named 'type', read from '_subtype' to avoid collision
  // with the structural entity.type property (which holds the entity kind key).
  const existing = field.key === 'type' ? (_draft._subtype ?? _draft[field.key]) : _draft[field.key];

  switch (field.type) {

    // ── TITLE (text, special styling) ────────────────────── //
    case 'title': {
      const input = document.createElement('input');
      input.type        = 'text';
      input.id          = `ef-field-${field.key}`;
      input.className   = 'input ef-title-field';
      input.placeholder = field.label;
      input.value       = existing || '';
      input.required    = true;
      input.autocomplete = 'off';
      input.style.cssText = 'font-size: var(--text-lg); font-weight: var(--weight-semibold); padding: var(--space-3);';
      input.addEventListener('input', () => { _draft[field.key] = input.value; });
      return input;
    }

    // ── TEXT / EMAIL / PHONE / URL ────────────────────────── //
    case 'text':
    case 'email':
    case 'phone':
    case 'url': {
      const typeMap = { text: 'text', email: 'email', phone: 'tel', url: 'url' };
      const input = document.createElement('input');
      input.type        = typeMap[field.type] || 'text';
      input.id          = `ef-field-${field.key}`;
      input.className   = 'input';
      input.placeholder = `Enter ${field.label.toLowerCase()}…`;
      input.value       = existing || '';
      if (field.required) input.required = true;
      input.addEventListener('input', () => { _draft[field.key] = input.value.trim() || null; });
      return input;
    }

    // ── NUMBER ───────────────────────────────────────────── //
    case 'number': {
      const input = document.createElement('input');
      input.type        = 'number';
      input.id          = `ef-field-${field.key}`;
      input.className   = 'input';
      input.placeholder = '0';
      input.value       = existing != null ? String(existing) : '';
      if (field.required) input.required = true;
      input.addEventListener('input', () => {
        _draft[field.key] = input.value !== '' ? Number(input.value) : null;
      });
      return input;
    }

    // ── DATE ─────────────────────────────────────────────── //
    case 'date': {
      const input = document.createElement('input');
      input.type      = 'date';
      input.id        = `ef-field-${field.key}`;
      input.className = 'input';
      input.value     = existing ? existing.slice(0, 10) : '';
      if (field.required) input.required = true;
      input.addEventListener('change', () => {
        _draft[field.key] = input.value || null;
      });
      return input;
    }

    // ── TIME ─────────────────────────────────────────────── //
    case 'time': {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;';

      const input = document.createElement('input');
      input.type      = 'time';
      input.id        = `ef-field-${field.key}`;
      input.className = 'input';
      input.step      = '600'; // 10-minute increments
      input.value     = existing || '06:00';
      if (field.placeholder) input.placeholder = field.placeholder;

      // Only save dueTime when dueDate is also set — prevents disappearing from calendar
      input.addEventListener('change', () => {
        const dateKey = field.key === 'dueTime' ? 'dueDate' : null;
        if (dateKey && !_draft[dateKey]) {
          // No date set — don't persist time, show hint
          hintEl.textContent = '⚠ Set a Due Date first';
          hintEl.style.color = 'var(--color-warning-text)';
          input.value = existing || '06:00';
          return;
        }
        _draft[field.key] = input.value || '06:00';
        hintEl.textContent = field.helpText || '10-min steps';
        hintEl.style.color = 'var(--color-text-muted)';
      });
      // Init draft only if dueDate exists
      if (!existing && _draft.dueDate) _draft[field.key] = '06:00';
      else if (!existing) _draft[field.key] = null; // no date = no time

      const hintEl = document.createElement('span');
      hintEl.style.cssText = 'font-size:var(--text-xs);color:var(--color-text-muted);white-space:nowrap;';
      hintEl.textContent = field.helpText || '10-min steps';

      wrap.append(input, hintEl);
      return wrap;
    }

    // ── DATETIME ─────────────────────────────────────────── //
    case 'datetime': {
      const input = document.createElement('input');
      input.type      = 'datetime-local';
      input.id        = `ef-field-${field.key}`;
      input.className = 'input';
      input.value     = existing ? existing.slice(0, 16) : '';
      if (field.required) input.required = true;
      input.addEventListener('change', () => {
        _draft[field.key] = input.value ? new Date(input.value).toISOString() : null;
      });
      return input;
    }

    // ── SELECT ───────────────────────────────────────────── //
    case 'select': {
      const select = document.createElement('select');
      select.id        = `ef-field-${field.key}`;
      select.className = 'select';
      if (field.required) select.required = true;

      const empty = document.createElement('option');
      empty.value       = '';
      empty.textContent = `— Select ${field.label} —`;
      select.appendChild(empty);

      for (const opt of (field.options || [])) {
        const o = document.createElement('option');
        o.value       = opt;
        o.textContent = opt;
        if (opt === existing) o.selected = true;
        select.appendChild(o);
      }

      // If no pre-selection yet, default to first option for non-required fields
      if (!existing && !field.required && field.options?.length) {
        // Leave blank
      }

      select.addEventListener('change', () => {
        const val = select.value || null;
        if (field.key === 'type') {
          _draft._subtype = val;   // safe alias
        }
        _draft[field.key] = val;
      });
      return select;
    }

    // ── CHECKBOX ─────────────────────────────────────────── //
    case 'checkbox': {
      const wrap = document.createElement('label');
      wrap.style.cssText = 'display: flex; align-items: center; gap: var(--space-2); cursor: pointer; font-size: var(--text-sm);';

      const cb = document.createElement('input');
      cb.type    = 'checkbox';
      cb.id      = `ef-field-${field.key}`;
      cb.checked = !!existing;
      cb.style.cssText = 'width: 18px; height: 18px; accent-color: var(--color-accent); cursor: pointer; flex-shrink: 0;';
      cb.addEventListener('change', () => { _draft[field.key] = cb.checked; });

      const lbl = document.createElement('span');
      lbl.textContent = field.label;

      wrap.appendChild(cb);
      wrap.appendChild(lbl);
      return wrap;
    }

    // ── RICHTEXT ─────────────────────────────────────────── //
    case 'richtext': {
      const wrap = document.createElement('div');

      // Mini toolbar
      const toolbar = document.createElement('div');
      toolbar.style.cssText = `
        display: flex; gap: var(--space-1); margin-bottom: var(--space-1);
        padding: var(--space-1); background: var(--color-surface);
        border: 1px solid var(--color-border); border-bottom: none;
        border-radius: var(--radius-sm) var(--radius-sm) 0 0;
      `;

      const toolbarBtns = [
        { cmd: 'bold',        label: '<b>B</b>',  title: 'Bold' },
        { cmd: 'italic',      label: '<i>I</i>',  title: 'Italic' },
        { cmd: 'insertUnorderedList', label: '• List', title: 'Bullet list' },
      ];

      for (const tb of toolbarBtns) {
        const btn = document.createElement('button');
        btn.type      = 'button';
        btn.innerHTML = tb.label;
        btn.title     = tb.title;
        btn.style.cssText = 'padding: 2px var(--space-2); font-size: var(--text-xs); background: none; border: 1px solid var(--color-border); border-radius: var(--radius-sm); cursor: pointer; font-family: var(--font-body);';
        btn.addEventListener('mousedown', (e) => {
          e.preventDefault();
          document.execCommand(tb.cmd, false, null);
          editor.focus();
        });
        toolbar.appendChild(btn);
      }

      // Editor
      const editor = document.createElement('div');
      editor.id              = `ef-field-${field.key}`;
      editor.contentEditable = 'true';
      editor.className       = 'ef-richtext-editor';
      editor.style.cssText   = `
        min-height: 100px; padding: var(--space-3);
        border: 1px solid var(--color-border);
        border-radius: 0 0 var(--radius-sm) var(--radius-sm);
        font-size: var(--text-sm); line-height: var(--leading-relaxed);
        outline: none; color: var(--color-text);
        background: var(--color-bg);
        transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
      `;
      editor.setAttribute('role', 'textbox');
      editor.setAttribute('aria-multiline', 'true');
      editor.setAttribute('aria-label', field.label);
      editor.setAttribute('spellcheck', 'true');

      if (existing) editor.textContent = existing;
      else {
        editor.dataset.placeholder = `Enter ${field.label.toLowerCase()}…`;
      }

      editor.addEventListener('focus', () => {
        editor.style.borderColor = 'var(--color-accent)';
        editor.style.boxShadow   = 'var(--shadow-focus)';
      });
      editor.addEventListener('blur', () => {
        editor.style.borderColor = 'var(--color-border)';
        editor.style.boxShadow   = 'none';
        _draft[field.key] = editor.textContent.trim() || null;
      });
      editor.addEventListener('input', () => {
        _draft[field.key] = editor.textContent.trim() || null;
      });

      wrap.appendChild(toolbar);
      wrap.appendChild(editor);
      return wrap;
    }

    // ── CHECKLIST ────────────────────────────────────────── //
    // ── CHECKLIST ──────────────────────────────────────────────────── //
    case 'checklist': {
      // Deep-copy existing items so draft mutations don’t affect the entity object
      let items = Array.isArray(existing) ? existing.map(it => ({ ...it })) : [];
      _draft[field.key] = items.length ? [...items] : null;

      const wrap = document.createElement('div');
      wrap.className = 'ef-checklist-wrap';
      wrap.style.cssText = 'display:flex;flex-direction:column;gap:var(--space-1-5);';

      function _genId() {
        return Math.random().toString(36).slice(2, 10);
      }

      function _syncDraft() {
        // Store a shallow-copy array so save reads correct state
        _draft[field.key] = items.length ? items.map(it => ({ ...it })) : null;
      }

      // Build the Add button once — re-append on each _renderItems, never recreate
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'ef-checklist-add btn btn-ghost btn-sm';
      addBtn.style.cssText = 'align-self:flex-start;margin-top:var(--space-1);font-size:var(--text-xs);';
      addBtn.textContent = '+ Add item';
      addBtn.addEventListener('click', () => {
        items.push({ id: _genId(), text: '', done: false });
        _syncDraft();
        _renderItems();
        const inputs = wrap.querySelectorAll('input[type="text"]');
        if (inputs.length) inputs[inputs.length - 1].focus();
      });

      function _renderItems() {
        wrap.innerHTML = '';
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;align-items:center;gap:var(--space-1-5);';

          const cb = document.createElement('input');
          cb.type    = 'checkbox';
          cb.checked = !!item.done;
          cb.style.cssText = 'width:15px;height:15px;flex-shrink:0;accent-color:var(--color-accent);cursor:pointer;';

          const txt = document.createElement('input');
          txt.type        = 'text';
          txt.value       = item.text || '';
          txt.className   = 'input';
          txt.placeholder = 'Item text…';
          txt.style.cssText = 'flex:1;padding:var(--space-1) var(--space-2);font-size:var(--text-sm);'
            + (item.done ? 'text-decoration:line-through;color:var(--color-text-muted);' : '');

          const del = document.createElement('button');
          del.type = 'button';
          del.textContent = '×';
          del.title = 'Remove item';
          del.style.cssText = 'background:none;border:none;cursor:pointer;color:var(--color-text-muted);font-size:var(--text-lg);line-height:1;padding:0 var(--space-1);flex-shrink:0;';

          // IIFE captures stable idx — prevents classic for-loop closure bug where all
          // event handlers would reference the final value of i after the loop ends.
          (function(idx) {
            cb.addEventListener('change', () => {
              items[idx].done = cb.checked;
              txt.style.textDecoration = cb.checked ? 'line-through' : 'none';
              txt.style.color = cb.checked ? 'var(--color-text-muted)' : 'var(--color-text)';
              _syncDraft();
            });
            txt.addEventListener('input', () => {
              items[idx].text = txt.value;
              _syncDraft();
            });
            del.addEventListener('click', () => {
              items.splice(idx, 1);
              _syncDraft();
              _renderItems();
            });
          })(i);

          row.append(cb, txt, del);
          wrap.appendChild(row);
        }
        wrap.appendChild(addBtn); // stable node re-appended each render
      }

      _renderItems();
      return wrap;
    }

    // ── TAGS (multiselect with chip + create) ─────────────── //
    case 'tags':
    case 'multiselect': {
      if (!_tagValues.has(field.key)) {
        _tagValues.set(field.key, Array.isArray(existing) ? [...existing] : []);
      }
      return _buildTagControl(field);
    }

    // ── RELATION (search-as-you-type) ─────────────────────── //
    case 'relation': {
      if (!_relationValues.has(field.key)) {
        _relationValues.set(field.key, []);
      }
      return _buildRelationControl(field, config);
    }

    default:
      return null;
  }
}

// ════════════════════════════════════════════════════════════
// TAG CONTROL
// ════════════════════════════════════════════════════════════

function _buildTagControl(field) {
  const wrap = document.createElement('div');
  wrap.className   = 'ef-tag-control';
  wrap.dataset.key = field.key;

  const _render = () => {
    wrap.innerHTML = '';
    const chipRow = document.createElement('div');
    chipRow.style.cssText = 'display: flex; flex-wrap: wrap; gap: var(--space-1); align-items: center; padding: var(--space-2); border: 1px solid var(--color-border); border-radius: var(--radius-sm); min-height: 42px; background: var(--color-bg); cursor: text;';

    const tags = _tagValues.get(field.key) || [];
    for (let i = 0; i < tags.length; i++) {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.style.cssText = 'display: inline-flex; align-items: center; gap: 4px;';
      chip.innerHTML = `<span>${tags[i]}</span>`;

      const rm = document.createElement('span');
      rm.textContent = '×';
      rm.style.cssText = 'cursor: pointer; font-weight: bold; color: var(--color-text-muted); margin-left: 2px;';
      rm.addEventListener('click', () => {
        const arr = _tagValues.get(field.key) || [];
        arr.splice(i, 1);
        _tagValues.set(field.key, arr);
        _render();
      });
      chip.appendChild(rm);
      chipRow.appendChild(chip);
    }

    // Input
    const input = document.createElement('input');
    input.type        = 'text';
    input.placeholder = tags.length ? '' : `Add ${field.label.toLowerCase()}…`;
    input.style.cssText = 'border: none; outline: none; font-size: var(--text-sm); background: transparent; min-width: 80px; flex: 1; font-family: var(--font-body);';

    input.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ',') && input.value.trim()) {
        e.preventDefault();
        const val = input.value.trim().replace(/,$/, '');
        if (val) {
          const arr = _tagValues.get(field.key) || [];
          if (!arr.includes(val)) arr.push(val);
          _tagValues.set(field.key, arr);
        }
        _render();
      }
      if (e.key === 'Backspace' && !input.value) {
        const arr = _tagValues.get(field.key) || [];
        if (arr.length) { arr.pop(); _tagValues.set(field.key, arr); _render(); }
      }
    });
    input.addEventListener('blur', () => {
      const val = input.value.trim();
      if (val) {
        const arr = _tagValues.get(field.key) || [];
        if (!arr.includes(val)) arr.push(val);
        _tagValues.set(field.key, arr);
        _render();
      }
    });

    chipRow.appendChild(input);
    chipRow.addEventListener('click', () => input.focus());
    wrap.appendChild(chipRow);

    const hint = document.createElement('span');
    hint.className    = 'form-hint';
    hint.textContent  = 'Press Enter or comma to add';
    wrap.appendChild(hint);
  };

  _render();
  return wrap;
}

// ════════════════════════════════════════════════════════════
// RELATION CONTROL
// ════════════════════════════════════════════════════════════

function _buildRelationControl(field, config) {
  const wrap = document.createElement('div');
  wrap.className   = 'ef-relation-control';
  wrap.dataset.key = field.key;

  const chipRow = document.createElement('div');
  chipRow.style.cssText = 'display: flex; flex-wrap: wrap; gap: var(--space-1); margin-bottom: var(--space-1);';
  wrap.appendChild(chipRow);

  const searchInput = document.createElement('input');
  searchInput.type        = 'text';
  searchInput.className   = 'input';
  searchInput.placeholder = `Search ${field.relatesTo || 'entities'}…`;
  searchInput.autocomplete = 'off';
  wrap.appendChild(searchInput);

  const results = document.createElement('div');
  results.style.cssText = `
    max-height: 140px; overflow-y: auto; border: 1px solid var(--color-border);
    border-top: none; border-radius: 0 0 var(--radius-sm) var(--radius-sm);
    display: none; background: var(--color-bg);
  `;
  wrap.appendChild(results);

  const _renderChips = () => {
    chipRow.innerHTML = '';
    const ids = _relationValues.get(field.key) || [];
    for (let i = 0; i < ids.length; i++) {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.style.cssText = 'display: inline-flex; align-items: center; gap: 4px;';
      // Show ID shortened as placeholder — resolved at save time
      chip.dataset.id = ids[i].id;

      const label = document.createElement('span');
      label.textContent = ids[i].label || ids[i].id;
      chip.appendChild(label);

      const rm = document.createElement('span');
      rm.textContent = '×';
      rm.style.cssText = 'cursor: pointer; font-weight: bold; color: var(--color-text-muted); margin-left: 2px;';
      rm.addEventListener('click', () => {
        const arr = _relationValues.get(field.key) || [];
        arr.splice(i, 1);
        _renderChips();
      });
      chip.appendChild(rm);
      chipRow.appendChild(chip);
    }
  };

  const _search = async (query) => {
    if (!field.relatesTo) { results.style.display = 'none'; return; }

    let candidates = [];
    try {
      candidates = await getEntitiesByType(field.relatesTo);
    } catch { return; }

    const filtered = candidates.filter(e => {
      if (e.deleted) return false;
      return !query || _getDisplayTitle(e).toLowerCase().includes(query.toLowerCase());
    }).slice(0, 8);

    results.innerHTML = '';
    if (filtered.length === 0) {
      results.style.display = 'none';
      return;
    }

    results.style.display = 'block';
    for (const candidate of filtered) {
      const cfg    = getEntityTypeConfig(candidate.type);
      const title  = _getDisplayTitle(candidate);

      const item = document.createElement('div');
      item.style.cssText = `
        display: flex; align-items: center; gap: var(--space-2);
        padding: var(--space-2) var(--space-3); cursor: pointer;
        font-size: var(--text-sm); transition: background var(--transition-fast);
      `;
      item.innerHTML = `<span>${cfg?.icon || '📎'}</span><span>${title}</span>`;
      item.addEventListener('mouseenter', () => { item.style.background = 'var(--color-surface-2)'; });
      item.addEventListener('mouseleave', () => { item.style.background = 'none'; });
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const arr = _relationValues.get(field.key) || [];
        if (!arr.find(r => r.id === candidate.id)) {
          arr.push({ id: candidate.id, label: title, type: candidate.type });
          _relationValues.set(field.key, arr);
        }
        _renderChips();
        searchInput.value = '';
        results.style.display = 'none';
      });
      results.appendChild(item);
    }
  };

  searchInput.addEventListener('input', () => _search(searchInput.value));
  searchInput.addEventListener('focus', () => _search(searchInput.value));
  searchInput.addEventListener('blur', () => {
    setTimeout(() => { results.style.display = 'none'; }, 150);
  });

  _renderChips();
  return wrap;
}

// ════════════════════════════════════════════════════════════
// SUBMIT / SAVE
// ════════════════════════════════════════════════════════════

async function _submitForm() {
  if (!_typeKey) return;

  const config = getEntityTypeConfig(_typeKey);
  if (!config) return;

  // Sync draft from live form
  _saveDraftFromForm();

  // ── Validate required fields ──────────────────────────── //
  let valid = true;

  for (const field of config.fields) {
    const group = _overlay?.querySelector(`[data-field="${field.key}"]`);
    const errEl = group?.querySelector('.ef-field-error');

    if (!field.required) continue;

    const val = field.type === 'tags'     ? _tagValues.get(field.key)
              : field.type === 'relation' ? _relationValues.get(field.key)
              : _draft[field.key];

    const isEmpty = val === null || val === undefined || val === ''
                 || (Array.isArray(val) && val.length === 0);

    if (isEmpty) {
      valid = false;
      if (errEl) {
        errEl.textContent = `${field.label} is required`;
        errEl.style.display = 'block';
      }
      if (group) {
        const control = group.querySelector('input, select, [contenteditable]');
        control?.focus();
      }
    } else {
      if (errEl) errEl.style.display = 'none';
    }
  }

  if (!valid) return;

  // ── Show saving state ─────────────────────────────────── //
  const saveBtn = _overlay?.querySelector('.ef-save-btn');
  if (saveBtn) {
    saveBtn.disabled     = true;
    saveBtn.textContent  = 'Saving…';
  }

  try {
    // ── Build entity object ───────────────────────────────── //
    const entityData = {
      ..._editEntity,          // preserve id, createdAt, createdBy if editing
      type: _typeKey,
    };

    for (const field of config.fields) {
      if (field.type === 'tags') {
        entityData[field.key] = _tagValues.get(field.key) || [];
      } else if (field.type === 'relation') {
        // Relations handled via edges — don't store on entity
      } else {
        const val = _draft[field.key];
        if (val !== undefined) {
          // GUARD: Never let a field named 'type' overwrite the structural entity type.
          // Store it under a safe alias instead (e.g. 'eventType', 'category').
          if (field.key === 'type') {
            entityData._subtype = val;       // preserved for display
            // Also keep the field.key so reads work — but re-assert structural type after
          } else {
            entityData[field.key] = val;
          }
        }
      }
    }

    // Re-assert structural type AFTER field loop to guard against any
    // field.key collision (e.g. event has a 'type' select field for
    // Family/School/Work which would overwrite entity.type).
    entityData.type = _typeKey;

    // ── Save entity ───────────────────────────────────────── //
    const saved = await saveEntity(entityData);

    // ── Save relation edges ───────────────────────────────── //
    for (const field of config.fields) {
      if (field.type !== 'relation') continue;
      const targets = _relationValues.get(field.key) || [];
      for (const target of targets) {
        try {
          await saveEdge({
            fromId:   saved.id,
            fromType: saved.type,
            toId:     target.id,
            toType:   target.type || field.relatesTo || '',
            relation: field.key,
          });
        } catch (edgeErr) {
          console.warn('[entity-form] Edge save failed:', edgeErr);
        }
      }
    }

    // ── Callback & close ──────────────────────────────────── //
    const cb = _onSave;
    closeForm();
    cb?.(saved);

    emit(EVENTS.ENTITY_SAVED, { entity: saved, isNew: !_editEntity });

  } catch (err) {
    console.error('[entity-form] Save failed:', err);
    if (saveBtn) {
      saveBtn.disabled    = false;
      saveBtn.textContent = _editEntity ? 'Save changes' : `Create ${config?.label}`;
    }
    // Show global error
    const body = _overlay?.querySelector('.ef-body');
    if (body) {
      let errBanner = body.querySelector('.ef-global-error');
      if (!errBanner) {
        errBanner = document.createElement('div');
        errBanner.className = 'ef-global-error';
        errBanner.style.cssText = `
          background: var(--color-danger-bg); color: var(--color-danger-text);
          border: 1px solid var(--color-danger); border-radius: var(--radius-sm);
          padding: var(--space-2) var(--space-3); font-size: var(--text-sm);
          margin-bottom: var(--space-3);
        `;
        body.insertBefore(errBanner, body.firstChild);
      }
      errBanner.textContent = `Save failed: ${err.message || 'Unknown error'}`;
    }
  }
}

// ════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════

/**
 * Sync live input values into _draft (for fields not already updating on input).
 */
function _saveDraftFromForm() {
  if (!_overlay || !_typeKey) return;
  const config = getEntityTypeConfig(_typeKey);
  if (!config) return;

  for (const field of config.fields) {
    if (['relation', 'tags', 'multiselect', 'richtext', 'checkbox', 'checklist'].includes(field.type)) continue;

    const el = _overlay.querySelector(`#ef-field-${field.key}`);
    if (!el) continue;

    if (el.tagName === 'SELECT') {
      _draft[field.key] = el.value || null;
    } else if (el.tagName === 'INPUT') {
      if (el.type === 'number') {
        _draft[field.key] = el.value !== '' ? Number(el.value) : null;
      } else {
        _draft[field.key] = el.value.trim() || null;
      }
    }
  }

  // Sync richtext editors
  _overlay.querySelectorAll('.ef-richtext-editor').forEach(ed => {
    const key = ed.closest('[data-field]')?.dataset.field;
    if (key) _draft[key] = ed.textContent.trim() || null;
  });
}

/** Get title field key for a given entity type */
function _getTitleKey(type) {
  const cfg = getEntityTypeConfig(type);
  if (!cfg) return 'title';
  const tf = cfg.fields.find(f => f.isTitle);
  return tf ? tf.key : 'title';
}

/** Get display title for any entity (derives from body for types without isTitle) */
function _getDisplayTitle(entity) {
  if (!entity) return 'Untitled';
  const cfg = getEntityTypeConfig(entity.type);
  if (!cfg) return entity.title || entity.name || 'Untitled';
  const tf = cfg.fields.find(f => f.isTitle);
  if (tf) return entity[tf.key] || 'Untitled';
  const bodyField = cfg.fields.find(f => f.type === 'richtext' || f.type === 'text');
  if (bodyField && entity[bodyField.key]) {
    const plain = String(entity[bodyField.key]).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    if (plain.length > 40) return plain.slice(0, 40) + '…';
    if (plain) return plain;
  }
  return entity.title || entity.name || 'Untitled';
}

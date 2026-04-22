/**
 * FamilyHub v2.0 — views/kanban.js
 * 4-column Kanban board: Inbox · In Progress · Review · Done
 * Renders into #view-kanban when view="kanban"
 *
 * Features:
 *   - Task cards: checkbox, title, project chip, assignee avatars, priority dot,
 *     due date, tag chips, blocker indicator
 *   - Filter bar: project, assignee, tag, priority, overdue-only
 *   - Sort per column: Deadline First / Priority / Date Created
 *   - Quick-add per column (inline title → Enter)
 *   - Mouse + touch drag-and-drop between columns
 *   - Click card → opens entity panel
 *
 * Registration: registerView('kanban', renderKanban)
 */

import { registerView }                         from '../core/router.js';
import { getEntitiesByType, getEdgesFrom,
         saveEntity }                            from '../core/db.js';
import { emit, on, EVENTS }                      from '../core/events.js';
import { getAccount }                            from '../core/auth.js';

// ── Constants ─────────────────────────────────────────────── //

const COLUMNS = [
  { key: 'Inbox',       label: 'Inbox',       color: 'var(--kanban-inbox)' },
  { key: 'In Progress', label: 'In Progress', color: 'var(--kanban-progress)' },
  { key: 'Review',      label: 'Review',      color: 'var(--kanban-review)' },
  { key: 'Done',        label: 'Done',        color: 'var(--kanban-done)' },
];

const PRIORITY_ORDER = { Critical: 0, High: 1, Medium: 2, Low: 3 };
const PRIORITY_COLORS = {
  Critical: 'var(--color-danger)',
  High:     'var(--color-warning)',
  Medium:   'var(--color-info)',
  Low:      'var(--color-text-muted)',
};

const SORT_OPTIONS = [
  { key: 'deadline',  label: 'Deadline First' },
  { key: 'priority',  label: 'Priority' },
  { key: 'created',   label: 'Date Created' },
];

// ── Module state ──────────────────────────────────────────── //

let _tasks      = [];
let _persons    = [];
let _projects   = [];
let _personMap  = new Map();
let _projectMap = new Map();
let _blockMap   = new Map(); // taskId → true if blocked by incomplete task

// Filter state
let _filterProject   = null;   // project ID or null
let _filterAssignees = new Set();
let _filterTags      = new Set();
let _filterPriority  = null;   // 'Critical' | 'High' | ... | null
let _filterOverdue   = false;

// Sort state per column key
let _sortBy = {};  // { 'Inbox': 'deadline', ... }

// Drag state
let _dragTaskId = null;
let _dragEl     = null;
let _dragGhost  = null;
let _dropTarget = null;

// ── Data loading ──────────────────────────────────────────── //

async function _loadData() {
  const [tasks, persons, projects] = await Promise.all([
    getEntitiesByType('task'),
    getEntitiesByType('person'),
    getEntitiesByType('project'),
  ]);

  _tasks    = tasks.filter(t => !t.deleted);
  _persons  = persons;
  _projects = projects.filter(p => !p.deleted);

  _personMap  = new Map(persons.map(p  => [p.id, p]));
  _projectMap = new Map(projects.map(pr => [pr.id, pr]));

  // Build blocker map: for each task, check if it has blockedBy edges to incomplete tasks
  await _buildBlockerMap();
}

async function _buildBlockerMap() {
  _blockMap.clear();
  const doneSet = new Set(['Done', 'done']);
  for (const task of _tasks) {
    const edges = await getEdgesFrom(task.id, 'blockedBy');
    if (edges.length === 0) continue;
    const isBlocked = edges.some(edge => {
      const blocker = _tasks.find(t => t.id === edge.toId);
      return blocker && !doneSet.has(blocker.status);
    });
    if (isBlocked) _blockMap.set(task.id, true);
  }
}

// ── Filter / sort helpers ─────────────────────────────────── //

function _applyFilters(tasks) {
  return tasks.filter(t => {
    if (_filterProject && t.project !== _filterProject) {
      // Check edges too — project might be linked via edge
      return false;
    }
    if (_filterAssignees.size > 0 && !_filterAssignees.has(t.assignedTo)) return false;
    if (_filterTags.size > 0) {
      const taskTags = new Set(t.tags || []);
      let hasMatch = false;
      for (const ft of _filterTags) {
        if (taskTags.has(ft)) { hasMatch = true; break; }
      }
      if (!hasMatch) return false;
    }
    if (_filterPriority && t.priority !== _filterPriority) return false;
    if (_filterOverdue) {
      const today = _todayStr();
      const due = t.dueDate ? t.dueDate.slice(0, 10) : null;
      if (!due || due >= today) return false;
    }
    return true;
  });
}

function _sortTasks(tasks, colKey) {
  const sortKey = _sortBy[colKey] || 'deadline';
  return [...tasks].sort((a, b) => {
    switch (sortKey) {
      case 'deadline': {
        const aDue = a.dueDate || '9999-99-99';
        const bDue = b.dueDate || '9999-99-99';
        return aDue.localeCompare(bDue);
      }
      case 'priority': {
        const ap = PRIORITY_ORDER[a.priority] ?? 99;
        const bp = PRIORITY_ORDER[b.priority] ?? 99;
        return ap - bp;
      }
      case 'created':
        return (b.createdAt || '').localeCompare(a.createdAt || '');
      default:
        return 0;
    }
  });
}

function _todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function _collectAllTags() {
  const tags = new Set();
  for (const t of _tasks) {
    if (Array.isArray(t.tags)) t.tags.forEach(tg => tags.add(tg));
  }
  return [...tags].sort();
}

function _collectAssignees() {
  const ids = new Set();
  for (const t of _tasks) {
    if (t.assignedTo) ids.add(t.assignedTo);
  }
  return [...ids].map(id => _personMap.get(id)).filter(Boolean);
}

// ── DOM: Filter bar ───────────────────────────────────────── //

function _buildFilterBar(container) {
  const bar = document.createElement('div');
  bar.className = 'kanban-filter-bar';

  // Project dropdown
  const projSelect = document.createElement('select');
  projSelect.className = 'select kanban-filter-select';
  projSelect.innerHTML = '<option value="">All Projects</option>';
  for (const p of _projects) {
    if (p.status === 'Archived') continue;
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `📁 ${p.name || 'Untitled'}`;
    if (p.id === _filterProject) opt.selected = true;
    projSelect.appendChild(opt);
  }
  projSelect.addEventListener('change', () => {
    _filterProject = projSelect.value || null;
    _rerenderColumns();
  });
  bar.appendChild(projSelect);

  // Priority dropdown
  const prioSelect = document.createElement('select');
  prioSelect.className = 'select kanban-filter-select';
  prioSelect.innerHTML = '<option value="">All Priorities</option>';
  for (const p of ['Critical', 'High', 'Medium', 'Low']) {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = p;
    if (p === _filterPriority) opt.selected = true;
    prioSelect.appendChild(opt);
  }
  prioSelect.addEventListener('change', () => {
    _filterPriority = prioSelect.value || null;
    _rerenderColumns();
  });
  bar.appendChild(prioSelect);

  // Assignee avatars
  const assignees = _collectAssignees();
  if (assignees.length) {
    const assigneeWrap = document.createElement('div');
    assigneeWrap.className = 'kanban-filter-avatars';
    for (const person of assignees) {
      const av = document.createElement('button');
      av.className = 'kanban-filter-avatar' + (_filterAssignees.has(person.id) ? ' active' : '');
      av.title = person.name || person.id;
      av.textContent = (person.name || '?').charAt(0).toUpperCase();
      av.addEventListener('click', () => {
        if (_filterAssignees.has(person.id)) _filterAssignees.delete(person.id);
        else _filterAssignees.add(person.id);
        _rerenderColumns();
        av.classList.toggle('active');
      });
      assigneeWrap.appendChild(av);
    }
    bar.appendChild(assigneeWrap);
  }

  // Tag chips
  const allTags = _collectAllTags();
  if (allTags.length) {
    const tagWrap = document.createElement('div');
    tagWrap.className = 'kanban-filter-tags';
    for (const tag of allTags.slice(0, 8)) {
      const chip = document.createElement('button');
      chip.className = 'kanban-filter-tag' + (_filterTags.has(tag) ? ' active' : '');
      chip.textContent = tag;
      chip.addEventListener('click', () => {
        if (_filterTags.has(tag)) _filterTags.delete(tag);
        else _filterTags.add(tag);
        _rerenderColumns();
        chip.classList.toggle('active');
      });
      tagWrap.appendChild(chip);
    }
    bar.appendChild(tagWrap);
  }

  // Overdue toggle
  const overdueBtn = document.createElement('button');
  overdueBtn.className = 'btn btn-ghost btn-sm kanban-overdue-btn' + (_filterOverdue ? ' active' : '');
  overdueBtn.textContent = '⏰ Overdue';
  overdueBtn.addEventListener('click', () => {
    _filterOverdue = !_filterOverdue;
    overdueBtn.classList.toggle('active');
    _rerenderColumns();
  });
  bar.appendChild(overdueBtn);

  // Clear filters
  const clearBtn = document.createElement('button');
  clearBtn.className = 'btn btn-ghost btn-xs kanban-clear-btn';
  clearBtn.textContent = '✕ Clear';
  clearBtn.addEventListener('click', () => {
    _filterProject   = null;
    _filterAssignees.clear();
    _filterTags.clear();
    _filterPriority  = null;
    _filterOverdue   = false;
    renderKanban({ _internal: true });
  });
  bar.appendChild(clearBtn);

  container.appendChild(bar);
}

// ── DOM: Columns ──────────────────────────────────────────── //

let _boardEl = null;

function _buildBoard(container) {
  _boardEl = document.createElement('div');
  _boardEl.className = 'kanban-board';
  container.appendChild(_boardEl);
  _rerenderColumns();
}

function _rerenderColumns() {
  if (!_boardEl) return;
  _boardEl.innerHTML = '';

  const filtered = _applyFilters(_tasks);

  for (const col of COLUMNS) {
    const colTasks = _sortTasks(
      filtered.filter(t => t.status === col.key),
      col.key
    );
    _buildColumn(_boardEl, col, colTasks);
  }
}

function _buildColumn(board, col, tasks) {
  const colEl = document.createElement('div');
  colEl.className = 'kanban-col';
  colEl.dataset.status = col.key;

  // Header
  const header = document.createElement('div');
  header.className = 'kanban-col-header';
  header.innerHTML = `
    <span class="kanban-col-dot" style="background:${col.color}"></span>
    <span class="kanban-col-label">${_esc(col.label)}</span>
    <span class="kanban-col-count">${tasks.length}</span>
  `;

  // Sort dropdown
  const sortSelect = document.createElement('select');
  sortSelect.className = 'kanban-sort-select';
  sortSelect.setAttribute('aria-label', `Sort ${col.label}`);
  for (const opt of SORT_OPTIONS) {
    const o = document.createElement('option');
    o.value = opt.key;
    o.textContent = opt.label;
    if ((_sortBy[col.key] || 'deadline') === opt.key) o.selected = true;
    sortSelect.appendChild(o);
  }
  sortSelect.addEventListener('change', () => {
    _sortBy[col.key] = sortSelect.value;
    _rerenderColumns();
  });
  header.appendChild(sortSelect);
  colEl.appendChild(header);

  // Card list (drop zone)
  const list = document.createElement('div');
  list.className = 'kanban-card-list';
  list.dataset.status = col.key;

  for (const task of tasks) {
    const card = _buildCard(task);
    list.appendChild(card);
  }

  // Drop zone listeners
  _wireDropZone(list, col.key);

  colEl.appendChild(list);

  // Quick-add
  const quickAdd = _buildQuickAdd(col.key);
  colEl.appendChild(quickAdd);

  board.appendChild(colEl);
}

// ── DOM: Task card ────────────────────────────────────────── //

function _buildCard(task) {
  const card = document.createElement('div');
  card.className = 'kanban-card';
  card.dataset.taskId = task.id;
  card.setAttribute('draggable', 'true');

  const today = _todayStr();
  const due   = task.dueDate ? task.dueDate.slice(0, 10) : null;
  const dueCls = !due ? '' : due < today ? 'due-overdue' : due === today ? 'due-today' : 'due-future';

  // Project chip
  const proj = task.project ? _projectMap.get(task.project) : null;
  const projChip = proj
    ? `<span class="kanban-card-project" style="border-left:3px solid ${proj.color || 'var(--color-accent)'}">${_esc(proj.name || 'Project')}</span>`
    : '';

  // Assignee avatar
  const assignee = task.assignedTo ? _personMap.get(task.assignedTo) : null;
  const assigneeEl = assignee
    ? `<span class="kanban-card-avatar" title="${_esc(assignee.name || '')}">${(assignee.name || '?').charAt(0).toUpperCase()}</span>`
    : '';

  // Priority dot
  const prioDot = task.priority
    ? `<span class="kanban-card-prio-dot" style="background:${PRIORITY_COLORS[task.priority] || 'var(--color-text-muted)'}" title="${_esc(task.priority)}"></span>`
    : '';

  // Due date
  const dueEl = due
    ? `<span class="kanban-card-due ${dueCls}">${_formatDue(due, today)}</span>`
    : '';

  // Tags (first 2 + "+N")
  const tags = Array.isArray(task.tags) ? task.tags : [];
  let tagHtml = '';
  if (tags.length > 0) {
    const shown = tags.slice(0, 2).map(t => `<span class="kanban-card-tag">${_esc(t)}</span>`).join('');
    const more  = tags.length > 2 ? `<span class="kanban-card-tag kanban-card-tag-more">+${tags.length - 2}</span>` : '';
    tagHtml = shown + more;
  }

  // Blocker
  const blockerEl = _blockMap.has(task.id)
    ? `<span class="kanban-card-blocker" title="Blocked by another task">🚫</span>`
    : '';

  card.innerHTML = `
    <div class="kanban-card-top">
      <label class="kanban-card-check-label">
        <input type="checkbox" class="kanban-card-checkbox" ${task.status === 'Done' ? 'checked' : ''} />
      </label>
      <span class="kanban-card-title">${_esc(task.title || 'Untitled')}</span>
      ${prioDot}
      ${blockerEl}
    </div>
    ${projChip}
    <div class="kanban-card-bottom">
      <div class="kanban-card-tags">${tagHtml}</div>
      <div class="kanban-card-meta">
        ${dueEl}
        ${assigneeEl}
      </div>
    </div>
  `;

  // ── Click: open panel (but not when clicking checkbox) ──
  card.addEventListener('click', (e) => {
    if (e.target.closest('.kanban-card-check-label')) return;
    emit(EVENTS.PANEL_OPENED, { entityType: 'task', entityId: task.id });
  });

  // ── Checkbox: toggle complete ──
  const cb = card.querySelector('.kanban-card-checkbox');
  cb.addEventListener('change', async (e) => {
    e.stopPropagation();
    const account = getAccount();
    const newStatus = cb.checked ? 'Done' : 'Inbox';
    try {
      await saveEntity({ ...task, status: newStatus }, account?.id);
      // Reload data and re-render
      await _loadData();
      _rerenderColumns();
    } catch (err) {
      console.error('[kanban] Complete failed:', err);
      cb.checked = !cb.checked;
    }
  });

  // ── Drag start ──
  card.addEventListener('dragstart', (e) => {
    _dragTaskId = task.id;
    _dragEl     = card;
    card.classList.add('kanban-card-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', task.id);
  });

  card.addEventListener('dragend', () => {
    card.classList.remove('kanban-card-dragging');
    _clearDropIndicators();
    _dragTaskId = null;
    _dragEl     = null;
  });

  // ── Touch drag ──
  _wireTouchDrag(card, task);

  return card;
}

// ── Quick-add ─────────────────────────────────────────────── //

function _buildQuickAdd(statusKey) {
  const wrap = document.createElement('div');
  wrap.className = 'kanban-quick-add';

  const addBtn = document.createElement('button');
  addBtn.className = 'kanban-quick-add-btn';
  addBtn.textContent = '+ Add task';
  addBtn.addEventListener('click', () => {
    addBtn.style.display = 'none';
    inputWrap.style.display = 'flex';
    input.focus();
  });

  const inputWrap = document.createElement('div');
  inputWrap.className = 'kanban-quick-add-input-wrap';
  inputWrap.style.display = 'none';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'input kanban-quick-add-input';
  input.placeholder = 'Task title…';

  const doAdd = async () => {
    const title = input.value.trim();
    if (!title) {
      inputWrap.style.display = 'none';
      addBtn.style.display = '';
      return;
    }
    const account = getAccount();
    try {
      await saveEntity({
        type:     'task',
        title,
        status:   statusKey,
        priority: 'Medium',
      }, account?.id);
      input.value = '';
      await _loadData();
      _rerenderColumns();
    } catch (err) {
      console.error('[kanban] Quick add failed:', err);
    }
    // Keep input open for rapid entry
    input.focus();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doAdd(); }
    if (e.key === 'Escape') {
      input.value = '';
      inputWrap.style.display = 'none';
      addBtn.style.display = '';
    }
  });

  input.addEventListener('blur', () => {
    // Small delay so Enter fires first
    setTimeout(() => {
      if (!input.value.trim()) {
        inputWrap.style.display = 'none';
        addBtn.style.display = '';
      }
    }, 150);
  });

  inputWrap.appendChild(input);
  wrap.appendChild(addBtn);
  wrap.appendChild(inputWrap);
  return wrap;
}

// ── Drag and drop: mouse ──────────────────────────────────── //

function _wireDropZone(listEl, statusKey) {
  listEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    _showDropIndicator(listEl, e.clientY);
  });

  listEl.addEventListener('dragleave', (e) => {
    // Only clear if leaving the list entirely
    if (!listEl.contains(e.relatedTarget)) {
      _clearDropIndicators();
    }
  });

  listEl.addEventListener('drop', async (e) => {
    e.preventDefault();
    _clearDropIndicators();
    const taskId = e.dataTransfer.getData('text/plain') || _dragTaskId;
    if (!taskId) return;
    await _moveTask(taskId, statusKey);
  });
}

function _showDropIndicator(listEl, clientY) {
  // Remove existing indicators
  listEl.querySelectorAll('.kanban-drop-indicator').forEach(el => el.remove());

  const cards = [...listEl.querySelectorAll('.kanban-card:not(.kanban-card-dragging)')];
  let insertBefore = null;

  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) {
      insertBefore = card;
      break;
    }
  }

  const indicator = document.createElement('div');
  indicator.className = 'kanban-drop-indicator';

  if (insertBefore) {
    listEl.insertBefore(indicator, insertBefore);
  } else {
    listEl.appendChild(indicator);
  }
}

function _clearDropIndicators() {
  document.querySelectorAll('.kanban-drop-indicator').forEach(el => el.remove());
}

// ── Drag and drop: touch ──────────────────────────────────── //

function _wireTouchDrag(card, task) {
  let touchStartX = 0, touchStartY = 0;
  let isDragging = false;

  card.addEventListener('touchstart', (e) => {
    const touch = e.touches[0];
    touchStartX = touch.clientX;
    touchStartY = touch.clientY;
    isDragging = false;
  }, { passive: true });

  card.addEventListener('touchmove', (e) => {
    const touch = e.touches[0];
    const dx = Math.abs(touch.clientX - touchStartX);
    const dy = Math.abs(touch.clientY - touchStartY);

    // Start drag after 10px threshold
    if (!isDragging && (dx > 10 || dy > 10)) {
      isDragging = true;
      _dragTaskId = task.id;
      card.classList.add('kanban-card-dragging');

      // Create ghost
      _dragGhost = card.cloneNode(true);
      _dragGhost.className = 'kanban-card kanban-card-ghost';
      _dragGhost.style.cssText = `
        position: fixed; z-index: 9999; pointer-events: none;
        width: ${card.offsetWidth}px; opacity: 0.85;
        transform: rotate(2deg); box-shadow: var(--shadow-xl);
      `;
      document.body.appendChild(_dragGhost);
    }

    if (isDragging) {
      e.preventDefault();
      if (_dragGhost) {
        _dragGhost.style.left = `${touch.clientX - card.offsetWidth / 2}px`;
        _dragGhost.style.top  = `${touch.clientY - 20}px`;
      }

      // Find which column we're over
      const colLists = document.querySelectorAll('.kanban-card-list');
      for (const list of colLists) {
        const rect = list.getBoundingClientRect();
        if (touch.clientX >= rect.left && touch.clientX <= rect.right &&
            touch.clientY >= rect.top && touch.clientY <= rect.bottom) {
          _dropTarget = list.dataset.status;
          _showDropIndicator(list, touch.clientY);
        }
      }
    }
  }, { passive: false });

  card.addEventListener('touchend', async () => {
    if (isDragging && _dragTaskId && _dropTarget) {
      await _moveTask(_dragTaskId, _dropTarget);
    }

    // Cleanup
    card.classList.remove('kanban-card-dragging');
    _dragGhost?.remove();
    _dragGhost  = null;
    _dropTarget = null;
    _dragTaskId = null;
    isDragging  = false;
    _clearDropIndicators();
  });
}

// ── Move task to new status ───────────────────────────────── //

async function _moveTask(taskId, newStatus) {
  const task = _tasks.find(t => t.id === taskId);
  if (!task || task.status === newStatus) return;

  const account = getAccount();
  try {
    await saveEntity({ ...task, status: newStatus }, account?.id);
    await _loadData();
    _rerenderColumns();
  } catch (err) {
    console.error('[kanban] Move task failed:', err);
  }
}

// ── Helper utilities ──────────────────────────────────────── //

function _esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _formatDue(dueStr, today) {
  if (!dueStr) return '';
  if (dueStr === today) return 'Today';
  // Yesterday / Tomorrow
  const d = new Date(dueStr + 'T00:00:00');
  const t = new Date(today + 'T00:00:00');
  const diff = Math.round((d - t) / 86400000);
  if (diff === -1) return 'Yesterday';
  if (diff === 1) return 'Tomorrow';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ── Styles injection ──────────────────────────────────────── //

function _injectStyles() {
  if (document.getElementById('kanban-view-styles')) return;
  const style = document.createElement('style');
  style.id = 'kanban-view-styles';
  style.textContent = `
    /* ── Kanban Layout ─────────────────────────────── */
    #view-kanban.active {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
      padding: 0;
    }

    /* ── Filter Bar ─────────────────────────────────── */
    .kanban-filter-bar {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      padding: var(--space-3) var(--space-4);
      border-bottom: 1px solid var(--color-border);
      background: var(--color-surface);
      flex-shrink: 0;
      flex-wrap: wrap;
      overflow-x: auto;
    }
    .kanban-filter-select {
      width: auto;
      min-width: 120px;
      padding: var(--space-1) var(--space-2);
      font-size: var(--text-xs);
    }
    .kanban-filter-avatars {
      display: flex;
      gap: var(--space-1);
    }
    .kanban-filter-avatar {
      width: 26px; height: 26px;
      border-radius: var(--radius-full);
      background: var(--color-surface-2);
      color: var(--color-text-muted);
      border: 2px solid transparent;
      font-size: 11px; font-weight: var(--weight-semibold);
      display: flex; align-items: center; justify-content: center;
      cursor: pointer;
      transition: border-color var(--transition-fast), background var(--transition-fast);
    }
    .kanban-filter-avatar.active {
      border-color: var(--color-accent);
      background: var(--color-accent);
      color: #fff;
    }
    .kanban-filter-tags {
      display: flex;
      gap: var(--space-1);
      flex-wrap: wrap;
    }
    .kanban-filter-tag {
      padding: 1px var(--space-2);
      border-radius: var(--radius-full);
      border: 1px solid var(--color-border);
      background: var(--color-bg);
      font-size: var(--text-xs);
      cursor: pointer;
      color: var(--color-text-muted);
      transition: all var(--transition-fast);
    }
    .kanban-filter-tag.active {
      background: var(--color-accent);
      border-color: var(--color-accent);
      color: #fff;
    }
    .kanban-overdue-btn.active {
      background: var(--color-danger-bg);
      color: var(--color-danger-text);
      border-color: var(--color-danger);
    }
    .kanban-clear-btn { margin-left: auto; }

    /* ── Board ──────────────────────────────────────── */
    .kanban-board {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: var(--space-3);
      flex: 1;
      overflow-x: auto;
      overflow-y: hidden;
      padding: var(--space-4);
      min-height: 0;
    }
    @media (max-width: 768px) {
      .kanban-board {
        grid-template-columns: repeat(4, minmax(260px, 1fr));
      }
    }

    /* ── Column ─────────────────────────────────────── */
    .kanban-col {
      display: flex;
      flex-direction: column;
      min-height: 0;
      border-radius: var(--radius-md);
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      overflow: hidden;
    }
    .kanban-col-header {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      padding: var(--space-3) var(--space-3);
      border-bottom: 1px solid var(--color-border);
      flex-shrink: 0;
    }
    .kanban-col-dot {
      width: 10px; height: 10px;
      border-radius: var(--radius-full);
      flex-shrink: 0;
    }
    .kanban-col-label {
      font-size: var(--text-sm);
      font-weight: var(--weight-semibold);
      color: var(--color-text);
    }
    .kanban-col-count {
      font-size: var(--text-xs);
      background: var(--color-surface-2);
      color: var(--color-text-muted);
      border-radius: var(--radius-full);
      padding: 0 6px;
      font-weight: var(--weight-semibold);
      line-height: 1.6;
    }
    .kanban-sort-select {
      margin-left: auto;
      border: none;
      background: transparent;
      font-size: var(--text-xs);
      color: var(--color-text-muted);
      cursor: pointer;
      padding: 2px;
      appearance: none;
    }

    /* ── Card List ──────────────────────────────────── */
    .kanban-card-list {
      flex: 1;
      overflow-y: auto;
      padding: var(--space-2);
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      min-height: 60px;
      scrollbar-width: thin;
      scrollbar-color: var(--color-border) transparent;
    }

    /* ── Card ───────────────────────────────────────── */
    .kanban-card {
      background: var(--color-bg);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: var(--space-2-5) var(--space-3);
      cursor: pointer;
      transition: box-shadow var(--transition-fast), border-color var(--transition-fast), opacity var(--transition-fast);
      display: flex;
      flex-direction: column;
      gap: var(--space-1-5);
      user-select: none;
    }
    .kanban-card:hover {
      border-color: var(--color-accent);
      box-shadow: var(--shadow-sm);
    }
    .kanban-card-dragging {
      opacity: 0.3;
    }
    .kanban-card-ghost {
      border-color: var(--color-accent);
    }

    .kanban-card-top {
      display: flex;
      align-items: flex-start;
      gap: var(--space-2);
    }
    .kanban-card-check-label {
      cursor: pointer;
      flex-shrink: 0;
      padding-top: 2px;
    }
    .kanban-card-checkbox {
      width: 14px; height: 14px;
      cursor: pointer;
      accent-color: var(--color-accent);
    }
    .kanban-card-title {
      font-size: var(--text-sm);
      font-weight: var(--weight-medium);
      color: var(--color-text);
      flex: 1;
      word-break: break-word;
      line-height: 1.35;
    }
    .kanban-card-prio-dot {
      width: 8px; height: 8px;
      border-radius: var(--radius-full);
      flex-shrink: 0;
      margin-top: 4px;
    }
    .kanban-card-blocker {
      font-size: 12px;
      flex-shrink: 0;
      margin-top: 1px;
    }
    .kanban-card-project {
      font-size: var(--text-xs);
      color: var(--color-text-muted);
      padding-left: var(--space-2);
      display: block;
    }

    .kanban-card-bottom {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-2);
    }
    .kanban-card-tags {
      display: flex;
      gap: var(--space-1);
      flex-wrap: wrap;
    }
    .kanban-card-tag {
      font-size: 10px;
      padding: 0 5px;
      border-radius: var(--radius-full);
      background: var(--color-surface-2);
      color: var(--color-text-muted);
      border: 1px solid var(--color-border);
      line-height: 1.6;
    }
    .kanban-card-tag-more {
      background: transparent;
      border: none;
      color: var(--color-text-muted);
      font-style: italic;
    }
    .kanban-card-meta {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      flex-shrink: 0;
    }
    .kanban-card-due {
      font-size: var(--text-xs);
      font-variant-numeric: tabular-nums;
    }
    .due-overdue { color: var(--color-danger); font-weight: var(--weight-semibold); }
    .due-today   { color: var(--color-warning-text); font-weight: var(--weight-semibold); }
    .due-future  { color: var(--color-text-muted); }

    .kanban-card-avatar {
      width: 22px; height: 22px;
      border-radius: var(--radius-full);
      background: var(--color-accent);
      color: #fff;
      font-size: 10px;
      font-weight: var(--weight-semibold);
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0;
    }

    /* ── Drop indicator ─────────────────────────────── */
    .kanban-drop-indicator {
      height: 3px;
      background: var(--color-accent);
      border-radius: var(--radius-full);
      margin: var(--space-0-5) 0;
      flex-shrink: 0;
      animation: dropPulse 0.8s ease infinite alternate;
    }
    @keyframes dropPulse {
      from { opacity: 0.5; }
      to   { opacity: 1; }
    }

    /* ── Quick Add ──────────────────────────────────── */
    .kanban-quick-add {
      padding: var(--space-2) var(--space-2);
      border-top: 1px solid var(--color-border);
      flex-shrink: 0;
    }
    .kanban-quick-add-btn {
      width: 100%;
      padding: var(--space-2);
      border: 1px dashed var(--color-border);
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--color-text-muted);
      font-size: var(--text-xs);
      cursor: pointer;
      transition: border-color var(--transition-fast), color var(--transition-fast);
      font-family: var(--font-body);
    }
    .kanban-quick-add-btn:hover {
      border-color: var(--color-accent);
      color: var(--color-accent);
    }
    .kanban-quick-add-input-wrap {
      display: flex;
      gap: var(--space-2);
    }
    .kanban-quick-add-input {
      font-size: var(--text-sm);
      padding: var(--space-2);
    }

    /* ── Mobile ─────────────────────────────────────── */
    @media (max-width: 600px) {
      .kanban-filter-bar {
        padding: var(--space-2);
      }
      .kanban-board {
        padding: var(--space-2);
        gap: var(--space-2);
      }
    }
  `;
  document.head.appendChild(style);
}

// ── Main render ───────────────────────────────────────────── //

async function renderKanban(params = {}) {
  const viewEl = document.getElementById('view-kanban');
  if (!viewEl) return;

  _injectStyles();

  viewEl.innerHTML = `
    <div style="padding: var(--space-8); color: var(--color-text-muted); text-align: center;">
      Loading tasks…
    </div>
  `;

  try {
    await _loadData();
    viewEl.innerHTML = '';

    _buildFilterBar(viewEl);
    _buildBoard(viewEl);

  } catch (err) {
    console.error('[kanban] Render failed:', err);
    viewEl.innerHTML = `
      <div style="padding: var(--space-8); color: var(--color-danger-text); text-align: center;">
        Failed to load Kanban board. Please try refreshing.
      </div>
    `;
  }
}

// ── Listen for entity saves to refresh board ──────────────── //

on(EVENTS.ENTITY_SAVED, ({ entity } = {}) => {
  if (entity?.type === 'task' && _boardEl) {
    // Refresh data and re-render columns
    _loadData().then(() => _rerenderColumns()).catch(() => {});
  }
});

// ── Registration ──────────────────────────────────────────── //

registerView('kanban', renderKanban);

export { renderKanban };

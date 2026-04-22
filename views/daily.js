/**
 * FamilyHub v2.0 — views/daily.js
 * Daily Review view — renders into #view-daily when view="daily"
 *
 * Sections (all collapsible, Tasks open by default):
 *   1. Daily Note       — editable richtext, saved as note{type:"daily-note"}, autosave on blur
 *   2. Tasks            — due today or overdue (status != Done/done), sorted overdue-first then priority
 *   3. Events           — events whose date falls on today
 *   4. Notes Created    — note entities with createdAt date = today
 *   5. Activity Log     — auditLog entries for today
 *   6. Reminders        — appointment entities with reminder=true and date = today
 *   7. Birthdays/Dates  — dateEntity records whose month+day = today
 *   8. Meals Today      — mealPlan entities for today grouped by mealType
 *
 * Top bar:
 *   - Date display "Monday, April 21" with prev/next arrows
 *   - 7-day mini-calendar strip — click to jump
 *   - "Add Task" and "Add Note" quick buttons
 *
 * Section open/closed state stored in sessionStorage.
 * Registration: registerView('daily', renderDaily) called at module init.
 */

import { registerView }                    from '../core/router.js';
import { getEntitiesByType, getSetting,
         saveEntity, uid }                 from '../core/db.js';
import { emit, EVENTS }                    from '../core/events.js';
import { getAccount }                      from '../core/auth.js';

// ── Constants ─────────────────────────────────────────────── //

const PRIORITY_ORDER = { Critical: 0, High: 1, Medium: 2, Low: 3 };
const DONE_STATUSES  = new Set(['done', 'Done']);

/** sessionStorage key prefix for section open/closed state */
const SS_PREFIX = 'fh_daily_section_';

/** Default open state per section key */
const SECTION_DEFAULTS = {
  'daily-note':   true,
  'tasks':        true,
  'events':       false,
  'notes':        false,
  'wall-posts':   false,
  'comments':     false,
  'activity':     false,
  'reminders':    false,
  'birthdays':    false,
  'meals':        false,
};

// ── Module state ──────────────────────────────────────────── //

/** Currently viewed date as a Date object (local midnight) */
let _currentDate = _todayLocal();

// ── Utility helpers ───────────────────────────────────────── //

/** Return a new Date set to local midnight today */
function _todayLocal() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Convert any Date → "YYYY-MM-DD" in LOCAL timezone.
 * Never use toISOString() for date-only comparisons — it shifts by UTC offset.
 */
function _toDateStr(d) {
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, '0');
  const dy = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dy}`;
}

/**
 * Given an ISO datetime string or date string, return the local "YYYY-MM-DD".
 * Handles both "2025-04-21" and "2025-04-21T10:30:00.000Z".
 */
function _isoToLocalDate(isoStr) {
  if (!isoStr) return null;
  // If it's already a plain date string (10 chars), return as-is
  if (/^\d{4}-\d{2}-\d{2}$/.test(isoStr)) return isoStr;
  // Otherwise parse as Date and convert to local date string
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return null;
  return _toDateStr(d);
}

/**
 * Format a Date for the top-bar headline: "Monday, April 21"
 */
function _formatHeadline(d) {
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    month:   'long',
    day:     'numeric',
  });
}

/**
 * Format a Date for the week-strip label: "21"
 */
function _formatDayNum(d) {
  return d.getDate();
}

/**
 * Short weekday label for week strip: "Mon"
 */
function _formatDayName(d) {
  return d.toLocaleDateString('en-US', { weekday: 'short' });
}

/**
 * Format a time string from an ISO datetime for display: "2:30 PM"
 */
function _formatTime(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/**
 * Format an ISO datetime for the activity log: "10:32 AM"
 */
function _formatLogTime(isoStr) {
  return _formatTime(isoStr);
}

// ── Session-storage helpers ───────────────────────────────── //

function _getSectionOpen(key) {
  const stored = sessionStorage.getItem(SS_PREFIX + key);
  if (stored === null) return SECTION_DEFAULTS[key] ?? false;
  return stored === '1';
}

function _setSectionOpen(key, open) {
  sessionStorage.setItem(SS_PREFIX + key, open ? '1' : '0');
}

// ── Data loaders ──────────────────────────────────────────── //

/**
 * Load all data needed for the current date in parallel.
 * Returns an object with each section's data.
 * REVIEW 1: all getEntitiesByType calls use the correct type keys from graph-engine.js
 */
async function _loadData(dateStr) {
  const [tasks, events, notes, posts, appointments, dateEntities, mealPlans, auditLog,
         persons, projects, authData] =
    await Promise.all([
      getEntitiesByType('task'),
      getEntitiesByType('event'),
      getEntitiesByType('note'),
      getEntitiesByType('post'),
      getEntitiesByType('appointment'),
      getEntitiesByType('dateEntity'),
      getEntitiesByType('mealPlan'),
      getSetting('auditLog'),
      getEntitiesByType('person'),
      getEntitiesByType('project'),
      getSetting('auth'),
    ]);

  // Build lookup maps for relation resolution
  const personMap  = new Map(persons.map(p  => [p.id, p.name  || p.title || p.id]));
  const projectMap = new Map(projects.map(pr => [pr.id, pr.name || pr.title || pr.id]));

  // accountMap: accountId → display name
  // Each account has memberId → linked person entity → person.name
  const accountMap = new Map();
  const accounts = authData?.accounts || [];
  for (const acct of accounts) {
    const personName = acct.memberId ? personMap.get(acct.memberId) : null;
    accountMap.set(acct.id, personName || acct.username || acct.id);
  }

  return { tasks, events, notes, posts, appointments, dateEntities, mealPlans,
           auditLog: auditLog || [], personMap, projectMap, accountMap };
}

/**
 * Filter tasks: dueDate = today OR overdue (dueDate < today, status != done).
 * REVIEW 2: status comparison covers both capitalised ('Done') and lowercase ('done')
 *           using the DONE_STATUSES Set. dueDate comparisons use string compare
 *           on local date strings — safe because both sides are "YYYY-MM-DD".
 */
function _filterTasks(tasks, dateStr) {
  return tasks.filter(t => {
    if (DONE_STATUSES.has(t.status)) return false;
    const due = _isoToLocalDate(t.dueDate);
    if (!due) return false;
    // due === today OR overdue (due < today)
    return due <= dateStr;
  });
}

/**
 * Sort tasks: overdue first (red), then today's, then by priority descending.
 * REVIEW 3: priority sort uses PRIORITY_ORDER map; unknown priorities fall to 99
 *           so they sort last rather than crashing.
 */
function _sortTasks(tasks, dateStr) {
  return [...tasks].sort((a, b) => {
    const aDue = _isoToLocalDate(a.dueDate) || '';
    const bDue = _isoToLocalDate(b.dueDate) || '';
    const aOverdue = aDue < dateStr ? 0 : 1;
    const bOverdue = bDue < dateStr ? 0 : 1;
    if (aOverdue !== bOverdue) return aOverdue - bOverdue;
    const aPrio = PRIORITY_ORDER[a.priority] ?? 99;
    const bPrio = PRIORITY_ORDER[b.priority] ?? 99;
    return aPrio - bPrio;
  });
}

/**
 * Filter events: date field (ISO datetime) falls on the given dateStr.
 */
function _filterEvents(events, dateStr) {
  return events.filter(e => _isoToLocalDate(e.date) === dateStr);
}

/**
 * Filter notes created today: createdAt date = dateStr.
 * Excludes daily-note type (shown in the dedicated Daily Note section).
 */
function _filterNotes(notes, dateStr) {
  return notes.filter(n =>
    n.type !== 'daily-note' &&
    _isoToLocalDate(n.createdAt) === dateStr
  );
}

/**
 * Filter wall posts created on the given dateStr.
 */
function _filterWallPosts(posts, dateStr) {
  return posts.filter(p => _isoToLocalDate(p.createdAt) === dateStr);
}

/**
 * Filter note entities that are comments (category='Comment') created today.
 * These are comments left on wall posts via the comments-on edge.
 */
function _filterComments(notes, dateStr) {
  return notes.filter(n =>
    n.category === 'Comment' &&
    _isoToLocalDate(n.createdAt) === dateStr
  );
}

/**
 * Filter audit log to today's entries.
 * auditLog entries have .at (ISO string) and .action, .entityTitle, .byAccountId
 */
function _filterAuditLog(log, dateStr) {
  return log.filter(entry => _isoToLocalDate(entry.at) === dateStr);
}

/**
 * Filter appointments with reminder=true whose date is today.
 */
function _filterReminders(appointments, dateStr) {
  return appointments.filter(a => a.reminder && _isoToLocalDate(a.date) === dateStr);
}

/**
 * Filter dateEntities whose month+day matches today's month+day.
 * Uses the local month/day of _currentDate — not dateStr string comparison.
 * This makes birthdays/anniversaries repeat every year.
 */
function _filterDateEntities(dateEntities, currentDate) {
  const todayMonth = currentDate.getMonth() + 1;
  const todayDay   = currentDate.getDate();
  return dateEntities.filter(de => {
    const raw = de.date;
    if (!raw) return false;
    // Parse: could be "YYYY-MM-DD" or ISO datetime
    const localStr = _isoToLocalDate(raw);
    if (!localStr) return false;
    const parts = localStr.split('-');
    if (parts.length < 3) return false;
    const month = parseInt(parts[1], 10);
    const day   = parseInt(parts[2], 10);
    return month === todayMonth && day === todayDay;
  });
}

/**
 * Filter mealPlans for today, grouped by mealType.
 */
function _filterMeals(mealPlans, dateStr) {
  const todays = mealPlans.filter(mp => _isoToLocalDate(mp.date) === dateStr);
  const grouped = { Breakfast: [], Lunch: [], Dinner: [], Snack: [] };
  for (const mp of todays) {
    const slot = mp.mealType || 'Other';
    if (!grouped[slot]) grouped[slot] = [];
    grouped[slot].push(mp);
  }
  return grouped;
}

// ── Daily Note helpers ────────────────────────────────────── //

/**
 * Find the daily-note entity for a given dateStr, or return null.
 * Stored as note entity with type="daily-note" and title=dateStr.
 */
async function _loadDailyNote(dateStr) {
  const notes = await getEntitiesByType('note');
  // type field overloaded: we store dailyNote as category:"Daily" + title=dateStr
  // per spec: note entity with type="daily-note" keyed by date
  // Since entity.type is always "note" in graph-engine, we use a custom marker:
  //   entity.category === 'Daily' && entity.dailyDate === dateStr
  return notes.find(n => n.dailyDate === dateStr) || null;
}

async function _saveDailyNote(dateStr, body, existingId) {
  const account = getAccount();
  const entity = {
    id:        existingId || uid(),
    type:      'note',
    title:     `Daily Note — ${dateStr}`,
    body,
    category:  'Daily',
    dailyDate: dateStr,
  };
  return saveEntity(entity, account?.id);
}

// ── DOM builders ──────────────────────────────────────────── //

/**
 * Build the top bar: headline date, prev/next arrows, week strip, action buttons.
 */
function _buildTopBar(container, dateStr) {
  const bar = document.createElement('div');
  bar.className = 'daily-top-bar';
  bar.innerHTML = `
    <div class="daily-nav-row">
      <button class="btn-icon daily-prev-btn" title="Previous day" aria-label="Previous day">‹</button>
      <h1 class="daily-headline" id="daily-headline">${_formatHeadline(_currentDate)}</h1>
      <button class="btn-icon daily-next-btn" title="Next day" aria-label="Next day">›</button>
      <button class="btn btn-ghost btn-sm daily-today-btn" title="Go to today" aria-label="Go to today">Today</button>
      <div class="daily-quick-btns">
        <button class="btn btn-primary btn-sm daily-add-task-btn">+ Task</button>
        <button class="btn btn-ghost btn-sm daily-add-note-btn">+ Note</button>
      </div>
    </div>
    <div class="daily-week-strip" id="daily-week-strip" role="list" aria-label="Week view"></div>
  `;

  bar.querySelector('.daily-prev-btn').addEventListener('click', () => {
    _currentDate = new Date(_currentDate);
    _currentDate.setDate(_currentDate.getDate() - 1);
    renderDaily({ _internal: true });
  });

  bar.querySelector('.daily-next-btn').addEventListener('click', () => {
    _currentDate = new Date(_currentDate);
    _currentDate.setDate(_currentDate.getDate() + 1);
    renderDaily({ _internal: true });
  });

  bar.querySelector('.daily-today-btn').addEventListener('click', () => {
    _currentDate = _todayLocal();
    renderDaily({ _internal: true });
  });

  // Dim "Today" button when already viewing today
  const todayBtn = bar.querySelector('.daily-today-btn');
  if (_toDateStr(_currentDate) === _toDateStr(_todayLocal())) {
    todayBtn.disabled = true;
    todayBtn.style.opacity = '0.4';
  }

  bar.querySelector('.daily-add-task-btn').addEventListener('click', () => {
    emit(EVENTS.FAB_CREATE, { entityType: 'task', prefill: { dueDate: dateStr } });
  });

  bar.querySelector('.daily-add-note-btn').addEventListener('click', () => {
    emit(EVENTS.FAB_CREATE, { entityType: 'note', prefill: { category: 'Daily' } });
  });

  _buildWeekStrip(bar.querySelector('#daily-week-strip'), dateStr);
  container.appendChild(bar);
}

/**
 * Build the 7-day mini-calendar strip centred on _currentDate.
 * Shows 3 days before, today, 3 days after.
 */
function _buildWeekStrip(stripEl, dateStr) {
  stripEl.innerHTML = '';
  const todayStr = _toDateStr(_todayLocal());

  for (let i = -3; i <= 3; i++) {
    const d = new Date(_currentDate);
    d.setDate(d.getDate() + i);
    const ds = _toDateStr(d);
    const isActive  = ds === dateStr;
    const isToday   = ds === todayStr;

    const cell = document.createElement('button');
    cell.className = 'daily-strip-day' +
      (isActive ? ' active' : '') +
      (isToday  ? ' today'  : '');
    cell.setAttribute('role', 'listitem');
    cell.setAttribute('aria-label', d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }));
    cell.setAttribute('aria-pressed', String(isActive));
    cell.innerHTML = `
      <span class="daily-strip-dayname">${_formatDayName(d)}</span>
      <span class="daily-strip-daynum">${_formatDayNum(d)}</span>
    `;
    cell.addEventListener('click', () => {
      _currentDate = d;
      renderDaily({ _internal: true });
    });
    stripEl.appendChild(cell);
  }
}

/**
 * Build a collapsible section wrapper.
 * Returns { wrapper, body } — body is where section content goes.
 */
function _buildSection(key, icon, label, count) {
  const isOpen = _getSectionOpen(key);

  const wrapper = document.createElement('div');
  wrapper.className = 'collapsible' + (isOpen ? ' open' : '');
  wrapper.dataset.sectionKey = key;

  const countChip = count != null
    ? `<span class="daily-section-count">${count}</span>`
    : '';

  wrapper.innerHTML = `
    <button class="collapsible-header" aria-expanded="${isOpen}"
            aria-controls="daily-section-body-${key}">
      <span class="daily-section-icon" aria-hidden="true">${icon}</span>
      <span class="collapsible-title">${label}</span>
      ${countChip}
      <span class="collapsible-chevron" aria-hidden="true">›</span>
    </button>
    <div class="collapsible-body" id="daily-section-body-${key}" role="region"
         aria-label="${label}">
    </div>
  `;

  const header = wrapper.querySelector('.collapsible-header');
  const body   = wrapper.querySelector('.collapsible-body');

  header.addEventListener('click', () => {
    const nowOpen = wrapper.classList.toggle('open');
    header.setAttribute('aria-expanded', String(nowOpen));
    _setSectionOpen(key, nowOpen);
  });

  return { wrapper, body };
}

/**
 * Render an empty-state message inside a body element.
 */
function _renderEmpty(body, message) {
  body.innerHTML = `
    <div class="daily-empty">
      <span class="daily-empty-icon">🌿</span>
      <span class="daily-empty-text">${message}</span>
    </div>
  `;
}

// ── Section renderers ─────────────────────────────────────── //

/**
 * Section 1: Daily Note — editable richtext, autosave on blur.
 */
async function _renderDailyNote(container, dateStr) {
  const { wrapper, body } = _buildSection('daily-note', '📓', 'Daily Note');
  container.appendChild(wrapper);

  // Load existing note for this date
  let existingNote = await _loadDailyNote(dateStr);

  const saved   = document.createElement('span');
  saved.className = 'daily-note-saved hidden';
  saved.textContent = '✓ Saved';
  saved.setAttribute('aria-live', 'polite');

  const editor = document.createElement('div');
  editor.className = 'daily-note-editor';
  editor.contentEditable = 'true';
  editor.setAttribute('role', 'textbox');
  editor.setAttribute('aria-multiline', 'true');
  editor.setAttribute('aria-label', 'Daily note for ' + dateStr);
  editor.setAttribute('placeholder', 'Write your daily note here…');
  editor.innerHTML = existingNote?.body || '';

  let _saveTimer = null;

  const doSave = async () => {
    const body = editor.innerHTML;
    try {
      const saved_entity = await _saveDailyNote(dateStr, body, existingNote?.id);
      if (!existingNote) existingNote = saved_entity;
      else existingNote.body = body;
      // Show "Saved" indicator briefly
      saved.classList.remove('hidden');
      clearTimeout(_saveTimer);
      _saveTimer = setTimeout(() => saved.classList.add('hidden'), 2000);
    } catch (err) {
      console.error('[daily] Failed to save daily note:', err);
    }
  };

  editor.addEventListener('blur', doSave);

  body.appendChild(saved);
  body.appendChild(editor);
}

/**
 * Section 2: Tasks — due today or overdue, sorted overdue-first then priority.
 * personMap and projectMap resolve relation IDs to display names.
 */
async function _renderTasks(container, dateStr, tasks, personMap, projectMap) {
  const filtered = _sortTasks(_filterTasks(tasks, dateStr), dateStr);
  const { wrapper, body } = _buildSection('tasks', '✅', 'Tasks', filtered.length);
  container.appendChild(wrapper);

  if (!filtered.length) {
    _renderEmpty(body, 'No tasks due today — enjoy the calm!');
    return;
  }

  const account = getAccount();

  const list = document.createElement('div');
  list.className = 'daily-task-list';

  for (const task of filtered) {
    const due        = _isoToLocalDate(task.dueDate) || '';
    const isOverdue  = due < dateStr;
    const row        = document.createElement('div');
    row.className    = 'daily-task-row' + (isOverdue ? ' overdue' : '');
    row.dataset.id   = task.id;

    // Priority colour accent
    const prioClass = task.priority
      ? `prio-${task.priority.toLowerCase()}`
      : 'prio-none';

    // Resolve relation IDs to display names
    const projectName  = task.project    ? (projectMap.get(task.project)    || null) : null;
    const assigneeName = task.assignedTo ? (personMap.get(task.assignedTo)  || null) : null;

    row.innerHTML = `
      <label class="daily-task-check-label" aria-label="Mark '${_esc(task.title)}' complete">
        <input type="checkbox" class="daily-task-checkbox"
               data-id="${task.id}" aria-label="Complete task" />
      </label>
      <div class="daily-task-info daily-task-info-clickable">
        <span class="daily-task-title ${prioClass}">${_esc(task.title || 'Untitled')}</span>
        <div class="daily-task-meta">
          ${projectName  ? `<span class="chip chip-project" title="Project">📁 ${_esc(projectName)}</span>` : ''}
          ${assigneeName ? `<span class="chip chip-assignee" title="Assigned to">${_esc(_firstInitial(assigneeName))} ${_esc(assigneeName)}</span>` : ''}
          ${isOverdue
            ? `<span class="badge badge-danger" title="Overdue">Overdue · ${_esc(due)}</span>`
            : `<span class="badge badge-today">Today</span>`}
          ${task.priority ? `<span class="badge badge-prio badge-prio-${(task.priority||'').toLowerCase()}">${_esc(task.priority)}</span>` : ''}
        </div>
      </div>
    `;

    // Clicking the info area opens the entity panel; checkbox handles completion
    row.querySelector('.daily-task-info-clickable').addEventListener('click', () => {
      emit(EVENTS.PANEL_OPENED, { entityType: 'task', entityId: task.id });
    });

    const checkbox = row.querySelector('.daily-task-checkbox');
    checkbox.addEventListener('change', async () => {
      if (!checkbox.checked) return;
      try {
        const updated = { ...task, status: 'Done' };
        await saveEntity(updated, account?.id);
        // Animate removal
        row.style.opacity = '0.4';
        row.style.transition = 'opacity 0.3s';
        setTimeout(() => {
          row.remove();
          // Update count chip
          _updateSectionCount(wrapper);
        }, 350);
      } catch (err) {
        console.error('[daily] Failed to complete task:', err);
        checkbox.checked = false;
      }
    });

    list.appendChild(row);
  }

  body.appendChild(list);
}

/**
 * Section 3: Events — events whose date = today.
 */
function _renderEvents(container, dateStr, events) {
  const filtered = _filterEvents(events, dateStr)
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const { wrapper, body } = _buildSection('events', '📅', 'Events', filtered.length);
  container.appendChild(wrapper);

  if (!filtered.length) {
    _renderEmpty(body, 'Nothing on the calendar today.');
    return;
  }

  const list = document.createElement('div');
  list.className = 'daily-event-list';

  for (const ev of filtered) {
    const row = document.createElement('div');
    row.className = 'daily-event-row';
    row.innerHTML = `
      <span class="daily-event-time">${_formatTime(ev.date) || '—'}</span>
      <div class="daily-event-info">
        <span class="daily-event-title">${_esc(ev.title || 'Untitled Event')}</span>
        ${ev.location ? `<span class="daily-event-location">📍 ${_esc(ev.location)}</span>` : ''}
      </div>
    `;
    row.addEventListener('click', () => emit(EVENTS.PANEL_OPENED, { entityType: 'event', entityId: ev.id }));
    list.appendChild(row);
  }

  body.appendChild(list);
}

/**
 * Section 4: Notes Created — note entities created today.
 */
function _renderNotes(container, dateStr, notes) {
  const filtered = _filterNotes(notes, dateStr);
  const { wrapper, body } = _buildSection('notes', '📝', 'Notes Created', filtered.length);
  container.appendChild(wrapper);

  if (!filtered.length) {
    _renderEmpty(body, 'No notes created today yet.');
    return;
  }

  const list = document.createElement('div');
  list.className = 'daily-notes-list';

  for (const note of filtered) {
    const preview = _stripHtml(note.body || '').slice(0, 50);
    const row = document.createElement('div');
    row.className = 'daily-note-row';
    row.innerHTML = `
      <span class="daily-note-row-title">${_esc(note.title || 'Untitled')}</span>
      ${preview ? `<span class="daily-note-row-preview">${_esc(preview)}…</span>` : ''}
    `;
    row.addEventListener('click', () => emit(EVENTS.PANEL_OPENED, { entityType: 'note', entityId: note.id }));
    list.appendChild(row);
  }

  body.appendChild(list);
}

/**
 * Section 5: Activity Log — audit log entries for today.
 * accountMap resolves byAccountId to display name.
 * Rows are clickable to open the referenced entity.
 */
function _renderActivityLog(container, dateStr, auditLog, accountMap) {
  const filtered = _filterAuditLog(auditLog, dateStr)
    .slice(-50)          // cap at 50 most recent
    .reverse();          // newest first
  const { wrapper, body } = _buildSection('activity', '📋', 'Activity Log', filtered.length);
  container.appendChild(wrapper);

  if (!filtered.length) {
    _renderEmpty(body, 'No activity recorded today.');
    return;
  }

  const list = document.createElement('div');
  list.className = 'daily-activity-list';

  for (const entry of filtered) {
    const row = document.createElement('div');
    // Rows with an entityId are clickable
    const isClickable = !!(entry.entityId && entry.entityType);
    row.className = 'daily-activity-row' + (isClickable ? ' daily-activity-row-clickable' : '');

    const actionLabel  = _formatAction(entry.action);
    const displayName  = entry.byAccountId
      ? (accountMap.get(entry.byAccountId) || entry.byAccountId)
      : null;

    row.innerHTML = `
      <span class="daily-activity-action badge badge-action">${_esc(actionLabel)}</span>
      <span class="daily-activity-title">${_esc(entry.entityTitle || entry.entityId || '—')}</span>
      ${displayName ? `<span class="daily-activity-by">by ${_esc(displayName)}</span>` : ''}
      <span class="daily-activity-time">${_formatLogTime(entry.at)}</span>
      ${isClickable ? `<span class="daily-activity-open-hint" aria-hidden="true">↗</span>` : ''}
    `;

    if (isClickable) {
      row.addEventListener('click', () => {
        emit(EVENTS.PANEL_OPENED, { entityType: entry.entityType, entityId: entry.entityId });
      });
    }

    list.appendChild(row);
  }

  body.appendChild(list);
}

/**
 * Section 6: Reminders — appointments with reminder=true and date = today.
 */
function _renderReminders(container, dateStr, appointments) {
  const filtered = _filterReminders(appointments, dateStr)
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const { wrapper, body } = _buildSection('reminders', '🔔', 'Reminders', filtered.length);
  container.appendChild(wrapper);

  if (!filtered.length) {
    _renderEmpty(body, 'No reminders set for today.');
    return;
  }

  const list = document.createElement('div');
  list.className = 'daily-reminder-list';

  for (const appt of filtered) {
    const row = document.createElement('div');
    row.className = 'daily-reminder-row';
    row.innerHTML = `
      <span class="daily-reminder-time">${_formatTime(appt.date) || '—'}</span>
      <span class="daily-reminder-title">${_esc(appt.title || 'Untitled Reminder')}</span>
      ${appt.location ? `<span class="daily-reminder-location">📍 ${_esc(appt.location)}</span>` : ''}
    `;
    row.addEventListener('click', () => emit(EVENTS.PANEL_OPENED, { entityType: 'appointment', entityId: appt.id }));
    list.appendChild(row);
  }

  body.appendChild(list);
}

/**
 * Section 7: Birthdays / Dates — dateEntity month+day = today.
 */
function _renderBirthdays(container, dateEntities) {
  const filtered = _filterDateEntities(dateEntities, _currentDate);
  const { wrapper, body } = _buildSection('birthdays', '🎂', 'Birthdays & Dates', filtered.length);
  container.appendChild(wrapper);

  if (!filtered.length) {
    _renderEmpty(body, 'No birthdays or special dates today.');
    return;
  }

  const list = document.createElement('div');
  list.className = 'daily-birthday-list';

  for (const de of filtered) {
    // Calculate age/year if date has year info
    const yearStr = de.date ? de.date.slice(0, 4) : null;
    const year    = yearStr ? parseInt(yearStr, 10) : null;
    const age     = year ? _currentDate.getFullYear() - year : null;

    const row = document.createElement('div');
    row.className = 'daily-birthday-row';
    row.innerHTML = `
      <span class="daily-birthday-icon">${de.type === 'Birthday' ? '🎂' : de.type === 'Anniversary' ? '💍' : '🗓️'}</span>
      <div class="daily-birthday-info">
        <span class="daily-birthday-label">${_esc(de.label || de.title || 'Special Date')}</span>
        <span class="daily-birthday-meta">
          ${de.type ? _esc(de.type) : ''}
          ${age !== null && de.type === 'Birthday' ? ` · Turning ${age}` : ''}
          ${age !== null && de.type === 'Anniversary' ? ` · ${age} year${age !== 1 ? 's' : ''}` : ''}
        </span>
      </div>
    `;
    row.addEventListener('click', () => emit(EVENTS.PANEL_OPENED, { entityType: 'dateEntity', entityId: de.id }));
    list.appendChild(row);
  }

  body.appendChild(list);
}

/**
 * Section 8: Meals Today — mealPlan entities for today.
 */
function _renderMeals(container, dateStr, mealPlans) {
  const grouped = _filterMeals(mealPlans, dateStr);
  const totalCount = Object.values(grouped).reduce((n, arr) => n + arr.length, 0);
  const { wrapper, body } = _buildSection('meals', '🍽️', 'Meals Today', totalCount);
  container.appendChild(wrapper);

  if (!totalCount) {
    _renderEmpty(body, 'No meals planned for today.');
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'daily-meals-grid';

  for (const [slot, meals] of Object.entries(grouped)) {
    const col = document.createElement('div');
    col.className = 'daily-meal-slot';
    col.innerHTML = `<div class="daily-meal-slot-label">${_esc(slot)}</div>`;

    if (!meals.length) {
      col.innerHTML += `<div class="daily-meal-empty">—</div>`;
    } else {
      for (const meal of meals) {
        const item = document.createElement('div');
        item.className = 'daily-meal-item';
        item.textContent = meal.title || 'Untitled';
        item.addEventListener('click', () => emit(EVENTS.PANEL_OPENED, { entityType: 'mealPlan', entityId: meal.id }));
        col.appendChild(item);
      }
    }
    grid.appendChild(col);
  }

  body.appendChild(grid);
}

/**
 * Section 9: Wall Posts — post entities created today.
 * Shows author, post type, body snippet and optional photo thumbnail.
 */
function _renderWallPosts(container, dateStr, posts, personMap, accountMap) {
  const filtered = _filterWallPosts(posts, dateStr)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  const { wrapper, body } = _buildSection('wall-posts', '🖼️', 'Wall Posts', filtered.length);
  container.appendChild(wrapper);

  if (!filtered.length) {
    _renderEmpty(body, 'No wall posts on this day.');
    return;
  }

  const list = document.createElement('div');
  list.className = 'daily-wall-list';

  for (const post of filtered) {
    const authorId = post._authorPersonId || post.createdBy;
    const authorName = authorId ? (personMap.get(authorId) || accountMap.get(authorId) || 'Unknown') : 'Unknown';
    const postType = post.postType || 'Text';
    const typeIcons = { Text: '💬', Photo: '📷', File: '📎', Link: '🔗', Milestone: '🏆' };
    const icon = typeIcons[postType] || '💬';
    const snippet = (post.body || '').slice(0, 80) + ((post.body || '').length > 80 ? '…' : '');

    const row = document.createElement('div');
    row.className = 'daily-wall-row';
    row.innerHTML = `
      <span class="daily-wall-type-icon" title="${_esc(postType)}">${icon}</span>
      <div class="daily-wall-info">
        <span class="daily-wall-author">${_esc(authorName)}</span>
        ${snippet ? `<span class="daily-wall-snippet">${_esc(snippet)}</span>` : ''}
        <div class="daily-wall-meta">
          <span class="chip">${_esc(postType)}</span>
          ${post.pinned ? '<span class="badge badge-today">📌 Pinned</span>' : ''}
          ${(post.tags || []).map(t => `<span class="chip">#${_esc(t)}</span>`).join('')}
        </div>
      </div>
      ${post.photoUrl && post.postType === 'Photo'
        ? `<img class="daily-wall-thumb" src="${_esc(post.photoUrl)}" alt="" loading="lazy" />`
        : ''}
    `;
    row.addEventListener('click', () => emit(EVENTS.PANEL_OPENED, { entityType: 'post', entityId: post.id }));
    list.appendChild(row);
  }

  body.appendChild(list);
}

/**
 * Section 10: Comments — comment entities (category='Comment') created today.
 * Shows commenter name, the comment body, and which post it was left on.
 */
function _renderComments(container, dateStr, notes, personMap, accountMap) {
  const filtered = _filterComments(notes, dateStr)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  const { wrapper, body } = _buildSection('comments', '💬', 'Comments', filtered.length);
  container.appendChild(wrapper);

  if (!filtered.length) {
    _renderEmpty(body, 'No comments on this day.');
    return;
  }

  const list = document.createElement('div');
  list.className = 'daily-comment-list';

  for (const comment of filtered) {
    const authorId = comment._authorPersonId || comment.createdBy;
    const authorName = authorId
      ? (personMap.get(authorId) || accountMap.get(authorId) || comment._authorName || 'Unknown')
      : (comment._authorName || 'Unknown');
    const text = comment.body || comment.title || '';
    const snippet = text.slice(0, 100) + (text.length > 100 ? '…' : '');

    const row = document.createElement('div');
    row.className = 'daily-comment-row';
    row.innerHTML = `
      <span class="daily-comment-icon">💬</span>
      <div class="daily-comment-info">
        <span class="daily-comment-author">${_esc(authorName)}</span>
        <span class="daily-comment-body">${_esc(snippet)}</span>
      </div>
    `;
    // Click opens the comment entity in the panel
    row.addEventListener('click', () => emit(EVENTS.PANEL_OPENED, { entityType: 'note', entityId: comment.id }));
    list.appendChild(row);
  }

  body.appendChild(list);
}

// ── Helper utilities ──────────────────────────────────────── //

/** Escape HTML to prevent XSS */
function _esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Strip HTML tags from a string (for note preview) */
function _stripHtml(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return tmp.textContent || tmp.innerText || '';
}

/** Get first initial from a name string */
function _firstInitial(name) {
  return (name || '').charAt(0).toUpperCase();
}

/** Human-readable action label */
function _formatAction(action) {
  const map = { create: 'Created', update: 'Updated', delete: 'Deleted',
                link: 'Linked', unlink: 'Unlinked', LOGIN: 'Login', LOGOUT: 'Logout' };
  return map[action] || action || '?';
}

/**
 * Update the count chip in a section header after a task is completed.
 */
function _updateSectionCount(wrapper) {
  const rows  = wrapper.querySelectorAll('.daily-task-row');
  const chip  = wrapper.querySelector('.daily-section-count');
  if (chip) chip.textContent = String(rows.length);
}

// ── Styles injection ──────────────────────────────────────── //

/**
 * Inject Daily Review-specific styles once.
 * Uses design tokens from tokens.css — no hardcoded colours.
 */
function _injectStyles() {
  if (document.getElementById('daily-view-styles')) return;
  const style = document.createElement('style');
  style.id = 'daily-view-styles';
  style.textContent = `
    /* ── Daily View Layout ────────────────────────────── */
    #view-daily {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
      padding: var(--space-5) var(--space-6);
      max-width: 860px;
      margin: 0 auto;
      width: 100%;
    }
    @media (max-width: 600px) {
      #view-daily { padding: var(--space-3) var(--space-3); }
    }

    /* ── Top Bar ─────────────────────────────────────── */
    .daily-top-bar {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
    }
    .daily-nav-row {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      flex-wrap: wrap;
    }
    .daily-headline {
      font-family: var(--font-heading);
      font-size: var(--text-2xl);
      font-weight: var(--weight-bold);
      color: var(--color-text);
      flex: 1;
      margin: 0;
    }
    .daily-quick-btns {
      display: flex;
      gap: var(--space-2);
      margin-left: auto;
    }

    /* ── Week Strip ──────────────────────────────────── */
    .daily-week-strip {
      display: flex;
      gap: var(--space-1);
      overflow-x: auto;
      padding-bottom: var(--space-1);
    }
    .daily-strip-day {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--space-0-5);
      padding: var(--space-2) var(--space-3);
      border-radius: var(--radius-md);
      border: 1px solid var(--color-border);
      background: var(--color-surface);
      cursor: pointer;
      min-width: 52px;
      transition: background var(--transition-base);
      color: var(--color-text-muted);
      font-size: var(--text-sm);
    }
    .daily-strip-day:hover { background: var(--color-surface-2); }
    .daily-strip-day.today {
      border-color: var(--color-accent);
      color: var(--color-accent);
    }
    .daily-strip-day.active {
      background: var(--color-accent);
      border-color: var(--color-accent);
      color: #fff;
    }
    .daily-strip-dayname { font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.04em; }
    .daily-strip-daynum  { font-size: var(--text-md); font-weight: var(--weight-semibold); }

    /* ── Section Styling ─────────────────────────────── */
    .daily-section-icon { font-size: 1rem; }
    /* Within daily sections the count chip takes margin-left:auto;
       the chevron must not also do so or it pushes away from the count. */
    #view-daily .collapsible-chevron {
      margin-left: var(--space-2);
    }
    .daily-section-count {
      font-size: var(--text-xs);
      background: var(--color-surface-2);
      color: var(--color-text-muted);
      border-radius: 999px;
      padding: 1px 7px;
      font-weight: var(--weight-semibold);
      margin-left: auto;  /* pushes count + chevron to the right */
    }
    .collapsible-title {
      font-size: var(--text-sm);
      font-weight: var(--weight-semibold);
      color: var(--color-text);
    }

    /* ── Empty State ─────────────────────────────────── */
    .daily-empty {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      padding: var(--space-4) var(--space-2);
      color: var(--color-text-muted);
      font-size: var(--text-sm);
    }
    .daily-empty-icon { font-size: 1.1rem; }

    /* ── Daily Note Editor ───────────────────────────── */
    .daily-note-saved {
      font-size: var(--text-xs);
      color: var(--color-success-text);
      display: block;
      text-align: right;
      margin-bottom: var(--space-1);
      transition: opacity 0.3s;
    }
    .daily-note-saved.hidden { opacity: 0; pointer-events: none; }
    .daily-note-editor {
      min-height: 100px;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: var(--space-3);
      font-size: var(--text-sm);
      color: var(--color-text);
      background: var(--color-bg);
      outline: none;
      line-height: 1.6;
      transition: border-color var(--transition-base);
    }
    .daily-note-editor:focus { border-color: var(--color-border-focus); }
    .daily-note-editor:empty:before {
      content: attr(placeholder);
      color: var(--color-text-muted);
      pointer-events: none;
    }

    /* ── Task List ───────────────────────────────────── */
    .daily-task-list { display: flex; flex-direction: column; gap: var(--space-1-5); }
    .daily-task-row {
      display: flex;
      align-items: flex-start;
      gap: var(--space-3);
      padding: var(--space-2-5) var(--space-2);
      border-radius: var(--radius-sm);
      background: var(--color-bg);
      border: 1px solid var(--color-border);
      transition: background var(--transition-base), opacity 0.3s;
    }
    .daily-task-row:hover { background: var(--color-surface); }
    .daily-task-row.overdue { border-left: 3px solid var(--color-danger); }
    .daily-task-check-label { cursor: pointer; padding-top: 2px; flex-shrink: 0; }
    .daily-task-checkbox { width: 15px; height: 15px; cursor: pointer; accent-color: var(--color-accent); }
    .daily-task-info { flex: 1; display: flex; flex-direction: column; gap: var(--space-1); }
    .daily-task-info-clickable { cursor: pointer; }
    .daily-task-info-clickable:hover .daily-task-title { color: var(--color-accent); }
    .daily-task-title { font-size: var(--text-sm); font-weight: var(--weight-medium); color: var(--color-text); }
    .daily-task-meta { display: flex; flex-wrap: wrap; gap: var(--space-1-5); align-items: center; }

    /* Priority colour accents on title */
    .prio-critical { color: var(--color-danger); }
    .prio-high     { color: var(--color-warning-text); }
    .prio-medium   { color: var(--color-text); }
    .prio-low      { color: var(--color-text-muted); }

    /* ── Chips & Badges ──────────────────────────────── */
    .chip {
      font-size: var(--text-xs);
      padding: 1px 6px;
      border-radius: 999px;
      border: 1px solid var(--color-border);
      background: var(--color-surface-2);
      color: var(--color-text-muted);
      white-space: nowrap;
    }
    .badge {
      font-size: var(--text-xs);
      padding: 1px 7px;
      border-radius: 999px;
      font-weight: var(--weight-semibold);
      white-space: nowrap;
    }
    .badge-danger { background: var(--color-danger-bg); color: var(--color-danger-text); }
    .badge-today  { background: var(--color-success-bg); color: var(--color-success-text); }
    .badge-action { background: var(--color-info-bg); color: var(--color-info-text); }
    .badge-prio-critical { background: var(--color-danger-bg);  color: var(--color-danger-text); }
    .badge-prio-high     { background: var(--color-warning-bg); color: var(--color-warning-text); }
    .badge-prio-medium   { background: var(--color-surface-2);  color: var(--color-text-muted); }
    .badge-prio-low      { background: var(--color-surface-2);  color: var(--color-text-muted); }

    /* ── Events ──────────────────────────────────────── */
    .daily-event-list { display: flex; flex-direction: column; gap: var(--space-2); }
    .daily-event-row {
      display: flex;
      align-items: flex-start;
      gap: var(--space-3);
      padding: var(--space-2);
      border-radius: var(--radius-sm);
      cursor: pointer;
      border: 1px solid var(--color-border);
    }
    .daily-event-row:hover { background: var(--color-surface); }
    .daily-event-time { font-size: var(--text-xs); color: var(--color-text-muted); min-width: 52px; font-variant-numeric: tabular-nums; padding-top: 2px; }
    .daily-event-info { display: flex; flex-direction: column; gap: var(--space-0-5); }
    .daily-event-title { font-size: var(--text-sm); font-weight: var(--weight-medium); }
    .daily-event-location { font-size: var(--text-xs); color: var(--color-text-muted); }

    /* ── Notes ───────────────────────────────────────── */
    .daily-notes-list { display: flex; flex-direction: column; gap: var(--space-2); }
    .daily-note-row {
      display: flex;
      flex-direction: column;
      gap: var(--space-0-5);
      padding: var(--space-2);
      border-radius: var(--radius-sm);
      cursor: pointer;
      border: 1px solid var(--color-border);
    }
    .daily-note-row:hover { background: var(--color-surface); }
    .daily-note-row-title   { font-size: var(--text-sm); font-weight: var(--weight-medium); }
    .daily-note-row-preview { font-size: var(--text-xs); color: var(--color-text-muted); }

    /* ── Activity Log ────────────────────────────────── */
    .daily-activity-list { display: flex; flex-direction: column; gap: var(--space-1-5); }
    .daily-activity-row {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      font-size: var(--text-xs);
      padding: var(--space-1-5) var(--space-2);
      border-radius: var(--radius-sm);
      border: 1px solid var(--color-border);
      flex-wrap: wrap;
    }
    .daily-activity-row-clickable {
      cursor: pointer;
      transition: background var(--transition-base);
    }
    .daily-activity-row-clickable:hover {
      background: var(--color-surface);
      border-color: var(--color-accent);
    }
    .daily-activity-title { flex: 1; font-weight: var(--weight-medium); color: var(--color-text); font-size: var(--text-sm); min-width: 80px; }
    .daily-activity-by   { color: var(--color-text-muted); }
    .daily-activity-time { color: var(--color-text-muted); margin-left: auto; font-variant-numeric: tabular-nums; }
    .daily-activity-open-hint { color: var(--color-text-muted); font-size: var(--text-xs); flex-shrink: 0; }

    /* ── Reminders ───────────────────────────────────── */
    .daily-reminder-list { display: flex; flex-direction: column; gap: var(--space-2); }
    .daily-reminder-row {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      padding: var(--space-2);
      border-radius: var(--radius-sm);
      cursor: pointer;
      border: 1px solid var(--color-border);
    }
    .daily-reminder-row:hover { background: var(--color-surface); }
    .daily-reminder-time  { font-size: var(--text-xs); color: var(--color-text-muted); min-width: 52px; font-variant-numeric: tabular-nums; }
    .daily-reminder-title { font-size: var(--text-sm); font-weight: var(--weight-medium); flex: 1; }
    .daily-reminder-location { font-size: var(--text-xs); color: var(--color-text-muted); }

    /* ── Birthdays ───────────────────────────────────── */
    .daily-birthday-list { display: flex; flex-direction: column; gap: var(--space-2); }
    .daily-birthday-row {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      padding: var(--space-2);
      border-radius: var(--radius-sm);
      cursor: pointer;
      border: 1px solid var(--color-border);
    }
    .daily-birthday-row:hover { background: var(--color-surface); }
    .daily-birthday-icon  { font-size: 1.3rem; }
    .daily-birthday-info  { display: flex; flex-direction: column; gap: var(--space-0-5); }
    .daily-birthday-label { font-size: var(--text-sm); font-weight: var(--weight-medium); }
    .daily-birthday-meta  { font-size: var(--text-xs); color: var(--color-text-muted); }

    /* ── Meals ───────────────────────────────────────── */
    .daily-meals-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: var(--space-3);
    }
    @media (max-width: 600px) {
      .daily-meals-grid { grid-template-columns: repeat(2, 1fr); }
    }
    .daily-meal-slot {
      display: flex;
      flex-direction: column;
      gap: var(--space-1-5);
    }
    .daily-meal-slot-label {
      font-size: var(--text-xs);
      font-weight: var(--weight-semibold);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--color-text-muted);
    }
    .daily-meal-empty { font-size: var(--text-xs); color: var(--color-text-muted); }
    .daily-meal-item {
      font-size: var(--text-sm);
      padding: var(--space-2);
      border-radius: var(--radius-sm);
      border: 1px solid var(--color-border);
      background: var(--color-surface);
      cursor: pointer;
      transition: background var(--transition-base);
    }
    .daily-meal-item:hover { background: var(--color-surface-2); }
  `;
    /* ── Wall Posts ──────────────────────────────────────── */
    .daily-wall-list { display: flex; flex-direction: column; gap: var(--space-2); }
    .daily-wall-row {
      display: flex;
      align-items: flex-start;
      gap: var(--space-3);
      padding: var(--space-2-5) var(--space-2);
      border-radius: var(--radius-sm);
      cursor: pointer;
      border: 1px solid var(--color-border);
      transition: background var(--transition-base);
    }
    .daily-wall-row:hover { background: var(--color-surface); }
    .daily-wall-type-icon { font-size: 1.3rem; flex-shrink: 0; }
    .daily-wall-info { flex: 1; display: flex; flex-direction: column; gap: var(--space-1); min-width: 0; }
    .daily-wall-author { font-size: var(--text-sm); font-weight: var(--weight-semibold); color: var(--color-text); }
    .daily-wall-snippet { font-size: var(--text-sm); color: var(--color-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .daily-wall-meta { display: flex; flex-wrap: wrap; gap: var(--space-1); align-items: center; }
    .daily-wall-thumb { width: 52px; height: 52px; object-fit: cover; border-radius: var(--radius-sm); flex-shrink: 0; }

    /* ── Comments ─────────────────────────────────────────── */
    .daily-comment-list { display: flex; flex-direction: column; gap: var(--space-2); }
    .daily-comment-row {
      display: flex;
      align-items: flex-start;
      gap: var(--space-3);
      padding: var(--space-2-5) var(--space-2);
      border-radius: var(--radius-sm);
      cursor: pointer;
      border: 1px solid var(--color-border);
      transition: background var(--transition-base);
    }
    .daily-comment-row:hover { background: var(--color-surface); }
    .daily-comment-icon { font-size: 1.1rem; flex-shrink: 0; padding-top: 2px; }
    .daily-comment-info { flex: 1; display: flex; flex-direction: column; gap: var(--space-0-5); min-width: 0; }
    .daily-comment-author { font-size: var(--text-sm); font-weight: var(--weight-semibold); color: var(--color-text); }
    .daily-comment-body { font-size: var(--text-sm); color: var(--color-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  `;
  document.head.appendChild(style);
}

// ── Main render ───────────────────────────────────────────── //

/**
 * Main render function for the Daily Review view.
 * Called by the router whenever view='daily' is activated.
 * Also called internally when navigating prev/next day or clicking the week strip.
 * @param {object} [params={}]  - router params; pass { date: 'YYYY-MM-DD' } to jump to a date
 */
async function renderDaily(params = {}) {
  // _internal: true  → called by prev/next/strip — keep _currentDate as-is
  // params.date      → deep-link to a specific date
  // params = {}      → fresh router navigation → reset to today
  if (params?._internal) {
    // Internal re-render: _currentDate already updated by caller, do nothing
  } else if (params?.date) {
    // Deep-link to a specific date string e.g. { date: '2025-04-21' }
    const d = new Date(params.date + 'T00:00:00');
    if (!isNaN(d.getTime())) _currentDate = d;
  } else {
    // Fresh router navigation (no params or unknown params) → snap to today
    _currentDate = _todayLocal();
  }
  const viewEl = document.getElementById('view-daily');
  if (!viewEl) return;

  _injectStyles();

  // Compute date string for the current date
  const dateStr = _toDateStr(_currentDate);

  // Show loading state
  viewEl.innerHTML = `
    <div style="padding: var(--space-8); color: var(--color-text-muted); text-align: center;">
      Loading daily review…
    </div>
  `;

  try {
    // Load all data in parallel
    const { tasks, events, notes, posts, appointments, dateEntities, mealPlans, auditLog,
            personMap, projectMap, accountMap } =
      await _loadData(dateStr);

    // Clear and rebuild
    viewEl.innerHTML = '';

    // ── Top bar ──────────────────────────────────────────────
    _buildTopBar(viewEl, dateStr);

    // ── Sections container ───────────────────────────────────
    const sections = document.createElement('div');
    sections.className = 'daily-sections';
    sections.style.cssText = 'display:flex;flex-direction:column;gap:var(--space-3);';
    viewEl.appendChild(sections);

    // ── Section 1: Daily Note ────────────────────────────────
    await _renderDailyNote(sections, dateStr);

    // ── Section 2: Tasks (open by default) ───────────────────
    await _renderTasks(sections, dateStr, tasks, personMap, projectMap);

    // ── Section 3: Events ────────────────────────────────────
    _renderEvents(sections, dateStr, events);

    // ── Section 4: Notes Created ─────────────────────────────
    _renderNotes(sections, dateStr, notes);

    // ── Section 5: Wall Posts ────────────────────────────────
    _renderWallPosts(sections, dateStr, posts, personMap, accountMap);

    // ── Section 6: Comments ──────────────────────────────────
    _renderComments(sections, dateStr, notes, personMap, accountMap);

    // ── Section 7: Activity Log ──────────────────────────────
    _renderActivityLog(sections, dateStr, auditLog, accountMap);

    // ── Section 8: Reminders ─────────────────────────────────
    _renderReminders(sections, dateStr, appointments);

    // ── Section 9: Birthdays / Dates ─────────────────────────
    _renderBirthdays(sections, dateEntities);

    // ── Section 10: Meals Today ──────────────────────────────
    _renderMeals(sections, dateStr, mealPlans);

  } catch (err) {
    console.error('[daily] Render failed:', err);
    viewEl.innerHTML = `
      <div style="padding: var(--space-8); color: var(--color-danger-text); text-align: center;">
        Failed to load daily review. Please try refreshing.
      </div>
    `;
  }
}

// ── Registration ──────────────────────────────────────────── //

registerView('daily', renderDaily);

// ── Export for external use (FAB, auth.js) ────────────────── //

export { renderDaily };

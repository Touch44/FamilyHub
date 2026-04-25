/**
 * FamilyHub v2.0 — views/daily.js [minor v16]
 * Daily Review view — renders into #view-daily when view="daily"
 *
 * Sections (all collapsible):
 *   1. Tasks            — due today or overdue (status != Done/done), sorted overdue-first then priority; open by default
 *   2. Events           — events whose date falls on today
 *   3. Daily Notes      — notes connected to this date's Daily Review entity; open by default
 *   4. Wall Posts       — post entities created today
 *   5. Reminders        — appointment entities with reminder=true and date = today
 *   6. Birthdays/Dates  — dateEntity records whose month+day = today
 *   7. Meals Today      — mealPlan entities for today grouped by mealType
 *   8. Comments         — comment note entities created today
 *   9. Activity Log     — auditLog entries for today
 *
 * Top bar:
 *   - Date display "Monday, April 21" with prev/next arrows
 *   - 7-day mini-calendar strip — click to jump
 *   - "+ Add" dropdown: create any entity type and connect it to this date's Daily Review entity
 *
 * Section open/closed state stored in sessionStorage.
 * Registration: registerView('daily', renderDaily) called at module init.
 */

import { registerView, navigate, VIEW_KEYS } from '../core/router.js';
import { getEntitiesByType, getEntity, getSetting,
         saveEntity, saveEdge, getEdgesFrom }  from '../core/db.js';
import { emit, on, EVENTS }                    from '../core/events.js';
import { getAccount }                      from '../core/auth.js';

// ── Constants ─────────────────────────────────────────────── //

const PRIORITY_ORDER = { Critical: 0, High: 1, Medium: 2, Low: 3 };
const DONE_STATUSES  = new Set(['done', 'Done']);

/** sessionStorage key prefix for section open/closed state */
const SS_PREFIX = 'fh_daily_section_';

/** Default open state per section key */
const SECTION_DEFAULTS = {
  'tasks':        true,   // always open — primary work list
  'events':       true,   // open — events today are critical
  'notes':        true,   // open — quick notes
  'reminders':    true,   // open — appointment reminders are important
  'wall-posts':   false,
  'birthdays':    false,  // forced open at render time if matching dateEntities exist today
  'meals':        false,
  'comments':     false,
  'activity':     false,
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
  const [tasks, events, notes, comments, posts, appointments, dateEntities, mealPlans, auditLog,
         persons, projects, authData] =
    await Promise.all([
      getEntitiesByType('task'),
      getEntitiesByType('event'),
      getEntitiesByType('note'),
      getEntitiesByType('comment'),     // new dedicated comment type
      getEntitiesByType('post'),
      getEntitiesByType('appointment'),
      getEntitiesByType('dateEntity'),
      getEntitiesByType('mealPlan'),
      getSetting('auditLog'),
      getEntitiesByType('person'),
      getEntitiesByType('project'),
      getSetting('auth'),
    ]);

  const personMap  = new Map(persons.map(p  => [p.id, p.name  || p.title || p.id]));
  const projectMap = new Map(projects.map(pr => [pr.id, pr.name || pr.title || pr.id]));

  const accountMap = new Map();
  const accounts = authData?.accounts || [];
  for (const acct of accounts) {
    const personName = acct.memberId ? personMap.get(acct.memberId) : null;
    accountMap.set(acct.id, personName || acct.username || acct.id);
  }

  // Merge new comment entities + legacy note-comments for backward compat
  const allComments = [
    ...comments,
    ...notes.filter(n => n.category === 'Comment'),
  ];

  return { tasks, events, notes, posts, appointments, dateEntities, mealPlans,
           auditLog: auditLog || [], personMap, projectMap, accountMap, allComments };
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
 * Filter wall posts created on the given dateStr.
 */
function _filterWallPosts(posts, dateStr) {
  return posts.filter(p => _isoToLocalDate(p.createdAt) === dateStr);
}

/**
 * Filter comment entities created today.
 * Supports both new type:'comment' and legacy type:'note' category:'Comment'.
 */
function _filterComments(notes, dateStr) {
  return notes.filter(n =>
    (n.type === 'comment' || n.category === 'Comment') &&
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

// ── Daily Review entity helpers ───────────────────────────── //

/**
 * Format YYYY-MM-DD → MM-DD-YYYY for display.
 * e.g. '2026-04-20' → '04-20-2026'
 */
function _formatDateTitle(dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  const [y, m, d] = dateStr.split('-');
  return `${m}-${d}-${y}`;
}

/**
 * Find or create the single Daily Review entity for a given date string.
 * Stored as a 'dailyReview' type entity with date = dateStr and
 * title = 'Daily Review — MM-DD-YYYY'. One per date, idempotent.
 * @param {string} dateStr  'YYYY-MM-DD'
 * @returns {Promise<object>} the dailyReview entity
 */
async function _getOrCreateDailyReview(dateStr) {
  try {
    const existing = await getEntitiesByType('dailyReview');
    const found = existing.find(dr => dr.date === dateStr && !dr.deleted);
    if (found) return found;

    const account = getAccount();
    return await saveEntity({
      type:  'dailyReview',
      title: `Daily Review — ${_formatDateTitle(dateStr)}`,
      date:  dateStr,
    }, account?.id);
  } catch (err) {
    console.error('[daily] _getOrCreateDailyReview failed:', dateStr, err);
    return null;
  }
}

/**
 * Create a bidirectional edge pair between the Daily Review and a section entity.
 * Checks for existing edges first to keep things idempotent.
 * relation: 'contains' (dailyReview → entity) and 'in daily review' (entity → dailyReview)
 *
 * @param {string} drId           Daily Review entity ID
 * @param {string} entityId       Section item entity ID
 * @param {string} entityType     Section item entity type key
 * @param {Set<string>} existing  Set of entity IDs already linked (to skip)
 */
async function _linkToDailyReview(drId, entityId, entityType, existing) {
  if (!drId || !entityId || existing.has(entityId)) return;
  try {
    await saveEdge({
      fromId:   drId,
      fromType: 'dailyReview',
      toId:     entityId,
      toType:   entityType,
      relation: 'contains',
    });
  } catch (err) {
    console.warn('[daily] saveEdge contains failed:', entityId, err);
  }
}

/**
 * Sync all bidirectional links from the Daily Review for a given date to
 * every item currently visible in the Daily Review sections.
 *
 * Called after data is loaded, before rendering. Non-blocking — awaited
 * but errors are caught so they never interrupt the render.
 *
 * @param {string} dateStr
 * @param {object} data   — the loaded data object from _loadData
 * @returns {Promise<string>} the daily review entity ID (for reference)
 */
async function _syncDailyReviewLinks(dateStr, data) {
  try {
    const dr = await _getOrCreateDailyReview(dateStr);
    if (!dr) return null;

    // Build set of already-linked entity IDs to skip
    const existing = await getEdgesFrom(dr.id, 'contains');
    const linkedSet = new Set(existing.map(e => e.toId));

    // ── Notes created today (not comments) ──
    for (const n of data.notes.filter(n =>
      n.type !== 'comment' &&          // new comment entity type
      n.category !== 'Comment' &&      // legacy comment notes
      _isoToLocalDate(n.createdAt) === dateStr
    )) {
      await _linkToDailyReview(dr.id, n.id, 'note', linkedSet);
      linkedSet.add(n.id);
    }

    // Tasks and events are shown in their own dedicated sections —
    // they are NOT auto-linked to the DR to avoid polluting the Notes section.

    // ── Wall posts created today ──────────────────────────
    for (const p of data.posts.filter(p => _isoToLocalDate(p.createdAt) === dateStr)) {
      await _linkToDailyReview(dr.id, p.id, 'post', linkedSet);
      linkedSet.add(p.id);
    }

    // ── Comments created today ────────────────────────────
    for (const c of (data.allComments || []).filter(c =>
      _isoToLocalDate(c.createdAt) === dateStr
    )) {
      await _linkToDailyReview(dr.id, c.id, c.type || 'note', linkedSet);
      linkedSet.add(c.id);
    }

    // ── Reminders (appointments with reminder=true, date today) ──
    for (const a of data.appointments.filter(a =>
      a.reminder && _isoToLocalDate(a.date) === dateStr
    )) {
      await _linkToDailyReview(dr.id, a.id, 'appointment', linkedSet);
      linkedSet.add(a.id);
    }

    // ── Birthdays/Dates (month+day match) ────────────────
    const currentDate = _currentDate;
    const todayMonth = currentDate.getMonth() + 1;
    const todayDay   = currentDate.getDate();
    for (const de of data.dateEntities.filter(de => {
      const local = _isoToLocalDate(de.date);
      if (!local) return false;
      const parts = local.split('-');
      return parseInt(parts[1], 10) === todayMonth && parseInt(parts[2], 10) === todayDay;
    })) {
      await _linkToDailyReview(dr.id, de.id, 'dateEntity', linkedSet);
      linkedSet.add(de.id);
    }

    // ── Meals today ───────────────────────────────────────
    for (const mp of data.mealPlans.filter(mp => _isoToLocalDate(mp.date) === dateStr)) {
      await _linkToDailyReview(dr.id, mp.id, 'mealPlan', linkedSet);
      linkedSet.add(mp.id);
    }

    return dr.id;
  } catch (err) {
    console.error('[daily] _syncDailyReviewLinks failed:', err);
    return null;
  }
}

// ── Entity selector catalogue ─────────────────────────────── //

/**
 * All entity types available from the "+ Add" dropdown.
 * Only types that make sense to connect to a Daily Review are included.
 * dailyReview itself and tag/post are excluded.
 */
const ADD_ENTITY_TYPES = [
  { key: 'note',         icon: '📝', label: 'Note' },
  { key: 'task',         icon: '✅', label: 'Task' },
  { key: 'event',        icon: '📅', label: 'Event' },
  { key: 'appointment',  icon: '🔔', label: 'Appointment' },
  { key: 'budgetEntry',  icon: '💰', label: 'Budget Entry' },
  { key: 'mealPlan',     icon: '🍽️', label: 'Meal Plan' },
  { key: 'shoppingItem', icon: '🛒', label: 'Shopping Item' },
  { key: 'habit',        icon: '🔄', label: 'Habit' },
  { key: 'goal',         icon: '🎯', label: 'Goal' },
  { key: 'idea',         icon: '💡', label: 'Idea' },
  { key: 'research',     icon: '🔬', label: 'Research' },
  { key: 'book',         icon: '📚', label: 'Book' },
  { key: 'trip',         icon: '✈️', label: 'Trip' },
  { key: 'place',        icon: '📍', label: 'Place' },
  { key: 'weblink',      icon: '🔗', label: 'Web Link' },
  { key: 'medication',   icon: '💊', label: 'Medication' },
  { key: 'recipe',       icon: '🥗', label: 'Recipe' },
  { key: 'contact',      icon: '🧑‍💼', label: 'Contact' },
  { key: 'document',     icon: '📄', label: 'Document' },
  { key: 'project',      icon: '📁', label: 'Project' },
];

/**
 * Load ALL entities connected to the Daily Review for this date via
 * the graph edge (drId → entity, relation='contains').
 * Returns an array of entity objects (any type).
 */
async function _loadDRLinkedNotes(dateStr) {
  try {
    const dr = await _getOrCreateDailyReview(dateStr);
    if (!dr) return [];
    const edges = await getEdgesFrom(dr.id, 'contains');
    const noteEdges = edges.filter(e => e.toType === 'note');
    if (!noteEdges.length) return [];
    // Deduplicate by toId — concurrent writes (capture bar + _syncDailyReviewLinks)
    // can produce two 'contains' edges to the same entity, rendering duplicate rows.
    const seenIds = new Set();
    const uniqueEdges = noteEdges.filter(e => {
      if (seenIds.has(e.toId)) return false;
      seenIds.add(e.toId);
      return true;
    });
    const resolved = await Promise.all(
      uniqueEdges.map(e => getEntity(e.toId).catch(() => null))
    );
    return resolved.filter(n =>
      n && !n.deleted &&
      n.type !== 'comment' &&
      n.category !== 'Comment'
    );
  } catch (err) {
    console.warn('[daily] _loadDRLinkedNotes failed:', err);
    return [];
  }
}

/**
 * Create an entity via FAB, then connect it to the Daily Review once saved.
 * Listens for the next ENTITY_SAVED of matching type created AFTER this call.
 * The listener is self-cancelling after 5 minutes to avoid leaks if form is dismissed.
 */
async function _createAndLink(entityType, dateStr, prefill = {}) {
  // Get/create DR first so the ID is ready when the entity saves
  const dr = await _getOrCreateDailyReview(dateStr);
  if (!dr) {
    // DR creation failed — just open the form anyway without linking
    emit(EVENTS.FAB_CREATE, { entityType, prefill });
    return;
  }

  // Record timestamp BEFORE opening FAB so we only catch the entity created NOW
  const listenFrom = Date.now();

  // Leak-prevention: auto-cancel listener after 5 minutes
  let cancelTimer = setTimeout(() => {
    unsub();
  }, 5 * 60 * 1000);

  const unsub = on(EVENTS.ENTITY_SAVED, async ({ entity }) => {
    // Must match type AND be newly created (createdAt after we opened the form)
    if (entity?.type !== entityType) return;
    const entityTime = entity.createdAt ? new Date(entity.createdAt).getTime() : 0;
    if (entityTime < listenFrom - 1000) return; // not the one we're waiting for

    // It's ours — detach and cancel timer
    unsub();
    clearTimeout(cancelTimer);

    try {
      await saveEdge({
        fromId:   dr.id,
        fromType: 'dailyReview',
        toId:     entity.id,
        toType:   entityType,
        relation: 'contains',
      });
      console.log('[daily] linked', entityType, entity.id, '→ DR', dr.id);
    } catch (err) {
      console.warn('[daily] failed to link entity to DR:', err);
    }
    // Refresh the view to show the new entity
    renderDaily({ _internal: true });
  });

  // Open the FAB form
  emit(EVENTS.FAB_CREATE, { entityType, prefill });
}

// ── DOM builders ──────────────────────────────────────────── //

/**
 * Build the top bar: headline date, prev/next arrows, week strip, "+ Add" entity selector.
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
        <div class="daily-add-wrapper" style="position:relative;">
          <button class="btn btn-primary btn-sm daily-add-btn" aria-haspopup="true" aria-expanded="false">+ Add</button>
          <div class="daily-add-menu" role="menu" aria-label="Add entity to this day" hidden></div>
        </div>
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

  // ── "+ Add" dropdown ─────────────────────────────────────
  const addBtn  = bar.querySelector('.daily-add-btn');
  const addMenu = bar.querySelector('.daily-add-menu');

  // Populate menu items
  for (const { key, icon, label } of ADD_ENTITY_TYPES) {
    const item = document.createElement('button');
    item.className = 'daily-add-menu-item';
    item.setAttribute('role', 'menuitem');
    item.innerHTML = `<span class="daily-add-menu-icon">${icon}</span><span>${label}</span>`;
    item.addEventListener('click', () => {
      _closeAddMenu(addBtn, addMenu);
      // Build sensible prefill for date-bearing entity types
      const prefill = {};
      if (['task'].includes(key))         prefill.dueDate  = dateStr;
      if (['event', 'appointment', 'mealPlan', 'budgetEntry'].includes(key)) prefill.date = dateStr;
      if (key === 'note')                  prefill.category = 'Daily';
      _createAndLink(key, dateStr, prefill);
    });
    addMenu.appendChild(item);
  }

  addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = !addMenu.hidden;
    if (isOpen) {
      _closeAddMenu(addBtn, addMenu);
    } else {
      addMenu.hidden = false;
      addBtn.setAttribute('aria-expanded', 'true');
      // Close when clicking outside
      const outside = (ev) => {
        if (!addMenu.contains(ev.target) && ev.target !== addBtn) {
          _closeAddMenu(addBtn, addMenu);
          document.removeEventListener('click', outside);
        }
      };
      setTimeout(() => document.addEventListener('click', outside), 0);
    }
  });

  _buildWeekStrip(bar.querySelector('#daily-week-strip'), dateStr);
  container.appendChild(bar);
}

function _closeAddMenu(btn, menu) {
  menu.hidden = true;
  btn.setAttribute('aria-expanded', 'false');
}

/**
 * Build the inline quick-capture bar.
 * Sits between the day nav strip and the sections list.
 * Supports Note | Task | Idea toggle, Enter to save, Shift+Enter to open full form.
 * After save: prepends the new item to the appropriate section without full reload.
 *
 * @param {HTMLElement} container  — the viewEl to append the bar to
 * @param {string}      dateStr    — current date 'YYYY-MM-DD'
 * @param {object}      sectionRefs — { notesBody, tasksBody } live DOM refs set after render
 */
function _buildCaptureBar(container, dateStr, sectionRefs) {
  const TYPES = [
    { key: 'note', label: 'Note', icon: '📝' },
    { key: 'task', label: 'Task', icon: '✅' },
    { key: 'idea', label: 'Idea', icon: '💡' },
  ];
  let selectedType = 'note';

  const bar = document.createElement('div');
  bar.id = 'daily-capture-bar';
  bar.className = 'daily-capture-bar';

  // Type toggle pill group
  const toggles = document.createElement('div');
  toggles.className = 'daily-capture-toggles';
  toggles.setAttribute('role', 'group');
  toggles.setAttribute('aria-label', 'Entity type');

  const btnMap = {};
  for (const t of TYPES) {
    const btn = document.createElement('button');
    btn.className = 'daily-capture-type-btn' + (t.key === selectedType ? ' active' : '');
    btn.textContent = t.label;
    btn.title = `Capture as ${t.label}`;
    btn.setAttribute('aria-pressed', String(t.key === selectedType));
    btn.addEventListener('click', () => {
      selectedType = t.key;
      for (const [k, b] of Object.entries(btnMap)) {
        const on = k === selectedType;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', String(on));
      }
      inp.placeholder = _capturePlaceholder(selectedType);
      inp.focus();
    });
    btnMap[t.key] = btn;
    toggles.appendChild(btn);
  }

  // Text input
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.className = 'daily-capture-input';
  inp.placeholder = _capturePlaceholder(selectedType);
  inp.setAttribute('aria-label', 'Quick capture');
  inp.autocomplete = 'off';

  // Add (➕) button
  const addBtn = document.createElement('button');
  addBtn.className = 'daily-capture-add-btn btn btn-primary btn-sm';
  addBtn.innerHTML = '&#xFF0B;';  // ＋ fullwidth plus — avoids template literal in attr
  addBtn.title = 'Save (Enter)';
  addBtn.setAttribute('aria-label', 'Save capture');

  bar.appendChild(toggles);
  bar.appendChild(inp);
  bar.appendChild(addBtn);

  // ── Save logic ───────────────────────────────────────────────
  const doSave = async () => {
    const title = inp.value.trim();
    if (!title) return;

    // Disable while saving
    inp.disabled = true;
    addBtn.disabled = true;

    try {
      const account = getAccount();
      const now     = new Date().toISOString();

      // Build entity based on type
      const entityData = { type: selectedType, title, createdAt: now, updatedAt: now };
      if (selectedType === 'task') {
        entityData.dueDate = dateStr;
        entityData.status  = 'Todo';
        entityData.priority = 'Medium';
      } else if (selectedType === 'note') {
        entityData.category = 'Daily';
      }

      const saved = await saveEntity(entityData, account?.id);

      // Link to Daily Review
      const dr = await _getOrCreateDailyReview(dateStr);
      if (dr && saved?.id) {
        await saveEdge({
          fromId:   dr.id,
          fromType: 'dailyReview',
          toId:     saved.id,
          toType:   selectedType,
          relation: 'contains',
        });
      }

      // Prepend new item to correct live section
      if (saved?.id) {
        _prependCapturedItem(saved, selectedType, dateStr, sectionRefs);
      }

      // Clear input + show toast
      inp.value = '';
      _showCaptureToast(`${TYPES.find(t => t.key === selectedType)?.label || 'Item'} saved`);

    } catch (err) {
      console.error('[daily] Quick capture failed:', err);
      _showCaptureToast('Save failed — try again', true);
    } finally {
      inp.disabled = false;
      addBtn.disabled = false;
      inp.focus();
    }
  };

  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSave();
    } else if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      // Open full entity form
      const prefill = {};
      if (selectedType === 'task') { prefill.dueDate = dateStr; prefill.title = inp.value.trim(); }
      if (selectedType === 'note') { prefill.category = 'Daily'; prefill.title = inp.value.trim(); }
      if (selectedType === 'idea') { prefill.title = inp.value.trim(); }
      inp.value = '';
      _createAndLink(selectedType, dateStr, prefill);
    }
  });

  addBtn.addEventListener('click', doSave);

  container.appendChild(bar);
}

/** Return a placeholder hint for each capture type */
function _capturePlaceholder(type) {
  if (type === 'task') return 'New task for today…';
  if (type === 'idea') return 'Capture an idea…';
  return 'Capture a thought, task, or note…';
}

/**
 * Prepend a newly captured entity row into the live section body without full reload.
 * Works for note, task, and idea types.
 */
function _prependCapturedItem(entity, type, dateStr, sectionRefs) {
  if (type === 'note') {
    const body = sectionRefs.notesBody;
    if (!body) return;
    // Remove empty-state if present
    body.querySelector('.daily-empty')?.remove();

    const row = document.createElement('div');
    row.className = 'daily-note-row';
    row.style.cssText = 'display:flex;flex-direction:column;gap:var(--space-0-5);padding:var(--space-2-5) var(--space-3);cursor:pointer;border-radius:var(--radius-sm);transition:background var(--transition-fast);border:1px solid var(--color-border);';
    row.innerHTML = `
      <span class="daily-note-row-title" style="font-size:var(--text-sm);font-weight:var(--weight-medium);color:var(--color-text);">${_esc(entity.title)}</span>
    `;
    row.addEventListener('mouseenter', () => row.style.background = 'var(--color-surface-2)');
    row.addEventListener('mouseleave', () => row.style.background = 'none');
    row.addEventListener('click', () => _openNoteModal(entity));

    // Ensure list container exists
    let list = body.querySelector('.daily-notes-list');
    if (!list) {
      list = document.createElement('div');
      list.className = 'daily-notes-list';
      body.appendChild(list);
    }
    list.prepend(row);

    // Update count chip
    const wrapper = body.closest('.collapsible');
    if (wrapper) {
      const chip = wrapper.querySelector('.daily-section-count');
      if (chip) chip.textContent = String(list.children.length);
    }

  } else if (type === 'task') {
    const body = sectionRefs.tasksBody;
    if (!body) return;
    body.querySelector('.daily-empty')?.remove();

    const row = document.createElement('div');
    row.className = 'daily-task-row';
    row.dataset.id = entity.id;
    row.innerHTML = `
      <label class="daily-task-check-label" aria-label="Mark complete">
        <input type="checkbox" class="daily-task-checkbox" data-id="${entity.id}" aria-label="Complete task" />
      </label>
      <div class="daily-task-info daily-task-info-clickable">
        <span class="daily-task-title">${_esc(entity.title)}</span>
        <div class="daily-task-meta">
          <span class="badge badge-today">Today</span>
          <span class="badge badge-prio badge-prio-medium">Medium</span>
        </div>
      </div>
    `;
    row.querySelector('.daily-task-info-clickable').addEventListener('click', () => {
      emit(EVENTS.PANEL_OPENED, { entityType: 'task', entityId: entity.id });
    });
    const cb = row.querySelector('.daily-task-checkbox');
    cb.addEventListener('change', async () => {
      if (!cb.checked) return;
      const account = getAccount();
      await saveEntity({ ...entity, status: 'Done' }, account?.id);
      row.style.opacity = '0.4';
      row.style.transition = 'opacity 0.3s';
      setTimeout(() => {
        row.remove();
        const wrapper = body.closest('.collapsible');
        if (wrapper) _updateSectionCount(wrapper);
      }, 350);
    });

    let list = body.querySelector('.daily-task-list');
    if (!list) {
      list = document.createElement('div');
      list.className = 'daily-task-list';
      body.appendChild(list);
    }
    list.prepend(row);

    const wrapper = body.closest('.collapsible');
    if (wrapper) _updateSectionCount(wrapper);

  } else {
    // idea or other — open panel to show
    if (entity?.id) {
      setTimeout(() => emit(EVENTS.PANEL_OPENED, { entityType: type, entityId: entity.id }), 200);
    }
  }
}

/**
 * Show a brief toast notification for capture feedback.
 * Uses the existing #toast-container / .toast system from layout.css
 * so styling, z-index, and animation are consistent app-wide.
 * @param {string}  message
 * @param {boolean} isError
 */
function _showCaptureToast(message, isError = false) {
  const container = document.getElementById('toast-container');
  if (!container) return; // fallback: no-op if container absent

  const toast = document.createElement('div');
  toast.className = 'toast' + (isError ? ' error' : ' success');
  toast.textContent = message;
  toast.setAttribute('role', 'status');
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.25s';
    setTimeout(() => toast.remove(), 260);
  }, 1800);
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
 * Section 1: Notes Today — note entities created on this date, linked to the DR.
 * Clicking a note opens a centered content-focused modal (not the right panel).
 */
async function _renderDailyNotes(container, dateStr) {
  const notes = await _loadDRLinkedNotes(dateStr);
  // Force open when notes exist — ensures newly captured notes are always visible
  // after re-render, regardless of any previously stored closed state.
  if (notes.length > 0) _setSectionOpen('notes', true);
  const { wrapper, body } = _buildSection('notes', '≡', 'Notes', notes.length || null);
  container.appendChild(wrapper);

  if (!notes.length) {
    _renderEmpty(body, 'No notes for this day — use "+ Add → Note" to create one.');
    return;
  }

  const list = document.createElement('div');
  list.className = 'daily-notes-list';

  for (const note of notes) {
    const title   = note.title || 'Untitled';
    const preview = _stripHtml(note.body || '').slice(0, 80);

    const row = document.createElement('div');
    row.className = 'daily-note-row';
    row.style.cssText = 'display:flex;flex-direction:column;gap:var(--space-0-5);padding:var(--space-2-5) var(--space-3);cursor:pointer;border-radius:var(--radius-sm);transition:background var(--transition-fast);';
    row.innerHTML = `
      <span class="daily-note-row-title" style="font-size:var(--text-sm);font-weight:var(--weight-medium);color:var(--color-text);">${_esc(title)}</span>
      ${preview ? `<span class="daily-note-row-preview" style="font-size:var(--text-xs);color:var(--color-text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(preview)}${preview.length >= 80 ? '…' : ''}</span>` : ''}
    `;
    row.addEventListener('mouseenter', () => row.style.background = 'var(--color-surface-2)');
    row.addEventListener('mouseleave', () => row.style.background = 'none');
    // Open content modal for notes — NOT the right-side panel
    row.addEventListener('click', () => _openNoteModal(note));
    list.appendChild(row);
  }

  body.appendChild(list);
}

/** Note-icon map for content modal type badge — reserved for future use */

/**
 * Open a centered content-focused modal for a note or content-first entity.
 * Shows the body editor prominently. Clicking outside or pressing Esc closes it.
 */
function _openNoteModal(entity) {
  // Remove any existing modal
  document.getElementById('daily-note-modal')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'daily-note-modal';
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: var(--z-modal);
    background: rgba(15,23,42,0.45); backdrop-filter: blur(2px);
    display: flex; align-items: center; justify-content: center;
    padding: var(--space-4);
  `;

  const modal = document.createElement('div');
  modal.style.cssText = `
    background: var(--color-bg); border-radius: var(--radius-lg);
    border: 1px solid var(--color-border);
    box-shadow: 0 24px 64px rgba(15,23,42,0.2);
    width: min(680px, calc(100vw - var(--space-8)));
    max-height: calc(100dvh - 80px);
    display: flex; flex-direction: column;
    overflow: hidden;
    animation: modalIn 0.18s cubic-bezier(0.4,0,0.2,1) both;
  `;

  // onEsc declared with let so closeModal can reference it before onEsc is assigned
  let onEsc;
  // _debounce declared here so closeModal can cancel a pending save on close
  let _debounce = null;

  // Centralised close — removes overlay AND cleans up the Esc listener
  const closeModal = () => {
    clearTimeout(_debounce);
    overlay.remove();
    document.removeEventListener('keydown', onEsc);
  };

  // ── Header ───────────────────────────────────────────────
  const header = document.createElement('div');
  header.style.cssText = `
    display:flex; align-items:flex-start; gap:var(--space-3);
    padding: var(--space-4) var(--space-5) var(--space-3);
    border-bottom: 1px solid var(--color-border); flex-shrink:0;
  `;

  const titleWrap = document.createElement('div');
  titleWrap.style.cssText = 'flex:1;min-width:0;';

  const titleEl = document.createElement('div');
  titleEl.style.cssText = `
    font-family: var(--font-heading); font-size: var(--text-xl);
    font-weight: 700; color: var(--color-text); line-height: 1.3;
    letter-spacing: -0.01em; cursor: pointer;
  `;
  titleEl.textContent = entity.title || 'Untitled';
  titleEl.title = 'Click to edit title';
  titleEl.addEventListener('click', () => {
    const input = document.createElement('input');
    input.style.cssText = 'width:100%;font:inherit;border:none;outline:none;background:none;color:inherit;letter-spacing:-0.01em;';
    input.value = entity.title || '';
    titleEl.replaceWith(input);
    input.focus();
    input.select();

    let _titleSaved = false;
    const saveTitle = async () => {
      if (_titleSaved) return;
      _titleSaved = true;
      entity.title = input.value.trim() || 'Untitled';
      titleEl.textContent = entity.title;
      // input may already be detached if modal closed, guard before replaceWith
      if (input.parentNode) input.replaceWith(titleEl);
      try { await saveEntity(entity); } catch (e) { console.warn('[daily-modal] title save failed', e); }
    };
    input.addEventListener('blur', saveTitle);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { input.value = entity.title || ''; input.blur(); }
    });
  });

  const dateEl = document.createElement('div');
  dateEl.style.cssText = 'font-size:var(--text-xs);color:var(--color-text-muted);margin-top:var(--space-1);';
  const created = entity.createdAt ? new Date(entity.createdAt).toLocaleDateString(undefined, { weekday:'short', month:'short', day:'numeric' }) : '';
  dateEl.textContent = created;

  titleWrap.appendChild(titleEl);
  titleWrap.appendChild(dateEl);

  // Open-in-panel button
  const panelBtn = document.createElement('button');
  panelBtn.style.cssText = 'background:none;border:none;cursor:pointer;color:var(--color-text-muted);font-size:0.9rem;padding:var(--space-1);border-radius:var(--radius-sm);flex-shrink:0;';
  panelBtn.title = 'Open in panel';
  panelBtn.textContent = '⊞';
  panelBtn.addEventListener('click', () => {
    closeModal();
    emit(EVENTS.PANEL_OPENED, { entityType: entity.type, entityId: entity.id });
  });

  const closeBtn = document.createElement('button');
  closeBtn.style.cssText = 'background:none;border:none;cursor:pointer;color:var(--color-text-muted);font-size:0.9rem;padding:var(--space-1);border-radius:var(--radius-sm);flex-shrink:0;';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', closeModal);

  header.appendChild(titleWrap);
  header.appendChild(panelBtn);
  header.appendChild(closeBtn);

  // ── Body: content editor ─────────────────────────────────
  const bodyWrap = document.createElement('div');
  bodyWrap.style.cssText = 'flex:1;overflow-y:auto;padding:var(--space-5);';

  const editor = document.createElement('div');
  editor.contentEditable = 'true';
  editor.className = 'panel-content-editor';
  editor.setAttribute('data-placeholder', 'Start writing…');
  editor.style.cssText = `
    min-height: 240px; font-size: var(--text-sm); line-height: 1.8;
    color: var(--color-text); outline: none; white-space: pre-wrap;
    word-break: break-word;
  `;
  editor.innerHTML = entity.body || '';

  const doSave = async () => {
    entity.body = editor.innerHTML;
    try { await saveEntity(entity); } catch (e) { console.warn('[daily-modal] save failed', e); }
  };
  const schedSave = () => { clearTimeout(_debounce); _debounce = setTimeout(doSave, 800); };
  editor.addEventListener('input', schedSave);
  // Only save on blur if the focus moved outside the modal entirely
  editor.addEventListener('blur', (e) => {
    if (!modal.contains(e.relatedTarget)) {
      clearTimeout(_debounce);
      doSave();
    }
  });

  bodyWrap.appendChild(editor);
  modal.appendChild(header);
  modal.appendChild(bodyWrap);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Close on overlay click (outside modal card)
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });

  // Assign onEsc handler (declared as let above so closeModal can reference it)
  onEsc = e => { if (e.key === 'Escape') closeModal(); };
  document.addEventListener('keydown', onEsc);

  // Focus editor
  setTimeout(() => editor.focus(), 50);
}

/**
 * Section 1: Tasks — due today or overdue, sorted overdue-first then priority.
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
 * Section 2: Events — events whose date = today.
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
 * Section 5: Activity Log — audit log entries for today.
 * accountMap resolves byAccountId to display name.
 * Rows are clickable to open the referenced entity.
 */
async function _renderActivityLog(container, dateStr, auditLog, accountMap) {
  const filtered = _filterAuditLog(auditLog, dateStr)
    .slice(-50)
    .reverse();
  const { wrapper, body } = _buildSection('activity', '📋', 'Activity Log', filtered.length);
  container.appendChild(wrapper);

  if (!filtered.length) {
    _renderEmpty(body, 'No activity recorded today.');
    return;
  }

  const list = document.createElement('div');
  list.className = 'daily-activity-list';

  // Helper: get entity name from an entity object (handles posts with .body)
  function _entityName(e) {
    if (!e) return null;
    return e.title || e.name || e.label
      || (e.body ? (typeof e.body === 'string' ? e.body.replace(/<[^>]*>/g,'').trim().slice(0,60) : null) : null)
      || null;
  }

  // Resolve entity names and existence for all entries in parallel
  const resolved = await Promise.all(filtered.map(async entry => {
    if (!entry.entityId) {
      return { entry, entity: null, exists: false, name: entry.entityTitle || '—' };
    }
    try {
      const e = await getEntity(entry.entityId);
      if (e) {
        // Entity exists and is not deleted
        const name = _entityName(e) || entry.entityTitle || entry.entityId;
        return { entry, entity: e, exists: true, name };
      } else {
        // getEntity returns null for deleted OR not-found
        // Fall back to stored entityTitle (set at write time)
        const storedName = entry.entityTitle
          ? (entry.entityTitle.match(/^[0-9a-f-]{36}$/) ? null : entry.entityTitle)
          : null;
        return { entry, entity: null, exists: false, name: storedName || 'Deleted item' };
      }
    } catch {
      return { entry, entity: null, exists: false, name: entry.entityTitle || 'Unknown' };
    }
  }));

  for (const { entry, exists, name } of resolved) {
    const row = document.createElement('div');
    const hasLink = !!(entry.entityId && entry.entityType);
    const isClickable = hasLink && exists;
    row.className = 'daily-activity-row' +
      (isClickable ? ' daily-activity-row-clickable' : '');

    const actionLabel = _formatAction(entry.action);
    const displayName = entry.byAccountId
      ? (accountMap.get(entry.byAccountId) || entry.byAccountId)
      : null;

    // Status indicator: ↗ if clickable, "✕ Deleted" badge if entity gone
    const statusHtml = !hasLink ? '' : isClickable
      ? `<span class="daily-activity-open-hint" aria-hidden="true" title="Open">↗</span>`
      : `<span class="badge daily-activity-gone" title="Item no longer exists">Deleted</span>`;

    row.innerHTML = `
      <span class="daily-activity-action badge badge-action">${_esc(actionLabel)}</span>
      <span class="daily-activity-title">${_esc(name)}</span>
      ${displayName ? `<span class="daily-activity-by">by ${_esc(displayName)}</span>` : ''}
      <span class="daily-activity-time">${_formatLogTime(entry.at)}</span>
      ${statusHtml}
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
    row.addEventListener('click', () => {
      navigate(VIEW_KEYS.FAMILY_WALL, { highlightId: post.id }, 'Wall Post');
    });
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
    row.addEventListener('click', () => {
      // Navigate to Family Wall; highlight parent post if stored on comment
      const parentPostId = comment._parentPostId || null;
      navigate(VIEW_KEYS.FAMILY_WALL, parentPostId ? { highlightId: parentPostId } : {}, 'Comment');
    });
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
    #view-daily.active {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
      padding: var(--space-5) var(--space-6);
      max-width: 860px;
      margin: 0 auto;
      width: 100%;
    }
    @media (max-width: 600px) {
      #view-daily.active { padding: var(--space-3) var(--space-3); }
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

    /* ── Add Entity Dropdown ─────────────────────────── */
    .daily-add-wrapper { position: relative; }
    .daily-add-menu {
      position: absolute;
      top: calc(100% + var(--space-1));
      right: 0;
      z-index: 200;
      background: var(--color-bg);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      box-shadow: 0 8px 24px rgba(0,0,0,0.12);
      min-width: 200px;
      max-height: 360px;
      overflow-y: auto;
      padding: var(--space-1-5);
      display: flex;
      flex-direction: column;
      gap: var(--space-0-5);
    }
    .daily-add-menu[hidden] { display: none; }
    .daily-add-menu-item {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      padding: var(--space-2) var(--space-2-5);
      border-radius: var(--radius-sm);
      border: none;
      background: transparent;
      color: var(--color-text);
      font-size: var(--text-sm);
      cursor: pointer;
      text-align: left;
      width: 100%;
      transition: background var(--transition-base);
    }
    .daily-add-menu-item:hover { background: var(--color-surface-2); color: var(--color-accent); }
    .daily-add-menu-icon { font-size: 1.1rem; width: 1.4rem; text-align: center; flex-shrink: 0; }

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

    /* ── Quick Capture Bar ───────────────────────────── */
    .daily-capture-bar {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      padding: var(--space-2) var(--space-3);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      background: var(--color-surface);
    }
    .daily-capture-toggles {
      display: flex;
      gap: var(--space-1);
      flex-shrink: 0;
    }
    .daily-capture-type-btn {
      font-size: 11px;
      font-weight: var(--weight-semibold);
      padding: 3px 9px;
      border-radius: 999px;
      border: 2px solid var(--color-border);
      background: transparent;
      color: var(--color-text-muted);
      cursor: pointer;
      white-space: nowrap;
      transition: border-color 0.15s, color 0.15s, background 0.15s;
      line-height: 1.4;
    }
    .daily-capture-type-btn:hover {
      border-color: var(--color-accent);
      color: var(--color-accent);
    }
    .daily-capture-type-btn.active {
      border-color: var(--color-accent);
      background: var(--color-accent);
      color: #fff;
    }
    .daily-capture-input {
      flex: 1;
      height: 36px;
      border: none;
      background: transparent;
      color: var(--color-text);
      font-size: var(--text-sm);
      outline: none;
      min-width: 0;
    }
    .daily-capture-input::placeholder { color: var(--color-text-muted); }
    .daily-capture-add-btn {
      flex-shrink: 0;
      font-size: var(--text-md);
      line-height: 1;
      padding: var(--space-1) var(--space-2-5);
      border-radius: var(--radius-sm);
    }
    @media (max-width: 600px) {
      .daily-capture-bar {
        flex-wrap: wrap;
        gap: var(--space-2);
      }
      .daily-capture-toggles { flex: 0 0 auto; }
      .daily-capture-input   { flex: 1 1 120px; }
    }

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
    .daily-activity-open-hint { color: var(--color-accent); font-size: var(--text-xs); flex-shrink: 0; font-weight: var(--weight-semibold); }
    .daily-activity-gone { background: var(--color-danger-bg); color: var(--color-danger-text); font-size: var(--text-xs); padding: 1px 6px; border-radius: 999px; flex-shrink: 0; }

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
            personMap, projectMap, accountMap, allComments } =
      await _loadData(dateStr);

    // ── Sync Daily Review entity + bidirectional links (non-blocking) ─
    // Run in background — don't let link errors break the render
    _syncDailyReviewLinks(dateStr, {
      tasks, events, notes, posts, appointments, dateEntities, mealPlans, allComments,
    }).catch(err => console.warn('[daily] Daily Review sync error (non-fatal):', err));

    // Clear and rebuild
    viewEl.innerHTML = '';

    // ── Top bar ──────────────────────────────────────────────
    _buildTopBar(viewEl, dateStr);

    // ── sectionRefs: live DOM body refs for capture-bar prepend ──
    const sectionRefs = { notesBody: null, tasksBody: null };

    // ── Quick Capture Bar ────────────────────────────────────
    _buildCaptureBar(viewEl, dateStr, sectionRefs);

    // ── Sections container ───────────────────────────────────
    const sections = document.createElement('div');
    sections.className = 'daily-sections';
    sections.style.cssText = 'display:flex;flex-direction:column;gap:var(--space-3);';
    viewEl.appendChild(sections);

    // ── Section 1: Tasks (always first) ────────────────────
    await _renderTasks(sections, dateStr, tasks, personMap, projectMap);
    sectionRefs.tasksBody = sections.querySelector('#daily-section-body-tasks');

    // ── Section 2: Events (always second) ───────────────────
    _renderEvents(sections, dateStr, events);

    // ── Section 3: Notes (always third) ─────────────────────
    await _renderDailyNotes(sections, dateStr);
    sectionRefs.notesBody = sections.querySelector('#daily-section-body-notes');

    // ── Sections 4–N: dynamic order — non-empty before empty ─
    // Pre-compute filtered data for each section to determine emptiness.
    const filteredPosts       = _filterWallPosts(posts, dateStr);
    const filteredReminders   = _filterReminders(appointments, dateStr);
    const filteredBirthdays   = _filterDateEntities(dateEntities, _currentDate);
    const filteredMeals       = _filterMeals(mealPlans, dateStr);
    const filteredComments    = _filterComments(allComments, dateStr);

    // Birthday auto-open: always write the correct open/closed state for this specific
    // date so navigating between dates (birthday → non-birthday) resets correctly.
    // Open when matching dateEntities exist; explicitly close when none.
    _setSectionOpen('birthdays', filteredBirthdays.length > 0);

    // Each entry: { isEmpty, render }
    const dynamicSections = [
      {
        isEmpty: filteredPosts.length === 0,
        render:  () => _renderWallPosts(sections, dateStr, posts, personMap, accountMap),
      },
      {
        isEmpty: filteredReminders.length === 0,
        render:  () => _renderReminders(sections, dateStr, appointments),
      },
      {
        isEmpty: filteredBirthdays.length === 0,
        render:  () => _renderBirthdays(sections, dateEntities),
      },
      {
        isEmpty: Object.values(filteredMeals).every(arr => arr.length === 0),
        render:  () => _renderMeals(sections, dateStr, mealPlans),
      },
      {
        isEmpty: filteredComments.length === 0,
        render:  () => _renderComments(sections, dateStr, allComments, personMap, accountMap),
      },
    ];

    // Stable sort: non-empty first, preserve relative order within each group
    const sorted = [
      ...dynamicSections.filter(s => !s.isEmpty),
      ...dynamicSections.filter(s =>  s.isEmpty),
    ];

    for (const section of sorted) {
      section.render();
    }

    // ── Activity Log (always last) ───────────────────────────
    await _renderActivityLog(sections, dateStr, auditLog, accountMap);

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

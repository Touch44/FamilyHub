/**
 * FamilyHub v2.0 — views/calendar.js
 * Combined Month + Week + Agenda calendar view
 * Renders into #view-calendar when view="calendar"
 *
 * Three sub-views (toggle via header buttons):
 *   1. MONTH VIEW  — 7-column grid, day cells with color-coded dots, click→day popover
 *   2. WEEK VIEW   — Time grid 06:00–22:00, events as timed blocks, tasks as chips
 *   3. AGENDA VIEW — Chronological list grouped by date (blueprint-style)
 *
 * Navigation:
 *   - ‹ / › buttons for prev/next period
 *   - "Today" button to snap to current period
 *   - Month / Week / Agenda toggle
 *
 * Data sources:
 *   - events       (by date/endDate datetime)
 *   - tasks        (by dueDate date)
 *   - dateEntities (by date date — recurring month+day match)
 *   - appointments (by date datetime, with optional reminder flag)
 *   - mealPlans    (by date date — shown as "M" indicator)
 *
 * Registration: registerView('calendar', renderCalendar) at module init.
 */

import { registerView }              from '../core/router.js';
import { getEntitiesByType, getEntity, saveEntity } from '../core/db.js';
import { emit, on, EVENTS }         from '../core/events.js';

// ── Constants ─────────────────────────────────────────────── //

const DONE_STATUSES = new Set(['done', 'Done']);

/**
 * Calendar entity type registry — extensible for future custom types.
 * Each entry defines: color, icon, dateField, and how to extract items.
 *
 * To add a new entity type to the calendar:
 *   1. Add an entry here with the type key
 *   2. Add the type key to DATA_TYPES array
 *   3. No other code changes needed — _buildDateMap, dots, popover, and agenda
 *      all read from this registry dynamically.
 */
const ENTITY_REGISTRY = {
  event: {
    color:     'var(--color-info)',       // blue
    icon:      '📅',
    label:     'Event',
    dateField: 'date',                   // ISO datetime
    hasTime:   true,
    recurring: false,
  },
  task: {
    color:     'var(--color-success)',     // green
    icon:      '✅',
    label:     'Task',
    dateField: 'dueDate',                // date string; dueTime holds HH:MM
    timeField: 'dueTime',                // optional "HH:MM", defaults "06:00"
    hasTime:   true,
    recurring: false,
    filterFn:  (entity) => !DONE_STATUSES.has(entity.status),
  },
  dateEntity: {
    color:     'var(--entity-date)',       // pink/purple
    icon:      '🗓️',
    label:     'Date',
    dateField: 'date',
    hasTime:   false,
    recurring: true,                      // matches by month+day yearly
  },
  appointment: {
    color:     'var(--color-warning)',     // orange
    icon:      '🏥',
    label:     'Appointment',
    dateField: 'date',                   // ISO datetime
    hasTime:   true,
    recurring: false,
  },
  mealPlan: {
    color:     'var(--entity-meal)',       // lime
    icon:      '🥗',
    label:     'Meal',
    dateField: 'date',
    hasTime:   false,
    recurring: false,
    dotStyle:  'letter',                  // renders as "M" instead of dot
    dotLetter: 'M',
  },
};

/** Ordered list of entity types to load — determines dot order */
const DATA_TYPES = ['event', 'task', 'dateEntity', 'appointment', 'mealPlan'];

/** Quick lookup helpers derived from registry */
function _getColor(type)  { return ENTITY_REGISTRY[type]?.color || 'var(--color-border)'; }
function _getIcon(type)   { return ENTITY_REGISTRY[type]?.icon || '📌'; }
function _getLabel(type)  { return ENTITY_REGISTRY[type]?.label || type; }

/** Sub-view modes */
const MODES = { MONTH: 'month', WEEK: 'week', AGENDA: 'agenda' };

/** Weekday short labels */
const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS_FULL  = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Hour grid range for week view */
const HOUR_START = 6;
const HOUR_END       = 22;
/** Fixed pixel height per hour row — deterministic positioning */
const SLOT_HEIGHT_PX = 60;
/** Drag-drop snap interval in minutes */
const SNAP_MINUTES   = 10;

/** Agenda lookahead (days) */
const AGENDA_DAYS = 14;

// ── Module state ──────────────────────────────────────────── //

/** Currently viewed date (local midnight) — anchor for month/week */
let _anchorDate = _todayLocal();

/** Current sub-view mode */
let _mode = MODES.MONTH;

// ── Date utility helpers ──────────────────────────────────── //

/**
 * Return a new Date set to local midnight today.
 */
function _todayLocal() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Convert any Date → "YYYY-MM-DD" in LOCAL timezone.
 * REVIEW 1: Never uses toISOString() which would shift by UTC offset.
 */
function _toDateStr(d) {
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, '0');
  const dy = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dy}`;
}

/**
 * Parse an ISO datetime or date string → local "YYYY-MM-DD".
 * Handles both "2025-04-21" and "2025-04-21T10:30:00.000Z".
 * REVIEW 2: Plain date strings returned as-is to avoid timezone shift.
 */
function _isoToLocalDate(isoStr) {
  if (!isoStr) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(isoStr)) return isoStr;
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return null;
  return _toDateStr(d);
}

/**
 * Extract local hour + fractional minutes from an ISO datetime.
 * Returns a float: 14.5 = 2:30 PM. Null for date-only or invalid.
 */
function _isoToLocalHourFrac(isoStr) {
  if (!isoStr) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(isoStr)) return null;
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return null;
  return d.getHours() + d.getMinutes() / 60;
}

/**
 * Format an ISO datetime for display: "2:30 PM".
 */
function _formatTime(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/**
 * Format a Date for month header: "April 2025".
 */
function _formatMonthYear(d) {
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

/**
 * Format a Date for agenda date header: "Monday, April 21".
 */
function _formatFullDate(d) {
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

/**
 * Format a Date for week header: "Apr 21 – Apr 27, 2025".
 */
function _formatWeekRange(weekStart) {
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);
  const sameMonth = weekStart.getMonth() === weekEnd.getMonth();
  const startStr = weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const endStr = sameMonth
    ? weekEnd.toLocaleDateString('en-US', { day: 'numeric' })
    : weekEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${startStr} – ${endStr}, ${weekEnd.getFullYear()}`;
}

/**
 * Get the Sunday-start week start for a given date.
 * REVIEW 3: Uses getDay() which is 0=Sun, 1=Mon,...
 */
function _getWeekStart(d) {
  const ws = new Date(d);
  ws.setDate(ws.getDate() - ws.getDay());
  ws.setHours(0, 0, 0, 0);
  return ws;
}

/**
 * Get the first day to render in a month grid (Sunday of the week containing the 1st).
 */
function _getMonthGridStart(year, month) {
  const first = new Date(year, month, 1);
  first.setDate(first.getDate() - first.getDay());
  first.setHours(0, 0, 0, 0);
  return first;
}

/**
 * Calculate duration in hours between two ISO datetime strings.
 * Returns 1 (minimum) if endDate is missing or invalid.
 */
function _durationHours(startIso, endIso) {
  if (!startIso || !endIso) return 1;
  const s = new Date(startIso);
  const e = new Date(endIso);
  if (isNaN(s.getTime()) || isNaN(e.getTime())) return 1;
  const hrs = (e - s) / (1000 * 60 * 60);
  return Math.max(0.5, Math.min(hrs, HOUR_END - HOUR_START));
}

/**
 * Get number of days in a month.
 * REVIEW 2 (date calc): Uses Date(year, month+1, 0) trick which correctly handles
 * February in leap years and all month lengths.
 */
function _daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

// ── Data loading ──────────────────────────────────────────── //

/**
 * Load all calendar-relevant entity types in parallel.
 * Uses DATA_TYPES registry so adding a new type only requires updating the registry.
 */
async function _loadData() {
  const results = await Promise.all(DATA_TYPES.map(t => getEntitiesByType(t)));
  const data = {};
  DATA_TYPES.forEach((t, i) => { data[t] = results[i]; });
  return data;
}

/**
 * Build a map: dateStr → array of { entity, entityType, sortTime, isOverdue }.
 * Used by month view (dot counts) and day popover (item list).
 *
 * Processes each entity type according to its ENTITY_REGISTRY config:
 *   - recurring: true → matches by month+day yearly (dateEntities)
 *   - filterFn → custom filter (e.g. exclude done tasks)
 *   - Events with endDate → multi-day spanning (capped at 60 days)
 *   - All other types → single-day by their dateField
 *
 * Also flags overdue tasks (dueDate < today, not done).
 */
function _buildDateMap(data, rangeStart, rangeEnd) {
  const map = new Map();
  const todayStr = _toDateStr(_todayLocal());

  function _add(dateStr, entity, entityType, extra = {}) {
    if (!dateStr) return;
    if (dateStr < rangeStart || dateStr > rangeEnd) return;
    if (!map.has(dateStr)) map.set(dateStr, []);
    const reg = ENTITY_REGISTRY[entityType] || {};
    map.get(dateStr).push({
      entity,
      entityType,
      sortTime: entity.date || entity.dueDate || entity.createdAt || '',
      isOverdue: extra.isOverdue || false,
    });
  }

  for (const typeKey of DATA_TYPES) {
    const reg      = ENTITY_REGISTRY[typeKey];
    const entities = data[typeKey] || [];
    if (!reg) continue;

    for (const entity of entities) {
      // Apply custom filter (e.g. exclude done tasks)
      if (reg.filterFn && !reg.filterFn(entity)) continue;

      // For tasks: synthesize a datetime ISO from dueDate + dueTime (default 06:00)
      if (typeKey === 'task' && entity.dueDate) {
        const tRaw = (entity.dueTime || '06:00').slice(0, 5);
        entity._dateTimeISO = `${entity.dueDate}T${tRaw}:00`;
      }

      const rawDate = entity[reg.dateField];
      if (!rawDate) continue;

      // ── Recurring types (dateEntity): match by month+day across years ──
      if (reg.recurring) {
        const localStr = _isoToLocalDate(rawDate);
        if (!localStr) continue;
        const parts = localStr.split('-');
        if (parts.length < 3) continue;
        const mm = parseInt(parts[1], 10);
        const dd = parseInt(parts[2], 10);

        const startYear = parseInt(rangeStart.substring(0, 4), 10);
        const endYear   = parseInt(rangeEnd.substring(0, 4), 10);
        for (let y = startYear; y <= endYear; y++) {
          const maxDay = _daysInMonth(y, mm - 1);
          if (dd > maxDay) continue;
          const ds = `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
          _add(ds, entity, typeKey);
        }
        continue;
      }

      // ── Events with endDate: multi-day spanning ──
      if (typeKey === 'event' && entity.endDate) {
        const startDs = _isoToLocalDate(rawDate);
        const endDs   = _isoToLocalDate(entity.endDate);
        if (startDs && endDs && endDs !== startDs) {
          const cursor  = new Date(startDs + 'T00:00:00');
          const endDate = new Date(endDs + 'T00:00:00');
          let safety = 0;
          while (cursor <= endDate && safety < 60) {
            _add(_toDateStr(cursor), entity, typeKey);
            cursor.setDate(cursor.getDate() + 1);
            safety++;
          }
          continue;
        }
      }

      // ── Standard single-day ──
      const ds = _isoToLocalDate(rawDate);
      const isOverdue = typeKey === 'task' && ds && ds < todayStr;
      _add(ds, entity, typeKey, { isOverdue });
    }
  }

  // Sort each day's items by time
  for (const [, items] of map) {
    items.sort((a, b) => (a.sortTime || '').localeCompare(b.sortTime || ''));
  }

  return map;
}

// ── Session state persistence ─────────────────────────────── //

const SS_CAL_MODE   = 'fh_cal_mode';
const SS_CAL_ANCHOR = 'fh_cal_anchor';

function _saveViewState() {
  try {
    sessionStorage.setItem(SS_CAL_MODE, _mode);
    sessionStorage.setItem(SS_CAL_ANCHOR, _toDateStr(_anchorDate));
  } catch { /* ignore quota errors */ }
}

function _restoreViewState() {
  try {
    const savedMode = sessionStorage.getItem(SS_CAL_MODE);
    if (savedMode && Object.values(MODES).includes(savedMode)) {
      _mode = savedMode;
    }
    const savedAnchor = sessionStorage.getItem(SS_CAL_ANCHOR);
    if (savedAnchor && /^\d{4}-\d{2}-\d{2}$/.test(savedAnchor)) {
      const d = new Date(savedAnchor + 'T00:00:00');
      if (!isNaN(d.getTime())) _anchorDate = d;
    }
  } catch { /* ignore */ }
}

// ── Debounced re-render ───────────────────────────────────── //

let _renderTimer = null;

function _debouncedRender() {
  if (_renderTimer) clearTimeout(_renderTimer);
  _renderTimer = setTimeout(() => {
    _renderTimer = null;
    const viewEl = document.getElementById('view-calendar');
    if (viewEl && viewEl.classList.contains('active')) {
      renderCalendar({ _internal: true });
    }
  }, 150);
}

// ── DOM builders: Header ──────────────────────────────────── //

/**
 * Build the calendar header with mode toggle and navigation.
 */
function _buildHeader(container) {
  const header = document.createElement('div');
  header.className = 'cal-header';

  // Title row
  const titleRow = document.createElement('div');
  titleRow.className = 'cal-title-row';

  const navLeft = document.createElement('button');
  navLeft.className = 'btn-icon cal-nav-btn';
  navLeft.title = 'Previous';
  navLeft.setAttribute('aria-label', 'Previous period');
  navLeft.textContent = '‹';
  navLeft.addEventListener('click', () => _navigatePrev());

  const title = document.createElement('h2');
  title.className = 'cal-title';
  title.id = 'cal-title';
  title.textContent = _getTitle();

  const navRight = document.createElement('button');
  navRight.className = 'btn-icon cal-nav-btn';
  navRight.title = 'Next';
  navRight.setAttribute('aria-label', 'Next period');
  navRight.textContent = '›';
  navRight.addEventListener('click', () => _navigateNext());

  const todayBtn = document.createElement('button');
  todayBtn.className = 'btn btn-ghost btn-sm cal-today-btn';
  todayBtn.textContent = 'Today';
  todayBtn.addEventListener('click', () => {
    _anchorDate = _todayLocal();
    _saveViewState();
    renderCalendar({ _internal: true });
  });

  titleRow.append(navLeft, title, navRight, todayBtn);

  // Quick-add buttons — always visible in all sub-views
  const quickBtns = document.createElement('div');
  quickBtns.className = 'cal-quick-btns';

  const addEventBtn = document.createElement('button');
  addEventBtn.className = 'btn btn-primary btn-sm';
  addEventBtn.textContent = '+ Event';
  addEventBtn.addEventListener('click', () => {
    const dateStr = _toDateStr(_anchorDate);
    emit(EVENTS.FAB_CREATE, {
      entityType: 'event',
      prefill: { date: dateStr + 'T12:00' },
    });
  });

  const addTaskBtn = document.createElement('button');
  addTaskBtn.className = 'btn btn-ghost btn-sm';
  addTaskBtn.textContent = '+ Task';
  addTaskBtn.addEventListener('click', () => {
    const dateStr = _toDateStr(_anchorDate);
    emit(EVENTS.FAB_CREATE, {
      entityType: 'task',
      prefill: { dueDate: dateStr },
    });
  });

  quickBtns.append(addEventBtn, addTaskBtn);
  titleRow.appendChild(quickBtns);

  // Mode toggle row
  const toggleRow = document.createElement('div');
  toggleRow.className = 'cal-toggle-row';

  for (const mode of [MODES.MONTH, MODES.WEEK, MODES.AGENDA]) {
    const btn = document.createElement('button');
    btn.className = 'cal-mode-btn' + (mode === _mode ? ' active' : '');
    btn.textContent = mode.charAt(0).toUpperCase() + mode.slice(1);
    btn.dataset.mode = mode;
    btn.addEventListener('click', () => {
      _mode = mode;
      _saveViewState();
      renderCalendar({ _internal: true });
    });
    toggleRow.appendChild(btn);
  }

  header.append(titleRow, toggleRow);
  container.appendChild(header);
}

function _getTitle() {
  if (_mode === MODES.MONTH) {
    return _formatMonthYear(_anchorDate);
  } else if (_mode === MODES.WEEK) {
    return _formatWeekRange(_getWeekStart(_anchorDate));
  } else {
    // Agenda: show "Next 14 days from <date>"
    return `Agenda · ${_formatMonthYear(_anchorDate)}`;
  }
}

function _navigatePrev() {
  if (_mode === MODES.MONTH) {
    // Go to previous month — REVIEW 2 (date calc): setMonth handles
    // month underflow correctly (e.g. Jan→Dec of previous year).
    // We anchor to the 1st to avoid day-overflow issues (e.g. Mar 31 → Feb 31).
    _anchorDate = new Date(_anchorDate.getFullYear(), _anchorDate.getMonth() - 1, 1);
  } else if (_mode === MODES.WEEK) {
    _anchorDate = new Date(_anchorDate);
    _anchorDate.setDate(_anchorDate.getDate() - 7);
  } else {
    // Agenda: go back 14 days
    _anchorDate = new Date(_anchorDate);
    _anchorDate.setDate(_anchorDate.getDate() - AGENDA_DAYS);
  }
  _anchorDate.setHours(0, 0, 0, 0);
  _saveViewState();
  renderCalendar({ _internal: true });
}

function _navigateNext() {
  if (_mode === MODES.MONTH) {
    // REVIEW 3 (date calc): Same overflow safety as _navigatePrev —
    // anchoring to the 1st prevents e.g. Jan 31 → Mar 3 when going forward.
    _anchorDate = new Date(_anchorDate.getFullYear(), _anchorDate.getMonth() + 1, 1);
  } else if (_mode === MODES.WEEK) {
    _anchorDate = new Date(_anchorDate);
    _anchorDate.setDate(_anchorDate.getDate() + 7);
  } else {
    _anchorDate = new Date(_anchorDate);
    _anchorDate.setDate(_anchorDate.getDate() + AGENDA_DAYS);
  }
  _anchorDate.setHours(0, 0, 0, 0);
  _saveViewState();
  renderCalendar({ _internal: true });
}

// ── DOM builders: Month View ──────────────────────────────── //

function _buildMonthView(container, dateMap) {
  const grid = document.createElement('div');
  grid.className = 'cal-month';

  // Weekday headers
  const headerRow = document.createElement('div');
  headerRow.className = 'cal-month-header';
  for (const wd of WEEKDAYS_SHORT) {
    const cell = document.createElement('div');
    cell.className = 'cal-weekday-label';
    cell.textContent = wd;
    headerRow.appendChild(cell);
  }
  grid.appendChild(headerRow);

  const year  = _anchorDate.getFullYear();
  const month = _anchorDate.getMonth();
  const gridStart = _getMonthGridStart(year, month);
  const todayStr = _toDateStr(_todayLocal());

  // Render 6 weeks (42 cells) to cover all month layouts
  // REVIEW 1 (date calc): 6 rows × 7 cols = 42 cells always covers any month,
  // including months that span 6 weeks (e.g. a month starting on Saturday).
  const daysCells = document.createElement('div');
  daysCells.className = 'cal-month-grid';

  for (let i = 0; i < 42; i++) {
    const cellDate = new Date(gridStart);
    cellDate.setDate(cellDate.getDate() + i);
    const cellDateStr = _toDateStr(cellDate);
    const isCurrentMonth = cellDate.getMonth() === month;
    const isToday = cellDateStr === todayStr;

    const cell = document.createElement('button');
    cell.className = 'cal-day-cell'
      + (isCurrentMonth ? '' : ' other-month')
      + (isToday ? ' today' : '');
    cell.setAttribute('aria-label', cellDate.toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    }));

    // Day number
    const dayNum = document.createElement('span');
    dayNum.className = 'cal-day-num';
    dayNum.textContent = cellDate.getDate();
    cell.appendChild(dayNum);

    // Dot indicators + accessibility count
    const items = dateMap.get(cellDateStr) || [];
    if (items.length > 0) {
      const dotRow = document.createElement('div');
      dotRow.className = 'cal-dot-row';

      // Group by type — show dots from registry in DATA_TYPES order
      const typesPresent = new Set(items.map(it => it.entityType));
      const hasOverdue = items.some(it => it.isOverdue);
      let dotCount = 0;

      for (const t of DATA_TYPES) {
        if (!typesPresent.has(t) || dotCount >= 4) continue;
        const reg = ENTITY_REGISTRY[t];
        if (!reg) continue;

        if (reg.dotStyle === 'letter') {
          // Letter indicator (e.g. "M" for meals)
          const mLabel = document.createElement('span');
          mLabel.className = 'cal-meal-indicator';
          mLabel.textContent = reg.dotLetter || t.charAt(0).toUpperCase();
          mLabel.title = _getLabel(t) + ' planned';
          dotRow.appendChild(mLabel);
        } else {
          const dot = document.createElement('span');
          dot.className = 'cal-dot' + (t === 'task' && hasOverdue ? ' overdue' : '');
          dot.style.background = _getColor(t);
          dot.title = _getLabel(t);
          dotRow.appendChild(dot);
          dotCount++;
        }
      }

      cell.appendChild(dotRow);

      // Accessibility: hidden text count for screen readers
      const srCount = document.createElement('span');
      srCount.className = 'sr-only';
      srCount.textContent = `${items.length} item${items.length !== 1 ? 's' : ''}`;
      cell.appendChild(srCount);
    }

    // Click → day popover
    cell.addEventListener('click', (e) => {
      e.stopPropagation();
      _showDayPopover(cell, cellDate, cellDateStr, items);
    });

    // Drop target for drag-and-drop rescheduling
    _makeDropTarget(cell, cellDateStr);

    daysCells.appendChild(cell);
  }

  grid.appendChild(daysCells);
  container.appendChild(grid);
}

// ── DOM builders: Day Popover ─────────────────────────────── //

/** Escape key handler (stored so we can remove it) */
let _popoverEscHandler = null;

/** Close any existing popover and remove Escape handler */
function _closePopover() {
  const existing = document.querySelector('.cal-popover');
  if (existing) existing.remove();
  const overlay = document.querySelector('.cal-popover-overlay');
  if (overlay) overlay.remove();
  if (_popoverEscHandler) {
    document.removeEventListener('keydown', _popoverEscHandler);
    _popoverEscHandler = null;
  }
}

/**
 * Show a day popover anchored near the clicked cell.
 */
function _showDayPopover(anchorEl, dateObj, dateStr, items) {
  _closePopover();

  // Overlay to catch clicks outside
  const overlay = document.createElement('div');
  overlay.className = 'cal-popover-overlay';
  overlay.addEventListener('click', _closePopover);
  document.body.appendChild(overlay);

  const popover = document.createElement('div');
  popover.className = 'cal-popover';

  // Header
  const header = document.createElement('div');
  header.className = 'cal-popover-header';
  const headerTitle = document.createElement('h3');
  headerTitle.className = 'cal-popover-title';
  headerTitle.textContent = _formatFullDate(dateObj);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn-icon cal-popover-close';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', _closePopover);

  header.append(headerTitle, closeBtn);
  popover.appendChild(header);

  // Items list
  const list = document.createElement('div');
  list.className = 'cal-popover-list';

  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'cal-popover-empty';
    empty.textContent = 'Nothing scheduled';
    list.appendChild(empty);
  } else {
    for (const item of items) {
      const row = document.createElement('button');
      row.className = 'cal-popover-item' + (item.isOverdue ? ' overdue' : '');

      const icon = document.createElement('span');
      icon.className = 'cal-popover-icon';
      icon.textContent = _getIcon(item.entityType);

      const info = document.createElement('div');
      info.className = 'cal-popover-info';

      const titleSpan = document.createElement('span');
      titleSpan.className = 'cal-popover-item-title';
      titleSpan.textContent = item.entity.title || item.entity.label || item.entity.name || 'Untitled';
      if (item.isOverdue) {
        const badge = document.createElement('span');
        badge.className = 'cal-overdue-badge';
        badge.textContent = 'overdue';
        titleSpan.appendChild(badge);
      }

      const detail = document.createElement('span');
      detail.className = 'cal-popover-item-detail';
      if (item.entityType === 'event' || item.entityType === 'appointment') {
        detail.textContent = _formatTime(item.entity.date) || _getLabel(item.entityType);
      } else if (item.entityType === 'task') {
        detail.textContent = item.entity.priority ? `${item.entity.priority} priority` : 'Task';
      } else if (item.entityType === 'mealPlan') {
        detail.textContent = item.entity.mealType || 'Meal';
      } else if (item.entityType === 'dateEntity') {
        detail.textContent = item.entity.type || 'Date';
      } else {
        detail.textContent = _getLabel(item.entityType);
      }

      info.append(titleSpan, detail);
      row.append(icon, info);

      // Color accent bar
      row.style.borderLeftColor = _getColor(item.entityType) || 'var(--color-border)';

      // Make draggable (except recurring dateEntities)
      if (item.entityType !== 'dateEntity') {
        _makeDraggable(row, item.entityType, item.entity.id);
      }

      // Click → open entity panel
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        _closePopover();
        emit(EVENTS.PANEL_OPENED, {
          entityType: item.entityType,
          entityId:   item.entity.id,
        });
      });

      list.appendChild(row);
    }
  }
  popover.appendChild(list);

  // "Add Event" button
  const addBtn = document.createElement('button');
  addBtn.className = 'btn btn-primary btn-sm cal-popover-add';
  addBtn.textContent = '+ Add Event';
  addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    _closePopover();
    // Build an ISO datetime string for noon on this day as a reasonable default
    emit(EVENTS.FAB_CREATE, {
      entityType: 'event',
      prefill: { date: dateStr + 'T12:00' },
    });
  });
  popover.appendChild(addBtn);

  document.body.appendChild(popover);

  // Escape key closes the popover
  _popoverEscHandler = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      _closePopover();
    }
  };
  document.addEventListener('keydown', _popoverEscHandler);

  // Position the popover near the anchor cell
  requestAnimationFrame(() => {
    const anchorRect = anchorEl.getBoundingClientRect();
    const popRect    = popover.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let top  = anchorRect.bottom + 6;
    let left = anchorRect.left;

    // Flip up if overflows bottom
    if (top + popRect.height > vh - 16) {
      top = anchorRect.top - popRect.height - 6;
    }
    // Shift left if overflows right
    if (left + popRect.width > vw - 16) {
      left = vw - popRect.width - 16;
    }
    // Clamp to at least 8px from left
    if (left < 8) left = 8;
    // Clamp top
    if (top < 8) top = 8;

    popover.style.top  = `${top}px`;
    popover.style.left = `${left}px`;
  });
}

// ── DOM builders: Week View ───────────────────────────────── //

function _buildWeekView(container, dateMap) {
  const weekStart = _getWeekStart(_anchorDate);
  const todayStr = _toDateStr(_todayLocal());

  const weekGrid = document.createElement('div');
  weekGrid.className = 'cal-week';

  // ── Header row with day labels ──
  const headerRow = document.createElement('div');
  headerRow.className = 'cal-week-header';

  // Time gutter spacer
  const gutterSpacer = document.createElement('div');
  gutterSpacer.className = 'cal-week-gutter';
  headerRow.appendChild(gutterSpacer);

  for (let d = 0; d < 7; d++) {
    const dayDate = new Date(weekStart);
    dayDate.setDate(dayDate.getDate() + d);
    const ds = _toDateStr(dayDate);
    const isToday = ds === todayStr;

    const dayLabel = document.createElement('div');
    dayLabel.className = 'cal-week-day-label' + (isToday ? ' today' : '');
    dayLabel.innerHTML = `
      <span class="cal-week-dayname">${WEEKDAYS_SHORT[d]}</span>
      <span class="cal-week-daynum">${dayDate.getDate()}</span>
    `;
    headerRow.appendChild(dayLabel);
  }
  weekGrid.appendChild(headerRow);

  // ── All-day / task chips row ──
  const allDayRow = document.createElement('div');
  allDayRow.className = 'cal-week-allday';

  const allDayGutter = document.createElement('div');
  allDayGutter.className = 'cal-week-gutter cal-week-gutter-label';
  allDayGutter.textContent = 'all day';
  allDayRow.appendChild(allDayGutter);

  // Track multi-day events already rendered (by entity id) so they appear once
  const _renderedMultiDay = new Set();

  for (let d = 0; d < 7; d++) {
    const dayDate = new Date(weekStart);
    dayDate.setDate(dayDate.getDate() + d);
    const ds = _toDateStr(dayDate);
    const items = dateMap.get(ds) || [];

    const allDayCell = document.createElement('div');
    allDayCell.className = 'cal-week-allday-cell';

    // Tasks have hasTime:true and show in the time grid — skip them in all-day row

    // DateEntities shown as chips
    const datesForDay = items.filter(it => it.entityType === 'dateEntity');
    for (const de of datesForDay.slice(0, 2)) {
      const chip = document.createElement('button');
      chip.className = 'cal-week-chip date-chip';
      chip.textContent = de.entity.label || de.entity.title || 'Date';
      chip.title = de.entity.label || de.entity.title || 'Date';
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        emit(EVENTS.PANEL_OPENED, { entityType: 'dateEntity', entityId: de.entity.id });
      });
      allDayCell.appendChild(chip);
    }

    // Single-day events that have no time (date-only start, no endDate)
    // are shown as all-day chips
    const allDayEvents = items.filter(it => {
      if (it.entityType !== 'event') return false;
      if (it.entity.endDate) {
        const sd = _isoToLocalDate(it.entity.date);
        const ed = _isoToLocalDate(it.entity.endDate);
        if (sd && ed && sd !== ed) return false; // multi-day handled below
      }
      return _isoToLocalHourFrac(it.entity.date) === null; // date-only
    });
    for (const ade of allDayEvents.slice(0, 2)) {
      const chip = document.createElement('button');
      chip.className = 'cal-week-chip';
      chip.style.cssText = 'background: var(--color-info-bg); color: var(--color-info-text); border-left: 2px solid var(--color-info);';
      chip.textContent = ade.entity.title || 'Event';
      chip.title = ade.entity.title || 'Event';
      _makeDraggable(chip, 'event', ade.entity.id);
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        emit(EVENTS.PANEL_OPENED, { entityType: 'event', entityId: ade.entity.id });
      });
      allDayCell.appendChild(chip);
    }

    // Drop target for all-day row
    _makeDropTarget(allDayCell, ds);

    allDayRow.appendChild(allDayCell);
  }

  weekGrid.appendChild(allDayRow);

  // ── Multi-day spanning bars (positioned after DOM render) ──
  // Collect unique multi-day events visible this week
  const weekEndDate = new Date(weekStart);
  weekEndDate.setDate(weekEndDate.getDate() + 6);
  const weekStartStr = _toDateStr(weekStart);
  const weekEndStr = _toDateStr(weekEndDate);
  const multiDaySet = new Map(); // entityId → { entity, startDay, endDay }

  for (let d = 0; d < 7; d++) {
    const dayDate = new Date(weekStart);
    dayDate.setDate(dayDate.getDate() + d);
    const ds = _toDateStr(dayDate);
    const items = dateMap.get(ds) || [];

    for (const it of items) {
      if (it.entityType !== 'event' || !it.entity.endDate) continue;
      if (multiDaySet.has(it.entity.id)) continue;

      const startDs = _isoToLocalDate(it.entity.date);
      const endDs = _isoToLocalDate(it.entity.endDate);
      if (!startDs || !endDs || startDs === endDs) continue;

      // Timed multi-day events render as vertical blocks in the time grid — skip all-day bar
      if (_isoToLocalHourFrac(it.entity.date) !== null) continue;

      // Clamp to visible week
      const visStart = startDs < weekStartStr ? 0 : d;
      const rawEnd = new Date(endDs + 'T00:00:00');
      const weekEndD = new Date(weekStart);
      weekEndD.setDate(weekEndD.getDate() + 6);
      const clampedEnd = rawEnd > weekEndD ? 6 : Math.floor((rawEnd - weekStart) / 86400000);
      const visEnd = Math.min(6, Math.max(visStart, clampedEnd));

      multiDaySet.set(it.entity.id, {
        entity: it.entity,
        startCol: visStart,
        endCol: visEnd,
      });
    }
  }

  // Place spanning bars after render
  if (multiDaySet.size > 0) {
    requestAnimationFrame(() => {
      const cells = allDayRow.querySelectorAll('.cal-week-allday-cell');
      if (cells.length < 7) return;
      const gutterW = allDayGutter.offsetWidth;
      const rowRect = allDayRow.getBoundingClientRect();
      const cellWidth = (rowRect.width - gutterW) / 7;
      let barIndex = 0;

      for (const [eid, info] of multiDaySet) {
        const bar = document.createElement('button');
        bar.className = 'cal-week-multiday-bar';
        bar.style.left = `${gutterW + info.startCol * cellWidth + 2}px`;
        bar.style.width = `${(info.endCol - info.startCol + 1) * cellWidth - 4}px`;
        bar.style.top = `${barIndex * 22 + 2}px`;
        bar.textContent = info.entity.title || 'Event';
        bar.title = info.entity.title || 'Event';
        _makeDraggable(bar, 'event', eid);
        bar.addEventListener('click', (e) => {
          e.stopPropagation();
          emit(EVENTS.PANEL_OPENED, { entityType: 'event', entityId: eid });
        });
        allDayRow.appendChild(bar);
        barIndex++;
      }
      // Expand allDay row height to fit bars
      if (barIndex > 0) {
        allDayRow.style.minHeight = `${Math.max(32, barIndex * 22 + 8)}px`;
      }
    });
  }

  // ── Time grid body ──
  const body = document.createElement('div');
  body.className = 'cal-week-body';

  // Hour rows
  for (let h = HOUR_START; h <= HOUR_END; h++) {
    const hourRow = document.createElement('div');
    hourRow.className = 'cal-week-hour-row';

    const label = document.createElement('div');
    label.className = 'cal-week-gutter cal-hour-label';
    const ampm = h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`;
    label.textContent = ampm;
    hourRow.appendChild(label);

    for (let d = 0; d < 7; d++) {
      const dayDate = new Date(weekStart);
      dayDate.setDate(dayDate.getDate() + d);
      const ds = _toDateStr(dayDate);
      const isToday = ds === todayStr;

      const slot = document.createElement('div');
      slot.className = 'cal-week-slot' + (isToday ? ' today-col' : '');

      // Click slot → create event at this time
      slot.addEventListener('click', () => {
        const hourStr = String(h).padStart(2, '0');
        emit(EVENTS.FAB_CREATE, {
          entityType: 'event',
          prefill: { date: `${ds}T${hourStr}:00` },
        });
      });

      // Drop target — reschedule to this day+hour
      _makeDropTarget(slot, ds, h);

      hourRow.appendChild(slot);
    }

    body.appendChild(hourRow);
  }

  // Overlay timed events as positioned blocks
  // We use absolute positioning relative to body
  // Need to do this after appending to DOM to get dimensions
  weekGrid.appendChild(body);
  container.appendChild(weekGrid);

  // Schedule event block placement + auto-scroll after render
  requestAnimationFrame(() => {
    _placeWeekEvents(body, weekStart, dateMap);

    // Auto-scroll week body to current hour (or 8 AM if before HOUR_START)
    const now = new Date();
    const currentHour = Math.max(HOUR_START, Math.min(now.getHours(), HOUR_END));
    const hourRows = body.querySelectorAll('.cal-week-hour-row');
    const targetIndex = currentHour - HOUR_START;
    if (hourRows[targetIndex]) {
      // Scroll to 1 hour before current hour for context
      const scrollTarget = Math.max(0, targetIndex - 1);
      if (hourRows[scrollTarget]) {
        body.scrollTop = hourRows[scrollTarget].offsetTop;
      }
    }
  });
}

/**
 * Place timed event/appointment blocks on the week grid.
 * Uses absolute positioning within each day column.
 * Handles overlapping events by narrowing and offsetting columns.
 */
function _placeWeekEvents(bodyEl, weekStart, dateMap) {
  const slots = bodyEl.querySelectorAll('.cal-week-hour-row');
  if (slots.length === 0) return;

  const firstSlot = slots[0];
  const gutterEl  = firstSlot.querySelector('.cal-week-gutter');
  if (!gutterEl) return;
  const gutterWidth = gutterEl.offsetWidth;
  const bodyRect    = bodyEl.getBoundingClientRect();
  const slotHeight  = SLOT_HEIGHT_PX;  // fixed 60px per hour
  const dayWidth    = (bodyRect.width - gutterWidth) / 7;

  for (let d = 0; d < 7; d++) {
    const dayDate = new Date(weekStart);
    dayDate.setDate(dayDate.getDate() + d);
    const ds = _toDateStr(dayDate);
    const items = dateMap.get(ds) || [];

    // Filter to timed items within visible hour range
    const timedItems = items.filter(it => {
      const reg = ENTITY_REGISTRY[it.entityType];
      if (!reg || !reg.hasTime) return false;
      const dateISO = it.entityType === 'task'
        ? (it.entity._dateTimeISO || null)
        : it.entity.date;
      if (!dateISO) return false;
      // For multi-day events: always include (we compute per-day slice below)
      if (it.entityType === 'event' && it.entity.endDate) {
        const startDs = _isoToLocalDate(it.entity.date);
        const endDs   = _isoToLocalDate(it.entity.endDate);
        if (startDs && endDs && startDs !== endDs) return true; // multi-day
      }
      const h = _isoToLocalHourFrac(dateISO);
      if (h === null) return false;
      // Tasks before HOUR_START are clamped to grid top rather than hidden
      if (it.entityType === 'task') return h < HOUR_END;
      return h >= HOUR_START && h < HOUR_END;
    });

    if (timedItems.length === 0) continue;

    // ── Overlap detection: assign column indices ──
    // Sort by start time, then find groups of overlapping events
    const sorted = timedItems.map(it => {
      const dateISO = it.entityType === 'task'
        ? (it.entity._dateTimeISO || it.entity.dueDate)
        : it.entity.date;

      let startH, endH;

      if (it.entityType === 'event' && it.entity.endDate) {
        const startDs  = _isoToLocalDate(it.entity.date);
        const endDs    = _isoToLocalDate(it.entity.endDate);
        const isMulti  = startDs && endDs && startDs !== endDs;
        if (isMulti) {
          const isFirst = ds === startDs;
          const isLast  = ds === endDs;
          if (isFirst)       { startH = _isoToLocalHourFrac(it.entity.date) ?? HOUR_START; endH = HOUR_END; }
          else if (isLast)   { startH = HOUR_START; endH = _isoToLocalHourFrac(it.entity.endDate) ?? HOUR_END; }
          else               { startH = HOUR_START; endH = HOUR_END; }
        } else {
          startH = _isoToLocalHourFrac(dateISO) ?? HOUR_START;
          endH   = Math.min(startH + Math.max(_durationHours(it.entity.date, it.entity.endDate), 0.5), HOUR_END);
        }
      } else if (it.entityType === 'task') {
        startH = Math.max(_isoToLocalHourFrac(dateISO) ?? 6, HOUR_START); // clamp to grid top
        endH   = Math.min(startH + 0.5, HOUR_END);
      } else {
        startH = _isoToLocalHourFrac(dateISO) ?? HOUR_START;
        endH   = Math.min(startH + 1, HOUR_END);
      }

      return { ...it, startH, endH, _dateISO: dateISO };
    }).sort((a, b) => a.startH - b.startH);

    // Greedy column assignment
    const columns = []; // each column is the endH of its last event
    const colAssignment = [];
    for (const ev of sorted) {
      let placed = false;
      for (let c = 0; c < columns.length; c++) {
        if (ev.startH >= columns[c]) {
          columns[c] = ev.endH;
          colAssignment.push(c);
          placed = true;
          break;
        }
      }
      if (!placed) {
        colAssignment.push(columns.length);
        columns.push(ev.endH);
      }
    }
    const totalCols = columns.length;

    // ── Render each block ──
    for (let idx = 0; idx < sorted.length; idx++) {
      const item = sorted[idx];
      const col  = colAssignment[idx];
      const colWidth = (dayWidth - 4) / totalCols;

      const block = document.createElement('button');
      block.className = 'cal-week-event-block';
      block.style.background = item.entityType === 'appointment'
        ? 'var(--color-warning-bg)' : 'var(--color-info-bg)';
      block.style.borderLeft = `3px solid ${_getColor(item.entityType)}`;
      block.style.top    = `${(item.startH - HOUR_START) * slotHeight}px`;
      block.style.left   = `${gutterWidth + d * dayWidth + 2 + col * colWidth}px`;
      block.style.width  = `${colWidth - 1}px`;
      block.style.height = `${Math.max((item.endH - item.startH) * slotHeight, slotHeight * 0.5)}px`;

      const blockTitle = document.createElement('span');
      blockTitle.className = 'cal-week-event-title';
      blockTitle.textContent = item.entity.title || 'Untitled';

      const blockTime = document.createElement('span');
      blockTime.className = 'cal-week-event-time';
      blockTime.textContent = _formatTime(item._dateISO || item.entity.date);

      block.append(blockTitle, blockTime);

      // Make event blocks draggable
      _makeDraggable(block, item.entityType, item.entity.id);

      block.addEventListener('click', (e) => {
        e.stopPropagation();
        emit(EVENTS.PANEL_OPENED, {
          entityType: item.entityType,
          entityId:   item.entity.id,
        });
      });

      bodyEl.appendChild(block);
    }
  }
}

// ── DOM builders: Agenda View ─────────────────────────────── //

function _buildAgendaView(container, dateMap) {
  const agenda = document.createElement('div');
  agenda.className = 'cal-agenda';

  const todayStr = _toDateStr(_todayLocal());
  let hasAnyItems = false;

  for (let i = 0; i < AGENDA_DAYS; i++) {
    const dayDate = new Date(_anchorDate);
    dayDate.setDate(dayDate.getDate() + i);
    const ds = _toDateStr(dayDate);
    const items = dateMap.get(ds) || [];

    if (items.length === 0) continue;
    hasAnyItems = true;

    // Day group
    const group = document.createElement('div');
    group.className = 'cal-agenda-day';

    // Date header
    const dateHeader = document.createElement('div');
    dateHeader.className = 'cal-agenda-date' + (ds === todayStr ? ' today' : '');

    const dayName = document.createElement('span');
    dayName.className = 'cal-agenda-dayname';
    dayName.textContent = ds === todayStr ? 'Today' : WEEKDAYS_FULL[dayDate.getDay()];

    const dayDetail = document.createElement('span');
    dayDetail.className = 'cal-agenda-daydetail';
    dayDetail.textContent = dayDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    dateHeader.append(dayName, dayDetail);
    group.appendChild(dateHeader);

    // Items
    const itemList = document.createElement('div');
    itemList.className = 'cal-agenda-items';

    for (const item of items) {
      const row = document.createElement('button');
      row.className = 'cal-agenda-item';

      // Left color bar
      row.style.borderLeftColor = _getColor(item.entityType) || 'var(--color-border)';

      // Time column
      const timeCol = document.createElement('div');
      timeCol.className = 'cal-agenda-time';
      if (item.entityType === 'event' || item.entityType === 'appointment') {
        const startTime = _formatTime(item.entity.date);
        const endTime   = item.entity.endDate ? _formatTime(item.entity.endDate) : '';
        timeCol.textContent = startTime ? (endTime ? `${startTime} – ${endTime}` : startTime) : 'All day';
      } else if (item.entityType === 'mealPlan') {
        timeCol.textContent = item.entity.mealType || 'Meal';
      } else {
        timeCol.textContent = item.entityType === 'task' ? 'Due' : '';
      }

      // Content column
      const contentCol = document.createElement('div');
      contentCol.className = 'cal-agenda-content';

      const itemTitle = document.createElement('span');
      itemTitle.className = 'cal-agenda-item-title';
      itemTitle.textContent = item.entity.title || item.entity.label || item.entity.name || 'Untitled';

      const itemMeta = document.createElement('span');
      itemMeta.className = 'cal-agenda-item-meta';
      const icon = _getIcon(item.entityType);
      const label = item.entityType === 'dateEntity'
        ? (item.entity.type || 'Date')
        : (item.entityType === 'task' ? (item.entity.priority || '') : '');
      itemMeta.textContent = `${icon} ${label}`.trim();

      contentCol.append(itemTitle, itemMeta);
      row.append(timeCol, contentCol);

      // Make draggable (except recurring dateEntities)
      if (item.entityType !== 'dateEntity') {
        _makeDraggable(row, item.entityType, item.entity.id);
      }

      row.addEventListener('click', () => {
        emit(EVENTS.PANEL_OPENED, {
          entityType: item.entityType,
          entityId:   item.entity.id,
        });
      });

      itemList.appendChild(row);
    }

    group.appendChild(itemList);

    // Make the entire day group a drop target
    _makeDropTarget(group, ds);

    agenda.appendChild(group);
  }

  if (!hasAnyItems) {
    const empty = document.createElement('div');
    empty.className = 'cal-agenda-empty';
    empty.textContent = 'Nothing scheduled in the next 14 days';
    agenda.appendChild(empty);
  }

  container.appendChild(agenda);
}

// ── Drag-and-Drop infrastructure ──────────────────────────── //

/**
 * Make an element draggable carrying entity + type payload.
 * Used on: month popover items, week event blocks, week all-day chips, agenda items.
 */
// ── Drag time tooltip ────────────────────────────────────── //

let _dragTooltip = null;

function _showDragTooltip(text, x, y) {
  if (!_dragTooltip) {
    _dragTooltip = document.createElement('div');
    _dragTooltip.className = 'cal-drag-tooltip';
    document.body.appendChild(_dragTooltip);
  }
  _dragTooltip.textContent = text;
  _dragTooltip.style.left = `${x + 14}px`;
  _dragTooltip.style.top  = `${y - 10}px`;
  _dragTooltip.style.display = 'block';
}

function _hideDragTooltip() {
  if (_dragTooltip) _dragTooltip.style.display = 'none';
}

function _makeDraggable(el, entityType, entityId) {
  el.setAttribute('draggable', 'true');
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', JSON.stringify({ entityType, entityId }));
    e.dataTransfer.effectAllowed = 'move';
    el.classList.add('cal-dragging');

    // Custom ghost image: compact pill showing entity label
    const ghost = document.createElement('div');
    ghost.className = 'cal-drag-ghost';
    ghost.textContent = (el.textContent || '').trim().split('\n')[0].trim().slice(0, 40);
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 0, 0);
    // Remove ghost after drag starts (browser has already captured it)
    requestAnimationFrame(() => ghost.remove());

    // Store globally so drop targets can highlight
    _dragPayload = { entityType, entityId };
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('cal-dragging');
    _dragPayload = null;
    _hideDragTooltip();
    // Remove all drop highlights
    document.querySelectorAll('.cal-drop-target').forEach(t => t.classList.remove('cal-drop-target'));
  });
}

/** Current drag payload — set during dragstart, cleared on dragend */
let _dragPayload = null;

/**
 * Make a cell a drop target. Snaps to SNAP_MINUTES (10) increments.
 * baseHour is the integer hour of this row; Y position within slot
 * determines the snapped minute.
 */
function _makeDropTarget(el, newDateStr, baseHour) {
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    el.classList.add('cal-drop-target');

    // Show snapped time tooltip during drag
    if (baseHour != null) {
      const rect   = el.getBoundingClientRect();
      const relY   = Math.max(0, Math.min(e.clientY - rect.top, rect.height - 1));
      const rawMin = (relY / rect.height) * 60;
      let   snapMin  = Math.round(rawMin / SNAP_MINUTES) * SNAP_MINUTES;
      let   snapHour = baseHour;
      if (snapMin >= 60) { snapHour++; snapMin = 0; }
      const ampm   = snapHour >= 12 ? 'PM' : 'AM';
      const h12    = snapHour === 0 ? 12 : snapHour > 12 ? snapHour - 12 : snapHour;
      const label  = `${h12}:${String(snapMin).padStart(2,'0')} ${ampm}`;
      _showDragTooltip(label, e.clientX, e.clientY);
    }
  });
  el.addEventListener('dragleave', (e) => {
    el.classList.remove('cal-drop-target');
    // Only hide tooltip if truly leaving this cell (not entering a child)
    if (!el.contains(e.relatedTarget)) _hideDragTooltip();
  });
  el.addEventListener('drop', async (e) => {
    e.preventDefault();
    el.classList.remove('cal-drop-target');
    let payload;
    try { payload = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }
    if (!payload?.entityId || !payload?.entityType) return;

    let hour = baseHour, min = 0;
    if (baseHour != null) {
      const rect   = el.getBoundingClientRect();
      const relY   = Math.max(0, Math.min(e.clientY - rect.top, rect.height - 1));
      const rawMin = (relY / rect.height) * 60;
      min  = Math.round(rawMin / SNAP_MINUTES) * SNAP_MINUTES;
      if (min >= 60) { hour++; min = 0; }
    }
    await _rescheduleEntity(payload.entityType, payload.entityId, newDateStr, hour, min);
  });
}

/**
 * Reschedule an entity to a new date (and optionally time).
 * Updates the appropriate date field based on entity type registry.
 */
async function _rescheduleEntity(entityType, entityId, newDateStr, newHour, newMin = 0) {
  try {
    // O(1) direct lookup by ID — avoids loading all entities of this type
    const entity = await getEntity(entityId);
    if (!entity) return;

    const reg = ENTITY_REGISTRY[entityType];
    if (!reg) return;
    const dateField = reg.dateField;
    const oldValue = entity[dateField];

    if (reg.hasTime && newHour != null) {
      const hourStr = String(newHour).padStart(2, '0');
      const minStr  = String(newMin).padStart(2, '0');
      if (entityType === 'task') {
        entity.dueDate = newDateStr;
        entity.dueTime = `${hourStr}:${minStr}`;
        entity._dateTimeISO = `${newDateStr}T${hourStr}:${minStr}:00`;
      } else {
        entity[dateField] = new Date(`${newDateStr}T${hourStr}:${minStr}:00`).toISOString();
        if (entityType === 'event' && entity.endDate && oldValue) {
          const oldStart = new Date(oldValue);
          const newStart = new Date(entity[dateField]);
          const delta    = newStart - oldStart;
          entity.endDate = new Date(new Date(entity.endDate).getTime() + delta).toISOString();
        }
      }
    } else if (reg.hasTime) {
      // Timed entity dropped on day cell (no specific hour): preserve time, change date
      if (oldValue && !/^\d{4}-\d{2}-\d{2}$/.test(oldValue)) {
        const old = new Date(oldValue);
        const preserved = new Date(`${newDateStr}T${String(old.getHours()).padStart(2,'0')}:${String(old.getMinutes()).padStart(2,'0')}:00`);
        const delta = preserved - old;
        entity[dateField] = preserved.toISOString();
        if (entityType === 'event' && entity.endDate) {
          entity.endDate = new Date(new Date(entity.endDate).getTime() + delta).toISOString();
        }
      } else {
        entity[dateField] = newDateStr + 'T12:00:00';
      }
    } else {
      if (entityType === 'task') {
        entity.dueDate = newDateStr;
        if (!entity.dueTime) entity.dueTime = '06:00';
      } else {
        entity[dateField] = newDateStr;
      }
    }

    await saveEntity(entity);
    console.log(`[calendar] Rescheduled ${entityType} "${entity.title || entity.id}" → ${newDateStr}`);
  } catch (err) {
    console.error('[calendar] Reschedule failed:', err);
  }
}

// ── Style injection ───────────────────────────────────────── //

function _injectStyles() {
  if (document.getElementById('calendar-view-styles')) return;
  const style = document.createElement('style');
  style.id = 'calendar-view-styles';
  style.textContent = `
    /* ── Calendar View Layout ─────────────────────────── */
    #view-calendar.active {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
      padding: var(--space-5) var(--space-6);
      max-width: 980px;
      margin: 0 auto;
      width: 100%;
    }
    @media (max-width: 600px) {
      #view-calendar.active { padding: var(--space-3); }
    }

    /* ── Header ───────────────────────────────────────── */
    .cal-header {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
    }
    .cal-title-row {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      flex-wrap: wrap;
    }
    .cal-title {
      font-family: var(--font-heading);
      font-size: var(--text-2xl);
      font-weight: var(--weight-bold);
      color: var(--color-text);
      flex: 1;
      margin: 0;
      min-width: 0;
    }
    .cal-nav-btn {
      font-size: var(--text-xl);
      width: 36px;
      height: 36px;
    }
    .cal-today-btn {
      white-space: nowrap;
    }
    .cal-quick-btns {
      display: flex;
      gap: var(--space-2);
      margin-left: auto;
    }
    .cal-toggle-row {
      display: flex;
      gap: var(--space-1);
      background: var(--color-surface);
      border-radius: var(--radius-md);
      padding: var(--space-0-5);
      border: 1px solid var(--color-border);
      width: fit-content;
    }
    .cal-mode-btn {
      padding: var(--space-1-5) var(--space-4);
      font-size: var(--text-sm);
      font-family: var(--font-body);
      font-weight: var(--weight-medium);
      color: var(--color-text-muted);
      background: transparent;
      border: none;
      border-radius: var(--radius-sm);
      cursor: pointer;
      transition: all var(--transition-fast);
    }
    .cal-mode-btn:hover {
      color: var(--color-text);
      background: var(--color-surface-2);
    }
    .cal-mode-btn.active {
      color: var(--color-text);
      background: var(--color-bg);
      box-shadow: var(--shadow-xs);
    }

    /* ── Month View ───────────────────────────────────── */
    .cal-month {
      display: flex;
      flex-direction: column;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      overflow: hidden;
    }
    .cal-month-header {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      background: var(--color-surface);
      border-bottom: 1px solid var(--color-border);
    }
    .cal-weekday-label {
      padding: var(--space-2) var(--space-1);
      text-align: center;
      font-size: var(--text-xs);
      font-weight: var(--weight-semibold);
      color: var(--color-text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .cal-month-grid {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
    }
    .cal-day-cell {
      position: relative;
      min-height: 80px;
      padding: var(--space-1-5);
      border: none;
      border-right: 1px solid var(--color-border);
      border-bottom: 1px solid var(--color-border);
      background: var(--color-bg);
      cursor: pointer;
      text-align: left;
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
      font-family: var(--font-body);
      transition: background var(--transition-fast);
    }
    .cal-day-cell:nth-child(7n) { border-right: none; }
    .cal-day-cell:nth-last-child(-n+7) { border-bottom: none; }
    .cal-day-cell:hover { background: var(--color-surface); }
    .cal-day-cell.other-month {
      background: var(--color-surface);
      opacity: 0.45;
    }
    .cal-day-cell.other-month:hover { opacity: 0.7; }
    .cal-day-cell.today {
      background: rgba(10, 123, 108, 0.06);
    }
    .cal-day-cell.today:hover {
      background: rgba(10, 123, 108, 0.1);
    }
    .cal-day-num {
      font-size: var(--text-sm);
      font-weight: var(--weight-medium);
      color: var(--color-text);
      line-height: 1;
    }
    .cal-day-cell.today .cal-day-num {
      color: var(--color-bg);
      background: var(--color-accent);
      width: 24px;
      height: 24px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: var(--radius-full);
      font-size: var(--text-xs);
    }
    .cal-day-cell.other-month .cal-day-num { color: var(--color-text-muted); }
    .cal-dot-row {
      display: flex;
      gap: 3px;
      align-items: center;
      flex-wrap: wrap;
      margin-top: auto;
    }
    .cal-dot {
      width: 6px;
      height: 6px;
      border-radius: var(--radius-full);
      flex-shrink: 0;
    }
    .cal-meal-indicator {
      font-size: 9px;
      font-weight: var(--weight-bold);
      color: var(--entity-meal);
      line-height: 1;
    }
    @media (max-width: 600px) {
      .cal-day-cell { min-height: 52px; padding: var(--space-1); }
      .cal-dot { width: 5px; height: 5px; }
    }

    /* ── Day Popover ──────────────────────────────────── */
    .cal-popover-overlay {
      position: fixed;
      inset: 0;
      z-index: var(--z-overlay);
    }
    .cal-popover {
      position: fixed;
      z-index: var(--z-panel);
      width: 300px;
      max-height: 420px;
      background: var(--color-bg);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      box-shadow: var(--shadow-xl);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      animation: cal-popover-in 0.15s ease;
    }
    @keyframes cal-popover-in {
      from { opacity: 0; transform: translateY(-4px) scale(0.97); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }
    .cal-popover-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--space-3) var(--space-4);
      border-bottom: 1px solid var(--color-border);
      background: var(--color-surface);
    }
    .cal-popover-title {
      font-family: var(--font-heading);
      font-size: var(--text-md);
      font-weight: var(--weight-bold);
      color: var(--color-text);
      margin: 0;
    }
    .cal-popover-close {
      width: 28px;
      height: 28px;
      font-size: var(--text-sm);
    }
    .cal-popover-list {
      flex: 1;
      overflow-y: auto;
      padding: var(--space-2);
    }
    .cal-popover-empty {
      padding: var(--space-6) var(--space-4);
      text-align: center;
      color: var(--color-text-muted);
      font-size: var(--text-sm);
    }
    .cal-popover-item {
      display: flex;
      align-items: flex-start;
      gap: var(--space-2-5);
      padding: var(--space-2) var(--space-3);
      border: none;
      border-left: 3px solid var(--color-border);
      background: transparent;
      width: 100%;
      text-align: left;
      font-family: var(--font-body);
      border-radius: var(--radius-sm);
      cursor: pointer;
      transition: background var(--transition-fast);
      margin-bottom: var(--space-1);
    }
    .cal-popover-item:hover { background: var(--color-surface); }
    .cal-popover-icon { font-size: var(--text-md); flex-shrink: 0; margin-top: 1px; }
    .cal-popover-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .cal-popover-item-title {
      font-size: var(--text-sm);
      font-weight: var(--weight-medium);
      color: var(--color-text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .cal-popover-item-detail {
      font-size: var(--text-xs);
      color: var(--color-text-muted);
    }
    .cal-popover-add {
      margin: var(--space-2) var(--space-3) var(--space-3);
      align-self: stretch;
    }

    /* ── Week View ────────────────────────────────────── */
    .cal-week {
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .cal-week-header {
      display: flex;
      background: var(--color-surface);
      border-bottom: 1px solid var(--color-border);
    }
    .cal-week-gutter {
      width: 56px;
      min-width: 56px;
      flex-shrink: 0;
    }
    .cal-week-gutter-label {
      font-size: var(--text-xs);
      color: var(--color-text-muted);
      padding: var(--space-2) var(--space-1);
      text-align: right;
      padding-right: var(--space-2);
    }
    .cal-week-day-label {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: var(--space-2) var(--space-1);
      gap: 2px;
    }
    .cal-week-day-label.today .cal-week-daynum {
      background: var(--color-accent);
      color: var(--color-bg);
      border-radius: var(--radius-full);
      width: 28px;
      height: 28px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .cal-week-dayname {
      font-size: var(--text-xs);
      color: var(--color-text-muted);
      text-transform: uppercase;
      font-weight: var(--weight-semibold);
      letter-spacing: 0.04em;
    }
    .cal-week-daynum {
      font-size: var(--text-md);
      font-weight: var(--weight-semibold);
      color: var(--color-text);
      line-height: 1;
    }

    /* Week: all-day row */
    .cal-week-allday {
      display: flex;
      border-bottom: 1px solid var(--color-border);
      min-height: 32px;
      position: relative;
    }
    .cal-week-allday-cell {
      flex: 1;
      display: flex;
      flex-wrap: wrap;
      gap: 3px;
      padding: var(--space-1);
      border-left: 1px solid var(--color-border);
      min-height: 28px;
    }
    .cal-week-multiday-bar {
      position: absolute;
      height: 20px;
      background: var(--color-info-bg);
      border: none;
      border-left: 3px solid var(--color-info);
      border-radius: var(--radius-sm);
      font-size: 10px;
      font-family: var(--font-body);
      font-weight: var(--weight-semibold);
      color: var(--color-info-text);
      padding: 2px 6px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      cursor: grab;
      z-index: var(--z-raised);
      transition: opacity var(--transition-fast);
    }
    .cal-week-multiday-bar:hover { opacity: 0.8; }
    .cal-week-chip {
      font-size: 10px;
      font-family: var(--font-body);
      padding: 2px 6px;
      border-radius: var(--radius-sm);
      border: none;
      cursor: pointer;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100%;
      line-height: 1.3;
      transition: opacity var(--transition-fast);
    }
    .cal-week-chip:hover { opacity: 0.8; }
    .cal-week-chip.task-chip {
      background: var(--color-success-bg);
      color: var(--color-success-text);
    }
    .cal-week-chip.date-chip {
      background: rgba(236, 72, 153, 0.1);
      color: var(--entity-date);
    }
    .cal-week-more {
      font-size: 9px;
      color: var(--color-text-muted);
      padding: 2px 4px;
    }

    /* Week: time grid body */
    .cal-week-body {
      position: relative;
      overflow-y: auto;
      max-height: 540px;
    }
    .cal-week-hour-row {
      display: flex;
      height: 60px;
      flex-shrink: 0;
      border-bottom: 1px solid var(--color-border);
      position: relative;
    }
    .cal-week-hour-row::after {
      content: '';
      position: absolute;
      left: 52px; right: 0; top: 50%;
      border-top: 1px dashed var(--color-border);
      opacity: 0.4;
      pointer-events: none;
    }
    .cal-week-hour-row:last-child { border-bottom: none; }
    .cal-hour-label {
      display: flex;
      align-items: flex-start;
      justify-content: flex-end;
      padding: 2px var(--space-2) 0 0;
      font-size: 10px;
      color: var(--color-text-muted);
      font-weight: var(--weight-medium);
    }
    .cal-week-slot {
      flex: 1;
      border-left: 1px solid var(--color-border);
      cursor: pointer;
      transition: background var(--transition-fast);
    }
    .cal-week-slot:hover { background: var(--color-surface); }
    .cal-week-slot.today-col { background: rgba(10, 123, 108, 0.03); }
    .cal-week-slot.today-col:hover { background: rgba(10, 123, 108, 0.07); }

    /* Week: event blocks (absolutely positioned in body) */
    .cal-week-event-block {
      position: absolute;
      border-radius: var(--radius-sm);
      padding: 3px 6px;
      display: flex;
      flex-direction: column;
      gap: 1px;
      overflow: hidden;
      cursor: pointer;
      border: none;
      font-family: var(--font-body);
      text-align: left;
      z-index: var(--z-raised);
      transition: opacity var(--transition-fast), box-shadow var(--transition-fast);
    }
    .cal-week-event-block:hover {
      opacity: 0.85;
      box-shadow: var(--shadow-sm);
    }
    .cal-week-event-title {
      font-size: 11px;
      font-weight: var(--weight-semibold);
      color: var(--color-text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .cal-week-event-time {
      font-size: 10px;
      color: var(--color-text-muted);
    }

    /* ── Agenda View ──────────────────────────────────── */
    .cal-agenda {
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
    }
    .cal-agenda-day {
      display: flex;
      flex-direction: column;
    }
    .cal-agenda-date {
      display: flex;
      align-items: baseline;
      gap: var(--space-3);
      padding: var(--space-3) var(--space-2) var(--space-2);
      border-bottom: 1px solid var(--color-border);
    }
    .cal-agenda-date.today {
      border-bottom-color: var(--color-accent);
    }
    .cal-agenda-dayname {
      font-family: var(--font-heading);
      font-size: var(--text-lg);
      font-weight: var(--weight-bold);
      color: var(--color-text);
    }
    .cal-agenda-date.today .cal-agenda-dayname {
      color: var(--color-accent);
    }
    .cal-agenda-daydetail {
      font-size: var(--text-sm);
      color: var(--color-text-muted);
    }
    .cal-agenda-items {
      display: flex;
      flex-direction: column;
    }
    .cal-agenda-item {
      display: flex;
      align-items: stretch;
      gap: var(--space-4);
      padding: var(--space-3) var(--space-3) var(--space-3) var(--space-4);
      border: none;
      border-left: 3px solid var(--color-border);
      background: transparent;
      width: 100%;
      text-align: left;
      font-family: var(--font-body);
      cursor: pointer;
      transition: background var(--transition-fast);
    }
    .cal-agenda-item:hover { background: var(--color-surface); }
    .cal-agenda-time {
      width: 110px;
      min-width: 110px;
      font-size: var(--text-xs);
      color: var(--color-text-muted);
      font-weight: var(--weight-medium);
      padding-top: 2px;
    }
    .cal-agenda-content {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }
    .cal-agenda-item-title {
      font-size: var(--text-sm);
      font-weight: var(--weight-medium);
      color: var(--color-text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .cal-agenda-item-meta {
      font-size: var(--text-xs);
      color: var(--color-text-muted);
    }
    .cal-agenda-empty {
      padding: var(--space-10) var(--space-4);
      text-align: center;
      color: var(--color-text-muted);
      font-size: var(--text-sm);
    }

    /* ── Overdue indicator ─────────────────────────────── */
    .cal-dot.overdue {
      box-shadow: 0 0 0 1.5px var(--color-danger);
    }
    .cal-popover-item.overdue {
      border-left-color: var(--color-danger) !important;
    }
    .cal-overdue-badge {
      font-size: 9px;
      font-weight: var(--weight-bold);
      color: var(--color-danger-text);
      background: var(--color-danger-bg);
      padding: 1px 5px;
      border-radius: var(--radius-full);
      margin-left: var(--space-1);
    }

    /* ── Accessibility: screen-reader only ────────────── */
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }

    /* ── Drag-and-drop ─────────────────────────────────── */
    /* Drag ghost image */
    .cal-drag-ghost {
      position: fixed;
      top: -200px; left: -200px;       /* off-screen but in DOM for setDragImage */
      background: var(--color-accent);
      color: white;
      font-size: 12px;
      font-weight: var(--weight-semibold);
      font-family: var(--font-body);
      padding: 4px 10px;
      border-radius: var(--radius-full);
      white-space: nowrap;
      pointer-events: none;
      box-shadow: var(--shadow-md);
    }

    /* Drag time tooltip */
    .cal-drag-tooltip {
      position: fixed;
      z-index: 99999;
      background: var(--color-text);
      color: var(--color-bg);
      font-size: 11px;
      font-weight: var(--weight-semibold);
      font-family: var(--font-body);
      padding: 3px 8px;
      border-radius: var(--radius-sm);
      pointer-events: none;
      display: none;
      white-space: nowrap;
      box-shadow: var(--shadow-sm);
    }

    .cal-dragging {
      opacity: 0.5;
      cursor: grabbing;
    }
    .cal-drop-target {
      background: rgba(10, 123, 108, 0.12) !important;
      outline: 2px dashed var(--color-accent);
      outline-offset: -2px;
    }
    [draggable="true"] {
      cursor: grab;
    }
    [draggable="true"]:active {
      cursor: grabbing;
    }

    /* ── Responsive ───────────────────────────────────── */
    @media (max-width: 600px) {
      .cal-toggle-row { width: 100%; }
      .cal-mode-btn { flex: 1; text-align: center; }
      .cal-week-gutter { width: 40px; min-width: 40px; }
      .cal-hour-label { font-size: 9px; }
      .cal-agenda-time { width: 80px; min-width: 80px; }
      .cal-popover { width: calc(100vw - 32px); max-width: 340px; }
      .cal-quick-btns { width: 100%; justify-content: stretch; }
      .cal-quick-btns .btn { flex: 1; }
      .cal-title-row { gap: var(--space-2); }
    }
  `;
  document.head.appendChild(style);
}

// ── Main render ───────────────────────────────────────────── //

/**
 * Main render function for the Calendar view.
 * Called by the router whenever view='calendar' is activated.
 * Also called internally when navigating or switching modes.
 * @param {object} [params={}]
 */
async function renderCalendar(params = {}) {
  // Clean up any open popover from a previous render
  _closePopover();

  // Handle params
  if (params?._internal) {
    // Internal re-render: _anchorDate already updated
  } else if (params?.date) {
    const d = new Date(params.date + 'T00:00:00');
    if (!isNaN(d.getTime())) _anchorDate = d;
  } else {
    // Fresh navigation: restore saved state or snap to today
    _restoreViewState();
  }

  const viewEl = document.getElementById('view-calendar');
  if (!viewEl) return;

  _injectStyles();

  // Show loading
  viewEl.innerHTML = `
    <div style="padding: var(--space-8); color: var(--color-text-muted); text-align: center;">
      Loading calendar…
    </div>
  `;

  try {
    const data = await _loadData();

    // Compute date range for the current view
    const year  = _anchorDate.getFullYear();
    const month = _anchorDate.getMonth();
    let rangeStart, rangeEnd;

    if (_mode === MODES.MONTH) {
      // Show from first visible grid cell to last (6 weeks around the month)
      const gridStart = _getMonthGridStart(year, month);
      const gridEnd   = new Date(gridStart);
      gridEnd.setDate(gridEnd.getDate() + 41);
      rangeStart = _toDateStr(gridStart);
      rangeEnd   = _toDateStr(gridEnd);
    } else if (_mode === MODES.WEEK) {
      const ws = _getWeekStart(_anchorDate);
      const we = new Date(ws);
      we.setDate(we.getDate() + 6);
      rangeStart = _toDateStr(ws);
      rangeEnd   = _toDateStr(we);
    } else {
      // Agenda: next AGENDA_DAYS from anchor
      rangeStart = _toDateStr(_anchorDate);
      const end = new Date(_anchorDate);
      end.setDate(end.getDate() + AGENDA_DAYS - 1);
      rangeEnd = _toDateStr(end);
    }

    const dateMap = _buildDateMap(data, rangeStart, rangeEnd);

    // Clear and rebuild
    viewEl.innerHTML = '';

    _buildHeader(viewEl);

    if (_mode === MODES.MONTH) {
      _buildMonthView(viewEl, dateMap);
    } else if (_mode === MODES.WEEK) {
      _buildWeekView(viewEl, dateMap);
    } else {
      _buildAgendaView(viewEl, dateMap);
    }

  } catch (err) {
    console.error('[calendar] Render failed:', err);
    viewEl.innerHTML = `
      <div style="padding: var(--space-8); color: var(--color-danger-text); text-align: center;">
        Failed to load calendar. Please try refreshing.
      </div>
    `;
  }
}

// ── Event listeners for live updates ──────────────────────── //

on(EVENTS.ENTITY_SAVED,   _debouncedRender);
on(EVENTS.ENTITY_DELETED, _debouncedRender);

// Close popover when navigating away from calendar
on(EVENTS.VIEW_CHANGED, ({ viewKey }) => {
  if (viewKey !== 'calendar') {
    _closePopover();
  }
});

// ── Registration ──────────────────────────────────────────── //

registerView('calendar', renderCalendar);

// ── Export ─────────────────────────────────────────────────── //

export { renderCalendar };

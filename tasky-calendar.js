/* ═══════════════════════════════════════════════════════════════════════════
   TASKY CALENDAR — Full Feature Implementation
   Replaces the stub _calRender / openCalendarView in tasky-features.js
   Features:
   • Monthly / Weekly view toggle
   • Drag-to-reschedule (updates task dueDate instantly)
   • Color-coded by status: todo=purple, working=amber, done=green
   • Collaboration sync: shows assignedTo avatars
   • Arrow-key navigation (days in month, weeks)
   ═══════════════════════════════════════════════════════════════════════════ */

(function() {
'use strict';

/* ─── State ──────────────────────────────────────────────────────────────── */
let _calYear    = new Date().getFullYear();
let _calMonth   = new Date().getMonth();
let _calView    = 'month';          // 'month' | 'week'
let _calWeekOf  = null;             // Date (Monday of current week in week-view)
let _focusedDs  = null;             // keyboard-focused date string YYYY-MM-DD
let _dragTaskId = null;
let _dragCol    = null;

/* ─── Helpers ─────────────────────────────────────────────────────────────  */
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAYS_S = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function _esc(s) {
  return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function _today() { return new Date().toISOString().split('T')[0]; }
function _dateStr(y,m,d) {
  return `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}
function _addDays(ds, n) {
  const d = new Date(ds + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}
function _mondayOf(ds) {
  const d = new Date(ds + 'T00:00:00');
  const dow = d.getDay(); // 0=Sun
  d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
  return d.toISOString().split('T')[0];
}

/* ─── Collect all tasks with dueDate ─────────────────────────────────────── */
function _buildTaskMap() {
  const map = {};
  const src = (typeof tasks !== 'undefined') ? tasks : {};
  ['todo','working','done'].forEach(col => {
    (src[col] || []).forEach(t => {
      if (!t.dueDate) return;
      if (!map[t.dueDate]) map[t.dueDate] = [];
      map[t.dueDate].push({ task: t, col });
    });
  });
  // Also pull collab tasks if present
  if (typeof window._collabTasksByDate === 'function') {
    const ct = window._collabTasksByDate();
    Object.keys(ct).forEach(ds => {
      if (!map[ds]) map[ds] = [];
      ct[ds].forEach(item => map[ds].push(item));
    });
  }
  return map;
}

/* ─── Avatar initials for a handle ───────────────────────────────────────── */
function _avatarHtml(handle) {
  if (!handle) return '';
  const initials = handle.replace(/[^a-z0-9]/gi,'').slice(0,2).toUpperCase() || '?';
  const hue = [...handle].reduce((h,c) => h + c.charCodeAt(0), 0) % 360;
  return `<span class="cal-avatar" style="background:hsl(${hue},55%,42%)" title="@${_esc(handle)}">${_esc(initials)}</span>`;
}

/* ─── Chip HTML for a task ────────────────────────────────────────────────── */
function _chipHtml(task, col, compact) {
  const label = compact ? (task.text||'').slice(0,18) : (task.text||'').slice(0,26);
  const avatar = task.assignedTo ? _avatarHtml(task.assignedTo) : '';
  const prio   = task.priority === 'high' ? '🔴' : task.priority === 'low' ? '🟢' : '';
  return `<div class="cal-chip ${col}" draggable="true"
      data-tid="${task.id}" data-col="${col}"
      title="${_esc(task.text)}${task.assignedTo?' → @'+task.assignedTo:''}"
    >${avatar}<span class="cal-chip-text">${_esc(label)}</span>${prio?`<span class="cal-chip-prio">${prio}</span>`:''}</div>`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   MONTH VIEW
   ═══════════════════════════════════════════════════════════════════════════ */
function _renderMonth() {
  const panel = document.getElementById('cal-main');
  if (!panel) return;

  const map = _buildTaskMap();
  const firstDay = new Date(_calYear, _calMonth, 1);
  const lastDay  = new Date(_calYear, _calMonth + 1, 0);
  const startDow = firstDay.getDay();
  const today    = _today();

  // Header row
  let html = `<div class="cal-month-grid">`;
  DAYS_S.forEach(d => { html += `<div class="cal-dow-header">${d}</div>`; });

  // Leading empty days from prev month
  for (let i = 0; i < startDow; i++) {
    const d = new Date(_calYear, _calMonth, -startDow + i + 1);
    const ds = d.toISOString().split('T')[0];
    html += _monthDayHtml(ds, d.getDate(), true, map[ds]||[], today);
  }
  for (let d = 1; d <= lastDay.getDate(); d++) {
    const ds = _dateStr(_calYear, _calMonth, d);
    html += _monthDayHtml(ds, d, false, map[ds]||[], today);
  }
  const total = startDow + lastDay.getDate();
  const trail = (7 - (total % 7)) % 7;
  for (let i = 1; i <= trail; i++) {
    const d = new Date(_calYear, _calMonth + 1, i);
    const ds = d.toISOString().split('T')[0];
    html += _monthDayHtml(ds, i, true, map[ds]||[], today);
  }
  html += `</div>`;
  panel.innerHTML = html;
  _bindChips(panel);
  _bindDropZones(panel);

  // Keyboard focus
  if (_focusedDs) {
    const el = panel.querySelector(`[data-date="${_focusedDs}"]`);
    if (el) { el.classList.add('cal-focused'); el.focus(); }
  }
}

function _monthDayHtml(ds, dayNum, other, dayTasks, today) {
  const isToday   = ds === today;
  const isFocused = ds === _focusedDs;
  const cls = ['cal-month-day',
    other    ? 'other-month' : '',
    isToday  ? 'today'       : '',
    isFocused? 'cal-focused' : ''
  ].filter(Boolean).join(' ');

  let inner = `<div class="cal-day-number">${dayNum}</div><div class="cal-day-tasks">`;
  const MAX = 3;
  dayTasks.slice(0, MAX).forEach(({task,col}) => {
    inner += _chipHtml(task, col, true);
  });
  if (dayTasks.length > MAX) {
    inner += `<div class="cal-more-badge">+${dayTasks.length - MAX} more</div>`;
  }
  inner += `</div>`;
  return `<div class="${cls}" data-date="${ds}" tabindex="-1">${inner}</div>`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   WEEK VIEW
   ═══════════════════════════════════════════════════════════════════════════ */
function _renderWeek() {
  const panel = document.getElementById('cal-main');
  if (!panel) return;

  if (!_calWeekOf) _calWeekOf = _mondayOf(_today());
  const map   = _buildTaskMap();
  const today = _today();

  // 7 days Mon–Sun
  const days = [];
  for (let i = 0; i < 7; i++) days.push(_addDays(_calWeekOf, i));

  let html = `<div class="cal-week-grid">`;
  // Headers
  days.forEach(ds => {
    const d = new Date(ds + 'T00:00:00');
    const isToday = ds === today;
    html += `<div class="cal-week-header${isToday?' today':''}">
      <span class="cal-week-dow">${DAYS_S[d.getDay()]}</span>
      <span class="cal-week-num${isToday?' today':''}">${d.getDate()}</span>
    </div>`;
  });
  // Task cells
  days.forEach(ds => {
    const isToday = ds === today;
    const isFocused = ds === _focusedDs;
    const dayTasks = map[ds] || [];
    html += `<div class="cal-week-cell${isToday?' today':''}${isFocused?' cal-focused':''}" data-date="${ds}" tabindex="-1">`;
    dayTasks.forEach(({task,col}) => { html += _chipHtml(task, col, false); });
    html += `</div>`;
  });
  html += `</div>`;
  panel.innerHTML = html;
  _bindChips(panel);
  _bindDropZones(panel);
}

/* ─── Bind chip click & drag-start ──────────────────────────────────────── */
function _bindChips(panel) {
  panel.querySelectorAll('.cal-chip[data-tid]').forEach(chip => {
    // Click → select task on board
    chip.addEventListener('click', function(e) {
      e.stopPropagation();
      closeCalendarView();
      const tid = parseInt(this.dataset.tid), col = this.dataset.col;
      setTimeout(() => {
        if (typeof selectTask === 'function') selectTask(col, tid);
        if (typeof scrollTaskIntoView === 'function') scrollTaskIntoView(tid);
      }, 220);
    });

    // Drag start
    chip.addEventListener('dragstart', function(e) {
      _dragTaskId = parseInt(this.dataset.tid);
      _dragCol    = this.dataset.col;
      this.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', _dragTaskId);
    });
    chip.addEventListener('dragend', function() {
      this.classList.remove('dragging');
      _dragTaskId = null; _dragCol = null;
    });
  });
}

/* ─── Bind drop zones (day cells) ────────────────────────────────────────── */
function _bindDropZones(panel) {
  panel.querySelectorAll('[data-date]').forEach(cell => {
    cell.addEventListener('dragover', function(e) {
      if (_dragTaskId === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      panel.querySelectorAll('.cal-drop-target').forEach(el => el.classList.remove('cal-drop-target'));
      this.classList.add('cal-drop-target');
    });
    cell.addEventListener('dragleave', function() {
      this.classList.remove('cal-drop-target');
    });
    cell.addEventListener('drop', function(e) {
      e.preventDefault();
      this.classList.remove('cal-drop-target');
      if (_dragTaskId === null) return;
      const newDate = this.dataset.date;
      _rescheduleTask(_dragCol, _dragTaskId, newDate);
    });

    // Click on empty area of day → set focus
    cell.addEventListener('click', function(e) {
      if (e.target === this || e.target.classList.contains('cal-day-tasks') || e.target.classList.contains('cal-day-number')) {
        _focusedDs = this.dataset.date;
        panel.querySelectorAll('.cal-focused').forEach(el => el.classList.remove('cal-focused'));
        this.classList.add('cal-focused');
      }
    });
  });
}

/* ─── Reschedule task ─────────────────────────────────────────────────────── */
function _rescheduleTask(col, taskId, newDate) {
  const src = (typeof tasks !== 'undefined') ? tasks : {};
  let found = null;
  ['todo','working','done'].forEach(c => {
    (src[c] || []).forEach(t => { if (t.id === taskId) { found = t; col = c; } });
  });
  if (!found) return;
  const oldDate = found.dueDate;
  found.dueDate = newDate;
  if (typeof saveAll === 'function') saveAll();
  if (typeof renderAllColumns === 'function') renderAllColumns();
  if (typeof showToast === 'function') {
    showToast(`📅 Rescheduled to ${newDate}`, () => {
      found.dueDate = oldDate; // undo
      if (typeof saveAll === 'function') saveAll();
      if (typeof renderAllColumns === 'function') renderAllColumns();
      _calRefresh();
    });
  }
  _calRefresh();
}

/* ═══════════════════════════════════════════════════════════════════════════
   RENDER DISPATCH + HEADER UPDATE
   ═══════════════════════════════════════════════════════════════════════════ */
function _updateHeader() {
  const lbl = document.getElementById('cal-period-label');
  if (!lbl) return;
  if (_calView === 'month') {
    lbl.textContent = `${MONTHS[_calMonth]} ${_calYear}`;
  } else {
    // Week view label
    if (!_calWeekOf) _calWeekOf = _mondayOf(_today());
    const sun = _addDays(_calWeekOf, 6);
    const dStart = new Date(_calWeekOf + 'T00:00:00');
    const dEnd   = new Date(sun + 'T00:00:00');
    const sameMonth = dStart.getMonth() === dEnd.getMonth();
    lbl.textContent = sameMonth
      ? `${MONTHS[dStart.getMonth()]} ${dStart.getDate()}–${dEnd.getDate()}, ${dStart.getFullYear()}`
      : `${MONTHS[dStart.getMonth()]} ${dStart.getDate()} – ${MONTHS[dEnd.getMonth()]} ${dEnd.getDate()}, ${dEnd.getFullYear()}`;
  }
}

function _calRefresh() {
  _updateHeader();
  if (_calView === 'month') _renderMonth();
  else _renderWeek();
}

/* ─── Navigation ──────────────────────────────────────────────────────────── */
function _calPrevPeriod() {
  if (_calView === 'month') {
    if (--_calMonth < 0) { _calMonth = 11; _calYear--; }
  } else {
    _calWeekOf = _addDays(_calWeekOf || _mondayOf(_today()), -7);
  }
  _calRefresh();
}
function _calNextPeriod() {
  if (_calView === 'month') {
    if (++_calMonth > 11) { _calMonth = 0; _calYear++; }
  } else {
    _calWeekOf = _addDays(_calWeekOf || _mondayOf(_today()), 7);
  }
  _calRefresh();
}
function _calGoToday() {
  const now = new Date();
  _calYear  = now.getFullYear();
  _calMonth = now.getMonth();
  _calWeekOf = _mondayOf(_today());
  _focusedDs = _today();
  _calRefresh();
}

/* ─── Keyboard navigation ─────────────────────────────────────────────────── */
function _calKeydown(e) {
  const overlay = document.getElementById('cal-overlay');
  if (!overlay || !overlay.classList.contains('visible')) return;

  const tag = document.activeElement ? document.activeElement.tagName : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

  switch (e.key) {
    case 'Escape':
      e.preventDefault(); e.stopPropagation();
      closeCalendarView();
      return;
    case 'ArrowLeft':
      e.preventDefault(); e.stopPropagation();
      if (_focusedDs) {
        _focusedDs = _addDays(_focusedDs, -1);
        const fd = new Date(_focusedDs + 'T00:00:00');
        if (_calView === 'month' && (fd.getMonth() !== _calMonth || fd.getFullYear() !== _calYear)) {
          _calYear = fd.getFullYear(); _calMonth = fd.getMonth();
        } else if (_calView === 'week') {
          _calWeekOf = _mondayOf(_focusedDs);
        }
      } else {
        _calPrevPeriod();
      }
      _calRefresh();
      return;
    case 'ArrowRight':
      e.preventDefault(); e.stopPropagation();
      if (_focusedDs) {
        _focusedDs = _addDays(_focusedDs, 1);
        const fd = new Date(_focusedDs + 'T00:00:00');
        if (_calView === 'month' && (fd.getMonth() !== _calMonth || fd.getFullYear() !== _calYear)) {
          _calYear = fd.getFullYear(); _calMonth = fd.getMonth();
        } else if (_calView === 'week') {
          _calWeekOf = _mondayOf(_focusedDs);
        }
      } else {
        _calNextPeriod();
      }
      _calRefresh();
      return;
    case 'ArrowUp':
      e.preventDefault(); e.stopPropagation();
      if (_focusedDs) {
        _focusedDs = _addDays(_focusedDs, -7);
        const fd = new Date(_focusedDs + 'T00:00:00');
        if (_calView === 'month' && (fd.getMonth() !== _calMonth || fd.getFullYear() !== _calYear)) {
          _calYear = fd.getFullYear(); _calMonth = fd.getMonth();
        } else if (_calView === 'week') {
          _calWeekOf = _mondayOf(_focusedDs);
        }
      } else {
        _calPrevPeriod();
      }
      _calRefresh();
      return;
    case 'ArrowDown':
      e.preventDefault(); e.stopPropagation();
      if (_focusedDs) {
        _focusedDs = _addDays(_focusedDs, 7);
        const fd = new Date(_focusedDs + 'T00:00:00');
        if (_calView === 'month' && (fd.getMonth() !== _calMonth || fd.getFullYear() !== _calYear)) {
          _calYear = fd.getFullYear(); _calMonth = fd.getMonth();
        } else if (_calView === 'week') {
          _calWeekOf = _mondayOf(_focusedDs);
        }
      } else {
        _calNextPeriod();
      }
      _calRefresh();
      return;
    case 't':
    case 'T':
      e.preventDefault(); e.stopPropagation();
      _calGoToday();
      return;
    case 'm':
    case 'M':
      e.preventDefault(); e.stopPropagation();
      _setView('month');
      return;
    case 'w':
    case 'W':
      e.preventDefault(); e.stopPropagation();
      _setView('week');
      return;
  }
}

function _setView(v) {
  _calView = v;
  if (v === 'week' && !_calWeekOf) _calWeekOf = _mondayOf(_today());
  document.querySelectorAll('.cal-view-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.view === v);
  });
  _calRefresh();
}

/* ═══════════════════════════════════════════════════════════════════════════
   OPEN / CLOSE
   ═══════════════════════════════════════════════════════════════════════════ */
function openCalendarView() {
  // Init state
  const now = new Date();
  _calYear  = now.getFullYear();
  _calMonth = now.getMonth();
  _calWeekOf = _mondayOf(_today());
  _focusedDs = _today();

  let overlay = document.getElementById('cal-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'cal-overlay';
    overlay.addEventListener('click', e => { if (e.target === overlay) closeCalendarView(); });
    overlay.innerHTML = `
    <div id="cal-panel">
      <div class="cal-header">
        <div class="cal-title-area">
          <span class="cal-icon">📅</span>
          <span class="cal-title">Calendar</span>
        </div>
        <div class="cal-controls">
          <div class="cal-view-toggle">
            <button class="cal-view-btn active" data-view="month" onclick="window._calSetView('month')">Month</button>
            <button class="cal-view-btn" data-view="week" onclick="window._calSetView('week')">Week</button>
          </div>
          <button class="cal-today-btn" onclick="window._calGoToday()" title="Go to today (T)">Today</button>
          <div class="cal-nav-group">
            <button class="cal-nav-btn" onclick="window._calPrev()" title="Previous">‹</button>
            <span class="cal-period-label" id="cal-period-label"></span>
            <button class="cal-nav-btn" onclick="window._calNext()" title="Next">›</button>
          </div>
          <button class="cal-close-btn" onclick="closeCalendarView()" title="Close (Esc)">✕</button>
        </div>
      </div>

      <div class="cal-legend">
        <span class="cal-legend-item todo">📝 To Do</span>
        <span class="cal-legend-item working">⚡ Working On</span>
        <span class="cal-legend-item done">✅ Done</span>
        <span class="cal-legend-hint">Drag chips to reschedule · Arrow keys to navigate</span>
      </div>

      <div id="cal-main" class="cal-main"></div>

      <div class="cal-footer-hint">
        <kbd>←</kbd><kbd>→</kbd><kbd>↑</kbd><kbd>↓</kbd> navigate days &nbsp;·&nbsp;
        <kbd>M</kbd> month view &nbsp;·&nbsp;
        <kbd>W</kbd> week view &nbsp;·&nbsp;
        <kbd>T</kbd> today &nbsp;·&nbsp;
        <kbd>Esc</kbd> close
      </div>
    </div>`;
    document.body.appendChild(overlay);
    document.addEventListener('keydown', _calKeydown, true);
  }

  overlay.classList.add('visible');
  _calRefresh();
  // Move DOM focus into the panel so board shortcuts don't intercept keys
  requestAnimationFrame(() => {
    const panel = document.getElementById('cal-panel');
    if (panel) {
      if (!panel.hasAttribute('tabindex')) panel.setAttribute('tabindex', '-1');
      panel.focus({ preventScroll: true });
    }
  });
}

function closeCalendarView() {
  const o = document.getElementById('cal-overlay');
  if (o) {
    o.classList.remove('visible');
    o.classList.add('cal-closing');
    setTimeout(() => o.classList.remove('cal-closing'), 300);
  }
}

/* ─── Expose globals ──────────────────────────────────────────────────────── */
window.openCalendarView  = openCalendarView;
window.closeCalendarView = closeCalendarView;
window._calPrev   = _calPrevPeriod;
window._calNext   = _calNextPeriod;
window._calGoToday = _calGoToday;
window._calSetView = _setView;

/* ─── Stub out old _calRender if tasky-features.js already defined it ─────── */
window._calRender = _calRefresh;

})();

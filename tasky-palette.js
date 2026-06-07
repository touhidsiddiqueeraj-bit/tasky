(function() {
var style = document.createElement('style');
style.textContent = `
#kp-overlay { position:fixed;inset:0;z-index:10500;display:none;align-items:flex-start;justify-content:center;padding-top:clamp(50px,8vh,100px);background:rgba(6,5,10,0.7);backdrop-filter:blur(10px); }
#kp-overlay.visible { display:flex;animation:kp-fade .15s ease; }
@keyframes kp-fade { from{opacity:0} to{opacity:1} }
#kp-box { width:min(580px,92vw);background:rgba(20,18,34,0.96);border:1px solid rgba(255,255,255,0.08);border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.5);overflow:hidden; }
#kp-input-row { display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid rgba(255,255,255,0.06); }
#kp-input-row span { font-size:16px;color:rgba(255,255,255,0.3); }
#kp-input { flex:1;background:none;border:none;color:#fff;font-size:16px;outline:none; }
#kp-input::placeholder { color:rgba(255,255,255,0.2); }
#kp-results { max-height:420px;overflow-y:auto;padding:6px 0; }
.kp-section-hdr { font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:rgba(255,255,255,0.25);padding:8px 18px 4px; }
.kp-item { display:flex;align-items:center;gap:10px;padding:8px 18px;cursor:pointer;transition:background .08s; }
.kp-item:hover,.kp-item.kp-focused { background:rgba(139,92,246,0.12); }
.kp-item-icon { width:24px;text-align:center;font-size:14px;flex-shrink:0; }
.kp-item-text { flex:1;font-size:13px;color:rgba(255,255,255,0.85); }
.kp-item-text em { color:#a78bfa;font-style:normal; }
.kp-item-col { font-size:10px;padding:2px 6px;border-radius:4px;background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.3);flex-shrink:0; }
.kp-item-kbd { font-size:10px;padding:2px 5px;border-radius:4px;background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.25);font-family:inherit;flex-shrink:0; }
.kp-footer { display:flex;gap:14px;padding:8px 18px;border-top:1px solid rgba(255,255,255,0.06);font-size:11px;color:rgba(255,255,255,0.2); }
.kp-footer kbd { background:rgba(255,255,255,0.06);border-radius:3px;padding:1px 5px;font-family:inherit;color:rgba(255,255,255,0.3); }

body.light-mode #kp-box { background:rgba(255,255,255,0.96);border-color:rgba(0,0,0,0.08); }
body.light-mode #kp-input-row { border-bottom-color:rgba(0,0,0,0.06); }
body.light-mode #kp-input-row span { color:rgba(0,0,0,0.2); }
body.light-mode #kp-input { color:#111; }
body.light-mode #kp-input::placeholder { color:rgba(0,0,0,0.2); }
body.light-mode .kp-section-hdr { color:rgba(0,0,0,0.3); }
body.light-mode .kp-item:hover,.kp-item.kp-focused { background:rgba(139,92,246,0.06); }
body.light-mode .kp-item-text { color:rgba(0,0,0,0.75); }
body.light-mode .kp-item-text em { color:#7C3AED; }
body.light-mode .kp-item-col { background:rgba(0,0,0,0.04);color:rgba(0,0,0,0.3); }
body.light-mode .kp-item-kbd { background:rgba(0,0,0,0.04);color:rgba(0,0,0,0.25); }
body.light-mode .kp-footer { border-top-color:rgba(0,0,0,0.06);color:rgba(0,0,0,0.2); }
body.light-mode .kp-footer kbd { background:rgba(0,0,0,0.04);color:rgba(0,0,0,0.25); }
`;
document.head.appendChild(style);
})();

console.log('tasky-palette.js loaded');
var _kpOpen = false;
var _kpFocus = -1;
var _kpItems = [];

var KP_ACTIONS = [
    { id: 'new-task', icon: '➕', label: 'New Task', action: function() { _kpClose(); setTimeout(function() { var fi = document.getElementById('floating-input'); if (fi) fi.focus(); }, 80); } },
    { id: 'search', icon: '🔍', label: 'Global Search', action: function() { _kpClose(); setTimeout(function() { if (typeof openGlobalSearch === 'function') openGlobalSearch(); }, 80); } },
    { id: 'calendar', icon: '📅', label: 'Open Calendar', action: function() { _kpClose(); setTimeout(function() { if (typeof toggleCalendar === 'function') toggleCalendar(); }, 80); } },
    { id: 'settings', icon: '⚙️', label: 'Open Settings', action: function() { _kpClose(); setTimeout(function() { if (typeof openSettings === 'function') openSettings(); }, 80); } },
    { id: 'darkmode', icon: '🌓', label: 'Toggle Dark Mode', action: function() { _kpClose(); setTimeout(function() { if (typeof toggleTheme === 'function') toggleTheme(); }, 80); } },
    { id: 'timer-view', icon: '⏱', label: 'Show Running Timers', action: function() { _kpClose(); setTimeout(function() { _kpShowRunningTimers(); }, 80); } },
    { id: 'bulk', icon: '☑', label: 'Toggle Bulk Select', action: function() { _kpClose(); setTimeout(function() { if (typeof _bulkToggle === 'function') _bulkToggle(); }, 80); } },
    { id: 'collab-create', icon: '👥', label: 'Create Collaboration', action: function() { _kpClose(); setTimeout(function() { if (typeof openCollabModal === 'function') openCollabModal('create'); }, 80); } },
    { id: 'collab-join', icon: '🔗', label: 'Join Collaboration', action: function() { _kpClose(); setTimeout(function() { if (typeof openCollabModal === 'function') openCollabModal('join'); }, 80); } },
    { id: 'task-groups', icon: '⊞', label: 'Task Groups', action: function() { _kpClose(); setTimeout(function() { if (typeof openTgModal === 'function') openTgModal(); }, 80); } },
    { id: 'how-to-use', icon: '❓', label: 'How to Use', action: function() { _kpClose(); setTimeout(function() { if (typeof openHowToUse === 'function') openHowToUse(); }, 80); } },
];

var KP_TASK_ACTIONS = [
    { id: 'move-todo', icon: '←', label: 'Move to To Do', action: function(task, col) { if (typeof moveTaskWithUndo === 'function') moveTaskWithUndo(col, 'todo', task.id); _kpClose(); } },
    { id: 'move-working', icon: '→', label: 'Move to Working On', action: function(task, col) { if (typeof moveTaskWithUndo === 'function') moveTaskWithUndo(col, 'working', task.id); _kpClose(); } },
    { id: 'move-done', icon: '→', label: 'Move to Done', action: function(task, col) { if (typeof moveTaskWithUndo === 'function') moveTaskWithUndo(col, 'done', task.id); _kpClose(); } },
    { id: 'pri-high', icon: '🔴', label: 'Priority: High', action: function(task) { task.priority = 'high'; saveAll(); renderAllColumns(); _kpClose(); } },
    { id: 'pri-medium', icon: '🟡', label: 'Priority: Medium', action: function(task) { task.priority = 'medium'; saveAll(); renderAllColumns(); _kpClose(); } },
    { id: 'pri-low', icon: '🟢', label: 'Priority: Low', action: function(task) { task.priority = 'low'; saveAll(); renderAllColumns(); _kpClose(); } },
    { id: 'delete-task', icon: '✕', label: 'Delete Task', action: function(task, col) { if (typeof deleteTaskWithUndo === 'function') deleteTaskWithUndo(col, task.id); _kpClose(); } },
];

function openPalette() {
    console.log('openPalette called');
    console.log('tasks at palette scope:', typeof tasks, tasks === undefined ? 'UNDEFINED!' : 'defined', tasks === null ? 'NULL!' : 'not null');
    if (typeof tasks !== 'undefined' && tasks) {
        console.log('tasks keys:', Object.keys(tasks), 'todo:', tasks.todo?.length, 'working:', tasks.working?.length, 'done:', tasks.done?.length);
    }
    var overlay = document.getElementById('kp-overlay');
    if (!overlay) _kpBuild();
    overlay = document.getElementById('kp-overlay');
    _kpOpen = true;
    _kpFocus = -1;
    overlay.classList.add('visible');
    var input = document.getElementById('kp-input');
    input.value = '';
    input.focus();
    _kpRender('');
}

function _kpClose() {
    var overlay = document.getElementById('kp-overlay');
    if (overlay) overlay.classList.remove('visible');
    _kpOpen = false;
    _kpFocus = -1;
}

function _kpBuild() {
    var overlay = document.createElement('div');
    overlay.id = 'kp-overlay';
    overlay.innerHTML = '<div id="kp-box"><div id="kp-input-row"><span>⌨️</span><input id="kp-input" type="text" placeholder="Type a command or task name…" autocomplete="off" spellcheck="false"></div><div id="kp-results"></div><div class="kp-footer"><span><kbd>↑↓</kbd> navigate</span><span><kbd>Enter</kbd> execute</span><span><kbd>Esc</kbd> close</span></div></div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', function(e) { if (e.target === overlay) _kpClose(); });
    document.getElementById('kp-input').addEventListener('input', function() { _kpRender(this.value); });
    document.getElementById('kp-input').addEventListener('keydown', _kpKeyNav);
}

function _kpGetAllTasks() {
    console.log('tasks exists:', typeof tasks, 'isUndefined:', tasks === undefined);
    var all = [];
    ['todo','working','done'].forEach(function(col) {
        try {
            var arr = tasks[col] || [];
            console.log('col ' + col + ' length:', arr.length);
            arr.forEach(function(t) {
                console.log('palette task:', t);
                var label = '#' + (t.number || '?') + ' ' + (t.text != null && t.text !== 'undefined' && t.text !== 'null' ? t.text : '(untitled)');
                all.push({ task: t, column: col, label: label, searchText: label.toLowerCase() });
            });
        } catch(e) {
            console.error('kpGetAllTasks error for col ' + col + ':', e);
        }
    });
    return all;
}

function _kpScore(text, query) {
    if (!query) return 1;
    text = text.toLowerCase();
    var q = query.toLowerCase().trim();
    if (text === q) return 100;
    if (text.startsWith(q)) return 80;
    if (text.indexOf(q) >= 0) return 60;
    // Fuzzy: each matching char in sequence
    var qi = 0;
    for (var i = 0; i < text.length && qi < q.length; i++) {
        if (text[i] === q[qi]) qi++;
    }
    if (qi === q.length) return 40;
    return 0;
}

function _kpRender(query) {
    var results = document.getElementById('kp-results');
    if (!results) return;
    var q = (query || '').trim();
    _kpItems = [];

    var html = '';

    // Collect matched actions
    var matchedActions = [];
    KP_ACTIONS.forEach(function(a) {
        var score = _kpScore(a.label, q);
        if (score > 0) matchedActions.push({ score: score, type: 'action', data: a });
    });

    // Collect matched tasks
    var allTasks = _kpGetAllTasks();
    var matchedTasks = [];
    allTasks.forEach(function(t) {
        var score = _kpScore(t.searchText, q);
        if (score > 0) matchedTasks.push({ score: score, type: 'task', data: t });
    });

    // Sort by score descending
    matchedActions.sort(function(a, b) { return b.score - a.score; });
    matchedTasks.sort(function(a, b) { return b.score - a.score; });
    var combined = matchedActions.concat(matchedTasks);

    // Limit
    if (combined.length > 30) combined = combined.slice(0, 30);

    if (combined.length === 0) {
        results.innerHTML = '<div style="text-align:center;padding:30px 20px;color:rgba(255,255,255,0.25);font-size:13px;">No matching commands</div>';
        return;
    }

    // Group by type
    var hasActions = combined.some(function(c) { return c.type === 'action'; });
    var hasTasks = combined.some(function(c) { return c.type === 'task'; });
    var actionCount = 0;
    var taskCount = 0;

    if (hasActions) {
        html += '<div class="kp-section-hdr">Actions</div>';
        combined.forEach(function(c) {
            if (c.type !== 'action') return;
            var a = c.data;
            var idx = _kpItems.length;
            html += '<div class="kp-item' + (_kpFocus === idx ? ' kp-focused' : '') + '" data-kp-idx="' + idx + '"><span class="kp-item-icon">' + a.icon + '</span><span class="kp-item-text">' + _kpHighlight(a.label, q) + '</span></div>';
            _kpItems.push({ type: 'action', data: a });
            actionCount++;
        });
    }

    if (hasTasks) {
        html += '<div class="kp-section-hdr">Tasks</div>';
        combined.forEach(function(c) {
            if (c.type !== 'task') return;
            var t = c.data;
            var idx = _kpItems.length;
            var colLabel = t.column;
            html += '<div class="kp-item' + (_kpFocus === idx ? ' kp-focused' : '') + '" data-kp-idx="' + idx + '"><span class="kp-item-icon">#</span><span class="kp-item-text">' + _kpHighlight(t.label, q) + '</span><span class="kp-item-col">' + colLabel + '</span></div>';
            _kpItems.push({ type: 'task', data: t });
            taskCount++;
        });
    }

    results.innerHTML = html;

    // Wire mouse events
    results.querySelectorAll('[data-kp-idx]').forEach(function(el) {
        el.addEventListener('click', function() {
            var idx = parseInt(this.dataset.kpIdx);
            _kpExecute(idx);
        });
        el.addEventListener('mouseenter', function() {
            _kpFocus = parseInt(this.dataset.kpIdx);
            _kpUpdateFocus();
        });
    });
}

function _kpHighlight(text, query) {
    if (!query) return escapeHtml(text);
    var q = query.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var re = new RegExp('(' + q.split('').join('|') + ')', 'gi');
    return escapeHtml(text).replace(re, '<em>$1</em>');
}

function _kpKeyNav(e) {
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        _kpFocus = Math.min(_kpFocus + 1, _kpItems.length - 1);
        _kpUpdateFocus();
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        _kpFocus = Math.max(_kpFocus - 1, 0);
        _kpUpdateFocus();
    } else if (e.key === 'Enter') {
        e.preventDefault();
        if (_kpFocus >= 0) _kpExecute(_kpFocus);
        else if (_kpItems.length > 0) _kpExecute(0);
    } else if (e.key === 'Escape') {
        _kpClose();
    }
}

function _kpUpdateFocus() {
    var items = document.querySelectorAll('#kp-results .kp-item');
    items.forEach(function(el, i) {
        el.classList.toggle('kp-focused', i === _kpFocus);
        if (i === _kpFocus) el.scrollIntoView({ block: 'nearest' });
    });
}

function _kpExecute(idx) {
    var item = _kpItems[idx];
    if (!item) return;
    if (item.type === 'action') {
        item.data.action();
    } else if (item.type === 'task') {
        var t = item.data;
        _kpClose();
        setTimeout(function() {
            if (typeof selectTask === 'function') selectTask(t.column, t.task.id);
            var card = document.getElementById('task-' + t.task.id);
            if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 80);
    }
}

function _kpShowRunningTimers() {
    var found = [];
    ['todo','working','done'].forEach(function(col) {
        (tasks[col] || []).forEach(function(t) {
            var timer = t.timer || {};
            if (timer.startedAt && !timer.pausedAt) {
                found.push({ task: t, col: col });
            }
        });
    });
    if (found.length === 0) {
        if (typeof showToast === 'function') showToast('No running timers', function(){});
        return;
    }
    found.forEach(function(f) {
        var card = document.getElementById('task-' + f.task.id);
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    if (found.length === 1 && typeof selectTask === 'function') selectTask(found[0].col, found[0].task.id);
    if (typeof showToast === 'function') showToast('Found ' + found.length + ' running timer(s)', function(){});
}

// Register keyboard shortcut: Cmd+K / Ctrl+K
if (window.innerWidth >= 768) {
    document.addEventListener('keydown', function(e) {
        if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
            e.preventDefault();
            if (_kpOpen) _kpClose();
            else openPalette();
        }
    });
}

window.openPalette = openPalette;
window._kpClose = _kpClose;

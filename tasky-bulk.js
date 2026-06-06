(function() {
var style = document.createElement('style');
style.textContent = `
.task-card.bulk-selected { outline:2px solid #8B5CF6;outline-offset:1px;border-radius:12px; }
#bulk-bar { position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:9000;background:rgba(20,20,40,0.92);backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,0.1);border-radius:14px;padding:8px 16px;display:none;align-items:center;gap:10px;box-shadow:0 8px 32px rgba(0,0,0,.4); }
.bulk-count { font-size:13px;font-weight:600;color:rgba(255,255,255,0.7);padding-right:8px;border-right:1px solid rgba(255,255,255,0.1);white-space:nowrap; }
.bulk-act { background:rgba(139,92,246,0.12);border:1px solid rgba(139,92,246,0.2);border-radius:8px;color:#a78bfa;font-size:12px;font-weight:500;padding:5px 12px;cursor:pointer;white-space:nowrap; }
.bulk-act:hover { background:rgba(139,92,246,0.2); }
.bulk-act--danger { border-color:rgba(239,68,68,0.3);color:#ef4444;background:rgba(239,68,68,0.08); }
.bulk-act--danger:hover { background:rgba(239,68,68,0.15); }
.bulk-act--clear { background:none;border-color:transparent;color:rgba(255,255,255,0.3); }
.bulk-act--clear:hover { color:rgba(255,255,255,0.6); }

body.light-mode .task-card.bulk-selected { outline-color:#7C3AED; }
body.light-mode #bulk-bar { background:rgba(255,255,255,0.92);border-color:rgba(0,0,0,0.1); }
body.light-mode .bulk-count { color:rgba(0,0,0,0.6);border-right-color:rgba(0,0,0,0.1); }
body.light-mode .bulk-act { background:rgba(139,92,246,0.06);border-color:rgba(139,92,246,0.15);color:#7C3AED; }
body.light-mode .bulk-act--danger { border-color:rgba(239,68,68,0.2);color:#dc2626;background:rgba(239,68,68,0.04); }
body.light-mode .bulk-act--clear { color:rgba(0,0,0,0.2); }
`;
document.head.appendChild(style);
})();

var _bulkMode = false;
var _bulkSelected = {};

function _bulkToggle() {
    _bulkMode = !_bulkMode;
    if (!_bulkMode) _bulkClear();
    var btn = document.getElementById('bulk-toggle-btn');
    if (btn) btn.classList.toggle('active', _bulkMode);
    _bulkUpdateBar();
}

function _bulkSelect(col, taskId) {
    var key = col + ':' + taskId;
    if (_bulkSelected[key]) {
        delete _bulkSelected[key];
        var card = document.getElementById('task-' + taskId);
        if (card) card.classList.remove('bulk-selected');
    } else {
        _bulkSelected[key] = true;
        var card = document.getElementById('task-' + taskId);
        if (card) card.classList.add('bulk-selected');
    }
    _bulkUpdateBar();
}

function _bulkClear() {
    Object.keys(_bulkSelected).forEach(function(k) {
        var parts = k.split(':');
        var card = document.getElementById('task-' + parts[1]);
        if (card) card.classList.remove('bulk-selected');
    });
    _bulkSelected = {};
    _bulkUpdateBar();
}

function _bulkCount() { return Object.keys(_bulkSelected).length; }

function _bulkEach(fn) {
    Object.keys(_bulkSelected).forEach(function(k) {
        var parts = k.split(':');
        fn(parts[0], parseInt(parts[1]));
    });
}

function _bulkMoveAll(targetCol) {
    var keys = Object.keys(_bulkSelected);
    keys.forEach(function(k) {
        var parts = k.split(':');
        var col = parts[0];
        var taskId = parseInt(parts[1]);
        if (typeof moveTaskWithUndo === 'function') moveTaskWithUndo(col, targetCol, taskId);
    });
    _bulkClear();
}

function _bulkDeleteAll() {
    var keys = Object.keys(_bulkSelected);
    var names = [];
    keys.forEach(function(k) {
        var parts = k.split(':');
        var col = parts[0];
        var taskId = parseInt(parts[1]);
        var t = _stFindTask(taskId);
        if (t) names.push('"' + t.text.slice(0, 30) + '"');
    });
    if (names.length === 0) { _bulkClear(); return; }
    if (typeof showConfirm === 'function') {
        showConfirm('Delete ' + keys.length + ' tasks?', names.join('\n'), 'Delete All').then(function(ok) {
            if (!ok) return;
            keys.forEach(function(k) {
                var parts = k.split(':');
                var col = parts[0];
                var taskId = parseInt(parts[1]);
                if (typeof deleteTaskWithUndo === 'function') deleteTaskWithUndo(col, taskId);
            });
            _bulkClear();
        });
    }
}

function _bulkSetPriority(pri) {
    _bulkEach(function(col, taskId) {
        var task = _stFindTask(taskId);
        if (!task) return;
        task.priority = pri;
    });
    saveAll();
    renderAllColumns();
    _bulkClear();
}

function _bulkUpdateBar() {
    var bar = document.getElementById('bulk-bar');
    var count = _bulkCount();
    if (count < 2 || !_bulkMode) {
        if (bar) bar.style.display = 'none';
        return;
    }
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'bulk-bar';
        bar.innerHTML = '<span class="bulk-count"></span>'
            + '<button class="bulk-act" data-bulk="todo">← To Do</button>'
            + '<button class="bulk-act" data-bulk="working">→ Working</button>'
            + '<button class="bulk-act" data-bulk="done">→ Done</button>'
            + '<button class="bulk-act" data-bulk="high">🔴 High</button>'
            + '<button class="bulk-act" data-bulk="medium">🟡 Med</button>'
            + '<button class="bulk-act" data-bulk="low">🟢 Low</button>'
            + '<button class="bulk-act bulk-act--danger" data-bulk="delete">✕ Delete</button>'
            + '<button class="bulk-act bulk-act--clear" data-bulk="clear">Clear</button>';
        document.body.appendChild(bar);
        bar.addEventListener('click', function(e) {
            var act = e.target.dataset.bulk;
            if (!act) return;
            if (act === 'clear') { _bulkClear(); return; }
            if (act === 'delete') { _bulkDeleteAll(); return; }
            if (act === 'todo' || act === 'working' || act === 'done') { _bulkMoveAll(act); return; }
            if (act === 'high' || act === 'medium' || act === 'low') { _bulkSetPriority(act); return; }
        });
    }
    bar.style.display = 'flex';
    bar.querySelector('.bulk-count').textContent = count + ' selected';
}

// Capture-phase click handler to intercept card clicks in bulk mode
document.addEventListener('click', function(e) {
    if (!_bulkMode) return;
    var card = e.target.closest('.task-card');
    if (!card) return;
    // Don't intercept clicks on interactive elements
    if (e.target.closest('button') || e.target.closest('input') || e.target.closest('textarea') || e.target.closest('[data-action]')) return;
    e.stopPropagation();
    e.preventDefault();
    var col = card.dataset.column;
    var tid = parseInt(card.dataset.taskId);
    _bulkSelect(col, tid);
}, true);

// Escape clears bulk mode
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && _bulkMode && _bulkCount() > 0) {
        _bulkClear();
        e.preventDefault();
        e.stopPropagation();
    }
}, true);

// Inject bulk toggle button into the board toolbar
(function _bulkInject() {
    var check = setInterval(function() {
        var toolbar = document.querySelector('.board-toolbar');
        if (!toolbar) return;
        clearInterval(check);
        var btn = document.createElement('button');
        btn.className = 'tb-btn';
        btn.id = 'bulk-toggle-btn';
        btn.textContent = '☑ Bulk';
        btn.title = 'Toggle bulk select mode';
        btn.addEventListener('click', _bulkToggle);
        toolbar.appendChild(btn);
    }, 500);
})();

window._bulkToggle = _bulkToggle;
window._bulkClear = _bulkClear;

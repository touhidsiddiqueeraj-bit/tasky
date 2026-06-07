(function() {
var style = document.createElement('style');
style.textContent = `
#act-overlay { position:fixed;inset:0;z-index:9500;display:none;background:rgba(6,5,10,0.5);backdrop-filter:blur(4px); }
#act-overlay.visible { display:block; }
#act-panel { position:fixed;top:0;right:0;bottom:0;width:380px;max-width:100vw;z-index:9501;background:rgba(16,14,28,0.96);backdrop-filter:blur(20px);border-left:1px solid rgba(255,255,255,0.08);display:flex;flex-direction:column;transform:translateX(100%);transition:transform .25s ease; }
#act-panel.open { transform:translateX(0); }
.act-header { display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-bottom:1px solid rgba(255,255,255,0.06);flex-shrink:0; }
.act-header h3 { margin:0;font-size:15px;font-weight:700;color:rgba(255,255,255,0.9); }
.act-close { background:none;border:none;color:rgba(255,255,255,0.4);font-size:18px;cursor:pointer;padding:4px; }
.act-close:hover { color:#fff; }
.act-body { flex:1;overflow-y:auto;padding:8px 0; }
.act-empty { text-align:center;padding:40px 20px;color:rgba(255,255,255,0.3);font-size:13px; }
.act-item { display:flex;gap:10px;padding:8px 18px;align-items:flex-start;transition:background .12s; }
.act-item:hover { background:rgba(255,255,255,0.03); }
.act-icon { width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0; }
.act-icon--move { background:rgba(59,130,246,0.15); }
.act-icon--delete { background:rgba(239,68,68,0.12); }
.act-icon--create { background:rgba(16,185,129,0.12); }
.act-icon--priority { background:rgba(245,158,11,0.12); }
.act-icon--comment { background:rgba(139,92,246,0.12); }
.act-icon--assign { background:rgba(236,72,153,0.12); }
.act-icon--timer { background:rgba(16,185,129,0.12); }
.act-detail { flex:1;min-width:0; }
.act-text { font-size:12px;color:rgba(255,255,255,0.8);line-height:1.4; }
.act-time { font-size:10px;color:rgba(255,255,255,0.3);margin-top:2px; }
.act-filter-bar { display:flex;gap:4px;padding:8px 18px;border-bottom:1px solid rgba(255,255,255,0.06);flex-wrap:wrap;flex-shrink:0; }
.act-filter { background:rgba(255,255,255,0.05);border:none;border-radius:6px;color:rgba(255,255,255,0.4);font-size:11px;padding:3px 8px;cursor:pointer; }
.act-filter.active { background:rgba(139,92,246,0.15);color:#a78bfa; }

body.light-mode #act-panel { background:rgba(255,255,255,0.96);border-left-color:rgba(0,0,0,0.08); }
body.light-mode .act-header { border-bottom-color:rgba(0,0,0,0.06); }
body.light-mode .act-header h3 { color:rgba(0,0,0,0.8); }
body.light-mode .act-close { color:rgba(0,0,0,0.3); }
body.light-mode .act-empty { color:rgba(0,0,0,0.2); }
body.light-mode .act-item:hover { background:rgba(0,0,0,0.02); }
body.light-mode .act-text { color:rgba(0,0,0,0.7); }
body.light-mode .act-time { color:rgba(0,0,0,0.2); }
body.light-mode .act-filter { color:rgba(0,0,0,0.3);background:rgba(0,0,0,0.03); }
body.light-mode .act-filter.active { background:rgba(139,92,246,0.08);color:#7C3AED; }
body.light-mode #act-toggle-btn { color:rgba(0,0,0,0.3);border-color:rgba(0,0,0,0.08); }
body.light-mode #act-toggle-btn:hover { border-color:rgba(139,92,246,0.3);color:#7C3AED; }
`;
document.head.appendChild(style);
})();

var _activityFeed = [];
var _actOpen = false;
var _actFilter = null;
var _actUnread = 0;
var _actLSKey = 'tasky_activity_v1';

function _actLoad() {
    try { return JSON.parse(localStorage.getItem(_actLSKey)) || []; } catch(e) { return []; }
}
function _actSave() {
    // Keep last 500 events
    if (_activityFeed.length > 500) _activityFeed = _activityFeed.slice(-500);
    localStorage.setItem(_actLSKey, JSON.stringify(_activityFeed));
}
function _actLog(type, taskId, taskText, details) {
    var entry = {
        id: Date.now() + Math.random(),
        type: type,
        taskId: taskId || null,
        taskText: taskText || '',
        details: details || '',
        handle: typeof currentHandle !== 'undefined' && currentHandle ? currentHandle : 'Me',
        timestamp: new Date().toISOString()
    };
    _activityFeed.push(entry);
    _actSave();
    _actUnread++;
    _actUpdateBadge();
    // Firestore sync for collab users
    if (typeof currentGroup !== 'undefined' && currentGroup && typeof db !== 'undefined' && db) {
        _actFirestoreLog(entry);
    }
}

async function _actFirestoreLog(entry) {
    try {
        await db.collection('groups').doc(currentGroup.code).collection('activity').add({
            type: entry.type,
            taskId: entry.taskId,
            taskText: entry.taskText,
            details: entry.details,
            handle: entry.handle,
            timestamp: firebase.firestore.FieldValue.serverTimestamp()
        });
    } catch(_) {}
}

function _actSyncFromFirestore() {
    if (typeof currentGroup === 'undefined' || !currentGroup || typeof db === 'undefined' || !db) return;
    try {
        db.collection('groups').doc(currentGroup.code).collection('activity')
            .orderBy('timestamp', 'desc').limit(100).get()
            .then(function(snap) {
                snap.forEach(function(doc) {
                    var d = doc.data();
                    if (!d.timestamp) return;
                    var id = d.timestamp.toMillis ? d.timestamp.toMillis() + Math.random() : Date.now();
                    if (_activityFeed.some(function(e) { return e.id === id; })) return;
                    _activityFeed.push({
                        id: id,
                        type: d.type || 'unknown',
                        taskId: d.taskId || null,
                        taskText: d.taskText || '',
                        details: d.details || '',
                        handle: d.handle || 'Unknown',
                        timestamp: d.timestamp.toDate ? d.timestamp.toDate().toISOString() : new Date().toISOString()
                    });
                });
                _activityFeed.sort(function(a, b) { return a.timestamp < b.timestamp ? 1 : -1; });
                _actSave();
                if (_actOpen) _actRender();
            }).catch(function() {});
    } catch(_) {}
}

function _actUpdateBadge() {
    var btn = document.getElementById('act-toggle-btn');
    if (!btn) return;
    btn.classList.toggle('has-new', _actUnread > 0);
}

function _actOpenPanel() {
    _actOpen = true;
    _actUnread = 0;
    _actUpdateBadge();
    var overlay = document.getElementById('act-overlay');
    var panel = document.getElementById('act-panel');
    if (!overlay || !panel) _actBuildPanel();
    overlay = document.getElementById('act-overlay');
    panel = document.getElementById('act-panel');
    overlay.classList.add('visible');
    setTimeout(function() { panel.classList.add('open'); }, 10);
    _actRender();
    _actSyncFromFirestore();
}

function _actClose() {
    _actOpen = false;
    var overlay = document.getElementById('act-overlay');
    var panel = document.getElementById('act-panel');
    if (panel) panel.classList.remove('open');
    if (overlay) setTimeout(function() { overlay.classList.remove('visible'); }, 200);
}

function _actBuildPanel() {
    var overlay = document.createElement('div');
    overlay.id = 'act-overlay';
    overlay.addEventListener('click', function(e) { if (e.target === overlay) _actClose(); });
    document.body.appendChild(overlay);

    var panel = document.createElement('div');
    panel.id = 'act-panel';
    panel.innerHTML = '<div class="act-header"><h3>📋 Activity</h3><button class="act-close" id="act-close-btn">✕</button></div><div class="act-filter-bar" id="act-filter-bar"></div><div class="act-body" id="act-body"></div>';
    document.body.appendChild(panel);
    panel.querySelector('#act-close-btn').addEventListener('click', _actClose);
}

function _actRender() {
    var body = document.getElementById('act-body');
    if (!body) return;
    var filtered = _actFilter ? _activityFeed.filter(function(e) { return e.type === _actFilter; }) : _activityFeed;
    if (filtered.length === 0) {
        body.innerHTML = '<div class="act-empty">No activity yet</div>';
        return;
    }
    var html = '';
    filtered.forEach(function(e) {
        var icon = _actIcon(e.type);
        var text = _actFormat(e);
        html += '<div class="act-item"><div class="act-icon act-icon--' + e.type + '">' + icon + '</div><div class="act-detail"><div class="act-text">' + escapeHtml(text) + '</div><div class="act-time">' + _actTimeAgo(e.timestamp) + ' · ' + escapeHtml(e.handle) + '</div></div></div>';
    });
    body.innerHTML = html;

    // Re-render filters
    var filterBar = document.getElementById('act-filter-bar');
    if (filterBar) {
        var types = {};
        _activityFeed.forEach(function(e) { types[e.type] = true; });
        var html = '<button class="act-filter' + (!_actFilter ? ' active' : '') + '" data-act-filter="">All</button>';
        Object.keys(types).forEach(function(t) {
            html += '<button class="act-filter' + (_actFilter === t ? ' active' : '') + '" data-act-filter="' + t + '">' + t + '</button>';
        });
        filterBar.innerHTML = html;
        filterBar.querySelectorAll('[data-act-filter]').forEach(function(btn) {
            btn.addEventListener('click', function() {
                _actFilter = this.dataset.actFilter || null;
                _actRender();
            });
        });
    }
}

function _actIcon(type) {
    switch(type) {
        case 'move': return '↔';
        case 'delete': return '✕';
        case 'create': return '+';
        case 'priority': return '🏳';
        case 'comment': return '💬';
        case 'assign': return '👤';
        case 'timer': return '⏱';
        default: return '•';
    }
}

function _actFormat(e) {
    switch(e.type) {
        case 'move': return 'Moved "' + (e.taskText || '').slice(0, 50) + '" — ' + e.details;
        case 'delete': return 'Deleted "' + (e.taskText || '').slice(0, 50) + '"';
        case 'create': return 'Created "' + (e.taskText || '').slice(0, 50) + '"';
        case 'priority': return 'Set priority of "' + (e.taskText || '').slice(0, 50) + '" to ' + e.details;
        case 'comment': return 'Commented on "' + (e.taskText || '').slice(0, 50) + '"';
        case 'assign': return 'Assigned "' + (e.taskText || '').slice(0, 50) + '" to ' + e.details;
        case 'timer': return 'Logged ' + e.details + ' on "' + (e.taskText || '').slice(0, 50) + '"';
        default: return e.details || (e.taskText || '').slice(0, 50);
    }
}

function _actTimeAgo(iso) {
    var diff = Date.now() - new Date(iso).getTime();
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago (' + Math.floor(mins % 60) + 'm)';
    var days = Math.floor(hrs / 24);
    return days + 'd ago';
}

// ─── Hook into existing functions ───

// Patch addTaskToTodo to log creation
var _origActAddTask = addTaskToTodo;
addTaskToTodo = function(text) {
    _origActAddTask(text);
    var t = tasks.todo[tasks.todo.length - 1];
    if (t) _actLog('create', t.id, t.text);
};

// Patch moveTaskWithUndo
var _origActMove = moveTaskWithUndo;
moveTaskWithUndo = function(fromCol, toCol, taskId) {
    var task = _stFindTask(taskId);
    var text = task ? task.text : '';
    _origActMove(fromCol, toCol, taskId);
    _actLog('move', taskId, text, fromCol + ' → ' + toCol);
};

// Patch deleteTaskWithUndo
var _origActDelete = deleteTaskWithUndo;
deleteTaskWithUndo = function(col, taskId) {
    var task = _stFindTask(taskId);
    var text = task ? task.text : '';
    _origActDelete(col, taskId);
    _actLog('delete', taskId, text);
};

// Patch cyclePriority
var _origActPriority = cyclePriority;
cyclePriority = function(col, taskId) {
    var task = _stFindTask(taskId);
    var oldPri = task ? task.priority : '';
    _origActPriority(col, taskId);
    if (task) _actLog('priority', taskId, task.text, oldPri + ' → ' + task.priority);
};

// Patch addComment if available
if (typeof addComment !== 'undefined') {
    var _origActComment = addComment;
    addComment = function(taskId, text, taskText) {
        _origActComment(taskId, text, taskText);
        _actLog('comment', taskId, taskText || '');
    };
}

// Hook into timer stop
document.addEventListener('timer:stop', function(e) {
    if (e.detail) _actLog('timer', e.detail.taskId, e.detail.taskText, e.detail.duration);
});

// Inject activity toggle button
(function _actInject() {
    var check = setInterval(function() {
        var toolbox = document.getElementById('toolbox');
        if (!toolbox) return;
        clearInterval(check);
        var btn = document.createElement('button');
        btn.className = 'tb-btn';
        btn.id = 'act-toggle-btn';
        btn.textContent = '📋 Activity';
        btn.addEventListener('click', _actOpenPanel);
        toolbox.appendChild(btn);
        // Set initial visibility
        _actUpdateButtonVisibility();
    }, 600);
})();

// Show activity button only on workspaces that have a collab attached
function _actUpdateButtonVisibility() {
    var btn = document.getElementById('act-toggle-btn');
    if (!btn) return;
    var isCollab = typeof window._isCollabLockActive === 'function' && window._isCollabLockActive();
    btn.style.display = isCollab ? '' : 'none';
    // Close panel if open and no longer on a collab workspace
    if (!isCollab && _actOpen) _actClose();
}

// Hook into renderGroupUI (set by tasky-collab.js) to update visibility on workspace/collab changes
window.addEventListener('load', function() {
    if (typeof renderGroupUI === 'function') {
        var _actOrigRenderGroupUI = renderGroupUI;
        renderGroupUI = function() {
            _actOrigRenderGroupUI.apply(this, arguments);
            _actUpdateButtonVisibility();
        };
    }
});


// Load persisted activity
_activityFeed = _actLoad();
_actUnread = 0;

window._actLog = _actLog;
window._actOpenPanel = _actOpenPanel;
window._actClose = _actClose;

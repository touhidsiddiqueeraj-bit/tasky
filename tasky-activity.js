// CSS moved to tasky.css

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

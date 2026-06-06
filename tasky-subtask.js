(function() {
var style = document.createElement('style');
style.textContent = `
.subtask-toggle { background:none;border:none;color:rgba(255,255,255,0.4);cursor:pointer;font-size:11px;padding:0 6px;white-space:nowrap; }
.subtask-toggle:hover { color:#a78bfa; }
.subtask-container { padding:4px 10px 8px 28px;border-top:1px solid rgba(255,255,255,0.06);margin-top:4px; }
.subtask-row { display:flex;align-items:center;gap:6px;padding:2px 0; }
.subtask-row.done .subtask-text { text-decoration:line-through;opacity:0.4; }
.subtask-row input[type=checkbox] { accent-color:#8B5CF6;cursor:pointer; }
.subtask-text { font-size:12px;color:rgba(255,255,255,0.8);flex:1; }
.subtask-del { background:none;border:none;color:rgba(255,255,255,0.2);cursor:pointer;font-size:12px;padding:0 4px; }
.subtask-del:hover { color:#ef4444; }
.subtask-add-row { padding:4px 0 0 20px; }
.subtask-input { background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:6px;color:rgba(255,255,255,0.8);font-size:12px;padding:4px 8px;width:100%;outline:none; }
.subtask-input:focus { border-color:#8B5CF6; }
.subtask-input::placeholder { color:rgba(255,255,255,0.25); }
.subtask-badge { font-size:11px;color:rgba(255,255,255,0.4);margin-left:6px;cursor:pointer; }
.subtask-badge:hover { color:#a78bfa; }

body.light-mode .subtask-toggle { color:rgba(0,0,0,0.3); }
body.light-mode .subtask-container { border-top-color:rgba(0,0,0,0.08); }
body.light-mode .subtask-text { color:rgba(0,0,0,0.7); }
body.light-mode .subtask-input { background:rgba(0,0,0,0.04);border-color:rgba(0,0,0,0.12);color:rgba(0,0,0,0.8); }
body.light-mode .subtask-badge { color:rgba(0,0,0,0.3); }
`;
document.head.appendChild(style);
})();

var _origSTCreateTaskCard = createTaskCard;
createTaskCard = function(task, column) {
    var card = _origSTCreateTaskCard(task, column);
    var subtasks = task.subtasks || [];
    var doneCount = subtasks.filter(function(s) { return s.done; }).length;

    var hoverControls = card.querySelector('.task-hover-controls');
    if (hoverControls) {
        var stBtn = document.createElement('button');
        stBtn.className = 'subtask-toggle';
        stBtn.title = 'Subtasks';
        stBtn.textContent = '☐';
        stBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            var container = card.querySelector('.subtask-container');
            if (container) container.style.display = container.style.display === 'none' ? '' : 'none';
        });
        hoverControls.appendChild(stBtn);
    }

    if (subtasks.length > 0) {
        var left = card.querySelector('.task-left');
        if (left) {
            var badge = document.createElement('span');
            badge.className = 'subtask-badge';
            badge.textContent = doneCount + '/' + subtasks.length;
            badge.addEventListener('click', function(e) {
                e.stopPropagation();
                var container = card.querySelector('.subtask-container');
                if (container) container.style.display = container.style.display === 'none' ? '' : 'none';
            });
            left.appendChild(badge);
        }
    }

    var container = document.createElement('div');
    container.className = 'subtask-container';
    container.style.display = 'none';
    container.id = 'st-cont-' + task.id;
    _stRenderContainer(container, task, column);
    card.appendChild(container);

    return card;
};

function _stRenderContainer(container, task, column) {
    var subtasks = task.subtasks || [];
    container.innerHTML = '';
    subtasks.forEach(function(s) {
        var row = document.createElement('div');
        row.className = 'subtask-row' + (s.done ? ' done' : '');
        row.innerHTML = '<input type="checkbox" class="st-cb" data-st-id="' + s.id + '" data-st-task="' + task.id + '" data-st-col="' + column + '"' + (s.done ? ' checked' : '') + '><span class="subtask-text">' + escapeHtml(s.text) + '</span><button class="subtask-del" data-st-del="' + s.id + '" data-st-task="' + task.id + '" data-st-col="' + column + '">✕</button>';
        container.appendChild(row);
    });
    var addRow = document.createElement('div');
    addRow.className = 'subtask-add-row';
    addRow.innerHTML = '<input type="text" class="subtask-input" placeholder="+ Add subtask…" data-st-new="' + task.id + '" data-st-col="' + column + '">';
    container.appendChild(addRow);

    // Update badge if present
    var card = document.getElementById('task-' + task.id);
    if (card) {
        var badge = card.querySelector('.subtask-badge');
        if (badge) {
            var doneCount = subtasks.filter(function(s) { return s.done; }).length;
            badge.textContent = doneCount + '/' + subtasks.length;
        }
    }
}

document.addEventListener('change', function(e) {
    if (e.target.matches('.st-cb')) {
        var taskId = parseInt(e.target.dataset.stTask);
        var subId = parseInt(e.target.dataset.stId);
        var col = e.target.dataset.stCol;
        var task = _stFindTask(taskId);
        if (!task) return;
        var sub = (task.subtasks || []).find(function(s) { return s.id === subId; });
        if (sub) {
            sub.done = e.target.checked;
            saveAll();
            var cont = document.getElementById('st-cont-' + taskId);
            if (cont) _stRenderContainer(cont, task, col);
        }
    }
});

document.addEventListener('click', function(e) {
    if (e.target.matches('[data-st-del]')) {
        var taskId = parseInt(e.target.dataset.stTask);
        var subId = parseInt(e.target.dataset.stId);
        var col = e.target.dataset.stCol;
        var task = _stFindTask(taskId);
        if (!task || !task.subtasks) return;
        task.subtasks = task.subtasks.filter(function(s) { return s.id !== subId; });
        saveAll();
        var cont = document.getElementById('st-cont-' + taskId);
        if (cont) _stRenderContainer(cont, task, col);
    }
});

document.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && e.target.matches('[data-st-new]')) {
        e.preventDefault();
        e.stopPropagation();
        var taskId = parseInt(e.target.dataset.stTask);
        var col = e.target.dataset.stCol;
        var text = e.target.value.trim();
        if (!text) return;
        var task = _stFindTask(taskId);
        if (!task) return;
        if (!task.subtasks) task.subtasks = [];
        task.subtasks.push({ id: Date.now() + Math.floor(Math.random() * 1000), text: text, done: false });
        e.target.value = '';
        saveAll();
        var cont = document.getElementById('st-cont-' + taskId);
        if (cont) _stRenderContainer(cont, task, col);
    }
});

function _stFindTask(taskId) {
    for (var ci = 0; ci < ['todo','working','done'].length; ci++) {
        var col = ['todo','working','done'][ci];
        var t = (tasks[col] || []).find(function(t) { return t.id === taskId; });
        if (t) return t;
    }
    return null;
}

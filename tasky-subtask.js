(function() {
var style = document.createElement('style');
style.textContent = `
.subtask-container { padding:4px 10px 8px 28px;border-top:1px solid rgba(255,255,255,0.06);margin-top:4px; }
.subtask-row { display:flex;align-items:center;gap:6px;padding:2px 0;cursor:default; }
.subtask-row.done .subtask-text { text-decoration:line-through;opacity:0.4; }
.subtask-row.dragging { opacity:0.4; }
.subtask-row.drag-over-target { border-top:2px solid #8B5CF6; }
.subtask-row input[type=checkbox] { accent-color:#8B5CF6;cursor:pointer; }
.subtask-text { font-size:12px;color:rgba(255,255,255,0.8);flex:1;cursor:text; }
.subtask-text-edit { background:rgba(255,255,255,0.1);border:1px solid #8B5CF6;border-radius:4px;color:#fff;font-size:12px;padding:1px 6px;width:100%;outline:none;font-family:inherit; }
.subtask-del { background:none;border:none;color:rgba(255,255,255,0.2);cursor:pointer;font-size:12px;padding:0 4px;line-height:1; }
.subtask-del:hover { color:#ef4444; }
.subtask-drag-handle { color:rgba(255,255,255,0.15);cursor:grab;font-size:12px;padding:0 2px;user-select:none;line-height:1; }
.subtask-drag-handle:hover { color:rgba(255,255,255,0.4); }
.subtask-drag-handle:active { cursor:grabbing; }
.subtask-add-row { padding:4px 0 0 20px; }
.subtask-input { background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:6px;color:rgba(255,255,255,0.8);font-size:12px;padding:4px 8px;width:100%;outline:none;box-sizing:border-box; }
.subtask-input:focus { border-color:#8B5CF6; }
.subtask-input::placeholder { color:rgba(255,255,255,0.25); }
.subtask-badge-group { display:inline-flex;align-items:center;gap:6px;margin-left:6px;cursor:pointer; }
.subtask-badge { font-size:11px;color:rgba(255,255,255,0.4);white-space:nowrap; }
.subtask-badge:hover { color:#a78bfa; }
.subtask-progress { width:44px;height:4px;background:rgba(255,255,255,0.08);border-radius:3px;overflow:hidden;flex-shrink:0; }
.subtask-progress-fill { height:100%;background:#8B5CF6;border-radius:3px;transition:width .25s ease; }

body.light-mode .subtask-container { border-top-color:rgba(0,0,0,0.08); }
body.light-mode .subtask-text { color:rgba(0,0,0,0.7); }
body.light-mode .subtask-text-edit { background:rgba(0,0,0,0.06);border-color:#8B5CF6;color:#000; }
body.light-mode .subtask-input { background:rgba(0,0,0,0.04);border-color:rgba(0,0,0,0.12);color:rgba(0,0,0,0.8); }
body.light-mode .subtask-badge { color:rgba(0,0,0,0.3); }
body.light-mode .subtask-drag-handle { color:rgba(0,0,0,0.12); }
body.light-mode .subtask-progress { background:rgba(0,0,0,0.08); }
body.light-mode .subtask-row.drag-over-target { border-top-color:#8B5CF6; }
`;
document.head.appendChild(style);
})();

var _origSTCreateTaskCard = createTaskCard;
createTaskCard = function(task, column) {
    var card = _origSTCreateTaskCard(task, column);
    var subtasks = task.subtasks || [];
    var doneCount = subtasks.filter(function(s) { return s.done; }).length;

    if (subtasks.length > 0) {
        var left = card.querySelector('.task-left');
        if (left) {
            var group = document.createElement('span');
            group.className = 'subtask-badge-group';

            var bar = document.createElement('span');
            bar.className = 'subtask-progress';
            bar.innerHTML = '<span class="subtask-progress-fill" style="width:' + (doneCount / subtasks.length * 100) + '%"></span>';

            var badge = document.createElement('span');
            badge.className = 'subtask-badge';
            badge.textContent = doneCount + '/' + subtasks.length;

            group.appendChild(bar);
            group.appendChild(badge);
            group.addEventListener('click', function(e) {
                e.stopPropagation();
                var container = card.querySelector('.subtask-container');
                if (!container) return;
                var wasHidden = container.style.display === 'none';
                container.style.display = wasHidden ? '' : 'none';
                if (wasHidden) {
                    var inp = container.querySelector('.subtask-input');
                    if (inp) setTimeout(function() { inp.focus(); }, 60);
                }
            });
            left.appendChild(group);
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
        row.draggable = true;
        row.dataset.stSubId = s.id;
        row.dataset.stTaskId = task.id;
        row.innerHTML = '<span class="subtask-drag-handle">⋮⋮</span>'
            + '<input type="checkbox" class="st-cb" data-st-id="' + s.id + '" data-st-task="' + task.id + '" data-st-col="' + column + '"' + (s.done ? ' checked' : '') + '>'
            + '<span class="subtask-text" data-st-text="' + s.id + '">' + escapeHtml(s.text) + '</span>'
            + '<button class="subtask-del" data-st-del="' + s.id + '" data-st-task="' + task.id + '" data-st-col="' + column + '">✕</button>';

        row.addEventListener('dragstart', _stOnDragStart);
        row.addEventListener('dragend', _stOnDragEnd);
        container.appendChild(row);
    });
    var addRow = document.createElement('div');
    addRow.className = 'subtask-add-row';
    addRow.innerHTML = '<input type="text" class="subtask-input" placeholder="+ Add subtask…" data-st-new="' + task.id + '" data-st-col="' + column + '">';
    container.appendChild(addRow);

    container.addEventListener('dragover', _stOnDragOver);
    container.addEventListener('dragleave', _stOnDragLeave);
    container.addEventListener('drop', _stOnDrop);

    _stUpdateBadge(task);
}

// ── Drag reorder state ──
var _stDragSubId = null;

function _stOnDragStart(e) {
    _stDragSubId = e.target.dataset.stSubId;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', _stDragSubId);
    e.target.classList.add('dragging');
}

function _stOnDragEnd(e) {
    e.target.classList.remove('dragging');
    var rows = e.target.closest('.subtask-container');
    if (rows) rows.querySelectorAll('.drag-over-target').forEach(function(el) { el.classList.remove('drag-over-target'); });
    _stDragSubId = null;
}

function _stOnDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    var row = e.target.closest('.subtask-row');
    if (!row || row.dataset.stSubId === _stDragSubId) return;
    var rect = row.getBoundingClientRect();
    var midY = rect.top + rect.height / 2;
    if (e.clientY < midY) {
        row.classList.add('drag-over-target');
    } else {
        row.classList.remove('drag-over-target');
    }
}

function _stOnDragLeave(e) {
    var row = e.target.closest('.subtask-row');
    if (row) row.classList.remove('drag-over-target');
}

function _stOnDrop(e) {
    e.preventDefault();
    var container = e.target.closest('.subtask-container');
    if (!container || !_stDragSubId) return;
    container.querySelectorAll('.drag-over-target').forEach(function(el) { el.classList.remove('drag-over-target'); });

    var targetRow = e.target.closest('.subtask-row');
    if (!targetRow || targetRow.dataset.stSubId === _stDragSubId) return;

    var taskId = parseInt(targetRow.dataset.stTaskId);
    var col = targetRow.querySelector('.st-cb').dataset.stCol;
    var task = _stFindTask(taskId);
    if (!task || !task.subtasks) { _stDragSubId = null; return; }

    var dragIdx = task.subtasks.findIndex(function(s) { return s.id === parseInt(_stDragSubId); });
    var targetIdx = task.subtasks.findIndex(function(s) { return s.id === parseInt(targetRow.dataset.stSubId); });
    if (dragIdx === -1 || targetIdx === -1) { _stDragSubId = null; return; }

    var rect = targetRow.getBoundingClientRect();
    var midY = rect.top + rect.height / 2;
    var insertBefore = e.clientY < midY;

    var item = task.subtasks.splice(dragIdx, 1)[0];
    var newIdx = targetIdx;
    if (dragIdx < targetIdx) newIdx = insertBefore ? targetIdx - 1 : targetIdx;
    else newIdx = insertBefore ? targetIdx : targetIdx + 1;
    newIdx = Math.max(0, Math.min(task.subtasks.length, newIdx));
    task.subtasks.splice(newIdx, 0, item);

    _stDragSubId = null;
    saveAll();
    var cont = document.getElementById('st-cont-' + taskId);
    if (cont) _stRenderContainer(cont, task, col);
}

// ── Badge update ──
function _stUpdateBadge(task) {
    var card = document.getElementById('task-' + task.id);
    if (!card) return;
    var group = card.querySelector('.subtask-badge-group');
    if (!group) return;
    var subtasks = task.subtasks || [];
    var doneCount = subtasks.filter(function(s) { return s.done; }).length;
    var badge = group.querySelector('.subtask-badge');
    var fill = group.querySelector('.subtask-progress-fill');
    if (badge) badge.textContent = doneCount + '/' + subtasks.length;
    if (fill) fill.style.width = subtasks.length > 0 ? (doneCount / subtasks.length * 100) + '%' : '0%';
}

// ── Event handlers (delegated) ──
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
        e.target.focus();
    }
});

// ── Inline editing ──
document.addEventListener('dblclick', function(e) {
    var textEl = e.target.closest('[data-st-text]');
    if (!textEl) return;
    var row = textEl.closest('.subtask-row');
    if (!row) return;
    if (row.querySelector('.subtask-text-edit')) return;

    var subId = parseInt(textEl.dataset.stText);
    var taskId = parseInt(row.dataset.stTaskId);
    var col = row.querySelector('.st-cb').dataset.stCol;
    var origText = textEl.textContent;

    var inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'subtask-text-edit';
    inp.value = origText;
    textEl.replaceWith(inp);
    inp.focus();
    inp.select();

    function _finishEdit(save) {
        var newText = inp.value.trim();
        if (save && newText && newText !== origText) {
            var task = _stFindTask(taskId);
            if (task && task.subtasks) {
                var sub = task.subtasks.find(function(s) { return s.id === subId; });
                if (sub) {
                    sub.text = newText;
                    saveAll();
                }
            }
        }
        var cont = document.getElementById('st-cont-' + taskId);
        if (cont) _stRenderContainer(cont, _stFindTask(taskId), col);
    }

    inp.addEventListener('keydown', function(ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); _finishEdit(true); }
        if (ev.key === 'Escape') { ev.preventDefault(); _finishEdit(false); }
    });
    inp.addEventListener('blur', function() { _finishEdit(true); });
});

// ── Find task ──
function _stFindTask(taskId) {
    for (var ci = 0; ci < ['todo','working','done'].length; ci++) {
        var col = ['todo','working','done'][ci];
        var t = (tasks[col] || []).find(function(t) { return t.id === taskId; });
        if (t) return t;
    }
    return null;
}

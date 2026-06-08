// CSS moved to tasky.css

if (!window._cardModifiers) window._cardModifiers = [];
window._cardModifiers.push(function(card, task, column) {
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
    container.style.display = subtasks.length > 0 ? '' : 'none';
    container.id = 'st-cont-' + task.id;
    _stRenderContainer(container, task, column);
    card.appendChild(container);

    return card;
});

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
    var newInput = document.createElement('input');
    newInput.type = 'text';
    newInput.className = 'subtask-input';
    newInput.placeholder = '+ Add subtask…';
    newInput.dataset.stNew = task.id;
    newInput.dataset.stCol = column;
    newInput.addEventListener('keydown', function(ev) {
        if (ev.key !== 'Enter') return;
        ev.preventDefault();
        ev.stopPropagation();
        var text = this.value.trim();
        if (!text) return;
        var t = _stFindTask(task.id);
        if (!t) return;
        if (!t.subtasks) t.subtasks = [];
        t.subtasks.push({ id: Date.now() + Math.floor(Math.random() * 1000), text: text, done: false });
        this.value = '';
        saveAll();
        var cont = document.getElementById('st-cont-' + task.id);
        if (cont) _stRenderContainer(cont, t, column);
        this.focus();
    });
    addRow.appendChild(newInput);
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
        var subId = parseInt(e.target.dataset.stDel);
        var col = e.target.dataset.stCol;
        var task = _stFindTask(taskId);
        if (!task || !task.subtasks) return;
        task.subtasks = task.subtasks.filter(function(s) { return s.id !== subId; });
        saveAll();
        var cont = document.getElementById('st-cont-' + taskId);
        if (cont) _stRenderContainer(cont, task, col);
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

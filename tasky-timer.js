var _tmrInterval = null;
var _tmrActiveTaskId = null;
var _tmrActiveCol = null;

var _origTMRCreateTaskCard = createTaskCard;
createTaskCard = function(task, column) {
    var card = _origTMRCreateTaskCard(task, column);
    var hoverControls = card.querySelector('.task-hover-controls');
    if (!hoverControls) return card;

    var timer = task.timer || {};
    var running = timer.startedAt && !timer.pausedAt;

    var btn = document.createElement('button');
    btn.className = 'tmr-toggle' + (running ? ' running' : '');
    btn.title = running ? _tmrFormat(timer.accumulated + (Date.now() - new Date(timer.startedAt).getTime())) : 'Timer';
    btn.textContent = running ? '⏱' : '⏱';
    btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var container = card.querySelector('.tmr-container');
        if (container) container.style.display = container.style.display === 'none' ? '' : 'none';
    });
    hoverControls.appendChild(btn);

    if (timer.logs && timer.logs.length > 0) {
        var left = card.querySelector('.task-left');
        if (left) {
            var badge = document.createElement('span');
            badge.className = 'tmr-badge';
            var total = timer.logs.reduce(function(s, l) { return s + (l.duration || 0); }, 0);
            badge.textContent = _tmrFormat(total);
            left.appendChild(badge);
        }
    }

    var container = document.createElement('div');
    container.className = 'tmr-container';
    container.style.display = 'none';
    _tmrRenderContainer(container, task, column);
    card.appendChild(container);

    return card;
};

function _tmrRenderContainer(container, task, column) {
    var timer = task.timer || {};
    var running = timer.startedAt && !timer.pausedAt;
    var elapsed = _tmrGetElapsed(timer);
    container.innerHTML = '';

    var display = document.createElement('div');
    display.className = 'tmr-display';
    display.id = 'tmr-disp-' + task.id;
    display.textContent = _tmrFormat(elapsed);
    container.appendChild(display);

    var modeRow = document.createElement('div');
    modeRow.className = 'tmr-mode-row';
    ['stopwatch','pomodoro'].forEach(function(mode) {
        var mb = document.createElement('button');
        mb.className = 'tmr-mode-btn' + ((timer.mode || 'stopwatch') === mode ? ' active' : '');
        mb.textContent = mode === 'stopwatch' ? '⏱ Stopwatch' : '🍅 Pomodoro';
        mb.addEventListener('click', function() {
            if (!timer.startedAt) {
                if (!task.timer) task.timer = {};
                task.timer.mode = mode;
                task.timer.accumulated = 0;
                saveAll();
                _tmrRenderContainer(container, task, column);
            }
        });
        modeRow.appendChild(mb);
    });
    container.appendChild(modeRow);

    var controls = document.createElement('div');
    controls.className = 'tmr-controls';

    if (running) {
        var pauseBtn = document.createElement('button');
        pauseBtn.className = 'tmr-btn active';
        pauseBtn.textContent = '⏸ Pause';
        pauseBtn.addEventListener('click', function() { _tmrPause(task, column, container); });
        controls.appendChild(pauseBtn);

        var stopBtn = document.createElement('button');
        stopBtn.className = 'tmr-btn tmr-btn--stop';
        stopBtn.textContent = '⏹ Stop';
        stopBtn.addEventListener('click', function() { _tmrStop(task, column, container); });
        controls.appendChild(stopBtn);
    } else if (timer.startedAt && timer.pausedAt) {
        var resumeBtn = document.createElement('button');
        resumeBtn.className = 'tmr-btn active';
        resumeBtn.textContent = '▶ Resume';
        resumeBtn.addEventListener('click', function() { _tmrResume(task, column, container); });
        controls.appendChild(resumeBtn);

        var stopBtn = document.createElement('button');
        stopBtn.className = 'tmr-btn tmr-btn--stop';
        stopBtn.textContent = '⏹ Stop';
        stopBtn.addEventListener('click', function() { _tmrStop(task, column, container); });
        controls.appendChild(stopBtn);

        var resetBtn = document.createElement('button');
        resetBtn.className = 'tmr-btn';
        resetBtn.textContent = '↺ Reset';
        resetBtn.addEventListener('click', function() { _tmrReset(task, column, container); });
        controls.appendChild(resetBtn);
    } else {
        var startBtn = document.createElement('button');
        startBtn.className = 'tmr-btn active';
        startBtn.textContent = '▶ Start';
        startBtn.addEventListener('click', function() { _tmrStart(task, column, container); });
        controls.appendChild(startBtn);
    }

    container.appendChild(controls);

    // Logs
    var logs = timer.logs || [];
    if (logs.length > 0) {
        var logContainer = document.createElement('div');
        logContainer.className = 'tmr-logs';
        var total = logs.reduce(function(s, l) { return s + (l.duration || 0); }, 0);
        logs.forEach(function(l) {
            var row = document.createElement('div');
            row.className = 'tmr-log-row';
            row.innerHTML = '<span>' + (l.type || 'session') + '</span><span>' + _tmrFormat(l.duration || 0) + '</span>';
            logContainer.appendChild(row);
        });
        container.appendChild(logContainer);

        var totalEl = document.createElement('div');
        totalEl.className = 'tmr-total';
        totalEl.textContent = 'Total: ' + _tmrFormat(total);
        container.appendChild(totalEl);
    }
}

function _tmrGetElapsed(timer) {
    if (!timer || !timer.startedAt) return 0;
    var base = timer.accumulated || 0;
    if (timer.pausedAt) return base;
    return base + (Date.now() - new Date(timer.startedAt).getTime());
}

function _tmrFormat(ms) {
    var totalSec = Math.floor(ms / 1000);
    var h = Math.floor(totalSec / 3600);
    var m = Math.floor((totalSec % 3600) / 60);
    var s = totalSec % 60;
    if (h > 0) return h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
}

function _tmrUpdateDisplay(taskId) {
    var disp = document.getElementById('tmr-disp-' + taskId);
    if (!disp) return;
    var task = _stFindTask(taskId);
    if (!task) return;
    disp.textContent = _tmrFormat(_tmrGetElapsed(task.timer || {}));

    // Update button tooltip
    var card = document.getElementById('task-' + taskId);
    if (card) {
        var btn = card.querySelector('.tmr-toggle');
        if (btn) btn.title = _tmrFormat(_tmrGetElapsed(task.timer || {}));
    }
}

function _tmrStart(task, column, container) {
    if (!task.timer) task.timer = { mode: 'stopwatch', accumulated: 0, logs: [] };
    task.timer.startedAt = new Date().toISOString();
    task.timer.pausedAt = null;
    task.timer.accumulated = task.timer.accumulated || 0;
    saveAll();
    _tmrRenderContainer(container, task, column);
    _tmrStartGlobalTick();
}

function _tmrPause(task, column, container) {
    if (!task.timer) return;
    var now = Date.now();
    var started = new Date(task.timer.startedAt).getTime();
    task.timer.accumulated = (task.timer.accumulated || 0) + (now - started);
    task.timer.pausedAt = new Date().toISOString();
    saveAll();
    _tmrRenderContainer(container, task, column);
    _tmrStopGlobalTick();
}

function _tmrResume(task, column, container) {
    if (!task.timer) return;
    task.timer.startedAt = new Date().toISOString();
    task.timer.pausedAt = null;
    saveAll();
    _tmrRenderContainer(container, task, column);
    _tmrStartGlobalTick();
}

function _tmrStop(task, column, container) {
    if (!task.timer) return;
    var now = Date.now();
    var duration;
    if (task.timer.pausedAt) {
        duration = task.timer.accumulated || 0;
    } else {
        var started = new Date(task.timer.startedAt).getTime();
        duration = (task.timer.accumulated || 0) + (now - started);
    }
    if (!task.timer.logs) task.timer.logs = [];
    task.timer.logs.push({ start: task.timer.startedAt || new Date().toISOString(), end: new Date().toISOString(), duration: duration, type: task.timer.mode || 'stopwatch' });
    task.timer.startedAt = null;
    task.timer.pausedAt = null;
    task.timer.accumulated = 0;
    saveAll();
    if (typeof showToast === 'function') showToast('⏱ Logged ' + _tmrFormat(duration) + ' for "' + task.text + '"', function(){});
    _tmrRenderContainer(container, task, column);
    _tmrStopGlobalTick();
    try { document.dispatchEvent(new CustomEvent('timer:stop', { detail: { taskId: task.id, taskText: task.text, duration: _tmrFormat(duration) } })); } catch(_) {}
}

function _tmrReset(task, column, container) {
    task.timer.startedAt = null;
    task.timer.pausedAt = null;
    task.timer.accumulated = 0;
    saveAll();
    _tmrRenderContainer(container, task, column);
    _tmrStopGlobalTick();
}

function _tmrStartGlobalTick() {
    if (_tmrInterval) return;
    _tmrInterval = setInterval(function() {
        // Update all running timer displays
        document.querySelectorAll('.tmr-display').forEach(function(disp) {
            var taskId = parseInt(disp.id.replace('tmr-disp-', ''));
            if (isNaN(taskId)) return;
            _tmrUpdateDisplay(taskId);
        });
    }, 1000);
}

function _tmrStopGlobalTick() {
    var hasRunning = false;
    ['todo','working','done'].forEach(function(col) {
        (tasks[col] || []).forEach(function(t) {
            var timer = t.timer || {};
            if (timer.startedAt && !timer.pausedAt) hasRunning = true;
        });
    });
    if (!hasRunning && _tmrInterval) {
        clearInterval(_tmrInterval);
        _tmrInterval = null;
    }
}

// Start global tick on load if any timers are running
window.addEventListener('load', function() {
    setTimeout(function() {
        var hasRunning = false;
        ['todo','working','done'].forEach(function(col) {
            (tasks[col] || []).forEach(function(t) {
                var timer = t.timer || {};
                if (timer.startedAt && !timer.pausedAt) hasRunning = true;
            });
        });
        if (hasRunning) _tmrStartGlobalTick();
    }, 1000);
});

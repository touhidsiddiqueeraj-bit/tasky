var _tmrInterval = null;
var _tmrActiveTaskId = null;
var _tmrActiveCol = null;

var _origTMRCreateTaskCard = createTaskCard;
createTaskCard = function(task, column) {
    var card = _origTMRCreateTaskCard(task, column);
    var timer = task.timer || {};
    var running = timer.startedAt && !timer.pausedAt;

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
    var isPomo = (timer.mode || 'stopwatch') === 'pomodoro';
    var elapsed = isPomo ? _tmrPomodoroRemaining(timer) : _tmrGetElapsed(timer);
    container.innerHTML = '';

    var display = document.createElement('div');
    display.className = 'tmr-display';
    display.id = 'tmr-disp-' + task.id;

    if (isPomo) {
        var phase = timer.pomodoroPhase || 'work';
        var phaseLabel = phase === 'work' ? '🍅 Work' : '☕ Break';
        var phaseEl = document.createElement('div');
        phaseEl.className = 'tmr-phase-label';
        phaseEl.textContent = phaseLabel;
        container.appendChild(phaseEl);

        display.textContent = _tmrFormat(elapsed);
    } else {
        display.textContent = _tmrFormat(elapsed);
    }
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
                task.timer.pomodoroPhase = 'work';
                task.timer.pomodoroDuration = 1500000;
                task.timer.pomodoroBreakDuration = 300000;
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
        var logCount = {};
        logs.forEach(function(l) {
            var t = l.type || 'session';
            logCount[t] = (logCount[t] || 0) + 1;
            var row = document.createElement('div');
            row.className = 'tmr-log-row';
            row.innerHTML = '<span>' + t + '</span><span>' + _tmrFormat(l.duration || 0) + '</span>';
            logContainer.appendChild(row);
        });
        container.appendChild(logContainer);

        var totalEl = document.createElement('div');
        totalEl.className = 'tmr-total';
        totalEl.textContent = 'Total: ' + _tmrFormat(total);
        if (logCount.pomodoro && logCount.break) {
            totalEl.textContent += ' — ' + logCount.pomodoro + '🍅 ' + logCount.break + '☕';
        } else if (logCount.pomodoro) {
            totalEl.textContent += ' — ' + logCount.pomodoro + '🍅';
        }
        container.appendChild(totalEl);
    }
}

function _tmrGetElapsed(timer) {
    if (!timer || !timer.startedAt) return 0;
    var base = timer.accumulated || 0;
    if (timer.pausedAt) return base;
    return base + (Date.now() - new Date(timer.startedAt).getTime());
}

function _tmrPomodoroRemaining(timer) {
    if (!timer || !timer.startedAt) return (timer.pomodoroDuration || 1500000);
    var phase = timer.pomodoroPhase || 'work';
    var duration = phase === 'work' ? (timer.pomodoroDuration || 1500000) : (timer.pomodoroBreakDuration || 300000);
    if (timer.pausedAt) {
        var pausedSince = new Date(timer.pausedAt).getTime();
        var elapsed = new Date(timer.pausedAt).getTime() - new Date(timer.startedAt).getTime();
        return Math.max(0, duration - elapsed);
    }
    var elapsed = Date.now() - new Date(timer.startedAt).getTime();
    return Math.max(0, duration - elapsed);
}

function _tmrFormat(ms) {
    var totalSec = Math.floor(Math.max(0, ms) / 1000);
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
    var timer = task.timer || {};
    var isPomo = (timer.mode || 'stopwatch') === 'pomodoro';
    var val = isPomo ? _tmrPomodoroRemaining(timer) : _tmrGetElapsed(timer);
    disp.textContent = _tmrFormat(val);

    // Update phase label
    if (isPomo) {
        var container = disp.parentNode;
        var phaseEl = container.querySelector('.tmr-phase-label');
        if (!phaseEl) {
            phaseEl = document.createElement('div');
            phaseEl.className = 'tmr-phase-label';
            container.insertBefore(phaseEl, disp);
        }
        var phase = timer.pomodoroPhase || 'work';
        phaseEl.textContent = phase === 'work' ? '🍅 Work' : '☕ Break';

        // Check if pomodoro completed
        if (timer.startedAt && !timer.pausedAt && val <= 0) {
            _tmrPomodoroComplete(task, taskId);
        }
    }
}

function _tmrPomodoroComplete(task, taskId) {
    var timer = task.timer;
    if (!timer) return;

    var phase = timer.pomodoroPhase || 'work';
    var phaseDuration = phase === 'work' ? (timer.pomodoroDuration || 1500000) : (timer.pomodoroBreakDuration || 300000);

    if (!timer.logs) timer.logs = [];
    if (phase === 'work') {
        timer.logs.push({ start: timer.startedAt, end: new Date().toISOString(), duration: phaseDuration, type: 'pomodoro' });
    } else {
        timer.logs.push({ start: timer.startedAt, end: new Date().toISOString(), duration: phaseDuration, type: 'break' });
    }

    // Switch phase
    var nextPhase = phase === 'work' ? 'break' : 'work';
    timer.pomodoroPhase = nextPhase;
    timer.startedAt = new Date().toISOString();
    timer.pausedAt = null;
    saveAll();

    // Notify
    try {
        if (typeof showToast === 'function') {
            var msg = phase === 'work' ? '🍅 Pomodoro complete! Time for a break.' : '☕ Break over! Time to focus.';
            showToast(msg, function() {});
        }
        if ('Notification' in window && Notification.permission === 'granted') {
            var title = phase === 'work' ? 'Pomodoro Complete' : 'Break Over';
            var body = phase === 'work' ? 'Good work! Take a 5 min break.' : 'Break is done, back to focus!';
            new Notification(title, { body: body });
        }
        document.dispatchEvent(new CustomEvent('timer:pomodoro', { detail: { taskId: task.id, phase: nextPhase } }));
    } catch(_) {}

    // Re-render container
    var cont = document.getElementById('st-cont-' + taskId);
    var card = document.getElementById('task-' + taskId);
    if (card) {
        var tmrCont = card.querySelector('.tmr-container');
        if (tmrCont) {
            var col = '';
            for (var ci = 0; ci < ['todo','working','done'].length; ci++) {
                if ((tasks[['todo','working','done'][ci]] || []).find(function(t) { return t.id === taskId; })) {
                    col = ['todo','working','done'][ci];
                    break;
                }
            }
            _tmrRenderContainer(tmrCont, task, col);
        }
    }
}

function _tmrStart(task, column, container) {
    if (!task.timer) {
        task.timer = { mode: 'stopwatch', accumulated: 0, logs: [], pomodoroPhase: 'work', pomodoroDuration: 1500000, pomodoroBreakDuration: 300000 };
    }
    task.timer.startedAt = new Date().toISOString();
    task.timer.pausedAt = null;
    if (task.timer.mode !== 'pomodoro') {
        task.timer.accumulated = task.timer.accumulated || 0;
    }
    saveAll();
    _tmrRenderContainer(container, task, column);
    _tmrStartGlobalTick();
}

function _tmrPause(task, column, container) {
    if (!task.timer || !task.timer.startedAt) return;
    var now = Date.now();
    var started = new Date(task.timer.startedAt).getTime();
    if (task.timer.mode !== 'pomodoro') {
        task.timer.accumulated = (task.timer.accumulated || 0) + (now - started);
    }
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
    var isPomo = (task.timer.mode || 'stopwatch') === 'pomodoro';

    if (isPomo) {
        var phase = task.timer.pomodoroPhase || 'work';
        var phaseDuration = phase === 'work' ? (task.timer.pomodoroDuration || 1500000) : (task.timer.pomodoroBreakDuration || 300000);
        if (task.timer.pausedAt) {
            var elapsed = new Date(task.timer.pausedAt).getTime() - new Date(task.timer.startedAt).getTime();
            duration = elapsed;
        } else {
            var elapsed = now - new Date(task.timer.startedAt).getTime();
            duration = elapsed;
        }
        if (!task.timer.logs) task.timer.logs = [];
        task.timer.logs.push({ start: task.timer.startedAt, end: new Date().toISOString(), duration: duration, type: 'pomodoro-manual' });
    } else {
        if (task.timer.pausedAt) {
            duration = task.timer.accumulated || 0;
        } else {
            var started = new Date(task.timer.startedAt).getTime();
            duration = (task.timer.accumulated || 0) + (now - started);
        }
        if (!task.timer.logs) task.timer.logs = [];
        task.timer.logs.push({ start: task.timer.startedAt || new Date().toISOString(), end: new Date().toISOString(), duration: duration, type: 'stopwatch' });
    }

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

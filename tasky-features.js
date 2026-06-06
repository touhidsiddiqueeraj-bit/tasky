// ═══════════════════════════════════════════════════════════════════════════
//  TASKY — EXTENDED FEATURES  (tasky-features.js)
//  Loads after tasky.js and tasky-collab.js
//
//  Feature 1: Supervisor-only task assignment & deletion (collab mode)
//  Feature 2: @mentions in comments with Firestore notification
//  Feature 3: Recurring tasks (daily / weekly / monthly) + manager in Settings
//  Feature 4: Calendar view (mini button in To Do header)
//  Feature 5: CSV import (in Settings panel)
//  Feature 6: Tab key cycles through workspaces
// ═══════════════════════════════════════════════════════════════════════════

/* ──────────────────────────────────────────────────────────────────────────
   SHARED STYLE INJECTION
   ────────────────────────────────────────────────────────────────────────── */
(function injectStyles() {
    const css = `
/* ── Cal mini-button hover ── */
#cal-mini-btn:hover {
    background: rgba(139,92,246,0.18) !important;
    border-color: rgba(139,92,246,0.4) !important;
    color: #a78bfa !important;
}

/* ── Recur badge on task card ── */
.recur-badge {
    display: inline-flex; align-items: center; gap: 3px;
    font-size: 10px; font-weight: 700; letter-spacing: .04em;
    padding: 2px 7px; border-radius: 6px;
    background: rgba(16,185,129,0.15); border: 1px solid rgba(16,185,129,0.3);
    color: #6ee7b7; white-space: nowrap; flex-shrink: 0;
}

/* ── Supervisor-lock on action buttons ── */
.task-card.supervisor-locked .delete-btn {
    opacity: 0.3 !important; cursor: not-allowed !important; pointer-events: none !important;
}

/* ── Mention autocomplete dropdown ── */
.mention-dropdown {
    position: fixed; z-index: 9999;
    background: linear-gradient(145deg,#18142a,#12101c);
    border: 1px solid rgba(139,92,246,0.4);
    border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.6);
    min-width: 160px; overflow: hidden; display: none;
}
.mention-dropdown.visible { display: block; }
.mention-item {
    padding: 9px 14px; display: flex; align-items: center; gap: 8px;
    cursor: pointer; font-size: 13px; color: #e2d9ff; transition: background .12s;
}
.mention-item:hover, .mention-item.focused { background: rgba(139,92,246,0.18); }
.mention-avatar {
    width: 22px; height: 22px; border-radius: 50%;
    background: linear-gradient(135deg,#7c3aed,#4c1d95);
    display: flex; align-items: center; justify-content: center;
    font-size: 11px; font-weight: 700; color: #fff; flex-shrink: 0;
}
.mention-handle { font-weight: 600; }
.mention-you { font-size: 10px; color: rgba(255,255,255,0.35); }
.mention-chip {
    display: inline; color: #a78bfa; font-weight: 600;
    background: rgba(139,92,246,0.12); border-radius: 4px; padding: 0 3px;
}

/* ── Recur option modal ── */
#recur-modal-overlay .recur-opts {
    display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px;
}
#recur-modal-overlay .recur-opt-btn {
    flex: 1; min-width: 80px; padding: 10px 8px; border-radius: 10px;
    border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.05);
    color: rgba(255,255,255,0.65); font-size: 13px; font-weight: 600;
    cursor: pointer; text-align: center;
    transition: background .15s, border-color .15s, color .15s;
}
#recur-modal-overlay .recur-opt-btn:hover  { background: rgba(139,92,246,0.15); border-color: rgba(139,92,246,0.35); color: #a78bfa; }
#recur-modal-overlay .recur-opt-btn.selected { background: rgba(139,92,246,0.25); border-color: rgba(139,92,246,0.5); color: #c4b5fd; }
#recur-modal-overlay .recur-opt-btn.none.selected { background: rgba(239,68,68,0.12); border-color: rgba(239,68,68,0.3); color: #f87171; }

/* ── Recurring manager panel (reuses tg-modal look) ── */
.recur-manager-row {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 14px; border-radius: 11px;
    background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.07);
    transition: background .15s;
}
.recur-manager-row:hover { background: rgba(139,92,246,0.07); border-color: rgba(139,92,246,0.2); }
.recur-manager-info { flex: 1; min-width: 0; }
.recur-manager-text { font-size: 13.5px; color: #e2d9ff; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.recur-manager-meta { font-size: 11px; color: rgba(255,255,255,0.35); margin-top: 2px; display: flex; gap: 8px; flex-wrap: wrap; }

/* ── Calendar overlay ── */
#cal-overlay {
    position: fixed; inset: 0; z-index: 8500;
    background: rgba(6,5,10,0.82); backdrop-filter: blur(18px);
    display: none; align-items: flex-start; justify-content: center;
    padding: 20px 12px; overflow-y: auto; box-sizing: border-box;
}
#cal-overlay.visible { display: flex; animation: ob-fade-in .3s ease; }
#cal-panel {
    background: linear-gradient(150deg,#15121f 0%,#0d0b16 100%);
    border: 1px solid rgba(255,255,255,0.09); border-radius: 22px;
    box-shadow: 0 28px 70px rgba(0,0,0,0.7), 0 0 0 1px rgba(139,92,246,0.12);
    width: min(960px, 100%); display: flex; flex-direction: column; overflow: hidden;
}
.cal-header {
    padding: 18px 22px; display: flex; align-items: center;
    justify-content: space-between; border-bottom: 1px solid rgba(255,255,255,0.07); flex-shrink: 0;
}
.cal-title { font-size: 17px; font-weight: 800; color: #e2d9ff; }
.cal-nav { display: flex; align-items: center; gap: 8px; }
.cal-nav-btn {
    background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.1);
    color: rgba(255,255,255,0.7); border-radius: 10px; width: 32px; height: 32px;
    font-size: 15px; cursor: pointer; display: flex; align-items: center; justify-content: center;
    transition: background .15s;
}
.cal-nav-btn:hover { background: rgba(139,92,246,0.2); border-color: rgba(139,92,246,0.4); color: #a78bfa; }
.cal-month-label { font-size: 14px; font-weight: 700; color: #c4b5fd; min-width: 130px; text-align: center; }
.cal-grid { display: grid; grid-template-columns: repeat(7,1fr); gap: 0; flex: 1; overflow-y: auto; }
.cal-day-header {
    text-align: center; padding: 9px 4px 7px;
    font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase;
    color: rgba(255,255,255,0.3); border-bottom: 1px solid rgba(255,255,255,0.07);
}
.cal-day {
    min-height: 88px; padding: 5px 6px; border-right: 1px solid rgba(255,255,255,0.05);
    border-bottom: 1px solid rgba(255,255,255,0.05);
    display: flex; flex-direction: column; gap: 2px;
}
.cal-day:nth-child(7n) { border-right: none; }
.cal-day.other-month { opacity: 0.3; }
.cal-day.today .cal-day-num { background: #8B5CF6; color: #fff; border-radius: 50%; width: 21px; height: 21px; display: flex; align-items: center; justify-content: center; }
.cal-day-num { font-size: 11px; font-weight: 700; color: rgba(255,255,255,0.4); line-height: 1; padding: 1px; }
.cal-task-chip {
    font-size: 10px; padding: 1px 5px; border-radius: 4px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    cursor: pointer; transition: opacity .12s; line-height: 1.5;
}
.cal-task-chip:hover { opacity: 0.75; }
.cal-task-chip.todo    { background: rgba(139,92,246,0.25); color: #c4b5fd; border: 1px solid rgba(139,92,246,0.3); }
.cal-task-chip.working { background: rgba(245,158,11,0.2);  color: #fcd34d; border: 1px solid rgba(245,158,11,0.3); }
.cal-task-chip.done    { background: rgba(16,185,129,0.12); color: #6ee7b7; border: 1px solid rgba(16,185,129,0.22); text-decoration: line-through; opacity: 0.65; }
.cal-more { font-size: 9px; color: rgba(255,255,255,0.25); padding-left: 1px; }
@media (max-width: 600px) {
    .cal-day { min-height: 60px; }
    .cal-task-chip { display: none; }
    .cal-more { display: block; }
}

/* ── CSV Import modal ── */
#csv-import-overlay {
    position: fixed; inset: 0; z-index: 8500;
    background: rgba(6,5,10,0.82); backdrop-filter: blur(18px);
    display: none; align-items: center; justify-content: center;
}
#csv-import-overlay.visible { display: flex; animation: ob-fade-in .3s ease; }
#csv-import-panel {
    background: linear-gradient(150deg,#15121f 0%,#0d0b16 100%);
    border: 1px solid rgba(255,255,255,0.09); border-radius: 22px;
    box-shadow: 0 28px 70px rgba(0,0,0,0.7);
    width: min(560px,95vw); display: flex; flex-direction: column; overflow: hidden;
}
.csv-drop-zone {
    border: 2px dashed rgba(139,92,246,0.35); border-radius: 14px;
    padding: 28px 20px; text-align: center;
    transition: border-color .2s, background .2s; cursor: pointer; color: rgba(255,255,255,0.4);
}
.csv-drop-zone:hover, .csv-drop-zone.dragover {
    border-color: rgba(139,92,246,0.7); background: rgba(139,92,246,0.07); color: #a78bfa;
}
.csv-drop-icon { font-size: 32px; margin-bottom: 8px; }
.csv-drop-text { font-size: 14px; font-weight: 600; margin-bottom: 5px; }
.csv-drop-hint { font-size: 12px; opacity: 0.6; }
.csv-preview-table {
    width: 100%; border-collapse: collapse; font-size: 12px;
    color: rgba(255,255,255,0.7); max-height: 200px; display: block; overflow-y: auto;
}
.csv-preview-table th {
    padding: 6px 10px; text-align: left; font-weight: 700;
    background: rgba(255,255,255,0.05); font-size: 10.5px; letter-spacing: .05em;
    text-transform: uppercase; color: rgba(255,255,255,0.4); position: sticky; top: 0;
}
.csv-preview-table td { padding: 5px 10px; border-bottom: 1px solid rgba(255,255,255,0.05); }
.csv-import-btn {
    background: linear-gradient(135deg,#8B5CF6,#6d28d9); color: #fff;
    border: none; border-radius: 12px; padding: 11px 28px;
    font-size: 14px; font-weight: 700; cursor: pointer; transition: filter .15s;
}
.csv-import-btn:hover { filter: brightness(1.1); }
.csv-import-btn:disabled { opacity: 0.45; cursor: not-allowed; filter: none; }
`;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
})();


/* ══════════════════════════════════════════════════════════════════════════
   FEATURE 1: SUPERVISOR-ONLY TASK ASSIGNMENT & DELETION
   ══════════════════════════════════════════════════════════════════════════ */

// Wrap deleteTaskWithUndo — blocks non-supervisors deleting supervisor-assigned tasks
const _sf1_origDeleteTaskWithUndo = deleteTaskWithUndo;
window.deleteTaskWithUndo = deleteTaskWithUndo = function(column, taskId) {
    if (typeof currentGroup !== 'undefined' && currentGroup &&
        typeof isSupervisor !== 'undefined' && !isSupervisor) {
        const task = (tasks[column] || []).find(t => t.id === taskId);
        if (task && task.assignedBy) {
            if (typeof showToast === 'function') showToast('🔒 Only the supervisor can delete assigned tasks', () => {});
            return;
        }
    }
    _sf1_origDeleteTaskWithUndo(column, taskId);
};

// Patch createTaskCard to visually lock assigned tasks for non-supervisors
window.addEventListener('load', function() {
    setTimeout(function() {
        const _prevCard = createTaskCard;
        createTaskCard = function(task, column) {
            const card = _prevCard(task, column);
            if (typeof currentGroup !== 'undefined' && currentGroup &&
                typeof isSupervisor !== 'undefined' && !isSupervisor &&
                task.assignedBy) {
                card.classList.add('supervisor-locked');
                const delBtn = card.querySelector('.delete-btn');
                if (delBtn) {
                    delBtn.addEventListener('click', function(e) {
                        e.stopPropagation();
                        if (typeof showToast === 'function') showToast('🔒 Only the supervisor can delete assigned tasks', () => {});
                    }, true);
                }
            }
            return card;
        };
    }, 150);
});


/* ══════════════════════════════════════════════════════════════════════════
   FEATURE 2: @MENTIONS IN COMMENTS + NOTIFICATIONS
   ══════════════════════════════════════════════════════════════════════════ */

let _mentionDropdown = null;
let _mentionStartIdx = -1;
let _mentionQuery    = '';
let _mentionFocusIdx = 0;
let _mentionInput    = null;
let _mentionTaskId   = null;
let _mentionTaskText = null;

function _createMentionDropdown() {
    if (_mentionDropdown) return;
    _mentionDropdown = document.createElement('div');
    _mentionDropdown.className = 'mention-dropdown';
    document.body.appendChild(_mentionDropdown);
}

function _getGroupMembers() {
    if (typeof currentGroup === 'undefined' || !currentGroup) return [];
    return (currentGroup.members || []).map(m => m.handle);
}

function _showMentionDD(input, query) {
    _createMentionDropdown();
    const members = _getGroupMembers();
    const filtered = query
        ? members.filter(h => h.toLowerCase().startsWith(query.toLowerCase()))
        : members;
    if (!filtered.length) { _hideMentionDD(); return; }

    _mentionInput    = input;
    _mentionQuery    = query;
    _mentionFocusIdx = 0;

    _mentionDropdown.innerHTML = filtered.map((h, i) => `
        <div class="mention-item${i === 0 ? ' focused' : ''}" data-handle="${h}" data-idx="${i}">
            <div class="mention-avatar">${h[0].toUpperCase()}</div>
            <span class="mention-handle">@${h}</span>
            ${typeof currentHandle !== 'undefined' && h === currentHandle ? '<span class="mention-you">you</span>' : ''}
        </div>`).join('');

    _mentionDropdown.querySelectorAll('.mention-item').forEach(item => {
        item.addEventListener('mousedown', e => { e.preventDefault(); _insertMention(item.dataset.handle); });
    });

    const rect = input.getBoundingClientRect();
    _mentionDropdown.style.left = Math.min(rect.left, window.innerWidth - 180) + 'px';
    _mentionDropdown.style.top  = (rect.top - 8) + 'px';
    _mentionDropdown.style.transform = 'translateY(-100%)';
    _mentionDropdown.classList.add('visible');
}

function _hideMentionDD() {
    if (_mentionDropdown) _mentionDropdown.classList.remove('visible');
    _mentionStartIdx = -1; _mentionQuery = '';
}

function _updateMentionFocus(idx) {
    if (!_mentionDropdown) return;
    const items = _mentionDropdown.querySelectorAll('.mention-item');
    items.forEach((el, i) => el.classList.toggle('focused', i === idx));
    _mentionFocusIdx = idx;
}

function _insertMention(handle) {
    if (!_mentionInput) return;
    const val = _mentionInput.value;
    const before = val.slice(0, _mentionStartIdx);
    const after  = val.slice(_mentionStartIdx + 1 + _mentionQuery.length);
    _mentionInput.value = before + '@' + handle + ' ' + after;
    const pos = before.length + handle.length + 2;
    _mentionInput.setSelectionRange(pos, pos);
    _hideMentionDD();
    _mentionInput.focus();
}

function _hookMentionInput(input) {
    if (input._mentionHooked) return;
    input._mentionHooked = true;

    input.addEventListener('keydown', function(e) {
        if (!(_mentionDropdown && _mentionDropdown.classList.contains('visible'))) return;
        const items = _mentionDropdown.querySelectorAll('.mention-item');
        if (e.key === 'ArrowDown')  { e.preventDefault(); _updateMentionFocus((_mentionFocusIdx + 1) % items.length); return; }
        if (e.key === 'ArrowUp')    { e.preventDefault(); _updateMentionFocus((_mentionFocusIdx - 1 + items.length) % items.length); return; }
        if (e.key === 'Enter' || e.key === 'Tab') {
            const focused = _mentionDropdown.querySelector('.mention-item.focused');
            if (focused) { e.preventDefault(); _insertMention(focused.dataset.handle); }
        }
        if (e.key === 'Escape') _hideMentionDD();
    });

    input.addEventListener('input', function() {
        const val = input.value, caret = input.selectionStart;
        let atPos = -1;
        for (let i = caret - 1; i >= 0; i--) {
            if (val[i] === '@') { atPos = i; break; }
            if (val[i] === ' ') break;
        }
        if (atPos !== -1 && _getGroupMembers().length > 0) {
            _mentionStartIdx = atPos;
            _showMentionDD(input, val.slice(atPos + 1, caret));
        } else {
            _hideMentionDD();
        }
    });

    input.addEventListener('blur', () => setTimeout(_hideMentionDD, 150));
}

// Hook into openComments after it renders
function _patchOpenComments() {
    if (typeof openComments === 'undefined') return;
    const _origOC = openComments;
    window.openComments = openComments = function(taskId, taskText, column, ownerUid) {
        _origOC(taskId, taskText, column, ownerUid);
        setTimeout(() => {
            const inp = document.getElementById('tcp-input');
            if (inp) _hookMentionInput(inp);
        }, 200);
    };
}

// Patch addComment to send mention notifications
function _patchAddComment() {
    if (typeof addComment === 'undefined') return;
    const _origAC = addComment;
    window.addComment = addComment = async function(taskId, text, taskTextParam) {
        await _origAC(taskId, text, taskTextParam);
        const mentions = (text.match(/@(\w+)/g) || []).map(m => m.slice(1).toLowerCase());
        if (!mentions.length || typeof currentGroup === 'undefined' || !currentGroup) return;
        for (const handle of mentions) {
            const member = (currentGroup.members || []).find(m => m.handle === handle);
            if (!member) continue;
            if (typeof currentUser !== 'undefined' && currentUser && member.uid === currentUser.uid) continue;
            try {
                await db.collection('notifications').add({
                    toUid:       member.uid,
                    fromHandle:  typeof currentHandle !== 'undefined' ? currentHandle : 'someone',
                    type:        'mention',
                    groupCode:   currentGroup.code,
                    taskId:      String(taskId),
                    taskText:    taskTextParam || '',
                    commentText: text,
                    createdAt:   firebase.firestore.FieldValue.serverTimestamp(),
                    read:        false
                });
            } catch(_) {}
        }
    };
}

// Mention notification listener — separate Firestore listener for type=mention
let _mentionNotifListener = null;
function _startMentionNotifListener() {
    if (!window.currentUser || _mentionNotifListener) return;
    _mentionNotifListener = db.collection('notifications')
        .where('toUid', '==', window.currentUser.uid)
        .where('type',  '==', 'mention')
        .where('read',  '==', false)
        .onSnapshot(snap => {
            snap.docChanges().forEach(change => {
                if (change.type !== 'added') return;
                const n = change.doc.data();
                change.doc.ref.update({ read: true }).catch(() => {});
                const msg = `🔔 @${n.fromHandle} mentioned you in "${n.taskText}"`;
                if (typeof _collabToast === 'function') _collabToast(msg);
                else if (typeof showToast === 'function') showToast(msg, () => {});
                if ('Notification' in window && Notification.permission === 'granted') {
                    try {
                        new Notification('Tasky — You were mentioned', {
                            body: `@${n.fromHandle}: "${n.commentText}"`,
                            icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="%238B5CF6"/><text x="16" y="22" text-anchor="middle" font-size="18" fill="white">@</text></svg>',
                        });
                    } catch(_) {}
                }
            });
        });
}

function stopMentionNotifListener() {
    if (_mentionNotifListener) { _mentionNotifListener(); _mentionNotifListener = null; }
}

// Enable mention notifications (called from Settings button)
window._enableMentionNotifications = async function() {
    if (!('Notification' in window)) { if (typeof showToast === 'function') showToast('⚠️ Browser does not support notifications', () => {}); return; }
    let perm = Notification.permission;
    if (perm === 'default') perm = await Notification.requestPermission();
    const btn = document.getElementById('st-mention-notif-btn');
    if (perm === 'granted') {
        if (typeof showToast === 'function') showToast('🔔 Mention notifications enabled!', () => {});
        if (btn) { btn.textContent = 'Enabled ✓'; btn.disabled = true; }
        _startMentionNotifListener();
        try {
            new Notification('Tasky — Mentions enabled', {
                body: "You'll be notified when someone @mentions you in comments.",
                icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="%238B5CF6"/><text x="16" y="22" text-anchor="middle" font-size="18" fill="white">@</text></svg>',
            });
        } catch(_) {}
    } else {
        if (typeof showToast === 'function') showToast('⚠️ Notification permission denied', () => {});
    }
};

// Sync mention notif button state on settings open
const _origOpenSettings = window.openSettings;
window.openSettings = function() {
    if (_origOpenSettings) _origOpenSettings();
    setTimeout(() => {
        const btn = document.getElementById('st-mention-notif-btn');
        if (btn) {
            const granted = 'Notification' in window && Notification.permission === 'granted';
            btn.textContent = granted ? 'Enabled ✓' : 'Enable';
            btn.disabled = granted;
        }
    }, 50);
};

// Boot: apply patches after auth
window.addEventListener('tasky:authchange', function() {
    setTimeout(function() {
        _patchOpenComments();
        _patchAddComment();
        if (window.currentUser && !window.currentUser.isAnonymous) {
            _startMentionNotifListener();
        } else {
            stopMentionNotifListener();
        }
    }, 500);
});
window.addEventListener('load', function() {
    setTimeout(function() {
        _patchOpenComments();
        _patchAddComment();
    }, 300);
});


/* ══════════════════════════════════════════════════════════════════════════
   FEATURE 3: RECURRING TASKS
   ══════════════════════════════════════════════════════════════════════════ */

const RECUR_LS_KEY = 'tasky_recur_spawned_v1';
function _recurSpawnedLoad() { try { return JSON.parse(localStorage.getItem(RECUR_LS_KEY)) || {}; } catch { return {}; } }
function _recurSpawnedSave(o) { localStorage.setItem(RECUR_LS_KEY, JSON.stringify(o)); }

function checkRecurringTasks() {
    if (typeof tasks === 'undefined') return;
    const now = new Date();
    const spawned = _recurSpawnedLoad();
    let changed = false;

    ['todo','working','done'].forEach(col => {
        (tasks[col] || []).forEach(t => {
            if (!t.recurring || !t.dueDate) return;
            const due = new Date(t.dueDate);
            if (due > now) return;

            let nextDue = new Date(t.dueDate);
            while (nextDue <= now) {
                if (t.recurring === 'daily')   nextDue.setDate(nextDue.getDate() + 1);
                else if (t.recurring === 'weekly')  nextDue.setDate(nextDue.getDate() + 7);
                else if (t.recurring === 'monthly') nextDue.setMonth(nextDue.getMonth() + 1);
                else break;
            }
            const nextDueStr = nextDue.toISOString().split('T')[0];
            const spawnKey = `${t.id}_${nextDueStr}`;
            if (spawned[spawnKey]) return;
            if ((tasks.todo || []).some(x => x.recurParentId === t.id && x.dueDate === nextDueStr)) {
                spawned[spawnKey] = true; return;
            }

            const nextNum = getNextNumber();
            taskCounter = Math.max(taskCounter, nextNum);
            const newTask = {
                id: Date.now() * 1000 + nextNum,
                number: nextNum,
                text: t.text,
                priority: t.priority || 'medium',
                dueDate: nextDueStr,
                createdAt: new Date().toISOString(),
                recurring: t.recurring,
                recurParentId: t.id,
                assignedTo: t.assignedTo || null,
                assignedBy: t.assignedBy || null,
                groupCode: t.groupCode || null
            };
            tasks.todo = tasks.todo || [];
            tasks.todo.push(newTask);
            spawned[spawnKey] = true;
            changed = true;
            if (typeof showToast === 'function') showToast(`🔁 Recurring: "${newTask.text}"`, () => {});
        });
    });

    if (changed) {
        _recurSpawnedSave(spawned);
        if (typeof saveAll === 'function') saveAll();
        if (typeof renderColumn === 'function') renderColumn('todo');
    }
}

window.addEventListener('load', function() {
    setTimeout(checkRecurringTasks, 2500);
    setInterval(checkRecurringTasks, 60_000);
});

// ── Per-task recurrence modal ────────────────────────────────────────────
function openRecurModal(column, taskId) {
    const task = (tasks[column] || []).find(t => t.id === taskId);
    if (!task) return;
    let overlay = document.getElementById('recur-modal-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'recur-modal-overlay';
        overlay.className = 'tg-overlay hidden';
        overlay.addEventListener('click', e => { if (e.target === overlay) closeRecurModal(); });
        overlay.innerHTML = `
        <div class="tg-modal" style="width:min(380px,94vw);">
            <div class="tg-header">
                <div class="tg-header-title">🔁 Recurring Task</div>
                <button class="tg-close-btn" onclick="closeRecurModal()">✕</button>
            </div>
            <div style="padding:20px 24px;display:flex;flex-direction:column;gap:14px;">
                <p style="font-size:13px;color:rgba(255,255,255,0.5);margin:0;line-height:1.5;">
                    Set how often this task re-appears in <strong style="color:#e2d9ff;">To Do</strong> after its due date passes.
                    A <strong style="color:#e2d9ff;">due date</strong> is required.
                </p>
                <div id="recur-nodate-warning" style="display:none;color:#fcd34d;font-size:12px;background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.25);border-radius:8px;padding:8px 12px;">
                    ⚠️ No due date set. Add one so Tasky knows when to re-add this task.
                </div>
                <div>
                    <div class="tg-field-label">Repeat</div>
                    <div class="recur-opts" id="recur-opts"></div>
                </div>
                <button class="tg-save-btn" onclick="saveRecurring()" style="align-self:flex-start;">Save</button>
            </div>
        </div>`;
        document.body.appendChild(overlay);
    }

    overlay.dataset.column = column;
    overlay.dataset.taskId = taskId;
    const current = task.recurring || 'none';
    overlay.querySelector('#recur-opts').innerHTML =
        ['none','daily','weekly','monthly'].map(v => {
            const labels = { none:'🚫 None', daily:'☀️ Daily', weekly:'📅 Weekly', monthly:'🗓️ Monthly' };
            return `<button class="recur-opt-btn ${v}${current === v ? ' selected' : ''}" data-value="${v}" onclick="selectRecurOpt(this)">${labels[v]}</button>`;
        }).join('');

    const warn = overlay.querySelector('#recur-nodate-warning');
    if (warn) warn.style.display = task.dueDate ? 'none' : 'block';

    overlay.classList.remove('hidden');
    overlay.classList.add('visible');
}
window.openRecurModal = openRecurModal;

function closeRecurModal() {
    const o = document.getElementById('recur-modal-overlay');
    if (!o) return;
    o.classList.remove('visible'); o.classList.add('hidden');
    setTimeout(() => o.classList.remove('hidden'), 270);
}
window.closeRecurModal = closeRecurModal;

function selectRecurOpt(btn) {
    btn.closest('.recur-opts').querySelectorAll('.recur-opt-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
}
window.selectRecurOpt = selectRecurOpt;

function saveRecurring() {
    const o = document.getElementById('recur-modal-overlay');
    if (!o) return;
    const column = o.dataset.column, taskId = parseInt(o.dataset.taskId);
    const sel = o.querySelector('.recur-opt-btn.selected');
    if (!sel) return;
    const value = sel.dataset.value === 'none' ? null : sel.dataset.value;
    const task = (tasks[column] || []).find(t => t.id === taskId);
    if (!task) return;
    task.recurring = value;
    if (typeof saveAll === 'function') saveAll();
    if (typeof replaceCardInColumn === 'function') replaceCardInColumn(column, task);
    closeRecurModal();
    if (typeof showToast === 'function') showToast(value ? `🔁 Recurring: ${value}` : '🔁 Recurrence removed', () => {});
}
window.saveRecurring = saveRecurring;

// ── Recurring Tasks Manager (opened from Settings) ───────────────────────
function openRecurringManager() {
    let overlay = document.getElementById('recur-manager-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'recur-manager-overlay';
        overlay.className = 'tg-overlay hidden';
        overlay.addEventListener('click', e => { if (e.target === overlay) closeRecurringManager(); });
        overlay.innerHTML = `
        <div class="tg-modal" style="width:min(540px,95vw);max-height:85vh;">
            <div class="tg-header">
                <div class="tg-header-title">🔁 Recurring Tasks</div>
                <button class="tg-close-btn" onclick="closeRecurringManager()">✕</button>
            </div>
            <div style="padding:4px 0 0;flex:1;overflow-y:auto;" id="recur-manager-body"></div>
        </div>`;
        document.body.appendChild(overlay);
    }

    overlay.classList.remove('hidden');
    overlay.classList.add('visible');
    _renderRecurManager();
}
window.openRecurringManager = openRecurringManager;

function closeRecurringManager() {
    const o = document.getElementById('recur-manager-overlay');
    if (!o) return;
    o.classList.remove('visible'); o.classList.add('hidden');
    setTimeout(() => o.classList.remove('hidden'), 270);
}
window.closeRecurringManager = closeRecurringManager;

function _escHtmlCal(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#x27;');
}

function _renderRecurManager() {
    const body = document.getElementById('recur-manager-body');
    if (!body) return;

    const all = [];
    ['todo','working','done'].forEach(col => {
        (tasks[col] || []).forEach(t => {
            if (t.recurring) all.push({ t, col });
        });
    });

    if (!all.length) {
        body.innerHTML = `
            <div style="padding:40px 24px;text-align:center;color:rgba(255,255,255,0.3);">
                <div style="font-size:40px;margin-bottom:12px;">🔁</div>
                <div style="font-size:14px;font-weight:600;color:rgba(255,255,255,0.5);margin-bottom:6px;">No recurring tasks yet</div>
                <div style="font-size:13px;line-height:1.6;">Set a task to repeat by clicking the 🔁 button in the task card's action row.</div>
            </div>`;
        return;
    }

    const icons = { daily:'☀️', weekly:'📅', monthly:'🗓️' };
    const colLabels = { todo:'To Do', working:'Working On', done:'Done' };

    body.innerHTML = `
        <div style="padding:12px 20px 4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:rgba(255,255,255,0.3);">
            ${all.length} recurring task${all.length !== 1 ? 's' : ''}
        </div>
        <div style="padding:0 16px 20px;display:flex;flex-direction:column;gap:8px;" id="recur-manager-list"></div>`;

    const list = body.querySelector('#recur-manager-list');
    all.forEach(({ t, col }) => {
        const row = document.createElement('div');
        row.className = 'recur-manager-row';
        row.innerHTML = `
            <span style="font-size:18px;flex-shrink:0;">${icons[t.recurring] || '🔁'}</span>
            <div class="recur-manager-info">
                <div class="recur-manager-text">#${t.number} ${_escHtmlCal(t.text)}</div>
                <div class="recur-manager-meta">
                    <span>${t.recurring}</span>
                    <span>·</span>
                    <span>${colLabels[col]}</span>
                    ${t.dueDate ? `<span>· due ${t.dueDate}</span>` : '<span style="color:#f87171;">· no due date</span>'}
                </div>
            </div>
            <div style="display:flex;gap:6px;flex-shrink:0;">
                <button class="tg-icon-btn" onclick="openRecurModal('${col}',${t.id});closeRecurringManager();" title="Edit">✏️</button>
                <button class="tg-icon-btn danger" onclick="_removeRecur('${col}',${t.id})" title="Remove recurrence">✕</button>
            </div>`;
        list.appendChild(row);
    });
}

window._removeRecur = function(column, taskId) {
    const task = (tasks[column] || []).find(t => t.id === taskId);
    if (!task) return;
    task.recurring = null;
    if (typeof saveAll === 'function') saveAll();
    if (typeof replaceCardInColumn === 'function') replaceCardInColumn(column, task);
    _renderRecurManager();
    if (typeof showToast === 'function') showToast('🔁 Recurrence removed', () => {});
};

// ── Patch createTaskCard to show recur badge ───────────────────────────
window.addEventListener('load', function() {
    setTimeout(function() {
        const _prevCard2 = createTaskCard;
        createTaskCard = function(task, column) {
            const card = _prevCard2(task, column);
            if (task.recurring) {
                const icons = { daily:'☀️', weekly:'📅', monthly:'🗓️' };
                const badge = document.createElement('span');
                badge.className = 'recur-badge';
                badge.textContent = (icons[task.recurring] || '🔁') + ' ' + task.recurring;
                const meta = card.querySelector('.task-left');
                if (meta) meta.appendChild(badge);
            }
            return card;
        };
    }, 250);
});


/* ══════════════════════════════════════════════════════════════════════════
   FEATURE 4: CALENDAR VIEW (mini button in To Do header)
   ══════════════════════════════════════════════════════════════════════════ */


/* ══════════════════════════════════════════════════════════════════════════
   FEATURE 5: CSV IMPORT (launched from Settings panel)
   ══════════════════════════════════════════════════════════════════════════ */

function openCsvImport() {
    let overlay = document.getElementById('csv-import-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'csv-import-overlay';
        overlay.addEventListener('click', e => { if (e.target === overlay) closeCsvImport(); });
        overlay.innerHTML = `
        <div id="csv-import-panel">
            <div class="tg-header" style="padding:20px 22px 0;">
                <div class="tg-header-title">📥 Import from CSV</div>
                <button class="tg-close-btn" onclick="closeCsvImport()">✕</button>
            </div>
            <div style="padding:18px 22px 22px;display:flex;flex-direction:column;gap:14px;">
                <p style="font-size:12px;color:rgba(255,255,255,0.4);margin:0;line-height:1.6;">
                    Columns: <strong style="color:#a78bfa;">Task</strong> (required) ·
                    <strong style="color:#a78bfa;">Status</strong> (To Do / Working On / Done) ·
                    <strong style="color:#a78bfa;">Priority</strong> (High / Medium / Low) ·
                    <strong style="color:#a78bfa;">Due Date</strong> (YYYY-MM-DD). Max 500 rows.
                </p>
                <div class="csv-drop-zone" id="csv-drop-zone" onclick="document.getElementById('csv-file-input').click()">
                    <div class="csv-drop-icon">📂</div>
                    <div class="csv-drop-text">Click or drag a CSV file here</div>
                    <div class="csv-drop-hint">UTF-8 · .csv</div>
                </div>
                <input type="file" id="csv-file-input" accept=".csv,text/csv" style="display:none">
                <div id="csv-preview-area" style="display:none">
                    <div style="font-size:11px;font-weight:700;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:.06em;margin-bottom:7px;">
                        Preview · <span id="csv-row-count">0</span> rows
                    </div>
                    <table class="csv-preview-table">
                        <thead><tr><th>Task</th><th>Status</th><th>Priority</th><th>Due Date</th></tr></thead>
                        <tbody id="csv-preview-body"></tbody>
                    </table>
                </div>
                <div id="csv-error" style="display:none;color:#f87171;font-size:12px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.25);border-radius:8px;padding:8px 12px;"></div>
                <div style="display:flex;gap:10px;justify-content:flex-end;">
                    <button onclick="closeCsvImport()" style="background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.12);color:rgba(255,255,255,0.6);border-radius:10px;padding:9px 18px;font-size:13px;font-weight:600;cursor:pointer;">Cancel</button>
                    <button class="csv-import-btn" id="csv-import-btn" disabled onclick="executeCsvImport()">Import Tasks</button>
                </div>
            </div>
        </div>`;
        document.body.appendChild(overlay);

        const fi = overlay.querySelector('#csv-file-input');
        fi.addEventListener('change', function() { if (this.files[0]) _csvLoadFile(this.files[0]); });
        const dz = overlay.querySelector('#csv-drop-zone');
        dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('dragover'); });
        dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
        dz.addEventListener('drop', e => {
            e.preventDefault(); dz.classList.remove('dragover');
            if (e.dataTransfer.files[0]) _csvLoadFile(e.dataTransfer.files[0]);
        });
    }

    overlay.querySelector('#csv-preview-area').style.display = 'none';
    overlay.querySelector('#csv-error').style.display = 'none';
    overlay.querySelector('#csv-import-btn').disabled = true;
    overlay._parsedRows = null;
    const fi = overlay.querySelector('#csv-file-input');
    if (fi) fi.value = '';
    overlay.classList.add('visible');
}
window.openCsvImport = openCsvImport;

function closeCsvImport() {
    const o = document.getElementById('csv-import-overlay');
    if (o) o.classList.remove('visible');
}
window.closeCsvImport = closeCsvImport;

function _csvLoadFile(file) {
    const overlay = document.getElementById('csv-import-overlay');
    const errEl   = overlay.querySelector('#csv-error');
    errEl.style.display = 'none';
    if (file.size > 2 * 1024 * 1024) { errEl.textContent = '⚠️ File too large (max 2 MB).'; errEl.style.display = 'block'; return; }
    const reader = new FileReader();
    reader.onload = e => {
        try {
            const rows = _csvParse(e.target.result);
            if (!rows.length) throw new Error('No data rows found.');
            _csvShowPreview(rows, overlay);
        } catch(err) {
            errEl.textContent = '⚠️ ' + err.message;
            errEl.style.display = 'block';
            overlay.querySelector('#csv-preview-area').style.display = 'none';
            overlay.querySelector('#csv-import-btn').disabled = true;
        }
    };
    reader.readAsText(file, 'UTF-8');
}

function _csvParse(text) {
    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    if (lines.length < 2) throw new Error('CSV needs a header row and at least one data row.');
    const headers = _csvSplitLine(lines[0]).map(h => h.trim().toLowerCase());
    const taskIdx     = headers.findIndex(h => ['task','name','title','description'].includes(h));
    const statusIdx   = headers.findIndex(h => ['status','column','state'].includes(h));
    const priorityIdx = headers.findIndex(h => h === 'priority');
    const dueIdx      = headers.findIndex(h => ['due date','due','duedate'].includes(h));
    if (taskIdx === -1) throw new Error('No "Task" column found. Column must be named Task, Name, or Title.');

    const rows = [];
    for (let i = 1; i < lines.length && rows.length < 500; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const cells = _csvSplitLine(line);
        const text = (cells[taskIdx] || '').trim();
        if (!text) continue;

        const sr = statusIdx !== -1 ? (cells[statusIdx] || '').trim().toLowerCase() : '';
        let col = 'todo';
        if (sr.includes('work') || sr === 'in progress' || sr === 'doing') col = 'working';
        else if (['done','complete','completed','finished'].includes(sr)) col = 'done';

        const pr = priorityIdx !== -1 ? (cells[priorityIdx] || '').trim().toLowerCase() : '';
        let priority = 'medium';
        if (['high','1','h'].includes(pr)) priority = 'high';
        else if (['low','3','l'].includes(pr)) priority = 'low';

        let dueDate = null;
        if (dueIdx !== -1 && cells[dueIdx]) {
            const d = new Date(cells[dueIdx].trim());
            if (!isNaN(d)) dueDate = d.toISOString().split('T')[0];
        }
        rows.push({ text, col, priority, dueDate });
    }
    if (!rows.length) throw new Error('No valid task rows found.');
    return rows;
}

function _csvSplitLine(line) {
    const cells = []; let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') { if (inQ && line[i+1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
        else if (ch === ',' && !inQ) { cells.push(cur); cur = ''; }
        else cur += ch;
    }
    cells.push(cur);
    return cells;
}

function _csvShowPreview(rows, overlay) {
    overlay.querySelector('#csv-preview-body').innerHTML = rows.slice(0, 10).map(r => `
        <tr>
            <td>${_escHtmlCal(r.text.slice(0, 50))}</td>
            <td>${_escHtmlCal(r.col === 'todo' ? 'To Do' : r.col === 'working' ? 'Working On' : 'Done')}</td>
            <td>${_escHtmlCal(r.priority)}</td>
            <td>${_escHtmlCal(r.dueDate || '—')}</td>
        </tr>`).join('');
    overlay.querySelector('#csv-row-count').textContent = rows.length;
    overlay.querySelector('#csv-preview-area').style.display = 'block';
    overlay.querySelector('#csv-import-btn').disabled = false;
    overlay._parsedRows = rows;
}

function executeCsvImport() {
    const overlay = document.getElementById('csv-import-overlay');
    if (!overlay || !overlay._parsedRows) return;
    const btn = overlay.querySelector('#csv-import-btn');
    btn.disabled = true; btn.textContent = 'Importing…';
    let count = 0;
    overlay._parsedRows.forEach((row, i) => {
        if (!row.text) return;
        const nextNum = getNextNumber();
        taskCounter = Math.max(taskCounter, nextNum);
        tasks[row.col] = tasks[row.col] || [];
        tasks[row.col].push({
            id: Date.now() * 1000 + nextNum + i,
            number: nextNum,
            text: row.text,
            priority: row.priority || 'medium',
            dueDate: row.dueDate || null,
            createdAt: new Date().toISOString()
        });
        count++;
    });
    if (typeof saveAll === 'function') saveAll();
    if (typeof renderAllColumns === 'function') renderAllColumns();
    btn.disabled = false; btn.textContent = 'Import Tasks';
    closeCsvImport();
    if (typeof showToast === 'function') showToast(`📥 Imported ${count} task${count !== 1 ? 's' : ''}`, () => {});
}
window.executeCsvImport = executeCsvImport;


/* ══════════════════════════════════════════════════════════════════════════
   FEATURE 6: TAB KEY → CYCLE WORKSPACES
   ══════════════════════════════════════════════════════════════════════════ */

document.addEventListener('keydown', function(e) {
    if (e.key !== 'Tab') return;
    const tag = document.activeElement ? document.activeElement.tagName : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (document.querySelector('.tg-overlay.visible, #cal-overlay.visible, #csv-import-overlay.visible')) return;
    if (typeof workspaces === 'undefined' || workspaces.length <= 1) return;
    e.preventDefault();
    const ids = workspaces.map(w => w.id);
    const cur = ids.indexOf(typeof activeWorkspaceId !== 'undefined' ? activeWorkspaceId : ids[0]);
    const next = e.shiftKey ? (cur - 1 + ids.length) % ids.length : (cur + 1) % ids.length;
    if (typeof switchWorkspace === 'function') switchWorkspace(ids[next]);
}, true);

/* ══════════════════════════════════════════════════════════════════════════
   FEATURE 7: DUE DATE REMINDERS
   ══════════════════════════════════════════════════════════════════════════ */

const _REMINDER_LS_KEY = 'tasky_reminder_lead_hours';
const _REMINDER_SENT_KEY = 'tasky_reminder_sent_v1';

function _getReminderLeadHours() {
    var v = parseInt(localStorage.getItem(_REMINDER_LS_KEY));
    return isNaN(v) ? 0 : v;
}

function _setReminderLeadHours(h) {
    localStorage.setItem(_REMINDER_LS_KEY, String(h));
}

function _reminderSent(taskId, dueDate) {
    var map = {};
    try { map = JSON.parse(localStorage.getItem(_REMINDER_SENT_KEY)) || {}; } catch(e) {}
    return map[taskId + '_' + dueDate];
}

function _markReminderSent(taskId, dueDate) {
    var map = {};
    try { map = JSON.parse(localStorage.getItem(_REMINDER_SENT_KEY)) || {}; } catch(e) {}
    map[taskId + '_' + dueDate] = Date.now();
    localStorage.setItem(_REMINDER_SENT_KEY, JSON.stringify(map));
}

function _clearStaleReminders() {
    var map = {};
    try { map = JSON.parse(localStorage.getItem(_REMINDER_SENT_KEY)) || {}; } catch(e) {}
    var changed = false;
    Object.keys(map).forEach(function(k) {
        var parts = k.split('_');
        var tid = parseInt(parts[0]);
        var exists = false;
        ['todo','working','done'].forEach(function(c) {
            if ((typeof tasks !== 'undefined' && (tasks[c] || []).some(function(t) { return t.id === tid; }))) exists = true;
        });
        if (!exists) { delete map[k]; changed = true; }
    });
    if (changed) localStorage.setItem(_REMINDER_SENT_KEY, JSON.stringify(map));
}

function _checkDueDateReminders() {
    var leadH = _getReminderLeadHours();
    if (leadH <= 0 || typeof tasks === 'undefined') return;
    var now = Date.now();
    var leadMs = leadH * 3600000;
    ['todo','working','done'].forEach(function(col) {
        (tasks[col] || []).forEach(function(t) {
            if (!t.dueDate) return;
            var dueMs = new Date(t.dueDate + 'T23:59:59').getTime();
            var diff = dueMs - now;
            if (diff <= 0 || diff > leadMs) return;
            if (_reminderSent(t.id, t.dueDate)) return;
            _markReminderSent(t.id, t.dueDate);
            if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
                try {
                    new Notification('⏰ Task Due Soon', {
                        body: '"' + t.text + '" due ' + new Date(t.dueDate).toLocaleDateString(),
                        icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="%230a0a1a"/><rect x="4" y="5" width="24" height="6" rx="3" fill="%238B5CF6"/><rect x="4" y="13" width="17" height="6" rx="3" fill="%23F59E0B"/><rect x="4" y="21" width="12" height="6" rx="3" fill="%2310B981"/></svg>'
                    });
                } catch(_) {}
            }
            if (typeof showToast === 'function') showToast('⏰ "' + t.text + '" due ' + new Date(t.dueDate).toLocaleDateString(), function(){});
        });
    });
}

// Check on load + every minute
window.addEventListener('load', function() { setTimeout(function() { _clearStaleReminders(); _checkDueDateReminders(); }, 4000); });
setInterval(_checkDueDateReminders, 60000);

// Expose for Settings panel
window._getReminderLeadHours = _getReminderLeadHours;
window._setReminderLeadHours = _setReminderLeadHours;

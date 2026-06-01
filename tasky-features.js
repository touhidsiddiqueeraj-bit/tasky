// ═══════════════════════════════════════════════════════════════════════════
//  TASKY — EXTENDED FEATURES
//  Loads after tasky.js and tasky-collab.js
//
//  Feature 1: Supervisor-only task assignment & deletion (collab mode)
//  Feature 2: @mentions in comments with notification
//  Feature 3: Recurring tasks (daily / weekly / monthly)
//  Feature 4: Calendar view
//  Feature 5: CSV import
//  Feature 6: Tab key cycles through workspaces
// ═══════════════════════════════════════════════════════════════════════════

/* ──────────────────────────────────────────────────────────────────────────
   SHARED STYLE INJECTION
   ────────────────────────────────────────────────────────────────────────── */
(function injectStyles() {
    const css = `
/* ── Feature: Recurring task badge ── */
.recur-badge {
    display: inline-flex; align-items: center; gap: 3px;
    font-size: 10px; font-weight: 700; letter-spacing: .04em;
    padding: 2px 7px; border-radius: 6px;
    background: rgba(16,185,129,0.15); border: 1px solid rgba(16,185,129,0.3);
    color: #6ee7b7; white-space: nowrap;
}
.recur-badge .recur-icon { font-size: 11px; }

/* ── Feature: Supervisor-lock overlay on action buttons ── */
.task-card.supervisor-locked .delete-btn,
.task-card.supervisor-locked .move-btn {
    opacity: 0.35; cursor: not-allowed; pointer-events: none;
}
.sup-lock-tooltip {
    position: absolute; bottom: 110%; left: 50%; transform: translateX(-50%);
    background: rgba(10,8,20,0.92); border: 1px solid rgba(239,68,68,0.3);
    border-radius: 8px; padding: 5px 10px; font-size: 11px; color: #fca5a5;
    white-space: nowrap; pointer-events: none; z-index: 9999;
    opacity: 0; transition: opacity .15s;
}
.task-card.supervisor-locked:hover .sup-lock-tooltip { opacity: 1; }

/* ── Mention autocomplete dropdown ── */
.mention-dropdown {
    position: fixed; z-index: 9999;
    background: linear-gradient(145deg,#18142a,#12101c);
    border: 1px solid rgba(139,92,246,0.4);
    border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.6);
    min-width: 160px; overflow: hidden;
    display: none;
}
.mention-dropdown.visible { display: block; }
.mention-item {
    padding: 9px 14px; display: flex; align-items: center; gap: 8px;
    cursor: pointer; font-size: 13px; color: #e2d9ff;
    transition: background .12s;
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

/* ── Mention highlight in comment text ── */
.mention-chip {
    display: inline; color: #a78bfa; font-weight: 600;
    background: rgba(139,92,246,0.12); border-radius: 4px;
    padding: 0 3px;
}

/* ── Recurring task modal ── */
#recur-modal-overlay .recur-opts {
    display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px;
}
#recur-modal-overlay .recur-opt-btn {
    flex: 1; min-width: 80px;
    padding: 10px 8px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.12);
    background: rgba(255,255,255,0.05); color: rgba(255,255,255,0.65);
    font-size: 13px; font-weight: 600; cursor: pointer;
    transition: background .15s, border-color .15s, color .15s;
    text-align: center;
}
#recur-modal-overlay .recur-opt-btn:hover { background: rgba(139,92,246,0.15); border-color: rgba(139,92,246,0.35); color: #a78bfa; }
#recur-modal-overlay .recur-opt-btn.selected { background: rgba(139,92,246,0.25); border-color: rgba(139,92,246,0.5); color: #c4b5fd; }
#recur-modal-overlay .recur-opt-btn.none.selected { background: rgba(239,68,68,0.12); border-color: rgba(239,68,68,0.3); color: #f87171; }

/* ── Calendar view overlay ── */
#cal-overlay {
    position: fixed; inset: 0; z-index: 8500;
    background: rgba(6,5,10,0.82); backdrop-filter: blur(18px);
    display: none; align-items: flex-start; justify-content: center;
    padding: 24px 16px; overflow-y: auto;
    box-sizing: border-box;
}
#cal-overlay.visible { display: flex; animation: ob-fade-in .3s ease; }
#cal-panel {
    background: linear-gradient(150deg,#15121f 0%,#0d0b16 100%);
    border: 1px solid rgba(255,255,255,0.09); border-radius: 22px;
    box-shadow: 0 28px 70px rgba(0,0,0,0.7), 0 0 0 1px rgba(139,92,246,0.12);
    width: min(900px, 100%); display: flex; flex-direction: column;
    overflow: hidden; min-height: 0;
}
.cal-header {
    padding: 20px 24px; display: flex; align-items: center;
    justify-content: space-between; border-bottom: 1px solid rgba(255,255,255,0.07);
    flex-shrink: 0;
}
.cal-title { font-size: 18px; font-weight: 800; color: #e2d9ff; }
.cal-nav { display: flex; align-items: center; gap: 8px; }
.cal-nav-btn {
    background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.1);
    color: rgba(255,255,255,0.7); border-radius: 10px; width: 34px; height: 34px;
    font-size: 16px; cursor: pointer; display: flex; align-items: center; justify-content: center;
    transition: background .15s;
}
.cal-nav-btn:hover { background: rgba(139,92,246,0.2); border-color: rgba(139,92,246,0.4); color: #a78bfa; }
.cal-month-label { font-size: 15px; font-weight: 700; color: #c4b5fd; min-width: 120px; text-align: center; }
.cal-grid {
    display: grid; grid-template-columns: repeat(7, 1fr);
    gap: 0; flex: 1; overflow-y: auto;
}
.cal-day-header {
    text-align: center; padding: 10px 4px 8px;
    font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase;
    color: rgba(255,255,255,0.3); border-bottom: 1px solid rgba(255,255,255,0.07);
}
.cal-day {
    min-height: 90px; padding: 6px 7px; border-right: 1px solid rgba(255,255,255,0.05);
    border-bottom: 1px solid rgba(255,255,255,0.05);
    display: flex; flex-direction: column; gap: 3px;
}
.cal-day:nth-child(7n) { border-right: none; }
.cal-day.other-month { opacity: 0.35; }
.cal-day.today .cal-day-num { background: #8B5CF6; color: #fff; border-radius: 50%; width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; }
.cal-day-num { font-size: 12px; font-weight: 700; color: rgba(255,255,255,0.45); line-height: 1; padding: 1px; }
.cal-task-chip {
    font-size: 10.5px; padding: 2px 6px; border-radius: 5px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    cursor: pointer; transition: opacity .12s;
    line-height: 1.4;
}
.cal-task-chip:hover { opacity: 0.8; }
.cal-task-chip.todo    { background: rgba(139,92,246,0.25); color: #c4b5fd; border: 1px solid rgba(139,92,246,0.3); }
.cal-task-chip.working { background: rgba(245,158,11,0.2);  color: #fcd34d; border: 1px solid rgba(245,158,11,0.3); }
.cal-task-chip.done    { background: rgba(16,185,129,0.15); color: #6ee7b7; border: 1px solid rgba(16,185,129,0.25); text-decoration: line-through; opacity: 0.7; }
.cal-more { font-size: 10px; color: rgba(255,255,255,0.3); padding-left: 2px; }

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
    width: min(560px,95vw); display: flex; flex-direction: column;
    overflow: hidden;
}
.csv-drop-zone {
    border: 2px dashed rgba(139,92,246,0.35); border-radius: 14px;
    padding: 32px 24px; text-align: center;
    transition: border-color .2s, background .2s; cursor: pointer;
    color: rgba(255,255,255,0.4);
}
.csv-drop-zone:hover, .csv-drop-zone.dragover {
    border-color: rgba(139,92,246,0.7); background: rgba(139,92,246,0.07); color: #a78bfa;
}
.csv-drop-icon { font-size: 36px; margin-bottom: 10px; }
.csv-drop-text { font-size: 14px; font-weight: 600; margin-bottom: 6px; }
.csv-drop-hint { font-size: 12px; opacity: 0.6; }
.csv-preview-table {
    width: 100%; border-collapse: collapse; font-size: 12px;
    color: rgba(255,255,255,0.7); max-height: 220px; display: block; overflow-y: auto;
}
.csv-preview-table th {
    padding: 7px 10px; text-align: left; font-weight: 700;
    background: rgba(255,255,255,0.05); font-size: 11px; letter-spacing: .05em;
    text-transform: uppercase; color: rgba(255,255,255,0.4);
    position: sticky; top: 0;
}
.csv-preview-table td { padding: 6px 10px; border-bottom: 1px solid rgba(255,255,255,0.05); }
.csv-import-btn {
    background: linear-gradient(135deg, #8B5CF6, #6d28d9);
    color: #fff; border: none; border-radius: 12px;
    padding: 12px 28px; font-size: 14px; font-weight: 700; cursor: pointer;
    transition: filter .15s;
}
.csv-import-btn:hover { filter: brightness(1.1); }
.csv-import-btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* ── Tab workspace hint in shortcuts overlay ── */
.shortcut-tab-ws { color: #a78bfa; }
`;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
})();


/* ══════════════════════════════════════════════════════════════════════════
   FEATURE 1: SUPERVISOR-ONLY TASK ASSIGNMENT & DELETION
   In collab mode, only the supervisor may delete tasks or assign tasks.
   Members see the delete/move buttons greyed out with an explanation tooltip.
   ══════════════════════════════════════════════════════════════════════════ */

// We hook into createTaskCard after tasky-collab.js's patches via its last
// monkey-patch (_commentPatchOrigCreateTaskCard). We wrap again here.
function _installSupervisorLockPatch() {
    if (typeof createTaskCard === 'undefined') return; // safety
    const _prevCreateTaskCard = createTaskCard;
    createTaskCard = function(task, column) {
        const card = _prevCreateTaskCard(task, column);

        // Only apply in collab mode when the current user is NOT the supervisor
        if (typeof currentGroup !== 'undefined' && currentGroup &&
            typeof isSupervisor !== 'undefined' && !isSupervisor) {

            // Check if this task was assigned to this user
            const ownTask = !task.assignedBy; // no assignedBy means self-created task
            // Supervisor assigned → member can't delete; member self-created → member CAN delete
            if (task.assignedBy) {
                card.classList.add('supervisor-locked');

                // Add tooltip explaining why
                const tooltip = document.createElement('div');
                tooltip.className = 'sup-lock-tooltip';
                tooltip.textContent = '🔒 Only the supervisor can delete or move assigned tasks';
                tooltip.style.position = 'relative';
                card.style.position = 'relative';
                card.querySelector('.task-header').appendChild(tooltip);

                // Override delete button to show toast instead of deleting
                const delBtn = card.querySelector('.delete-btn');
                if (delBtn) {
                    delBtn.style.opacity = '0.3';
                    delBtn.style.cursor = 'not-allowed';
                    delBtn.addEventListener('click', function(e) {
                        e.stopPropagation();
                        if (typeof showToast === 'function') {
                            showToast('🔒 Only the supervisor can delete assigned tasks', () => {});
                        }
                    }, true);
                }
            }
        }
        return card;
    };
}

// Run after DOM and scripts are ready
window.addEventListener('load', function() {
    setTimeout(_installSupervisorLockPatch, 100);
});

// Wrap deleteTaskWithUndo to block non-supervisors from deleting assigned tasks
const _sf1_origDeleteTaskWithUndo = deleteTaskWithUndo;
window.deleteTaskWithUndo = deleteTaskWithUndo = function(column, taskId) {
    if (typeof currentGroup !== 'undefined' && currentGroup &&
        typeof isSupervisor !== 'undefined' && !isSupervisor) {
        const col = tasks[column] || [];
        const task = col.find(t => t.id === taskId);
        if (task && task.assignedBy) {
            if (typeof showToast === 'function') {
                showToast('🔒 Only the supervisor can delete assigned tasks', () => {});
            }
            return;
        }
    }
    _sf1_origDeleteTaskWithUndo(column, taskId);
};

// Block keyboard Del key for non-supervisors on assigned tasks
const _sf1_origSetupKeyboard = setupKeyboard;
// We can't re-intercept setupKeyboard easily, so instead we intercept the keydown
// handler that fires Delete. We do this by checking during the delete action.
// (Already handled by the deleteTaskWithUndo override above.)


/* ══════════════════════════════════════════════════════════════════════════
   FEATURE 2: @MENTIONS IN COMMENTS
   In the comment input, typing @ shows a dropdown of group members.
   Mentioning someone creates a notification for them.
   ══════════════════════════════════════════════════════════════════════════ */

let _mentionDropdown = null;
let _mentionStartIdx = -1;   // caret position where @ was typed
let _mentionQuery = '';
let _mentionFocusedIdx = 0;
let _mentionActiveInput = null;
let _mentionTaskId = null;
let _mentionTaskText = null;

function _createMentionDropdown() {
    if (_mentionDropdown) return;
    _mentionDropdown = document.createElement('div');
    _mentionDropdown.className = 'mention-dropdown';
    _mentionDropdown.id = 'mention-dropdown';
    document.body.appendChild(_mentionDropdown);
}

function _getGroupMembers() {
    if (typeof currentGroup === 'undefined' || !currentGroup) return [];
    return (currentGroup.members || []).map(m => m.handle);
}

function _showMentionDropdown(input, query, taskId, taskText) {
    _createMentionDropdown();
    const members = _getGroupMembers();
    const filtered = query
        ? members.filter(h => h.toLowerCase().startsWith(query.toLowerCase()))
        : members;

    if (filtered.length === 0) { _hideMentionDropdown(); return; }

    _mentionActiveInput = input;
    _mentionQuery = query;
    _mentionTaskId = taskId;
    _mentionTaskText = taskText;
    _mentionFocusedIdx = 0;

    _mentionDropdown.innerHTML = filtered.map((h, i) => `
        <div class="mention-item${i === 0 ? ' focused' : ''}" data-handle="${h}" data-idx="${i}">
            <div class="mention-avatar">${h[0].toUpperCase()}</div>
            <span class="mention-handle">@${h}</span>
            ${typeof currentHandle !== 'undefined' && h === currentHandle ? '<span class="mention-you">you</span>' : ''}
        </div>
    `).join('');

    _mentionDropdown.querySelectorAll('.mention-item').forEach(item => {
        item.addEventListener('mousedown', function(e) {
            e.preventDefault();
            _insertMention(item.dataset.handle);
        });
    });

    // Position near caret
    const rect = input.getBoundingClientRect();
    _mentionDropdown.style.left = Math.min(rect.left, window.innerWidth - 200) + 'px';
    _mentionDropdown.style.top  = (rect.top - _mentionDropdown.offsetHeight - 8) + 'px';
    _mentionDropdown.classList.add('visible');

    // After render, reposition if above viewport
    requestAnimationFrame(() => {
        const mRect = _mentionDropdown.getBoundingClientRect();
        if (mRect.top < 8) {
            _mentionDropdown.style.top = (rect.bottom + 8) + 'px';
        }
    });
}

function _hideMentionDropdown() {
    if (_mentionDropdown) _mentionDropdown.classList.remove('visible');
    _mentionStartIdx = -1;
    _mentionQuery = '';
}

function _updateMentionFocus(idx) {
    if (!_mentionDropdown) return;
    const items = _mentionDropdown.querySelectorAll('.mention-item');
    items.forEach((item, i) => item.classList.toggle('focused', i === idx));
    _mentionFocusedIdx = idx;
}

function _insertMention(handle) {
    if (!_mentionActiveInput) return;
    const val = _mentionActiveInput.value;
    const before = val.slice(0, _mentionStartIdx);
    const after  = val.slice(_mentionStartIdx + 1 + _mentionQuery.length); // +1 for @
    _mentionActiveInput.value = before + '@' + handle + ' ' + after;
    // Move caret after inserted mention
    const pos = before.length + handle.length + 2; // @handle + space
    _mentionActiveInput.setSelectionRange(pos, pos);
    _hideMentionDropdown();
    _mentionActiveInput.focus();
}

function _hookMentionToInput(input, taskId, taskText) {
    input.addEventListener('keydown', function(e) {
        if (_mentionDropdown && _mentionDropdown.classList.contains('visible')) {
            const items = _mentionDropdown.querySelectorAll('.mention-item');
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                _updateMentionFocus((_mentionFocusedIdx + 1) % items.length);
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                _updateMentionFocus((_mentionFocusedIdx - 1 + items.length) % items.length);
                return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
                const focused = _mentionDropdown.querySelector('.mention-item.focused');
                if (focused) {
                    e.preventDefault();
                    _insertMention(focused.dataset.handle);
                    return;
                }
            }
            if (e.key === 'Escape') {
                _hideMentionDropdown();
                return;
            }
        }
    });

    input.addEventListener('input', function() {
        const val = input.value;
        const caret = input.selectionStart;
        // Find the last @ before caret
        let atPos = -1;
        for (let i = caret - 1; i >= 0; i--) {
            if (val[i] === '@') { atPos = i; break; }
            if (val[i] === ' ') break;
        }
        if (atPos !== -1 && _getGroupMembers().length > 0) {
            _mentionStartIdx = atPos;
            const query = val.slice(atPos + 1, caret);
            _showMentionDropdown(input, query, taskId, taskText);
        } else {
            _hideMentionDropdown();
        }
    });

    input.addEventListener('blur', function() {
        setTimeout(_hideMentionDropdown, 150);
    });
}

// Hook into openComments — we patch it after load
function _hookMentionsIntoComments() {
    if (typeof openComments === 'undefined') return;
    const _origOpenComments = openComments;
    window.openComments = openComments = function(taskId, taskText, column, ownerUid) {
        _origOpenComments(taskId, taskText, column, ownerUid);
        // Give the panel time to render
        setTimeout(() => {
            const input = document.getElementById('tcp-input');
            if (input && !input._mentionHooked) {
                _hookMentionToInput(input, taskId, taskText);
                input._mentionHooked = true;
            }
        }, 200);
    };
}

// Patch addComment to fire notifications to mentioned members
function _hookMentionNotifications() {
    if (typeof addComment === 'undefined') return;
    const _origAddComment = addComment;
    window.addComment = addComment = async function(taskId, text, taskTextParam) {
        await _origAddComment(taskId, text, taskTextParam);
        // Extract @mentions from text
        const mentions = (text.match(/@(\w+)/g) || []).map(m => m.slice(1).toLowerCase());
        if (!mentions.length || typeof currentGroup === 'undefined' || !currentGroup) return;
        for (const handle of mentions) {
            const member = currentGroup.members.find(m => m.handle === handle);
            if (!member || (typeof currentUser !== 'undefined' && currentUser && member.uid === currentUser.uid)) continue;
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

// Render @mentions as highlighted chips in comment feed entries
const _origRenderMentionFeed = window._renderCommentFeed;
function _renderCommentFeedWithMentions(taskId, entries) {
    if (typeof _renderCommentFeed === 'function') {
        _renderCommentFeed(taskId, entries);
        // Highlight @mentions in rendered text
        const feed = document.getElementById('tcp-feed');
        if (!feed) return;
        feed.querySelectorAll('.tcp-entry-text').forEach(el => {
            el.innerHTML = el.textContent.replace(/@(\w+)/g, '<span class="mention-chip">@$1</span>');
        });
    }
}

// Extend notification handler to show mention toasts
window.addEventListener('tasky:authchange', function() {
    setTimeout(function() {
        _hookMentionsIntoComments();
        _hookMentionNotifications();
    }, 500);
});

// Also hook on startup
window.addEventListener('load', function() {
    setTimeout(function() {
        _hookMentionsIntoComments();
        _hookMentionNotifications();
        // Extend the notification listener to handle 'mention' type
        const _origExtended = window._startExtendedNotifListener;
        if (_origExtended) {
            window._startExtendedNotifListener = function() {
                _origExtended();
                // We piggyback by intercepting via the notification snapshot:
                // The listener added by _origExtended already calls _collabToast for 'comment'.
                // We enhance it in-place by wrapping the snapshot via a second listener just
                // for 'mention' type — handled here.
                if (!window.currentUser) return;
                db.collection('notifications')
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
            };
        }
    }, 600);
});


/* ══════════════════════════════════════════════════════════════════════════
   FEATURE 3: RECURRING TASKS
   Tasks can be set to recur daily, weekly, or monthly.
   On page load (and every minute), overdue recurring tasks are re-added to
   the To Do column automatically.
   Data field: task.recurring = 'daily' | 'weekly' | 'monthly' | null
   ══════════════════════════════════════════════════════════════════════════ */

const RECUR_LS_KEY = 'tasky_recur_spawned_v1';

function _recurSpawnedLoad() {
    try { return JSON.parse(localStorage.getItem(RECUR_LS_KEY)) || {}; } catch { return {}; }
}
function _recurSpawnedSave(obj) {
    localStorage.setItem(RECUR_LS_KEY, JSON.stringify(obj));
}

function checkRecurringTasks() {
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const spawned = _recurSpawnedLoad();
    let changed = false;

    // Collect tasks from all columns
    const allTasks = [
        ...(tasks.todo    || []).map(t => ({ t, col: 'todo' })),
        ...(tasks.working || []).map(t => ({ t, col: 'working' })),
        ...(tasks.done    || []).map(t => ({ t, col: 'done' }))
    ];

    allTasks.forEach(({ t, col }) => {
        if (!t.recurring || !t.dueDate) return;

        const due = new Date(t.dueDate);
        if (due > now) return; // not yet due

        // Calculate the next due date after today
        let nextDue = new Date(t.dueDate);
        while (nextDue <= now) {
            if (t.recurring === 'daily')   nextDue.setDate(nextDue.getDate() + 1);
            if (t.recurring === 'weekly')  nextDue.setDate(nextDue.getDate() + 7);
            if (t.recurring === 'monthly') nextDue.setMonth(nextDue.getMonth() + 1);
        }
        const nextDueStr = nextDue.toISOString().split('T')[0];

        // Spawn key: original task id + next due date
        const spawnKey = `${t.id}_${nextDueStr}`;
        if (spawned[spawnKey]) return; // already spawned for this cycle

        // Check if a copy is already in todo with this nextDue
        const alreadyPresent = (tasks.todo || []).some(
            x => x.recurParentId === t.id && x.dueDate === nextDueStr
        );
        if (alreadyPresent) { spawned[spawnKey] = true; return; }

        // Create new recurring copy in To Do
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

        if (typeof showToast === 'function') {
            showToast(`🔁 Recurring task re-added: "${newTask.text}"`, () => {});
        }
    });

    if (changed) {
        _recurSpawnedSave(spawned);
        if (typeof saveAll === 'function') saveAll();
        if (typeof renderColumn === 'function') renderColumn('todo');
    }
}

// Run on load and every minute
window.addEventListener('load', function() {
    setTimeout(checkRecurringTasks, 2000);
    setInterval(checkRecurringTasks, 60_000);
});

// ── Recur modal ──────────────────────────────────────────────────────────

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
        <div class="tg-modal" style="width:min(400px,94vw);">
            <div class="tg-header">
                <div class="tg-header-title">🔁 Recurring Task</div>
                <button class="tg-close-btn" onclick="closeRecurModal()">✕</button>
            </div>
            <div style="padding:24px 28px;display:flex;flex-direction:column;gap:16px;">
                <p style="font-size:13px;color:rgba(255,255,255,0.5);margin:0;line-height:1.5;">
                    Set how often this task should automatically re-appear in To Do after its due date passes.
                    A <strong style="color:#e2d9ff;">due date</strong> is required for recurring to work.
                </p>
                <div>
                    <div class="tg-field-label">Repeat frequency</div>
                    <div class="recur-opts" id="recur-opts"></div>
                </div>
                <div id="recur-nodate-warning" style="display:none;color:#fcd34d;font-size:12px;background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.25);border-radius:8px;padding:9px 12px;">
                    ⚠️ This task has no due date. Set one so Tasky knows when to re-add it.
                </div>
                <button class="tg-save-btn" id="recur-save-btn" onclick="saveRecurring()">Save</button>
            </div>
        </div>`;
        document.body.appendChild(overlay);
    }

    // Store context
    overlay.dataset.column = column;
    overlay.dataset.taskId = taskId;
    overlay.dataset.currentRecur = task.recurring || 'none';

    // Render options
    const opts = overlay.querySelector('#recur-opts');
    const current = task.recurring || 'none';
    opts.innerHTML = ['none','daily','weekly','monthly'].map(v => {
        const labels = { none: '🚫 None', daily: '☀️ Daily', weekly: '📅 Weekly', monthly: '🗓️ Monthly' };
        return `<button class="recur-opt-btn ${v} ${current === v ? 'selected' : ''}"
            data-value="${v}" onclick="selectRecurOpt(this)">${labels[v]}</button>`;
    }).join('');

    // Show warning if no due date
    const warn = overlay.querySelector('#recur-nodate-warning');
    if (warn) warn.style.display = task.dueDate ? 'none' : 'block';

    overlay.classList.remove('hidden');
    overlay.classList.add('visible');
}

window.openRecurModal = openRecurModal;

function closeRecurModal() {
    const overlay = document.getElementById('recur-modal-overlay');
    if (!overlay) return;
    overlay.classList.remove('visible');
    overlay.classList.add('hidden');
    setTimeout(() => overlay.classList.remove('hidden'), 270);
}
window.closeRecurModal = closeRecurModal;

function selectRecurOpt(btn) {
    const opts = btn.closest('.recur-opts');
    opts.querySelectorAll('.recur-opt-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
}
window.selectRecurOpt = selectRecurOpt;

function saveRecurring() {
    const overlay = document.getElementById('recur-modal-overlay');
    if (!overlay) return;
    const column = overlay.dataset.column;
    const taskId = parseInt(overlay.dataset.taskId);
    const selected = overlay.querySelector('.recur-opt-btn.selected');
    if (!selected) return;
    const value = selected.dataset.value === 'none' ? null : selected.dataset.value;

    const task = (tasks[column] || []).find(t => t.id === taskId);
    if (!task) return;
    task.recurring = value;
    if (typeof saveAll === 'function') saveAll();
    if (typeof replaceCardInColumn === 'function') replaceCardInColumn(column, task);

    closeRecurModal();
    if (typeof showToast === 'function') {
        showToast(value ? `🔁 Recurring: ${value}` : '🔁 Recurrence removed', () => {});
    }
}
window.saveRecurring = saveRecurring;

// ── Patch createTaskCard to show recur badge + button ────────────────────
window.addEventListener('load', function() {
    setTimeout(function() {
        const _rf3_prevCard = createTaskCard;
        createTaskCard = function(task, column) {
            const card = _rf3_prevCard(task, column);

            if (task.recurring) {
                const badge = document.createElement('span');
                badge.className = 'recur-badge';
                const icons = { daily: '☀️', weekly: '📅', monthly: '🗓️' };
                badge.innerHTML = `<span class="recur-icon">${icons[task.recurring] || '🔁'}</span>${task.recurring}`;
                const meta = card.querySelector('.task-left');
                if (meta) meta.appendChild(badge);
            }

            // Add recur button to hover controls
            const recurBtn = document.createElement('button');
            recurBtn.className = 'date-btn';
            recurBtn.title = 'Set recurring schedule';
            recurBtn.textContent = '🔁';
            recurBtn.addEventListener('click', e => {
                e.stopPropagation();
                openRecurModal(column, task.id);
            });
            const hoverControls = card.querySelector('.task-hover-controls');
            if (hoverControls) {
                const delBtn = hoverControls.querySelector('.delete-btn');
                hoverControls.insertBefore(recurBtn, delBtn || null);
            }
            return card;
        };
    }, 200);
});


/* ══════════════════════════════════════════════════════════════════════════
   FEATURE 4: CALENDAR VIEW
   Shows all tasks in a monthly calendar grid using their due dates.
   Opened from the dropdown menu.
   ══════════════════════════════════════════════════════════════════════════ */

let _calYear  = new Date().getFullYear();
let _calMonth = new Date().getMonth(); // 0-based

function openCalendarView() {
    _calYear  = new Date().getFullYear();
    _calMonth = new Date().getMonth();

    let overlay = document.getElementById('cal-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'cal-overlay';
        overlay.addEventListener('click', e => { if (e.target === overlay) closeCalendarView(); });
        overlay.innerHTML = `
        <div id="cal-panel">
            <div class="cal-header">
                <div class="cal-title">📅 Calendar View</div>
                <div style="display:flex;gap:8px;align-items:center;">
                    <div class="cal-nav">
                        <button class="cal-nav-btn" onclick="_calPrev()">‹</button>
                        <span class="cal-month-label" id="cal-month-label"></span>
                        <button class="cal-nav-btn" onclick="_calNext()">›</button>
                    </div>
                    <button class="tg-close-btn" onclick="closeCalendarView()">✕</button>
                </div>
            </div>
            <div class="cal-grid" id="cal-grid"></div>
        </div>`;
        document.body.appendChild(overlay);
    }

    overlay.classList.add('visible');
    _calRender();

    // Close dropdown
    const dd = document.getElementById('dropdown');
    if (dd) dd.classList.remove('show');
}
window.openCalendarView = openCalendarView;

function closeCalendarView() {
    const overlay = document.getElementById('cal-overlay');
    if (overlay) overlay.classList.remove('visible');
}
window.closeCalendarView = closeCalendarView;

window._calPrev = function() { _calMonth--; if (_calMonth < 0) { _calMonth = 11; _calYear--; } _calRender(); };
window._calNext = function() { _calMonth++; if (_calMonth > 11) { _calMonth = 0; _calYear++; } _calRender(); };

function _calRender() {
    const label = document.getElementById('cal-month-label');
    const grid  = document.getElementById('cal-grid');
    if (!label || !grid) return;

    const monthNames = ['January','February','March','April','May','June',
                        'July','August','September','October','November','December'];
    label.textContent = `${monthNames[_calMonth]} ${_calYear}`;

    // Build task map: { 'YYYY-MM-DD': [{task,col},...] }
    const taskMap = {};
    ['todo','working','done'].forEach(col => {
        (tasks[col] || []).forEach(t => {
            if (!t.dueDate) return;
            taskMap[t.dueDate] = taskMap[t.dueDate] || [];
            taskMap[t.dueDate].push({ task: t, col });
        });
    });

    // Build calendar grid
    const firstDay = new Date(_calYear, _calMonth, 1);
    const lastDay  = new Date(_calYear, _calMonth + 1, 0);
    const startDow = firstDay.getDay(); // 0=Sun
    const today    = new Date().toISOString().split('T')[0];

    let html = '';
    // Day headers
    ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].forEach(d => {
        html += `<div class="cal-day-header">${d}</div>`;
    });

    // Leading empty cells
    for (let i = 0; i < startDow; i++) {
        const prevDate = new Date(_calYear, _calMonth, -startDow + i + 1);
        const ds = prevDate.toISOString().split('T')[0];
        html += _calDayHtml(ds, prevDate.getDate(), true, taskMap[ds] || [], today);
    }

    // Month days
    for (let d = 1; d <= lastDay.getDate(); d++) {
        const date = new Date(_calYear, _calMonth, d);
        const ds = date.toISOString().split('T')[0];
        html += _calDayHtml(ds, d, false, taskMap[ds] || [], today);
    }

    // Trailing empty cells to fill last row
    const totalCells = startDow + lastDay.getDate();
    const trailCount = (7 - (totalCells % 7)) % 7;
    for (let i = 1; i <= trailCount; i++) {
        const date = new Date(_calYear, _calMonth + 1, i);
        const ds = date.toISOString().split('T')[0];
        html += _calDayHtml(ds, i, true, taskMap[ds] || [], today);
    }

    grid.innerHTML = html;

    // Wire chip clicks → select task on board
    grid.querySelectorAll('.cal-task-chip[data-taskid]').forEach(chip => {
        chip.addEventListener('click', function() {
            const tid = parseInt(this.dataset.taskid);
            const col = this.dataset.col;
            closeCalendarView();
            setTimeout(() => {
                if (typeof selectTask === 'function') selectTask(col, tid);
                if (typeof scrollTaskIntoView === 'function') scrollTaskIntoView(tid);
            }, 200);
        });
    });
}

function _calDayHtml(ds, dayNum, otherMonth, dayTasks, today) {
    const isToday = ds === today;
    let inner = `<div class="cal-day-num">${dayNum}</div>`;
    const MAX_SHOW = 3;
    const shown = dayTasks.slice(0, MAX_SHOW);
    const more  = dayTasks.length - MAX_SHOW;
    shown.forEach(({ task, col }) => {
        const text = (task.text || '').slice(0, 28);
        inner += `<div class="cal-task-chip ${col}" data-taskid="${task.id}" data-col="${col}" title="${_escHtmlCal(task.text)}">${_escHtmlCal(text)}</div>`;
    });
    if (more > 0) inner += `<div class="cal-more">+${more} more</div>`;
    return `<div class="cal-day${otherMonth ? ' other-month' : ''}${isToday ? ' today' : ''}">${inner}</div>`;
}

function _escHtmlCal(str) {
    return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Add Calendar View to dropdown after DOM ready
window.addEventListener('load', function() {
    setTimeout(function() {
        const dd = document.getElementById('dropdown');
        if (!dd) return;
        // Insert after the Task Groups button
        const tgBtn = [...dd.querySelectorAll('.dropdown-item')].find(b => b.textContent.includes('Task Groups'));
        const calBtn = document.createElement('button');
        calBtn.className = 'dropdown-item';
        calBtn.innerHTML = '<span>📅</span><span>Calendar View</span>';
        calBtn.addEventListener('click', openCalendarView);
        if (tgBtn && tgBtn.nextSibling) {
            dd.insertBefore(calBtn, tgBtn.nextSibling);
        } else {
            dd.appendChild(calBtn);
        }
    }, 300);
});


/* ══════════════════════════════════════════════════════════════════════════
   FEATURE 5: CSV IMPORT
   Import tasks from a CSV file with columns: Task, Status, Priority, Due Date
   ══════════════════════════════════════════════════════════════════════════ */

function openCsvImport() {
    let overlay = document.getElementById('csv-import-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'csv-import-overlay';
        overlay.addEventListener('click', e => { if (e.target === overlay) closeCsvImport(); });
        overlay.innerHTML = `
        <div id="csv-import-panel">
            <div class="tg-header" style="padding:20px 24px 0;">
                <div class="tg-header-title">📥 Import from CSV</div>
                <button class="tg-close-btn" onclick="closeCsvImport()">✕</button>
            </div>
            <div style="padding:20px 24px 24px;display:flex;flex-direction:column;gap:16px;">
                <p style="font-size:12.5px;color:rgba(255,255,255,0.45);margin:0;line-height:1.6;">
                    Expected columns: <strong style="color:#a78bfa;">Task</strong> (required), 
                    <strong style="color:#a78bfa;">Status</strong> (To Do / Working On / Done), 
                    <strong style="color:#a78bfa;">Priority</strong> (High / Medium / Low), 
                    <strong style="color:#a78bfa;">Due Date</strong> (YYYY-MM-DD).
                    Extra columns are ignored.
                </p>
                <div class="csv-drop-zone" id="csv-drop-zone" onclick="document.getElementById('csv-file-input').click()">
                    <div class="csv-drop-icon">📂</div>
                    <div class="csv-drop-text">Click or drag a CSV file here</div>
                    <div class="csv-drop-hint">Max 500 rows · UTF-8 encoding</div>
                </div>
                <input type="file" id="csv-file-input" accept=".csv,text/csv" style="display:none">
                <div id="csv-preview-area" style="display:none">
                    <div style="font-size:12px;font-weight:700;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px;">
                        Preview (<span id="csv-row-count">0</span> rows)
                    </div>
                    <table class="csv-preview-table">
                        <thead><tr>
                            <th>Task</th><th>Status</th><th>Priority</th><th>Due Date</th>
                        </tr></thead>
                        <tbody id="csv-preview-body"></tbody>
                    </table>
                </div>
                <div id="csv-error" style="display:none;color:#f87171;font-size:12px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.25);border-radius:8px;padding:9px 12px;"></div>
                <div style="display:flex;gap:10px;justify-content:flex-end;">
                    <button onclick="closeCsvImport()" style="background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.12);color:rgba(255,255,255,0.6);border-radius:10px;padding:10px 20px;font-size:13px;font-weight:600;cursor:pointer;">Cancel</button>
                    <button class="csv-import-btn" id="csv-import-btn" disabled onclick="executeCsvImport()">Import Tasks</button>
                </div>
            </div>
        </div>`;
        document.body.appendChild(overlay);

        // Wire file input
        const fileInput = overlay.querySelector('#csv-file-input');
        fileInput.addEventListener('change', function() {
            if (this.files[0]) _csvLoadFile(this.files[0]);
        });

        // Wire drag-and-drop
        const dropZone = overlay.querySelector('#csv-drop-zone');
        dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
        dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
        dropZone.addEventListener('drop', e => {
            e.preventDefault();
            dropZone.classList.remove('dragover');
            const f = e.dataTransfer.files[0];
            if (f) _csvLoadFile(f);
        });
    }

    // Reset state
    overlay.querySelector('#csv-preview-area').style.display = 'none';
    overlay.querySelector('#csv-error').style.display = 'none';
    overlay.querySelector('#csv-import-btn').disabled = true;
    overlay._parsedRows = null;
    const fi = overlay.querySelector('#csv-file-input');
    if (fi) fi.value = '';

    overlay.classList.add('visible');

    const dd = document.getElementById('dropdown');
    if (dd) dd.classList.remove('show');
}
window.openCsvImport = openCsvImport;

function closeCsvImport() {
    const overlay = document.getElementById('csv-import-overlay');
    if (overlay) overlay.classList.remove('visible');
}
window.closeCsvImport = closeCsvImport;

function _csvLoadFile(file) {
    const overlay = document.getElementById('csv-import-overlay');
    const errEl   = overlay.querySelector('#csv-error');
    errEl.style.display = 'none';

    if (file.size > 2 * 1024 * 1024) {
        errEl.textContent = '⚠️ File too large (max 2 MB).';
        errEl.style.display = 'block';
        return;
    }

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const rows = _csvParse(e.target.result);
            if (rows.length === 0) throw new Error('No data rows found.');
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
    // Simple RFC-4180-ish CSV parser
    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    if (lines.length < 2) throw new Error('CSV must have a header row and at least one data row.');

    const headers = _csvSplitLine(lines[0]).map(h => h.trim().toLowerCase());
    const taskIdx    = headers.findIndex(h => h === 'task' || h === 'name' || h === 'title' || h === 'description');
    const statusIdx  = headers.findIndex(h => h === 'status' || h === 'column' || h === 'state');
    const priorityIdx = headers.findIndex(h => h === 'priority');
    const dueIdx     = headers.findIndex(h => h === 'due date' || h === 'due' || h === 'duedate');

    if (taskIdx === -1) throw new Error('No "Task" column found. Make sure your CSV has a column named Task, Name, or Title.');

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const cells = _csvSplitLine(line);
        const text = taskIdx !== -1 ? (cells[taskIdx] || '').trim() : '';
        if (!text) continue;

        const statusRaw = statusIdx !== -1 ? (cells[statusIdx] || '').trim().toLowerCase() : '';
        let col = 'todo';
        if (statusRaw.includes('work') || statusRaw === 'in progress' || statusRaw === 'doing') col = 'working';
        if (statusRaw === 'done' || statusRaw === 'complete' || statusRaw === 'completed' || statusRaw === 'finished') col = 'done';

        const priRaw = priorityIdx !== -1 ? (cells[priorityIdx] || '').trim().toLowerCase() : '';
        let priority = 'medium';
        if (priRaw === 'high' || priRaw === '1' || priRaw === 'h') priority = 'high';
        if (priRaw === 'low'  || priRaw === '3' || priRaw === 'l') priority = 'low';

        let dueDate = null;
        if (dueIdx !== -1 && cells[dueIdx]) {
            const raw = cells[dueIdx].trim();
            // Try YYYY-MM-DD or various formats
            const d = new Date(raw);
            if (!isNaN(d)) dueDate = d.toISOString().split('T')[0];
        }

        if (rows.length >= 500) break;
        rows.push({ text, col, priority, dueDate });
    }
    if (rows.length === 0) throw new Error('No valid task rows found in the CSV.');
    return rows;
}

function _csvSplitLine(line) {
    // Handle quoted fields
    const cells = [];
    let cur = '', inQuote = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (inQuote && line[i+1] === '"') { cur += '"'; i++; }
            else inQuote = !inQuote;
        } else if (ch === ',' && !inQuote) {
            cells.push(cur); cur = '';
        } else {
            cur += ch;
        }
    }
    cells.push(cur);
    return cells;
}

function _csvShowPreview(rows, overlay) {
    const tbody = overlay.querySelector('#csv-preview-body');
    tbody.innerHTML = rows.slice(0, 10).map(r => `
        <tr>
            <td>${_escHtmlCal(r.text.slice(0, 50))}</td>
            <td>${r.col === 'todo' ? 'To Do' : r.col === 'working' ? 'Working On' : 'Done'}</td>
            <td>${r.priority}</td>
            <td>${r.dueDate || '—'}</td>
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
    btn.disabled = true;
    btn.textContent = 'Importing…';

    let count = 0;
    overlay._parsedRows.forEach(row => {
        if (!row.text) return;
        const nextNum = getNextNumber();
        taskCounter = Math.max(taskCounter, nextNum);
        const task = {
            id: Date.now() * 1000 + nextNum + count,
            number: nextNum,
            text: row.text,
            priority: row.priority || 'medium',
            dueDate: row.dueDate || null,
            createdAt: new Date().toISOString()
        };
        tasks[row.col] = tasks[row.col] || [];
        tasks[row.col].push(task);
        count++;
    });

    if (typeof saveAll === 'function') saveAll();
    if (typeof renderAllColumns === 'function') renderAllColumns();

    btn.disabled = false;
    btn.textContent = 'Import Tasks';
    closeCsvImport();

    if (typeof showToast === 'function') {
        showToast(`📥 Imported ${count} task${count !== 1 ? 's' : ''}`, () => {});
    }
}
window.executeCsvImport = executeCsvImport;

// Add CSV Import to dropdown
window.addEventListener('load', function() {
    setTimeout(function() {
        const dd = document.getElementById('dropdown');
        if (!dd) return;
        // Insert after Calendar View (or Task Groups)
        const calBtn = [...dd.querySelectorAll('.dropdown-item')].find(b => b.textContent.includes('Calendar View'));
        const csvBtn = document.createElement('button');
        csvBtn.className = 'dropdown-item';
        csvBtn.innerHTML = '<span>📥</span><span>Import CSV</span>';
        csvBtn.addEventListener('click', openCsvImport);
        if (calBtn && calBtn.nextSibling) {
            dd.insertBefore(csvBtn, calBtn.nextSibling);
        } else {
            const tgBtn = [...dd.querySelectorAll('.dropdown-item')].find(b => b.textContent.includes('Task Groups'));
            if (tgBtn && tgBtn.nextSibling) dd.insertBefore(csvBtn, tgBtn.nextSibling);
            else dd.appendChild(csvBtn);
        }
    }, 400);
});


/* ══════════════════════════════════════════════════════════════════════════
   FEATURE 6: TAB KEY → CYCLE WORKSPACES
   Pressing Tab (when not in an input) cycles forward through workspaces.
   Shift+Tab cycles backward.
   ══════════════════════════════════════════════════════════════════════════ */

document.addEventListener('keydown', function(e) {
    if (e.key !== 'Tab') return;
    // Don't intercept if user is typing in an input/textarea
    const tag = document.activeElement ? document.activeElement.tagName : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    // Don't intercept if a modal is open
    if (document.querySelector('.tg-overlay.visible, #cal-overlay.visible, #csv-import-overlay.visible')) return;
    if (typeof workspaces === 'undefined' || workspaces.length <= 1) return;

    e.preventDefault();

    const ids = workspaces.map(w => w.id);
    const currentIdx = ids.indexOf(typeof activeWorkspaceId !== 'undefined' ? activeWorkspaceId : ids[0]);
    let nextIdx;
    if (e.shiftKey) {
        nextIdx = (currentIdx - 1 + ids.length) % ids.length;
    } else {
        nextIdx = (currentIdx + 1) % ids.length;
    }
    if (typeof switchWorkspace === 'function') {
        switchWorkspace(ids[nextIdx]);
    }
}, true); // capture phase so it fires before any other keydown handler


/* ══════════════════════════════════════════════════════════════════════════
   UPDATE SHORTCUTS OVERLAY — add Tab and Recur entries
   ══════════════════════════════════════════════════════════════════════════ */
window.addEventListener('load', function() {
    setTimeout(function() {
        const grid = document.querySelector('.shortcuts-grid');
        if (!grid) return;
        const newRows = [
            `<div><kbd>Tab</kbd><span>Cycle to next workspace</span></div>`,
            `<div><kbd>Shift</kbd>+<kbd>Tab</kbd><span>Cycle to previous workspace</span></div>`,
        ];
        grid.insertAdjacentHTML('beforeend', newRows.join(''));
    }, 500);
});

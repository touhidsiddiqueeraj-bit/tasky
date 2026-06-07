// ═══════════════════════════════════════════════════════════════════════════
//  TASKY — COLLABORATIVE LAYER  (append after tasky.js, or replace it)
//  Adds: groups, supervisor role, task assignment, team panel, member summary
// ═══════════════════════════════════════════════════════════════════════════

// currentUser is declared by tasky.js at global scope (let currentUser).
// tasky-collab.js shares that same global — no re-declaration here.
// _handleAuthChange syncs it from window.currentUser before any collab logic runs.

// ─── Collab State ─────────────────────────────────────────────────────────
let currentGroup      = null;   // { code, name, supervisorUid, supervisorHandle, members[] }
let currentHandle     = null;   // short username like "jon"
let isSupervisor      = false;

// Sync collab state to window so tasky-voice.js (and other modules) can read it
function _syncCollabState() {
    window.currentGroup   = currentGroup;
    window.currentHandle  = currentHandle;
    window.isSupervisor   = isSupervisor;
}
let groupListener     = null;   // Firestore onSnapshot unsubscribe
let tasksListener     = null;   // Firestore onSnapshot for tasks subcollection (supervisor)
let teamPanelMember   = null;   // handle being inspected in team panel

// ─── Handle / Identity ────────────────────────────────────────────────────
async function ensureHandle() {
    if (!currentUser) return null;
    if (currentHandle) return currentHandle;

    // Check localStorage first (written on saveHandle)
    const localHandle = localStorage.getItem('tasky_handle');
    if (localHandle) { currentHandle = localHandle; _syncCollabState(); return currentHandle; }

    // Fall back to Firestore SDK
    try {
        const snap = await db.collection('users').doc(currentUser.uid).get();
        if (snap.exists && snap.data().handle) {
            currentHandle = snap.data().handle;
            _syncCollabState();
            localStorage.setItem('tasky_handle', currentHandle);
            return currentHandle;
        }
    } catch(_) {}

    return null;
}

async function saveHandle(handle) {
    if (!currentUser) return;
    await db.collection('users').doc(currentUser.uid).set({ handle, email: currentUser.email }, { merge: true });
    currentHandle = handle;
    _syncCollabState();
    localStorage.setItem('tasky_handle', handle);
}

// ─── Plan / Member limit ──────────────────────────────────────────────────
const MAX_MEMBERS = 10;  // flat limit for all collaborations

// ─── Group Code Generator ─────────────────────────────────────────────────
function genGroupCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
}

// ─── Create Group ─────────────────────────────────────────────────────────
async function createGroup(groupName) {
    if (!currentUser || !currentHandle) return null;
    const code = genGroupCode();
    const groupData = {
        name: groupName,
        code,
        supervisorUid: currentUser.uid,
        supervisorHandle: currentHandle,
        memberLimit: MAX_MEMBERS,
        members: [{ uid: currentUser.uid, handle: currentHandle, email: currentUser.email }],
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    await db.collection('groups').doc(code).set(groupData);
    await db.collection('users').doc(currentUser.uid).set({ activeGroup: code }, { merge: true });
    // Create a workspace for this collaboration and switch to it
    if (typeof window.createWorkspace === 'function') {
        var wsId = window.createWorkspace(groupName, code);
        if (typeof window.switchWorkspace === 'function') window.switchWorkspace(wsId);
    }
    saveGroupCodeLocally(code);
    return code;
}

// ─── Join Group ───────────────────────────────────────────────────────────
async function joinGroup(code) {
    if (!currentUser || !currentHandle) return { ok: false, err: 'Not signed in' };
    const ref = db.collection('groups').doc(code.toUpperCase().trim());
    const snap = await ref.get();
    if (!snap.exists) return { ok: false, err: 'Group not found. Check the code.' };

    const data = snap.data();
    const already = data.members.some(m => m.uid === currentUser.uid);

    if (!already) {
        const limit = data.memberLimit || MAX_MEMBERS;
        if (data.members.length >= limit) {
            return {
                ok: false,
                err: `This collaboration is full (max ${limit} members).`
            };
        }
        await ref.update({
            members: firebase.firestore.FieldValue.arrayUnion({
                uid: currentUser.uid,
                handle: currentHandle,
                email: currentUser.email
            })
        });
    }
    await db.collection('users').doc(currentUser.uid).set({ activeGroup: code.toUpperCase() }, { merge: true });
    // Find or create a workspace for this collaboration
    if (typeof window.getWorkspaceByCollab === 'function' && typeof window.createWorkspace === 'function') {
        var ws = window.getWorkspaceByCollab(code.toUpperCase());
        if (ws) {
            if (typeof window.switchWorkspace === 'function') window.switchWorkspace(ws.id);
        } else {
            var wsId = window.createWorkspace(data.name || 'Collaboration', code.toUpperCase());
            if (typeof window.switchWorkspace === 'function') window.switchWorkspace(wsId);
        }
    }
    saveGroupCodeLocally(code.toUpperCase());
    return { ok: true };
}

// ─── Leave / Delete Group ────────────────────────────────────────────────
async function leaveGroup() {
    if (!currentUser || !currentGroup) return;
    if (isSupervisor && currentGroup.members.length > 1) {
        var confirmed = await showConfirm(
            'Delete Collaboration',
            'You are the supervisor of this collaboration. Leaving will delete it for everyone. All tasks, comments, and member data will be lost. This cannot be undone.',
            'Delete'
        );
        if (!confirmed) return;
        // Delete the entire group document — all members lose access
        var ref = db.collection('groups').doc(currentGroup.code);
        await ref.delete();
    } else {
        const ref = db.collection('groups').doc(currentGroup.code);
        const snap = await ref.get();
        if (snap.exists) {
            const updated = (snap.data().members || []).filter(m => m.uid !== currentUser.uid);
            if (updated.length === 0) {
                await ref.delete();
            } else {
                await ref.update({ members: updated });
            }
        }
    }
    await db.collection('users').doc(currentUser.uid).update({ activeGroup: firebase.firestore.FieldValue.delete() });
    saveGroupCodeLocally(null);
    // Unlink collab code from active workspace
    if (typeof window.linkWorkspaceToCollab === 'function') {
        window.linkWorkspaceToCollab(typeof activeWorkspaceId !== 'undefined' ? activeWorkspaceId : 1, null, null);
    }
    stopGroupListener();
    currentGroup = null;
    _syncCollabState();
    isSupervisor = false;
    _syncCollabState();
    teamPanelMember = null;
    renderGroupUI();
    if (typeof window.renderWorkspaceSwitcher === 'function') window.renderWorkspaceSwitcher();
}

// ─── Load & Listen to Group ───────────────────────────────────────────────
// Strategy: localStorage as write-through cache for the group code.
// On boot: read instantly from localStorage (survives F5, blocked network, broken SDK cache).
// Then verify/refresh from Firestore in the background.
// On join/create/leave: always write to both localStorage AND Firestore.

const LS_GROUP_KEY = 'tasky_active_group';

function saveGroupCodeLocally(code) {
    if (code) localStorage.setItem(LS_GROUP_KEY, code);
    else       localStorage.removeItem(LS_GROUP_KEY);
    // Also sync to the active workspace's collabCode
    if (typeof window.linkWorkspaceToCollab === 'function' && typeof activeWorkspaceId !== 'undefined') {
        window.linkWorkspaceToCollab(activeWorkspaceId, code, null);
    }
}

async function loadActiveGroup() {
    if (!currentUser) return;

    // 1. Start immediately from the active workspace or localStorage
    var localCode = null;
    if (typeof workspaces !== 'undefined' && workspaces.length > 0) {
        var ws = workspaces.find(function(w) { return w.id === activeWorkspaceId; });
        if (ws && ws.collabCode) localCode = ws.collabCode;
    }
    if (!localCode) localCode = localStorage.getItem(LS_GROUP_KEY);
    if (localCode) {
        startGroupListener(localCode);
    }

    // 2. Verify from Firestore in background
    try {
        const snap = await db.collection('users').doc(currentUser.uid).get();
        const serverCode = snap.exists ? (snap.data().activeGroup || null) : null;

        if (serverCode !== localCode) {
            // Server is authoritative — update local cache and restart listener
            saveGroupCodeLocally(serverCode);
            stopGroupListener();
            if (serverCode) {
                startGroupListener(serverCode);
            } else {
                currentGroup = null;
                _syncCollabState();
                renderGroupUI();
            }
        }
    } catch(_) {
        // Network blocked or SDK error — localStorage value is our best source, already started
    }
}

function startGroupListener(code) {
    stopGroupListener();

    // onSnapshot gives us real-time updates AND the initial value straight
    // from the server (source:'server' on the initial event is implicit).
    groupListener = db.collection('groups').doc(code).onSnapshot({ includeMetadataChanges: false }, async snap => {
        if (!snap.exists) {
            currentGroup = null;
            _syncCollabState();
            isSupervisor = false;
            _syncCollabState();
            stopTasksListener();
            renderGroupUI();
            return;
        }

        currentGroup = { ...snap.data(), code };
        _syncCollabState();
        isSupervisor = currentGroup.supervisorUid === currentUser.uid;
        _syncCollabState();
        renderGroupUI();

        if (isSupervisor) {
            startTasksListener(code);
        } else {
            stopTasksListener();
        }
    });
}

// Real-time listener on the tasks subcollection — supervisor only.
// Fires whenever ANY member updates their tasks, refreshing the team panel.
function startTasksListener(code) {
    if (tasksListener) return; // already listening
    tasksListener = db.collection('groups').doc(code)
        .collection('tasks').onSnapshot(snap => {
            snap.docChanges().forEach(change => {
                const uid = change.doc.id;
                if (change.type === 'removed') {
                    delete teamTasksCache[uid];
                } else {
                    const data = change.doc.data();
                    const member = currentGroup && currentGroup.members.find(m => m.uid === uid);
                    teamTasksCache[uid] = {
                        tasks: data.tasks || { todo: [], working: [], done: [] },
                        handle: data.handle || (member ? member.handle : uid)
                    };
                }
            });
            // Re-render team panel with fresh data (without a full Firestore fetch)
            const list = document.getElementById('team-list');
            if (list && currentGroup && isSupervisor && !teamPanelMember) {
                // Lightweight re-render using cached data
                list.innerHTML = '';
                currentGroup.members.forEach(m => {
                    const data = teamTasksCache[m.uid] || { tasks: { todo: [], working: [], done: [] } };
                    const todoCount    = (data.tasks.todo    || []).length;
                    const workingCount = (data.tasks.working || []).length;
                    const doneCount    = (data.tasks.done    || []).length;
                    const isSup = m.uid === currentGroup.supervisorUid;
                    const card = document.createElement('div');
                    card.className = 'member-card';
                    card.innerHTML = `
                        <div class="member-avatar ${isSup ? 'supervisor' : ''}">${m.handle[0].toUpperCase()}</div>
                        <div class="member-info">
                            <div class="member-name">@${m.handle} ${isSup ? '<span class="sup-tag">SUP</span>' : ''}</div>
                            <div class="member-stats">
                                <span class="stat-pill todo">${todoCount} todo</span>
                                <span class="stat-pill working">${workingCount} working</span>
                                <span class="stat-pill done">${doneCount} done</span>
                            </div>
                        </div>
                        <div style="display:flex;flex-direction:column;gap:5px;flex-shrink:0;">
                            <button class="member-assign-btn" title="Assign task to @${m.handle}">+ Assign</button>
                            <button class="member-inspect-btn" title="View tasks">View →</button>
                        </div>
                    `;
                    card.querySelector('.member-assign-btn').addEventListener('click', (e) => {
                        e.stopPropagation();
                        openAssignModal(m.handle);
                    });
                    card.querySelector('.member-inspect-btn').addEventListener('click', (e) => {
                        e.stopPropagation();
                        teamPanelMember = m.handle;
                        renderTeamPanel();
                    });
                    list.appendChild(card);
                });
                renderTeamSummaryTable(list);
            } else if (list && teamPanelMember) {
                // Someone we're inspecting changed — re-render their detail
                list.innerHTML = '';
                renderMemberDetail(list);
            }
        });
}

function stopTasksListener() {
    if (tasksListener) { tasksListener(); tasksListener = null; }
}

function stopGroupListener() {
    if (groupListener) { groupListener(); groupListener = null; }
    stopTasksListener();
}

// ─── Assigned-to task parsing ─────────────────────────────────────────────
// Syntax: "fix auth bug to::jon priority::high date::20may"
function parseAssignedTask(raw) {
    const result = { text: raw, assignedTo: null, priority: null, dueDate: null };

    // Extract `to::handle`
    const toMatch = raw.match(/\bto::(\w+)/i);
    if (toMatch) {
        result.assignedTo = toMatch[1].toLowerCase();
        raw = raw.replace(toMatch[0], '').trim();
    }

    // Extract `priority::high|medium|low`
    const priMatch = raw.match(/\bpriority::(high|medium|med|low)/i);
    if (priMatch) {
        const p = priMatch[1].toLowerCase();
        result.priority = p === 'med' ? 'medium' : p;
        raw = raw.replace(priMatch[0], '').trim();
    }

    // Extract `date::20may` or `date::2024-05-20` or `date::today` or `date::tomorrow`
    const dateMatch = raw.match(/\bdate::(\S+)/i);
    if (dateMatch) {
        result.dueDate = parseNaturalDate(dateMatch[1]);
        raw = raw.replace(dateMatch[0], '').trim();
    }

    // Clean up leftover double-spaces
    result.text = raw.replace(/\s{2,}/g, ' ').trim();
    return result;
}

function parseNaturalDate(str) {
    str = str.toLowerCase().trim();
    const today = new Date();
    if (str === 'today') return today.toISOString().split('T')[0];
    if (str === 'tomorrow') {
        const t = new Date(today); t.setDate(t.getDate() + 1);
        return t.toISOString().split('T')[0];
    }
    // Formats like "20may", "20 may", "may20", "20-may", "20/05", "2025-05-20"
    const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
    // Try dd-mon or mon-dd
    const m1 = str.match(/^(\d{1,2})[-\/\s]?([a-z]{3})/);
    if (m1 && months[m1[2]] !== undefined) {
        const d = new Date(today.getFullYear(), months[m1[2]], parseInt(m1[1]));
        // If date is in the past, bump to next year
        if (d < today) d.setFullYear(d.getFullYear() + 1);
        return d.toISOString().split('T')[0];
    }
    const m2 = str.match(/^([a-z]{3})[-\/\s]?(\d{1,2})/);
    if (m2 && months[m2[1]] !== undefined) {
        const d = new Date(today.getFullYear(), months[m2[1]], parseInt(m2[2]));
        if (d < today) d.setFullYear(d.getFullYear() + 1);
        return d.toISOString().split('T')[0];
    }
    // Try dd/mm or mm/dd
    const m3 = str.match(/^(\d{1,2})[\/\-](\d{1,2})$/);
    if (m3) {
        const d = new Date(today.getFullYear(), parseInt(m3[2]) - 1, parseInt(m3[1]));
        if (d < today) d.setFullYear(d.getFullYear() + 1);
        return d.toISOString().split('T')[0];
    }
    // ISO
    const iso = new Date(str);
    if (!isNaN(iso)) return iso.toISOString().split('T')[0];
    return null;
}

// ─── Collab addTask override ──────────────────────────────────────────────
// Wraps the original addTaskToTodo to handle assignment syntax
const _origAddTaskToTodo = addTaskToTodo;
addTaskToTodo = function(text) {
    // Only parse assignment syntax if in a group and is supervisor
    if (currentGroup && isSupervisor && text.includes('to::')) {
        const parsed = parseAssignedTask(text);
        // Validate assignee is in group
        const member = currentGroup.members.find(m => m.handle === parsed.assignedTo);
        if (!member) {
            _collabToast(`⚠️ No member "@${parsed.assignedTo}" in this collaboration`);
            return;
        }
        addCollabTask(parsed);
        return;
    }
    _origAddTaskToTodo(text);
}

async function addCollabTask(parsed) {
    const member = currentGroup.members.find(m => m.handle === parsed.assignedTo);
    if (!member) return;

    const task = {
        id: Date.now() * 1000 + Math.floor(Math.random() * 1000),
        number: 1,   // will be set correctly inside their own board; just needs to be unique
        text: parsed.text,
        priority: parsed.priority || 'medium',
        dueDate: parsed.dueDate || null,
        createdAt: new Date().toISOString(),
        assignedTo: parsed.assignedTo,
        assignedBy: currentHandle || null,
        groupCode: currentGroup.code,
        blockedBy: []
    };

    try {
        // Read the member's current task doc from Firestore
        const memberDocRef = db.collection('groups').doc(currentGroup.code)
            .collection('tasks').doc(member.uid);
        const snap = await memberDocRef.get();

        let memberTasks = { todo: [], working: [], done: [] };
        if (snap.exists && snap.data().tasks) {
            memberTasks = snap.data().tasks;
        }

        // Give the task a number that doesn't collide with theirs
        const usedNums = new Set(
            ['todo','working','done'].flatMap(c => (memberTasks[c] || []).map(t => t.number))
        );
        let n = 1;
        while (usedNums.has(n)) n++;
        task.number = n;

        memberTasks.todo = [...(memberTasks.todo || []), task];

        await memberDocRef.set({
            tasks: memberTasks,
            handle: member.handle,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        _collabToast(`✅ Assigned "${task.text}" → @${task.assignedTo}`);
        pushAssignmentNotification(task);
        // Refresh team panel so supervisor sees updated counts immediately
        renderTeamPanel();
    } catch(e) {
        _collabToast(`⚠️ Failed to assign task: ${e.message}`);
    }
}

async function pushAssignmentNotification(task) {
    if (!currentGroup || !task.assignedTo) return;
    const member = currentGroup.members.find(m => m.handle === task.assignedTo);
    if (!member) return;
    try {
        await db.collection('notifications').add({
            toUid: member.uid,
            fromHandle: currentHandle,
            groupCode: currentGroup.code,
            taskText: task.text,
            priority: task.priority,
            dueDate: task.dueDate,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            read: false
        });
    } catch(_) {}
}

// ─── Notification listener (for non-supervisors) ──────────────────────────
let notifListener = null;

// Pull tasks from this user's group subcollection and merge into local board
async function syncGroupTasksToBoard() {
    if (!currentUser || !currentGroup) return;
    try {
        const snap = await db.collection('groups').doc(currentGroup.code)
            .collection('tasks').doc(currentUser.uid).get();
        if (!snap.exists || !snap.data().tasks) return;

        const groupTasks = snap.data().tasks;

        // Collect all task IDs already on our board (by id) to avoid duplicates
        const existingIds = new Set(
            ['todo','working','done'].flatMap(c => (tasks[c] || []).map(t => t.id))
        );

        let changed = false;
        ['todo','working','done'].forEach(col => {
            (groupTasks[col] || []).forEach(t => {
                if (!existingIds.has(t.id)) {
                    tasks[col] = tasks[col] || [];
                    tasks[col].push(t);
                    existingIds.add(t.id);
                    changed = true;
                }
            });
        });

        if (changed) {
            saveAll();        // saves locally + calls pushToCloud → scheduleGroupSync
            renderAllColumns();
        }
    } catch(_) {}
}

function startNotifListener() {
    if (!currentUser) return;
    stopNotifListener();
    notifListener = db.collection('notifications')
        .where('toUid', '==', currentUser.uid)
        .where('read', '==', false)
        .onSnapshot(snap => {
            snap.docChanges().forEach(change => {
                if (change.type === 'added') {
                    const n = change.doc.data();
                    _collabToast(`📋 New task from @${n.fromHandle}: "${n.taskText}"`);
                    // Mark read
                    change.doc.ref.update({ read: true }).catch(() => {});
                    // Merge the new task from the group subcollection into the local board
                    syncGroupTasksToBoard();
                }
            });
        });
}

function stopNotifListener() {
    if (notifListener) { notifListener(); notifListener = null; }
}

// ─── Sync member tasks to group subcollection ─────────────────────────────
// Completely decoupled from pushToCloud / localStorage.
// Writes directly to Firestore whenever tasks change.
// Uses a short debounce to batch rapid changes (dragging, etc).
let _groupSyncTimer = null;

function scheduleGroupSync() {
    if (!currentGroup || !currentUser) return;
    if (_groupSyncTimer) clearTimeout(_groupSyncTimer);
    _groupSyncTimer = setTimeout(writeGroupTasks, 800);
}

async function writeGroupTasks() {
    if (!currentGroup || !currentUser) return;
    try {
        await db.collection('groups').doc(currentGroup.code)
            .collection('tasks').doc(currentUser.uid).set({
                tasks: JSON.parse(JSON.stringify(tasks)),
                handle: currentHandle,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
    } catch(e) {
        console.warn('[collab] writeGroupTasks failed:', e.message);
    }
}

// Hook into pushToCloud to also trigger a group sync.
// pushToCloud itself handles users/{uid} — we handle groups/{code}/tasks/{uid}.
const _origPushToCloud = pushToCloud;
pushToCloud = function() {
    _origPushToCloud();
    scheduleGroupSync();
}

// ─── Team Panel Data (supervisor) ─────────────────────────────────────────
let teamTasksCache = {}; // { uid: { tasks, handle } }

async function fetchAllMemberTasks() {
    if (!currentGroup) return;
    teamTasksCache = {};
    const promises = currentGroup.members.map(async m => {
        try {
            const snap = await db.collection('groups').doc(currentGroup.code)
                .collection('tasks').doc(m.uid).get();
            if (snap.exists) {
                teamTasksCache[m.uid] = { ...snap.data(), handle: m.handle };
            } else {
                teamTasksCache[m.uid] = { tasks: { todo: [], working: [], done: [] }, handle: m.handle };
            }
        } catch(_) {
            teamTasksCache[m.uid] = { tasks: { todo: [], working: [], done: [] }, handle: m.handle };
        }
    });
    await Promise.all(promises);
}

// ─── Group UI Rendering ───────────────────────────────────────────────────
function renderGroupUI() {
    const board = document.querySelector('.board');
    if (!board) return;

    // Update board class
    board.classList.toggle('board-4col', !!(currentGroup && isSupervisor));

    // Update collab badge in header
    renderCollabBadge();

    if (currentGroup && isSupervisor) {
        // Inject 4th column once; reuse on subsequent renders
        var teamCol = document.getElementById('collab-team-column');
        if (!teamCol) {
            teamCol = buildTeamColumn();
            board.appendChild(teamCol);
            // Fetch once on first load; after that the live listener keeps cache fresh
            fetchAllMemberTasks().then(function() { renderTeamPanel(); });
        } else {
            renderTeamPanel();
        }
    } else {
        // Remove 4th column if no longer supervisor
        var existing4th = document.getElementById('collab-team-column');
        if (existing4th) existing4th.remove();
    }

    // Update collab summary bar
    renderCollabSummary();

    // Update dropdown collab items
    renderCollabDropdownItems();
}

function renderCollabBadge() {
    let badge = document.getElementById('collab-badge');
    if (!badge) {
        badge = document.createElement('div');
        badge.id = 'collab-badge';
        badge.className = 'collab-badge';
        var target = document.querySelector('.top-menu') || document.body;
        target.appendChild(badge);
    }
    if (currentGroup) {
        badge.style.display = 'flex';
        badge.innerHTML = `
            <span class="collab-badge-dot ${isSupervisor ? 'supervisor' : 'member'}"></span>
            <span>${currentGroup.name}</span>
        `;
        // For members (no team panel), inject Board button + notification bell
        // right inside the badge itself so it stays visible
        if (!isSupervisor) {
            _mbInjectMemberControls(badge);
        }
    } else {
        badge.style.display = 'none';
        // Remove member controls if collab ended
        const mc = document.getElementById('mb-member-controls');
        if (mc) mc.remove();
    }
}

function buildTeamColumn() {
    const wrapper = document.createElement('div');
    wrapper.className = 'column-wrapper';
    wrapper.id = 'collab-team-column';
    wrapper.innerHTML = `
        <div class="column-ring collab-ring"></div>
        <div class="column-ring-inner collab-ring-inner"></div>
        <div class="column" id="team-column-inner">
            <div class="column-header" style="flex-direction:column;align-items:stretch;gap:8px;padding-bottom:10px;">
                <div style="display:flex;align-items:center;justify-content:space-between;">
                    <h2 class="column-title">👥 Team</h2>
                    <div style="display:flex;align-items:center;gap:6px;">
                        <button class="tc-board-btn" id="tc-board-btn" title="Message Board">
                            💬 Board
                            <span class="tc-board-badge" id="tc-board-badge" style="display:none;"></span>
                        </button>
                        <button class="assign-quick-btn" id="assign-quick-btn" title="Assign a task to a member">+ Assign</button>
                        <span class="task-count" id="team-member-count">0</span>
                    </div>
                </div>
                <div class="tc-meta-row">
                    <span class="tc-code-chip" id="tc-code-chip" title="Collaboration code — click to copy"></span>
                    <span class="tc-role-chip">👑 Supervisor</span>
                </div>
            </div>
            <div class="task-list" id="team-list" style="overflow-y:auto;"></div>
        </div>
    `;
    wrapper.querySelector('#assign-quick-btn').addEventListener('click', () => openAssignModal(null));
    wrapper.querySelector('#tc-board-btn').addEventListener('click', () => {
        _mbOpen ? closeMsgBoard() : openMsgBoard();
    });
    // Fill code chip
    const chip = wrapper.querySelector('#tc-code-chip');
    if (chip && currentGroup) {
        chip.textContent = currentGroup.code;
        chip.addEventListener('click', () => {
            navigator.clipboard.writeText(currentGroup.code).then(() => _collabToast('📋 Code copied!'));
        });
    }
    return wrapper;
}

function renderTeamPanel() {
    const list = document.getElementById('team-list');
    const countEl = document.getElementById('team-member-count');
    if (!list || !currentGroup) return;

    if (countEl) countEl.textContent = currentGroup.members.length;
    list.innerHTML = '';

    // If a member is being inspected
    if (teamPanelMember) {
        renderMemberDetail(list);
        return;
    }

    // List all members
    currentGroup.members.forEach(m => {
        const data = teamTasksCache[m.uid] || { tasks: { todo: [], working: [], done: [] } };
        const todoCount    = (data.tasks.todo    || []).length;
        const workingCount = (data.tasks.working || []).length;
        const doneCount    = (data.tasks.done    || []).length;
        const isSup = m.uid === currentGroup.supervisorUid;

        const card = document.createElement('div');
        card.className = 'member-card';
        card.innerHTML = `
            <div class="member-avatar ${isSup ? 'supervisor' : ''}">${m.handle[0].toUpperCase()}</div>
            <div class="member-info">
                <div class="member-name">@${m.handle} ${isSup ? '<span class="sup-tag">SUP</span>' : ''}</div>
                <div class="member-stats">
                    <span class="stat-pill todo">${todoCount} todo</span>
                    <span class="stat-pill working">${workingCount} working</span>
                    <span class="stat-pill done">${doneCount} done</span>
                </div>
            </div>
            <div style="display:flex;flex-direction:column;gap:5px;flex-shrink:0;">
                <button class="member-assign-btn" title="Assign task to @${m.handle}">+ Assign</button>
                <button class="member-inspect-btn" title="View tasks">View →</button>
            </div>
        `;
        card.querySelector('.member-assign-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            openAssignModal(m.handle);
        });
        card.querySelector('.member-inspect-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            teamPanelMember = m.handle;
            renderTeamPanel();
        });
        list.appendChild(card);
    });

    // Summary table at the bottom
    renderTeamSummaryTable(list);
}

function renderTeamSummaryTable(list) {
    if (!currentGroup || !isSupervisor) return;

    const divider = document.createElement('div');
    divider.className = 'team-summary-divider';
    divider.textContent = '📊 Team Summary';
    list.appendChild(divider);

    // Collect all tasks across all members
    let totalTodo = 0, totalWorking = 0, totalDone = 0;
    const assignedTasks = []; // { text, assignedTo, priority, dueDate, col }

    currentGroup.members.forEach(m => {
        const data = teamTasksCache[m.uid] || { tasks: { todo: [], working: [], done: [] } };
        const todo    = data.tasks.todo    || [];
        const working = data.tasks.working || [];
        const done    = data.tasks.done    || [];
        totalTodo    += todo.length;
        totalWorking += working.length;
        totalDone    += done.length;

        // Collect assigned tasks (tasks with assignedBy = supervisor assigned them)
        [...todo, ...working].forEach(t => {
            if (t.assignedBy) assignedTasks.push({ ...t, col: todo.includes(t) ? 'todo' : 'working', member: m.handle });
        });
    });

    const total = totalTodo + totalWorking + totalDone;

    // Totals row
    const totalsCard = document.createElement('div');
    totalsCard.className = 'summary-totals-card';
    totalsCard.innerHTML = `
        <div class="summary-total-item">
            <span class="summary-total-num todo-color">${totalTodo}</span>
            <span class="summary-total-label">To Do</span>
        </div>
        <div class="summary-total-sep"></div>
        <div class="summary-total-item">
            <span class="summary-total-num working-color">${totalWorking}</span>
            <span class="summary-total-label">In Progress</span>
        </div>
        <div class="summary-total-sep"></div>
        <div class="summary-total-item">
            <span class="summary-total-num done-color">${totalDone}</span>
            <span class="summary-total-label">Done</span>
        </div>
        <div class="summary-total-sep"></div>
        <div class="summary-total-item">
            <span class="summary-total-num">${total}</span>
            <span class="summary-total-label">Total</span>
        </div>
    `;
    list.appendChild(totalsCard);

    // Per-member table
    const table = document.createElement('div');
    table.className = 'team-summary-table';

    // Header
    table.innerHTML = `
        <div class="tst-row tst-header">
            <div class="tst-cell tst-member-col">Member</div>
            <div class="tst-cell tst-num-col">📝</div>
            <div class="tst-cell tst-num-col">⚡</div>
            <div class="tst-cell tst-num-col">✅</div>
            <div class="tst-cell tst-bar-col">Progress</div>
        </div>
    `;

    currentGroup.members.forEach(m => {
        const data = teamTasksCache[m.uid] || { tasks: { todo: [], working: [], done: [] } };
        const todo    = (data.tasks.todo    || []).length;
        const working = (data.tasks.working || []).length;
        const done    = (data.tasks.done    || []).length;
        const mtotal  = todo + working + done;
        const isSup   = m.uid === currentGroup.supervisorUid;
        const pct     = mtotal ? Math.round(done / mtotal * 100) : 0;

        const row = document.createElement('div');
        row.className = 'tst-row';
        row.innerHTML = `
            <div class="tst-cell tst-member-col">
                <div class="member-avatar tiny ${isSup ? 'supervisor' : ''}">${m.handle[0].toUpperCase()}</div>
                <span class="tst-handle">@${escHtml(m.handle)}</span>
            </div>
            <div class="tst-cell tst-num-col"><span class="stat-pill todo">${todo}</span></div>
            <div class="tst-cell tst-num-col"><span class="stat-pill working">${working}</span></div>
            <div class="tst-cell tst-num-col"><span class="stat-pill done">${done}</span></div>
            <div class="tst-cell tst-bar-col">
                <div class="tst-bar-track">
                    <div class="tst-bar-fill" style="width:${pct}%"></div>
                </div>
                <span class="tst-pct">${pct}%</span>
            </div>
        `;
        row.addEventListener('click', () => {
            teamPanelMember = m.handle;
            renderTeamPanel();
        });
        table.appendChild(row);
    });

    list.appendChild(table);

    // Active tasks section (assigned & in progress)
    const activeTasks = assignedTasks.filter(t => t.col === 'working');
    if (activeTasks.length > 0) {
        const activeLabel = document.createElement('div');
        activeLabel.className = 'team-summary-divider';
        activeLabel.textContent = '⚡ Currently Working On';
        list.appendChild(activeLabel);

        activeTasks.forEach(t => {
            const item = document.createElement('div');
            item.className = `member-task-item priority-${t.priority || 'medium'}`;
            item.style.marginTop = '4px';
            const isOverdue = t.dueDate && new Date(t.dueDate) < new Date();
            item.innerHTML = `
                <span class="member-task-priority">${t.priority === 'high' ? '🔴' : t.priority === 'medium' ? '🟡' : '🟢'}</span>
                <div class="member-task-body">
                    <span class="member-task-text">${escHtml(t.text)}</span>
                    <span class="member-task-assigned">@${escHtml(t.member)}</span>
                    ${t.dueDate ? `<span class="member-task-date ${isOverdue ? 'overdue' : ''}">📅 ${new Date(t.dueDate).toLocaleDateString('en-US',{month:'short',day:'numeric'})}</span>` : ''}
                </div>
            `;
            list.appendChild(item);
        });
    }
}

function renderMemberDetail(list) {
    const member = currentGroup.members.find(m => m.handle === teamPanelMember);
    if (!member) { teamPanelMember = null; renderTeamPanel(); return; }

    const data = teamTasksCache[member.uid] || { tasks: { todo: [], working: [], done: [] } };

    const header = document.createElement('div');
    header.className = 'member-detail-header';
    header.innerHTML = `
        <button class="member-back-btn" id="member-back-btn">← Back</button>
        <div class="member-detail-name">
            <div class="member-avatar small">${member.handle[0].toUpperCase()}</div>
            @${member.handle}
        </div>
    `;
    header.querySelector('#member-back-btn').addEventListener('click', () => {
        teamPanelMember = null;
        renderTeamPanel();
    });
    list.appendChild(header);

    let taskCount = 0;
    ['todo', 'working', 'done'].forEach(col => {
        const colTasks = (data.tasks[col] || []);
        if (colTasks.length === 0) return;
        const colHeader = document.createElement('div');
        colHeader.className = 'member-detail-col-label';
        colHeader.textContent = col === 'todo' ? '📝 To Do' : col === 'working' ? '⚡ Working On' : '✅ Done';
        list.appendChild(colHeader);

        colTasks.forEach(t => {
            taskCount++;
            const item = document.createElement('div');
            item.className = `member-task-item priority-${t.priority || 'medium'}`;
            item.style.flexDirection = 'column';
            item.style.alignItems = 'stretch';
            const isOverdue = t.dueDate && new Date(t.dueDate) < new Date() && col !== 'done';
            item.innerHTML = `
                <div style="display:flex;align-items:flex-start;gap:6px;">
                    <span class="member-task-priority">${t.priority === 'high' ? '🔴' : t.priority === 'medium' ? '🟡' : '🟢'}</span>
                    <div class="member-task-body" style="flex:1;min-width:0;">
                        <span class="member-task-text">${escHtml(t.text)}</span>
                        ${t.dueDate ? `<span class="member-task-date ${isOverdue ? 'overdue' : ''}">📅 ${new Date(t.dueDate).toLocaleDateString('en-US',{month:'short',day:'numeric'})}</span>` : ''}
                        ${t.assignedBy ? `<span class="member-task-assigned">from @${t.assignedBy}</span>` : ''}
                    </div>
                    <button class="member-task-comment-btn" data-taskid="${t.id}"
                        style="flex-shrink:0;background:none;border:1px solid rgba(255,255,255,0.12);border-radius:8px;
                        color:rgba(255,255,255,0.45);font-size:13px;padding:4px 8px;cursor:pointer;white-space:nowrap;">💬</button>
                </div>
                <div class="ic-strip" id="inline-comments-${t.id}" style="display:none;margin-top:6px;margin-left:22px;"></div>
            `;
            item.querySelector('.member-task-comment-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                openComments(t.id, t.text, col, member.uid);
            });

            // Load inline comment strip asynchronously
            if (currentGroup && db) {
                loadCommentEntries(t.id).then(entries => {
                    _renderInlineComments(t.id, entries);
                }).catch(() => {});
            }

            list.appendChild(item);
        });
    });

    if (taskCount === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.innerHTML = '<div class="empty-state-icon">🎉</div><div>No tasks yet</div>';
        list.appendChild(empty);
    }
}

// ─── Summary bar ──────────────────────────────────────────────────────────
async function renderCollabSummary() {
    let bar = document.getElementById('collab-summary-bar');

    if (!currentGroup || !isSupervisor) {
        if (bar) bar.remove();
        return;
    }

    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'collab-summary-bar';
        bar.className = 'collab-summary-bar';
        var _container = document.querySelector('.container');
        if (!_container) return;
        _container.after(bar);
    }

    await fetchAllMemberTasks();

    bar.innerHTML = `
        <div class="summary-bar-title">📊 Team Summary — ${currentGroup.name}</div>
        <div class="summary-bar-rows" id="summary-bar-rows"></div>
    `;

    const rowsEl = bar.querySelector('#summary-bar-rows');

    currentGroup.members.forEach(m => {
        const data = teamTasksCache[m.uid] || { tasks: { todo: [], working: [], done: [] } };
        const todo    = data.tasks.todo    || [];
        const working = data.tasks.working || [];
        const done    = data.tasks.done    || [];
        const total   = todo.length + working.length + done.length;

        const row = document.createElement('div');
        row.className = 'summary-row';
        row.innerHTML = `
            <div class="summary-member">
                <div class="member-avatar tiny ${m.uid === currentGroup.supervisorUid ? 'supervisor' : ''}">${m.handle[0].toUpperCase()}</div>
                <span>@${m.handle}</span>
            </div>
            <div class="summary-counts">
                <span class="stat-pill todo">${todo.length}</span>
                <span class="stat-pill working">${working.length}</span>
                <span class="stat-pill done">${done.length}</span>
            </div>
            <div class="summary-bar-visual">
                <div class="summary-bar-fill todo" style="width:${total ? (todo.length/total*100) : 0}%"></div>
                <div class="summary-bar-fill working" style="width:${total ? (working.length/total*100) : 0}%"></div>
                <div class="summary-bar-fill done" style="width:${total ? (done.length/total*100) : 0}%"></div>
            </div>
        `;
        row.addEventListener('click', () => {
            teamPanelMember = m.handle;
            // Scroll to team panel
            const col = document.getElementById('collab-team-column');
            if (col) col.scrollIntoView({ behavior: 'smooth', block: 'start' });
            renderTeamPanel();
        });
        rowsEl.appendChild(row);
    });
}

// ─── Dropdown collab items ────────────────────────────────────────────────
function renderCollabDropdownItems() {
    // The static buttons live in index.html; we just show/hide them here.
    const createBtn  = document.getElementById('collab-create-dd-btn');
    const joinBtn    = document.getElementById('collab-join-dd-btn');
    const infoBtn    = document.getElementById('collab-info-dd-btn');
    const leaveBtn   = document.getElementById('collab-leave-dd-btn');
    const divider    = document.getElementById('collab-dd-divider');
    if (!createBtn) return; // HTML not ready yet

    if (!currentGroup) {
        // Not in a collab — show Create / Join
        createBtn.style.display = '';
        joinBtn.style.display   = '';
        infoBtn.style.display   = 'none';
        leaveBtn.style.display  = 'none';
    } else {
        // In a collab — show Info / Leave, hide Create / Join
        createBtn.style.display = 'none';
        joinBtn.style.display   = 'none';
        infoBtn.style.display   = '';
        leaveBtn.style.display  = '';
        const infoText = document.getElementById('collab-info-dd-text');
        if (infoText) infoText.textContent = `${currentGroup.name} (${currentGroup.code})`;
    }
    if (divider) divider.style.display = '';
}

// ─── Collab Modal ─────────────────────────────────────────────────────────
function openCollabModal(mode) {
    let modal = document.getElementById('collab-modal-overlay');
    if (!modal) {
        modal = buildCollabModal();
        document.body.appendChild(modal);
    }
    modal.classList.remove('hidden');
    modal.classList.add('visible');
    showCollabModalPane(mode);
}

function closeCollabModal() {
    const modal = document.getElementById('collab-modal-overlay');
    if (!modal) return;
    modal.classList.remove('visible');
    modal.classList.add('hidden');
    setTimeout(() => modal.classList.remove('hidden'), 300);
}

function buildCollabModal() {
    const overlay = document.createElement('div');
    overlay.id = 'collab-modal-overlay';
    overlay.className = 'tg-overlay hidden';
    overlay.addEventListener('click', e => { if (e.target === overlay) closeCollabModal(); });

    overlay.innerHTML = `
    <div class="tg-modal" style="width:min(520px,96vw);">
        <div class="tg-header">
            <div class="tg-header-title" id="collab-modal-title">👥 Collaborations</div>
            <button class="tg-close-btn" onclick="closeCollabModal()">✕</button>
        </div>
        <div class="tg-body" style="padding:0;">
            <!-- Handle setup pane -->
            <div id="collab-pane-handle" class="collab-pane" style="display:none;padding:28px;">
                <p class="collab-pane-desc" id="collab-handle-desc">Choose a short username so teammates can identify you.</p>
                <div class="tg-field-label" style="margin-top:16px;">Your username (3–16 chars, letters/numbers)</div>
                <input class="tg-input" id="collab-handle-input" type="text" placeholder="e.g. jon, sara, dev01" maxlength="16">
                <div id="collab-handle-error" style="color:#f87171;font-size:12px;margin-top:6px;display:none;"></div>
                <div style="display:flex;gap:10px;margin-top:16px;">
                    <button class="tg-save-btn" id="collab-handle-save-btn">Save Username</button>
                </div>
            </div>
            <!-- Create pane -->
            <div id="collab-pane-create" class="collab-pane" style="display:none;padding:28px;">
                <p class="collab-pane-desc">Start a new Collaboration. You'll be the supervisor and share a 6-character code with teammates.</p>
                <div class="tg-field-label" style="margin-top:16px;">Collaboration Name</div>
                <input class="tg-input" id="collab-group-name-input" type="text" placeholder='e.g. "Dev Team", "Sprint 12"' maxlength="40">
                <div id="collab-create-error" style="color:#f87171;font-size:12px;margin-top:6px;display:none;"></div>
                <div style="display:flex;gap:10px;margin-top:16px;">
                    <button class="tg-save-btn" id="collab-create-btn">Create Collaboration</button>
                </div>
                <div id="collab-create-username-row" style="margin-top:18px;padding-top:14px;border-top:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;gap:10px;">
                    <span style="font-size:12px;color:rgba(255,255,255,0.35);">Your username: <strong id="collab-create-handle-display" style="color:rgba(255,255,255,0.6);"></strong></span>
                    <button class="tg-icon-btn" onclick="showCollabModalPane('change')" style="font-size:11px;padding:4px 10px;">✏️ Change</button>
                </div>
            </div>
            <!-- Join pane -->
            <div id="collab-pane-join" class="collab-pane" style="display:none;padding:28px;">
                <p class="collab-pane-desc">Enter the 6-character code from your supervisor.</p>
                <div class="tg-field-label" style="margin-top:16px;">Collaboration Code</div>
                <input class="tg-input" id="collab-join-code-input" type="text" placeholder="e.g. AB3X7K" maxlength="6"
                    style="text-transform:uppercase;letter-spacing:.2em;font-size:20px;font-weight:700;">
                <div id="collab-join-error" style="color:#f87171;font-size:12px;margin-top:6px;display:none;"></div>
                <div style="display:flex;gap:10px;margin-top:16px;">
                    <button class="tg-save-btn" id="collab-join-btn">Join Collaboration</button>
                </div>
                <div id="collab-join-username-row" style="margin-top:18px;padding-top:14px;border-top:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;gap:10px;">
                    <span style="font-size:12px;color:rgba(255,255,255,0.35);">Your username: <strong id="collab-join-handle-display" style="color:rgba(255,255,255,0.6);"></strong></span>
                    <button class="tg-icon-btn" onclick="showCollabModalPane('change')" style="font-size:11px;padding:4px 10px;">✏️ Change</button>
                </div>
            </div>
            <!-- Success pane -->
            <div id="collab-pane-success" class="collab-pane" style="display:none;padding:28px;text-align:center;">
                <div style="font-size:48px;margin-bottom:12px;">🎉</div>
                <div id="collab-success-title" style="font-size:18px;font-weight:700;color:#e2d9ff;margin-bottom:8px;"></div>
                <div id="collab-success-body" style="font-size:14px;color:rgba(255,255,255,0.55);line-height:1.6;margin-bottom:20px;"></div>
                <div id="collab-code-display" style="display:none;">
                    <div style="background:rgba(139,92,246,0.12);border:1px solid rgba(139,92,246,0.3);
                        border-radius:16px;padding:20px 24px;display:inline-block;margin-bottom:20px;">
                        <div style="font-size:11px;font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:#a78bfa;margin-bottom:6px;">Share this code</div>
                        <div id="collab-share-code" style="font-size:32px;font-weight:800;letter-spacing:.3em;color:#e2d9ff;"></div>
                    </div>
                    <button class="tg-icon-btn" onclick="copyGroupCode()" style="margin:0 auto;display:flex;">📋 Copy Code</button>
                </div>
                <button class="tg-save-btn" onclick="closeCollabModal()" style="margin-top:16px;">Done</button>
            </div>
            <!-- Info pane -->
            <div id="collab-pane-info" class="collab-pane" style="display:none;padding:28px;overflow-y:auto;max-height:72vh;">
                <div id="collab-info-content"></div>
            </div>
        </div>
    </div>`;

    // Wire up buttons
    overlay.querySelector('#collab-handle-save-btn').addEventListener('click', handleSaveHandle);
    overlay.querySelector('#collab-create-btn').addEventListener('click', handleCreateGroup);
    overlay.querySelector('#collab-join-btn').addEventListener('click', handleJoinGroup);
    overlay.querySelector('#collab-join-code-input').addEventListener('input', e => {
        e.target.value = e.target.value.toUpperCase();
    });
    overlay.querySelector('#collab-join-code-input').addEventListener('keydown', e => {
        if (e.key === 'Enter') handleJoinGroup();
    });

    return overlay;
}

// ─── GUI Assign Task Modal ────────────────────────────────────────────────
function openAssignModal(preselectedHandle) {
    let modal = document.getElementById('assign-modal-overlay');
    if (!modal) {
        modal = buildAssignModal();
        document.body.appendChild(modal);
    }

    // Populate member dropdowns (both panes)
    const memberSelects = [
        modal.querySelector('#assign-member-select'),
        modal.querySelector('#assign-group-member-select')
    ];
    memberSelects.forEach(sel => {
        if (!sel) return;
        sel.innerHTML = '<option value="">— Select member —</option>';
        (currentGroup.members || []).forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.handle;
            opt.textContent = `@${m.handle}${m.uid === currentGroup.supervisorUid ? ' (Supervisor)' : ''}`;
            sel.appendChild(opt);
        });
        if (preselectedHandle) sel.value = preselectedHandle;
    });

    // Reset single-task fields
    modal.querySelector('#assign-task-text').value = '';
    modal.querySelector('#assign-priority-select').value = 'medium';
    modal.querySelector('#assign-due-date').value = '';
    modal.querySelector('#assign-error').style.display = 'none';
    modal.querySelector('#assign-submit-btn').textContent = 'Assign Task';
    modal.querySelector('#assign-submit-btn').disabled = false;

    // Reset group pane
    modal.querySelector('#assign-group-due-date').value = '';
    modal.querySelector('#assign-group-error').style.display = 'none';
    modal.querySelector('#assign-group-preview').style.display = 'none';

    // Switch to single-task tab by default
    switchAssignMode('single');

    // Populate group list
    _populateAssignGroupList(modal);

    modal.classList.remove('hidden');
    modal.classList.add('visible');
    modal.querySelector('#assign-task-text').focus();
}

function switchAssignMode(mode) {
    const modal = document.getElementById('assign-modal-overlay');
    if (!modal) return;
    const singlePane = modal.querySelector('#assign-pane-single');
    const groupPane  = modal.querySelector('#assign-pane-group');
    const tabSingle  = modal.querySelector('#assign-tab-single');
    const tabGroup   = modal.querySelector('#assign-tab-group');
    if (mode === 'single') {
        singlePane.style.display = '';
        groupPane.style.display  = 'none';
        tabSingle.classList.add('active');
        tabGroup.classList.remove('active');
        modal.querySelector('#assign-task-text').focus();
    } else {
        singlePane.style.display = 'none';
        groupPane.style.display  = '';
        tabSingle.classList.remove('active');
        tabGroup.classList.add('active');
    }
}

// Populate the group-selection list inside the assign modal
function _populateAssignGroupList(modal) {
    if (!modal) modal = document.getElementById('assign-modal-overlay');
    if (!modal) return;
    const groups    = typeof tgLoad === 'function' ? tgLoad() : [];
    const emptyEl   = modal.querySelector('#assign-group-empty');
    const contentEl = modal.querySelector('#assign-group-content');
    const listEl    = modal.querySelector('#assign-group-list');
    const submitBtn = modal.querySelector('#assign-group-submit-btn');

    if (!groups.length) {
        if (emptyEl)   emptyEl.style.display   = 'flex';
        if (contentEl) contentEl.style.display = 'none';
        return;
    }
    if (emptyEl)   emptyEl.style.display   = 'none';
    if (contentEl) contentEl.style.display = '';

    listEl.innerHTML = '';
    let selectedGroupId = null;

    const selectGroup = (id) => {
        selectedGroupId = id;
        // Highlight selected
        listEl.querySelectorAll('.assign-group-option').forEach(el => {
            el.classList.toggle('selected', el.dataset.id === id);
        });
        // Show preview of tasks
        const g = groups.find(g => g.id === id);
        const previewEl = modal.querySelector('#assign-group-preview');
        const previewListEl = modal.querySelector('#assign-group-preview-list');
        if (g && previewEl && previewListEl) {
            previewListEl.innerHTML = g.tasks.map(t => {
                const priIcon = t.priority === 'high' ? '🔴' : t.priority === 'medium' ? '🟡' : '🟢';
                return `<div class="tg-subtask-row" style="pointer-events:none;">
                    <span style="font-size:12px;">${priIcon}</span>
                    <input class="tg-input" style="flex:1;padding:5px 8px;font-size:12px;border:none;background:transparent;" value="${escHtml(t.text)}" readonly>
                    <span style="font-size:11px;color:rgba(255,255,255,0.35);flex-shrink:0;">${t.priority}</span>
                </div>`;
            }).join('');
            previewEl.style.display = '';
        }
        if (submitBtn) submitBtn.disabled = false;
    };

    groups.forEach(g => {
        const colLabel = g.column === 'working' ? 'Working On' : 'To Do';
        const div = document.createElement('div');
        div.className = 'assign-group-option tg-group-card';
        div.dataset.id = g.id;
        div.style.cursor = 'pointer';
        div.innerHTML = `
            <div class="tg-group-card-main">
                <div class="tg-group-name">${escHtml(g.name)}</div>
                <div class="tg-group-meta">
                    <span class="tg-group-col-badge ${g.column === 'working' ? 'working' : 'todo'}">${colLabel}</span>
                    <span class="tg-group-task-count">${g.tasks.length} task${g.tasks.length !== 1 ? 's' : ''}</span>
                </div>
            </div>
            <div style="flex-shrink:0;color:rgba(255,255,255,0.25);font-size:18px;">○</div>
        `;
        div.addEventListener('click', () => selectGroup(g.id));
        listEl.appendChild(div);
    });

    // Store selected id accessor
    listEl._getSelectedId = () => selectedGroupId;
}

async function handleAssignGroupSubmit() {
    const modal   = document.getElementById('assign-modal-overlay');
    if (!modal) return;
    const listEl  = modal.querySelector('#assign-group-list');
    const groupId = listEl ? listEl._getSelectedId() : null;
    const handle  = modal.querySelector('#assign-group-member-select').value;
    const dateVal = modal.querySelector('#assign-group-due-date').value;
    const errEl   = modal.querySelector('#assign-group-error');
    const btn     = modal.querySelector('#assign-group-submit-btn');

    errEl.style.display = 'none';
    if (!groupId) { errEl.textContent = 'Please select a task group.';   errEl.style.display = 'block'; return; }
    if (!handle)  { errEl.textContent = 'Please select a team member.';  errEl.style.display = 'block'; return; }

    const groups = typeof tgLoad === 'function' ? tgLoad() : [];
    const group  = groups.find(g => g.id === groupId);
    if (!group)   { errEl.textContent = 'Group not found.'; errEl.style.display = 'block'; return; }

    btn.textContent = 'Assigning…'; btn.disabled = true;

    let assigned = 0, skipped = 0;
    for (const task of group.tasks) {
        try {
            await addCollabTask({
                text:       task.text,
                assignedTo: handle,
                priority:   task.priority || 'medium',
                dueDate:    dateVal || null
            });
            assigned++;
        } catch(_) { skipped++; }
    }

    btn.textContent = 'Assign Group'; btn.disabled = false;
    closeAssignModal();
    const msg = skipped
        ? `⊞ \"${group.name}\" assigned to @${handle} — ${assigned} sent, ${skipped} failed`
        : `⊞ \"${group.name}\" — ${assigned} task${assigned !== 1 ? 's' : ''} assigned to @${handle}`;
    _collabToast(msg);
}

function closeAssignModal() {
    const modal = document.getElementById('assign-modal-overlay');
    if (!modal) return;
    modal.classList.remove('visible');
    modal.classList.add('hidden');
    setTimeout(() => modal.classList.remove('hidden'), 300);
}

function buildAssignModal() {
    const overlay = document.createElement('div');
    overlay.id = 'assign-modal-overlay';
    overlay.className = 'tg-overlay hidden';
    overlay.addEventListener('click', e => { if (e.target === overlay) closeAssignModal(); });

    overlay.innerHTML = `
    <div class="tg-modal" style="width:min(500px,96vw);">
        <div class="tg-header">
            <div class="tg-header-title">📋 Assign Task</div>
            <button class="tg-close-btn" onclick="closeAssignModal()">✕</button>
        </div>
        <!-- Mode tabs -->
        <div class="tg-tabs" id="assign-mode-tabs">
            <button class="tg-tab active" id="assign-tab-single" onclick="switchAssignMode('single')">Single Task</button>
            <button class="tg-tab"        id="assign-tab-group"  onclick="switchAssignMode('group')">⊞ Use Group</button>
        </div>
        <div class="tg-body" style="padding:24px;display:flex;flex-direction:column;gap:16px;overflow-y:auto;">

            <!-- ── SINGLE TASK PANE ── -->
            <div id="assign-pane-single">
                <div>
                    <div class="tg-field-label">Task description</div>
                    <textarea id="assign-task-text" class="tg-input assign-textarea"
                        placeholder="Describe the task…" rows="3" maxlength="300"></textarea>
                </div>
                <div style="margin-top:14px;">
                    <div class="tg-field-label">Assign to</div>
                    <select id="assign-member-select" class="tg-input assign-select"></select>
                </div>
                <div style="display:flex;gap:12px;margin-top:14px;">
                    <div style="flex:1;">
                        <div class="tg-field-label">Priority</div>
                        <select id="assign-priority-select" class="tg-input assign-select">
                            <option value="high">🔴 High</option>
                            <option value="medium" selected>🟡 Medium</option>
                            <option value="low">🟢 Low</option>
                        </select>
                    </div>
                    <div style="flex:1;">
                        <div class="tg-field-label">Due date (optional)</div>
                        <input id="assign-due-date" class="tg-input" type="date">
                    </div>
                </div>
                <div id="assign-error" style="color:#f87171;font-size:12px;display:none;margin-top:8px;"></div>
                <button class="tg-save-btn" id="assign-submit-btn" style="margin-top:16px;">Assign Task</button>
                <div style="font-size:11px;color:rgba(255,255,255,0.25);text-align:center;margin-top:8px;">
                    Power users: type <code style="color:#a78bfa;">task to::handle priority::high date::20may</code> in the main input
                </div>
            </div>

            <!-- ── GROUP ASSIGN PANE ── -->
            <div id="assign-pane-group" style="display:none;">
                <div id="assign-group-empty" style="display:none;flex-direction:column;align-items:center;gap:12px;padding:24px 0;color:rgba(255,255,255,0.3);text-align:center;">
                    <div style="font-size:36px;">⊞</div>
                    <div style="font-size:13px;line-height:1.6;">No task groups yet.<br>Create groups from <strong style="color:#a78bfa;">Tasky ▼ → Task Groups</strong>.</div>
                </div>
                <div id="assign-group-content">
                    <div>
                        <div class="tg-field-label">Select group</div>
                        <div id="assign-group-list" style="display:flex;flex-direction:column;gap:8px;margin-top:8px;max-height:220px;overflow-y:auto;"></div>
                    </div>
                    <div style="margin-top:16px;">
                        <div class="tg-field-label">Assign all tasks to</div>
                        <select id="assign-group-member-select" class="tg-input assign-select"></select>
                    </div>
                    <div style="margin-top:14px;">
                        <div class="tg-field-label">Due date for all tasks (optional)</div>
                        <input id="assign-group-due-date" class="tg-input" type="date">
                    </div>
                    <div id="assign-group-preview" style="display:none;margin-top:14px;">
                        <div class="tg-field-label">Tasks that will be assigned</div>
                        <div id="assign-group-preview-list" style="display:flex;flex-direction:column;gap:5px;margin-top:8px;max-height:150px;overflow-y:auto;"></div>
                    </div>
                    <div id="assign-group-error" style="color:#f87171;font-size:12px;display:none;margin-top:8px;"></div>
                    <button class="tg-save-btn" id="assign-group-submit-btn" style="margin-top:16px;" disabled>Assign Group</button>
                    <div style="font-size:11px;color:rgba(255,255,255,0.3);margin-top:8px;">
                        Each task in the group will be assigned individually. Duplicate tasks (already on member's board) are skipped.
                    </div>
                </div>
            </div>

        </div>
    </div>`;

    overlay.querySelector('#assign-submit-btn').addEventListener('click', handleAssignModalSubmit);
    overlay.querySelector('#assign-task-text').addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAssignModalSubmit(); }
    });
    overlay.querySelector('#assign-group-submit-btn').addEventListener('click', handleAssignGroupSubmit);
    return overlay;
}

async function handleAssignModalSubmit() {
    const text     = document.getElementById('assign-task-text').value.trim();
    const handle   = document.getElementById('assign-member-select').value;
    const priority = document.getElementById('assign-priority-select').value;
    const dateVal  = document.getElementById('assign-due-date').value;
    const errEl    = document.getElementById('assign-error');
    const btn      = document.getElementById('assign-submit-btn');

    errEl.style.display = 'none';
    if (!text)   { errEl.textContent = 'Please enter a task description.'; errEl.style.display = 'block'; return; }
    if (!handle) { errEl.textContent = 'Please select a member.';          errEl.style.display = 'block'; return; }

    btn.textContent = 'Assigning…'; btn.disabled = true;

    await addCollabTask({ text, assignedTo: handle, priority, dueDate: dateVal || null });

    closeAssignModal();
}

async function showCollabModalPane(mode) {
    // Hide all panes
    document.querySelectorAll('.collab-pane').forEach(p => p.style.display = 'none');
    const title = document.getElementById('collab-modal-title');

    // If not signed in and trying to create/join, show sign-in prompt
    const isRealUser = currentUser && !currentUser.isAnonymous;
    if (!isRealUser && mode !== 'info' && mode !== 'change') {
        const pane = document.getElementById('collab-pane-handle') || document.querySelector('.collab-pane');
        if (pane) {
            pane.style.display = 'block';
            pane.innerHTML = `
                <div style="text-align:center;padding:16px 0;">
                    <div style="font-size:42px;margin-bottom:14px;">☁️</div>
                    <div style="font-size:16px;font-weight:700;color:#e2d9ff;margin-bottom:8px;">Sign in to use Collaborations</div>
                    <div style="font-size:13px;color:rgba(255,255,255,0.5);line-height:1.6;margin-bottom:20px;">
                        Collaborations use Google sign-in to sync tasks in real-time across your team. It's free.
                    </div>
                    <button class="tg-save-btn" onclick="closeCollabModal();signInWithGoogle();">Sign in with Google</button>
                </div>
            `;
        }
        if (title) title.textContent = '👥 Collaborations';
        return;
    }

    // 'change' mode: explicitly editing an existing handle
    if (mode === 'change') {
        const handleInput = document.getElementById('collab-handle-input');
        const handlePane  = document.getElementById('collab-pane-handle');
        const handleDesc  = document.getElementById('collab-handle-desc');
        if (handleInput) handleInput.value = currentHandle || '';
        if (handlePane)  handlePane.dataset.nextMode = currentGroup ? 'info' : 'create';
        if (handleDesc)  handleDesc.textContent = currentHandle
            ? `Your current username is @${currentHandle}. Enter a new one below.`
            : 'Choose a short username so teammates can identify you.';
        handlePane.style.display = 'block';
        if (title) title.textContent = '✏️ Change Username';
        handleInput.focus();
        return;
    }

    // If no handle yet, redirect to handle pane first
    const handle = await ensureHandle();
    if (!handle && mode !== 'info') {
        const handleInput = document.getElementById('collab-handle-input');
        if (handleInput) handleInput.value = '';
        document.getElementById('collab-pane-handle').style.display = 'block';
        if (title) title.textContent = '👤 Set Username';
        handleInput.focus();
        // Store intended mode
        document.getElementById('collab-pane-handle').dataset.nextMode = mode;
        return;
    }

    if (mode === 'create') {
        document.getElementById('collab-pane-create').style.display = 'block';
        if (title) title.textContent = '👥 Create Collaboration';
        document.getElementById('collab-group-name-input').focus();
        const cd = document.getElementById('collab-create-handle-display');
        if (cd) cd.textContent = currentHandle ? '@' + currentHandle : '(not set)';
    } else if (mode === 'join') {
        document.getElementById('collab-pane-join').style.display = 'block';
        if (title) title.textContent = '🔗 Join Collaboration';
        document.getElementById('collab-join-code-input').focus();
        const jd = document.getElementById('collab-join-handle-display');
        if (jd) jd.textContent = currentHandle ? '@' + currentHandle : '(not set)';
    } else if (mode === 'info') {
        document.getElementById('collab-pane-info').style.display = 'block';
        if (title) title.textContent = '👥 Collaboration Info';
        renderGroupInfoPane();
    }
}

function renderGroupInfoPane() {
    const el = document.getElementById('collab-info-content');
    if (!el || !currentGroup) return;
    el.innerHTML = `
        <div style="margin-bottom:16px;">
            <div class="tg-field-label">Collaboration Name</div>
            <div style="font-size:18px;font-weight:700;color:#e2d9ff;margin-top:4px;">${escHtml(currentGroup.name)}</div>
        </div>

        <!-- ── Invite teammates card ── -->
        <div style="margin-bottom:20px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.09);border-radius:14px;padding:16px 18px;">
            <div class="tg-field-label" style="margin-bottom:10px;">Invite Teammates</div>
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px;">
                <div style="font-size:26px;font-weight:800;letter-spacing:.28em;color:#a78bfa;font-family:monospace;">${currentGroup.code}</div>
                <button class="tg-icon-btn" style="font-size:12px;" onclick="copyGroupCode()">📋 Copy Code</button>
            </div>
            <div style="font-size:12px;color:rgba(255,255,255,0.35);margin-bottom:10px;">
                Or send a one-click invite link — they'll land straight on the Join screen with the code pre-filled.
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
                <button class="tg-save-btn" style="padding:10px 18px;font-size:13px;margin:0;" onclick="copyInviteLink()">🤝 Copy Invite Link</button>
                <button class="tg-icon-btn" style="font-size:12px;" onclick="shareInviteLink()">↗️ Share…</button>
            </div>
            <div id="collab-invite-link-preview" style="margin-top:10px;font-size:11px;font-family:monospace;
                color:rgba(255,255,255,0.35);word-break:break-all;display:none;background:rgba(0,0,0,0.2);
                border-radius:8px;padding:8px 10px;"></div>
        </div>

        <div>
            <div class="tg-field-label">Members (${currentGroup.members.length} / ${currentGroup.memberLimit || MAX_MEMBERS})</div>
            <div style="display:flex;flex-direction:column;gap:8px;margin-top:10px;">
                ${currentGroup.members.map(m => `
                    <div style="display:flex;align-items:center;gap:10px;background:rgba(255,255,255,0.04);border-radius:10px;padding:10px 12px;">
                        <div class="member-avatar tiny ${m.uid === currentGroup.supervisorUid ? 'supervisor' : ''}">${m.handle[0].toUpperCase()}</div>
                        <span style="font-size:14px;color:#e2d9ff;">@${escHtml(m.handle)}</span>
                        ${m.uid === currentGroup.supervisorUid ? '<span class="sup-tag">SUPERVISOR</span>' : ''}
                        ${m.email ? `<span style="font-size:11px;color:rgba(255,255,255,0.3);margin-left:auto;">${escHtml(m.email)}</span>` : ''}
                    </div>
                `).join('')}
            </div>
        </div>

        <!-- ── Share Live Board — prominent card ── -->
        <div style="margin-top:18px;background:linear-gradient(135deg,rgba(139,92,246,0.12),rgba(99,60,220,0.08));
            border:1px solid rgba(139,92,246,0.3);border-radius:14px;padding:16px 18px;">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
                <span style="font-size:16px;">📤</span>
                <span style="font-size:13px;font-weight:700;color:#c4b5fd;letter-spacing:.04em;text-transform:uppercase;">Share Live Board</span>
            </div>
            <div style="font-size:12px;color:rgba(255,255,255,0.45);line-height:1.5;margin-bottom:12px;">
                Send your client a read-only link — live task view, no login needed.
            </div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                <button class="tg-save-btn" style="padding:10px 20px;font-size:13px;margin:0;" onclick="copyShareableBoardLink()">🔗 Copy Share Link</button>
                <button class="tg-icon-btn" style="font-size:12px;" onclick="openShareableBoard()">👁️ Preview</button>
            </div>
            <div id="collab-share-link-preview" style="margin-top:10px;font-size:11px;font-family:monospace;
                color:rgba(255,255,255,0.35);word-break:break-all;display:none;background:rgba(0,0,0,0.25);
                border-radius:8px;padding:8px 10px;"></div>
        </div>

        ${isSupervisor ? `
        <div style="margin-top:16px;">
            <div class="tg-field-label">Supervisor Tip</div>
            <div style="font-size:13px;color:rgba(255,255,255,0.45);line-height:1.6;margin-top:6px;background:rgba(139,92,246,0.08);border:1px solid rgba(139,92,246,0.2);border-radius:10px;padding:12px;">
                Assign tasks with: <code style="color:#c4b5fd;">fix auth to::jon priority::high date::20may</code><br>
                Supports: <code style="color:#c4b5fd;">to::</code> <code style="color:#c4b5fd;">priority::</code> <code style="color:#c4b5fd;">date::</code>
            </div>
        </div>` : ''}
        <div style="margin-top:16px;padding-top:14px;border-top:1px solid rgba(255,255,255,0.06);">
            <div class="tg-field-label">Your Username</div>
            <div style="display:flex;align-items:center;gap:12px;margin-top:8px;">
                <span style="font-size:15px;font-weight:700;color:#e2d9ff;">@${escHtml(currentHandle || '—')}</span>
                <button class="tg-icon-btn" onclick="showCollabModalPane('change')" style="font-size:12px;">✏️ Change</button>
            </div>
        </div>
    `;
}

function copyGroupCode() {
    const code = currentGroup ? currentGroup.code :
        document.getElementById('collab-share-code')?.textContent;
    if (!code) return;
    navigator.clipboard.writeText(code).then(() => _collabToast('📋 Code copied!')).catch(() => {});
}

// ─── Invite Link ──────────────────────────────────────────────────────────
// Format: yoursite.com/tasky/?join=GROUPCODE
// When someone opens it, the Join modal pops with the code pre-filled.
function _buildInviteUrl(code) {
    const base = window.location.href.split('?')[0].split('#')[0];
    return `${base}?join=${code}`;
}

function copyInviteLink() {
    if (!currentGroup) return;
    const url = _buildInviteUrl(currentGroup.code);
    const preview = document.getElementById('collab-invite-link-preview');
    if (preview) { preview.textContent = url; preview.style.display = 'block'; }
    navigator.clipboard.writeText(url)
        .then(() => _collabToast('🤝 Invite link copied! Send it to your teammate.'))
        .catch(() => { _collabToast('🤝 Invite link: ' + url); });
}

function shareInviteLink() {
    if (!currentGroup) return;
    const url = _buildInviteUrl(currentGroup.code);
    if (navigator.share) {
        navigator.share({
            title: `Join "${currentGroup.name}" on Tasky`,
            text: `You've been invited to join the "${currentGroup.name}" collaboration on Tasky. Click to join:`,
            url
        }).catch(() => {});
    } else {
        copyInviteLink(); // fallback to copy on desktop
    }
}

// ─── Shareable Read-Only Board ─────────────────────────────────────────────
function _buildShareUrl(code) {
    const base = window.location.href.split('?')[0].split('#')[0];
    return `${base}?view=${code}`;
}

function copyShareableBoardLink() {
    if (!currentGroup) return;
    const url = _buildShareUrl(currentGroup.code);
    // Show preview
    const preview = document.getElementById('collab-share-link-preview');
    if (preview) { preview.textContent = url; preview.style.display = 'block'; }
    navigator.clipboard.writeText(url)
        .then(() => _collabToast('🔗 Share link copied! Send it to your client.'))
        .catch(() => { _collabToast('🔗 Link: ' + url); });
}

function openShareableBoard() {
    if (!currentGroup) return;
    window.open(_buildShareUrl(currentGroup.code), '_blank');
}

// ─── Read-only view mode (?view=CODE) ─────────────────────────────────────
// Activated when URL contains ?view=GROUPCODE
// Shows a clean live-updating board for clients — no auth, no editing.

(function initReadOnlyMode() {
    const params = new URLSearchParams(window.location.search);
    const viewCode = params.get('view');
    if (!viewCode) return;

    // Wait for Firebase to be ready, then boot read-only mode
    function _bootReadOnly() {
        // Wait until tasky.js has set window.db AND firebase has at least one
        // registered app (initializeApp completed). Checking only typeof db is
        // unreliable because window.db is assigned inside a setTimeout(,0) in
        // tasky.js — there is a brief window where firebase.apps is still empty
        // even after window.db appears, causing firebase.auth() to throw
        // "no-app" which previously triggered an infinite retry loop.
        if (!window.db || typeof firebase === 'undefined' || !firebase.apps || firebase.apps.length === 0) {
            setTimeout(_bootReadOnly, 100);
            return;
        }
        // Sign in anonymously so Firestore rules can grant read access without a Google account.
        // This works in incognito — anonymous auth creates a temporary session with no stored credentials.
        const auth = firebase.auth();
        if (auth.currentUser) {
            _mountReadOnlyBoard(viewCode.toUpperCase());
        } else {
            auth.signInAnonymously()
                .catch(() => {}) // if anon auth is disabled, try anyway — public rules may still allow it
                .finally(() => _mountReadOnlyBoard(viewCode.toUpperCase()));
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _bootReadOnly);
    } else {
        _bootReadOnly();
    }
})();

// ─── Invite link auto-join (?join=CODE) ───────────────────────────────────
// When a teammate clicks an invite link, the Join modal opens automatically
// with the code pre-filled. They still need to sign in and set a handle.
(function initInviteMode() {
    const params = new URLSearchParams(window.location.search);
    const joinCode = params.get('join');
    if (!joinCode) return;

    // Clean the URL so refreshing doesn't re-trigger this
    const cleanUrl = window.location.pathname;
    window.history.replaceState({}, '', cleanUrl);

    // Wait for the app to be ready, then open the join modal
    function _openJoinModal() {
        if (typeof openCollabModal !== 'function') { setTimeout(_openJoinModal, 150); return; }
        openCollabModal('join');
        // Pre-fill the code once the modal is open
        setTimeout(() => {
            const input = document.getElementById('collab-join-code-input');
            if (input) {
                input.value = joinCode.toUpperCase().trim();
                input.dispatchEvent(new Event('input'));
            }
        }, 100);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(_openJoinModal, 600));
    } else {
        setTimeout(_openJoinModal, 600);
    }
})();

async function _mountReadOnlyBoard(code) {
    // Remove loading splash (tasky.js skips this when ?view= is present)
    const splash = document.getElementById('loading-splash');
    if (splash) splash.remove();

    // Hide the normal app UI entirely (defensive — none should exist in view mode)
    document.querySelector('.top-menu')?.remove();
    document.querySelector('.container')?.remove();
    document.querySelector('.floating-input-container')?.remove();
    document.querySelector('.shortcuts-hint')?.remove();
    document.querySelector('#mobile-bottom-bar')?.remove();
    document.querySelector('.mobile-add-btn')?.remove();
    document.querySelector('.mobile-mic-btn')?.remove();
    document.querySelector('.sync-status')?.remove();
    document.querySelector('#enc-indicator')?.remove();
    document.querySelector('#workspace-switcher')?.remove();
    document.querySelector('.task-selector')?.remove();
    document.querySelector('.voice-overlay')?.remove();
    document.querySelectorAll('.onboarding-overlay').forEach(e => e.remove());

    // Build the read-only shell
    const shell = document.createElement('div');
    shell.id = 'ro-shell';
    shell.innerHTML = `
        <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #09080f; font-family: 'Inter', system-ui, sans-serif; color: #e2d9ff; min-height: 100vh; }
        #ro-shell { display: flex; flex-direction: column; min-height: 100vh; }
        .ro-topbar {
            background: linear-gradient(90deg, #13101e 0%, #0e0c17 100%);
            border-bottom: 1px solid rgba(255,255,255,0.08);
            padding: 14px 24px;
            display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px;
        }
        .ro-brand { display: flex; align-items: center; gap: 10px; }
        .ro-brand-logo { font-size: 22px; }
        .ro-brand-name { font-size: 16px; font-weight: 800; color: #e2d9ff; }
        .ro-group-name { font-size: 14px; color: #a78bfa; font-weight: 600; }
        .ro-badge {
            display: flex; align-items: center; gap: 6px;
            background: rgba(16,185,129,0.12); border: 1px solid rgba(16,185,129,0.3);
            border-radius: 20px; padding: 5px 12px; font-size: 12px; color: #6ee7b7; font-weight: 600;
        }
        .ro-badge-dot {
            width: 7px; height: 7px; border-radius: 50%; background: #10b981;
            animation: ro-pulse 1.8s ease-in-out infinite;
        }
        @keyframes ro-pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.5;transform:scale(.7)} }
        .ro-updated { font-size: 11px; color: rgba(255,255,255,0.3); }
        .ro-board {
            flex: 1; display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 20px; padding: 24px; align-items: start;
            max-width: 1200px; margin: 0 auto; width: 100%;
        }
        @media (max-width: 700px) { .ro-board { grid-template-columns: 1fr; padding: 14px; gap: 14px; } }
        .ro-col { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.07); border-radius: 18px; overflow: hidden; }
        .ro-col-header {
            padding: 14px 18px 12px;
            border-bottom: 1px solid rgba(255,255,255,0.07);
            display: flex; align-items: center; justify-content: space-between;
        }
        .ro-col-title { font-size: 14px; font-weight: 700; }
        .ro-col-count {
            font-size: 11px; font-weight: 700; background: rgba(255,255,255,0.08);
            border-radius: 10px; padding: 2px 9px; color: rgba(255,255,255,0.5);
        }
        .ro-col-todo    .ro-col-header { border-top: 3px solid #8B5CF6; }
        .ro-col-working .ro-col-header { border-top: 3px solid #F59E0B; }
        .ro-col-done    .ro-col-header { border-top: 3px solid #10B981; }
        .ro-tasks { padding: 12px; display: flex; flex-direction: column; gap: 8px; min-height: 60px; }
        .ro-task {
            background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08);
            border-radius: 12px; padding: 12px 14px;
        }
        .ro-task-text { font-size: 13.5px; color: #e2d9ff; line-height: 1.45; margin-bottom: 6px; }
        .ro-task-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
        .ro-priority {
            font-size: 10px; font-weight: 700; border-radius: 6px; padding: 2px 7px; letter-spacing: .04em;
        }
        .ro-priority.high   { background: rgba(239,68,68,.2); color: #fca5a5; border: 1px solid rgba(239,68,68,.3); }
        .ro-priority.medium { background: rgba(245,158,11,.2); color: #fcd34d; border: 1px solid rgba(245,158,11,.3); }
        .ro-priority.low    { background: rgba(16,185,129,.2); color: #6ee7b7; border: 1px solid rgba(16,185,129,.3); }
        .ro-due { font-size: 11px; color: rgba(255,255,255,0.4); }
        .ro-due.overdue { color: #f87171; }
        .ro-assignee { font-size: 11px; color: #a78bfa; }
        .ro-task-num { font-size: 10px; color: rgba(255,255,255,0.2); margin-left: auto; }
        .ro-empty { font-size: 12px; color: rgba(255,255,255,0.2); text-align: center; padding: 20px 0; }
        .ro-footer {
            text-align: center; padding: 20px;
            font-size: 12px; color: rgba(255,255,255,0.2);
            border-top: 1px solid rgba(255,255,255,0.05);
        }
        .ro-members {
            display: flex; flex-wrap: wrap; gap: 6px; padding: 14px 24px 0;
            max-width: 1200px; margin: 0 auto; width: 100%;
        }
        .ro-member-chip {
            display: flex; align-items: center; gap: 5px;
            background: rgba(139,92,246,0.1); border: 1px solid rgba(139,92,246,0.2);
            border-radius: 20px; padding: 3px 10px 3px 5px; font-size: 12px; color: #c4b5fd;
        }
        .ro-member-avatar {
            width: 20px; height: 20px; border-radius: 50%; background: rgba(139,92,246,0.4);
            display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; color: #fff;
        }
        .ro-section-label {
            font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .1em;
            color: rgba(255,255,255,0.25); padding: 0 24px; max-width: 1200px; margin: 14px auto 0; width: 100%;
        }
        .ro-loading { display: flex; flex-direction: column; align-items: center; justify-content: center; flex: 1; gap: 12px; padding: 60px; }
        .ro-spinner { width: 36px; height: 36px; border: 3px solid rgba(139,92,246,0.2); border-top-color: #8B5CF6; border-radius: 50%; animation: spin .7s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .ro-error { text-align: center; padding: 60px 24px; color: rgba(255,255,255,0.4); }
        .ro-error-icon { font-size: 48px; margin-bottom: 12px; }
        .ro-error-msg { font-size: 15px; color: #fca5a5; font-weight: 600; margin-bottom: 8px; }
        </style>
        <div class="ro-topbar">
            <div class="ro-brand">
                <span class="ro-brand-logo">✅</span>
                <div>
                    <div class="ro-brand-name">Tasky — Live Board</div>
                    <div class="ro-group-name" id="ro-group-name">Loading…</div>
                </div>
            </div>
            <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
                <span class="ro-updated" id="ro-updated"></span>
                <div class="ro-badge">
                    <div class="ro-badge-dot"></div>
                    Live
                </div>
            </div>
        </div>
        <div id="ro-members-row"></div>
        <div id="ro-board-area">
            <div class="ro-loading">
                <div class="ro-spinner"></div>
                <div style="color:rgba(255,255,255,0.35);font-size:13px;">Loading workspace…</div>
            </div>
        </div>
        <div class="ro-footer">Read-only view · Updates live · Powered by Tasky</div>
    `;
    document.body.appendChild(shell);
    document.title = 'Tasky — Live Board';

    // Listen to the group doc
    let groupData = null;
    let memberTasksCache = {};

    const groupUnsub = db.collection('groups').doc(code).onSnapshot(snap => {
        if (!snap.exists) {
            document.getElementById('ro-board-area').innerHTML = `
                <div class="ro-error">
                    <div class="ro-error-icon">🔍</div>
                    <div class="ro-error-msg">Board not found</div>
                    <div>The collaboration code <strong>${code}</strong> doesn't exist or has been deleted.</div>
                </div>`;
            document.getElementById('ro-group-name').textContent = 'Not found';
            return;
        }
        groupData = snap.data();
        document.getElementById('ro-group-name').textContent = groupData.name || code;
        document.title = `${groupData.name || 'Board'} — Tasky Live`;
        _renderROMembers(groupData);

        // Listen to all member tasks
        _listenROTasks(code, groupData);
    }, err => {
        const isPermission = err.code === 'permission-denied';
        document.getElementById('ro-board-area').innerHTML = `
            <div class="ro-error">
                <div class="ro-error-icon">${isPermission ? '🔒' : '⚠️'}</div>
                <div class="ro-error-msg">${isPermission ? 'Access denied' : 'Could not load board'}</div>
                <div style="margin-bottom:8px;">${isPermission
                    ? 'Firestore rules are blocking unauthenticated reads. Update your rules — see instructions below.'
                    : 'Check your connection or try refreshing.'}</div>
                ${isPermission ? `<div style="margin-top:16px;background:rgba(0,0,0,0.3);border-radius:10px;padding:14px 16px;text-align:left;font-size:12px;color:rgba(255,255,255,0.5);line-height:1.8;">
                    In Firebase Console → Firestore → Rules, add:<br>
                    <code style="color:#c4b5fd;font-size:11px;">match /groups/{code} { allow read: if true; }<br>
match /groups/{code}/tasks/{uid} { allow read: if true; }</code>
                </div>` : ''}
            </div>`;
    });

    let tasksUnsub = null;
    function _listenROTasks(code, group) {
        if (tasksUnsub) tasksUnsub();
        tasksUnsub = db.collection('groups').doc(code).collection('tasks')
            .onSnapshot(snap => {
                snap.docChanges().forEach(change => {
                    if (change.type === 'removed') {
                        delete memberTasksCache[change.doc.id];
                    } else {
                        const d = change.doc.data();
                        const member = (group.members || []).find(m => m.uid === change.doc.id);
                        memberTasksCache[change.doc.id] = {
                            tasks: d.tasks || { todo: [], working: [], done: [] },
                            handle: d.handle || (member ? member.handle : change.doc.id)
                        };
                    }
                });
                _renderROBoard(group, memberTasksCache);
            });
    }

    function _renderROMembers(group) {
        const row = document.getElementById('ro-members-row');
        if (!row) return;
        const members = group.members || [];
        if (!members.length) { row.innerHTML = ''; return; }
        row.innerHTML = `
            <div class="ro-section-label">Team Members</div>
            <div class="ro-members">
                ${members.map(m => `
                    <div class="ro-member-chip">
                        <div class="ro-member-avatar">${(m.handle || '?')[0].toUpperCase()}</div>
                        @${escHtml(m.handle)}
                        ${m.uid === group.supervisorUid ? ' 👑' : ''}
                    </div>
                `).join('')}
            </div>`;
    }

    function _renderROBoard(group, cache) {
        // Merge all tasks across members
        const merged = { todo: [], working: [], done: [] };
        (group.members || []).forEach(m => {
            const d = cache[m.uid] || { tasks: { todo: [], working: [], done: [] } };
            ['todo','working','done'].forEach(col => {
                (d.tasks[col] || []).forEach(t => {
                    if (!merged[col].some(x => x.id === t.id)) {
                        merged[col].push({ ...t, _handle: m.handle });
                    }
                });
            });
        });

        const now = new Date();
        function taskHTML(t) {
            const isOverdue = t.dueDate && new Date(t.dueDate) < now;
            const dueLabel = t.dueDate ? new Date(t.dueDate).toLocaleDateString('en-US', { month:'short', day:'numeric' }) : '';
            return `
                <div class="ro-task">
                    <div class="ro-task-text">${escHtml(t.text)}</div>
                    <div class="ro-task-meta">
                        ${t.priority ? `<span class="ro-priority ${t.priority}">${t.priority}</span>` : ''}
                        ${dueLabel ? `<span class="ro-due ${isOverdue ? 'overdue' : ''}">📅 ${dueLabel}${isOverdue ? ' · Overdue' : ''}</span>` : ''}
                        ${t.assignedTo ? `<span class="ro-assignee">→ @${escHtml(t.assignedTo)}</span>` : ''}
                        ${t.number ? `<span class="ro-task-num">#${t.number}</span>` : ''}
                    </div>
                </div>`;
        }

        const cols = [
            { key:'todo',    label:'📝 To Do',      cls:'ro-col-todo' },
            { key:'working', label:'⚡ Working On',  cls:'ro-col-working' },
            { key:'done',    label:'✅ Done',         cls:'ro-col-done' },
        ];

        const board = document.getElementById('ro-board-area');
        board.innerHTML = `
            <div class="ro-board">
                ${cols.map(c => `
                    <div class="ro-col ${c.cls}">
                        <div class="ro-col-header">
                            <span class="ro-col-title">${c.label}</span>
                            <span class="ro-col-count">${merged[c.key].length}</span>
                        </div>
                        <div class="ro-tasks">
                            ${merged[c.key].length
                                ? merged[c.key].map(taskHTML).join('')
                                : `<div class="ro-empty">No tasks</div>`}
                        </div>
                    </div>`).join('')}
            </div>`;

        const upd = document.getElementById('ro-updated');
        if (upd) upd.textContent = 'Updated ' + new Date().toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' });
    }
}

// ─── Handle button handlers ───────────────────────────────────────────────
async function handleSaveHandle() {
    const input = document.getElementById('collab-handle-input');
    const errEl = document.getElementById('collab-handle-error');
    const handle = input.value.trim().toLowerCase();

    errEl.style.display = 'none';
    if (!/^[a-z0-9]{3,16}$/.test(handle)) {
        errEl.textContent = 'Username must be 3–16 lowercase letters or numbers.';
        errEl.style.display = 'block';
        return;
    }

    const btn = document.getElementById('collab-handle-save-btn');
    btn.textContent = 'Saving…'; btn.disabled = true;

    // Check uniqueness — exclude own document so a user can "re-save" their handle
    const existing = await db.collection('users').where('handle', '==', handle).get();
    const takenByOther = existing.docs.some(doc => doc.id !== currentUser.uid);
    if (takenByOther) {
        errEl.textContent = 'Username taken. Try another.';
        errEl.style.display = 'block';
        btn.textContent = 'Save Username'; btn.disabled = false;
        return;
    }

    await saveHandle(handle);
    btn.textContent = 'Save Username'; btn.disabled = false;

    // Continue to intended mode
    const pane = document.getElementById('collab-pane-handle');
    const nextMode = pane.dataset.nextMode || 'create';
    showCollabModalPane(nextMode);
}

async function handleCreateGroup() {
    const input = document.getElementById('collab-group-name-input');
    const errEl = document.getElementById('collab-create-error');
    const name  = input.value.trim();

    errEl.style.display = 'none';
    if (!name) { errEl.textContent = 'Enter a collaboration name.'; errEl.style.display = 'block'; return; }

    const btn = document.getElementById('collab-create-btn');
    btn.textContent = 'Creating…'; btn.disabled = true;

    try {
        const code = await createGroup(name);
        startGroupListener(code);
        startNotifListener();

        document.querySelectorAll('.collab-pane').forEach(p => p.style.display = 'none');
        document.getElementById('collab-pane-success').style.display = 'block';
        document.getElementById('collab-modal-title').textContent = '✅ Collaboration Created';
        document.getElementById('collab-success-title').textContent = `"${name}" is ready`;
        document.getElementById('collab-success-body').textContent = 'Share the code below with teammates so they can join.';
        document.getElementById('collab-code-display').style.display = 'block';
        document.getElementById('collab-share-code').textContent = code;
    } catch(e) {
        errEl.textContent = 'Failed to create collaboration. Try again.';
        errEl.style.display = 'block';
    }
    btn.textContent = 'Create Collaboration'; btn.disabled = false;
}

async function handleJoinGroup() {
    const input = document.getElementById('collab-join-code-input');
    const errEl = document.getElementById('collab-join-error');
    const code  = input.value.trim().toUpperCase();

    errEl.style.display = 'none';
    if (code.length < 4) { errEl.textContent = 'Enter a valid collaboration code.'; errEl.style.display = 'block'; return; }

    const btn = document.getElementById('collab-join-btn');
    btn.textContent = 'Joining…'; btn.disabled = true;

    const result = await joinGroup(code);
    if (!result.ok) {
        errEl.textContent = result.err;
        errEl.style.display = 'block';
        btn.textContent = 'Join Collaboration'; btn.disabled = false;
        return;
    }

    startGroupListener(code);
    startNotifListener();

    const snap = await db.collection('groups').doc(code).get();
    const groupName = snap.exists ? snap.data().name : code;

    document.querySelectorAll('.collab-pane').forEach(p => p.style.display = 'none');
    document.getElementById('collab-pane-success').style.display = 'block';
    document.getElementById('collab-modal-title').textContent = '✅ Joined!';
    document.getElementById('collab-success-title').textContent = `Joined "${groupName}"`;
    document.getElementById('collab-success-body').textContent = `You're now a member. Tasks assigned to you will appear on your board.`;
    document.getElementById('collab-code-display').style.display = 'none';

    btn.textContent = 'Join Collaboration'; btn.disabled = false;
}

// ─── Task card: show assignment badge ────────────────────────────────────
// Monkey-patch createTaskCard to show assignedTo/assignedBy info
const _origCreateTaskCard = createTaskCard;
createTaskCard = function(task, column) {
    const card = _origCreateTaskCard(task, column);
    if (task.assignedTo || task.assignedBy) {
        const badge = document.createElement('div');
        badge.className = 'task-assign-badge';
        if (task.assignedTo) {
            badge.innerHTML += `<span class="assign-to">→ @${escHtml(task.assignedTo)}</span>`;
        }
        if (task.assignedBy && task.assignedBy !== currentHandle) {
            badge.innerHTML += `<span class="assign-from">from @${escHtml(task.assignedBy)}</span>`;
        }
        const meta = card.querySelector('.task-meta');
        if (meta) meta.appendChild(badge);
    }
    return card;
}

// ─── Helper (HTML escape for collab modal; tasky.js uses escapeHtml) ──────
function escHtml(str) {
    if (!str) return '';
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Hook into Firebase auth flow ─────────────────────────────────────────
// We piggyback on tasky.js's updateAuthUI (which fires AFTER currentUser is
// set) instead of registering a second onAuthStateChanged listener. That second
// listener was the root cause of the race: both listeners fired independently,
// so collab state was sometimes resolved before currentUser was updated and
// vice-versa, causing buttons to flicker or appear in the wrong state.
//
// Strategy:
//   • Real Google user  → load group, start listeners, render collab UI
//   • Anonymous / null  → tear down collab state, re-render (buttons hidden)
//   • We debounce rapid back-to-back calls (e.g. anon→google transition) with
//     a short timeout so only the final stable state triggers full setup.

let _collabAuthTimer = null;

async function _handleAuthChange() {
    // Sync module-level currentUser from window before any collab logic runs
    currentUser = window.currentUser || null;
    const user = currentUser;

    if (user && !user.isAnonymous) {
        // ── Real user — always run full setup so the dropdown renders on every load
        await ensureHandle();
        await loadActiveGroup();
        startNotifListener();
        await writeGroupTasks();
        await syncGroupTasksToBoard();
        renderGroupUI();
    } else {
        // ── Signed out — tear down collab state
        stopGroupListener();
        stopNotifListener();
        stopTasksListener();
        saveGroupCodeLocally(null);
        currentGroup    = null;
        _syncCollabState();
        isSupervisor    = false;
        _syncCollabState();
        currentHandle   = null;
        _syncCollabState();
        localStorage.removeItem('tasky_handle');
        teamPanelMember = null;
        teamTasksCache  = {};
        if (_groupSyncTimer) { clearTimeout(_groupSyncTimer); _groupSyncTimer = null; }
        renderGroupUI(); // always render — now shows collab buttons even when signed out
    }
}

function setupCollabAuth() {
    // tasky.js fires 'tasky:authchange' from onAuthStateChanged AFTER setting
    // window.currentUser. The 80ms debounce collapses the double-fire that can
    // happen during sign-in into one call on the final stable state.
    window.addEventListener('tasky:authchange', () => {
        if (_collabAuthTimer) clearTimeout(_collabAuthTimer);
        _collabAuthTimer = setTimeout(_handleAuthChange, 80);
    });
}

// Immediate (non-debounced) version used on boot only
async function pushGroupTasksNow() {
    await writeGroupTasks();
}

// ─── STATE exposure (tasky.js accesses these globals) ─────────────────────
// Expose STATE-like object for tgExpandGroup compatibility
window.STATE = {
    get tasks() { return tasks; }
};

// ─── Boot ─────────────────────────────────────────────────────────────────
// Use window 'load' (not DOMContentLoaded) so tasky.js has fully run and
// Firebase 'app' + 'db' globals are guaranteed to exist before we touch them.
setupCollabAuth(); // run immediately — auth events fire before window 'load'

// Show collab dropdown buttons immediately on DOM ready (before auth resolves)
document.addEventListener('DOMContentLoaded', () => {
    renderCollabDropdownItems();
});

// ─── Workspace switch handler: follow collab per workspace ─────────────────
window.__onWorkspaceSwitch = function(newId, oldId) {
    stopGroupListener();
    var ws = typeof workspaces !== 'undefined' ? workspaces.find(function(w) { return w.id === newId; }) : null;
    if (ws && ws.collabCode) {
        saveGroupCodeLocally(ws.collabCode);
        startGroupListener(ws.collabCode);
    } else {
        saveGroupCodeLocally(null);
        currentGroup = null;
        _syncCollabState();
        isSupervisor = false;
        _syncCollabState();
        teamPanelMember = null;
        renderGroupUI();
    }
};

// ─── Floating input assignment hint visibility ─────────────────────────────
function updateAssignHintVisibility() {
    const hint = document.getElementById('floating-assign-hint');
    if (!hint) return;
    hint.style.display = (currentGroup && isSupervisor) ? 'inline' : 'none';
}

// Also update placeholder
function updateInputPlaceholder() {
    const input = document.getElementById('floating-input');
    if (!input) return;
    if (currentGroup && isSupervisor) {
        input.placeholder = 'Add task — or: fix auth to::jon priority::high date::20may';
    } else {
        input.placeholder = 'Type to add task or template name…';
    }
}

// ─── Hook placeholder + hint updates into renderGroupUI ───────────────────
// Store original under a private name that won't collide
const _collabRenderGroupUI_orig = renderGroupUI;
renderGroupUI = function() {
    _collabRenderGroupUI_orig();
    updateInputPlaceholder();
    updateAssignHintVisibility();
};

// ═══════════════════════════════════════════════════════════════════════════
//  CLOUD COMMENTS & ACTIVITY FEED
//  Firestore path: groups/{code}/comments/{taskId}
//  Document shape: { taskId, taskText, entries: [ { id, text, ts, type,
//    authorHandle, authorUid } ] }
//
//  type = 'comment'  → user-written note
//  type = 'activity' → auto-logged event (move, priority, assign)
//
//  Comments are only available when the user is in a collab group.
//  Solo users still get activity logged locally to a lightweight in-memory
//  store (no localStorage) so the panel renders, but won't persist.
// ═══════════════════════════════════════════════════════════════════════════

// ─── In-memory fallback for solo (non-collab) activity ──────────────────
const _soloActivity = {};   // { [taskId]: [ entry, … ] }

// ─── Firestore ref helper ─────────────────────────────────────────────────
// Comments are stored inside each user's OWN tasks doc (which they can write)
// under a top-level 'comments' field: { [taskId]: [ entry, ... ] }
// This avoids needing extra Firestore rules.
function _myTasksDocRef() {
    if (!currentGroup || !currentUser || !db) return null;
    return db.collection('groups').doc(currentGroup.code)
             .collection('tasks').doc(currentUser.uid);
}

// For reading comments on a task, we read from ALL members' task docs.
// commentsDocRef is kept as a compat shim but is no longer the write path.
function commentsDocRef(taskId) {
    // Legacy path — no longer used for writes; kept for any stale references.
    return null;
}

// ─── Log an activity event (called by move/priority/assign hooks) ────────
async function logActivity(taskId, msg) {
    const entry = {
        id: Date.now() + Math.random(),
        text: msg,
        ts: new Date().toISOString(),
        type: 'activity',
        authorHandle: currentHandle || 'system',
        authorUid: currentUser ? currentUser.uid : null
    };

    const ref = _myTasksDocRef();
    if (ref) {
        try {
            const key = `comments_${String(taskId).replace(/[^a-z0-9]/gi,'_')}`;
            await ref.set({ [key]: firebase.firestore.FieldValue.arrayUnion(entry) }, { merge: true });
        } catch(_) {}
    } else {
        if (!_soloActivity[taskId]) _soloActivity[taskId] = [];
        _soloActivity[taskId].push(entry);
    }
}

// ─── Add a user comment ──────────────────────────────────────────────────
async function addComment(taskId, text, taskText) {
    if (!text.trim()) return;
    const entry = {
        id: Date.now() + Math.random(),
        text: text.trim(),
        ts: new Date().toISOString(),
        type: 'comment',
        authorHandle: currentHandle || 'me',
        authorUid: currentUser ? currentUser.uid : null
    };

    const ref = _myTasksDocRef();
    if (ref) {
        const key = `comments_${String(taskId).replace(/[^a-z0-9]/gi,'_')}`;
        await ref.set({ [key]: firebase.firestore.FieldValue.arrayUnion(entry) }, { merge: true });
        // Re-render panel if open (live listener also handles it)
        _refreshOpenCommentPanel(taskId);
        // Refresh inline strip on the card
        loadCommentEntries(taskId).then(entries => _renderInlineComments(taskId, entries)).catch(() => {});
        // Ping the supervisor if the commenter is a member (not supervisor)
        if (!isSupervisor && currentGroup) {
            _pingCommentNotification(taskId, taskText, text.trim());
        }
    } else {
        if (!_soloActivity[taskId]) _soloActivity[taskId] = [];
        _soloActivity[taskId].push(entry);
        _refreshOpenCommentPanel(taskId);
        // Refresh inline strip for solo mode
        _renderInlineComments(taskId, _soloActivity[taskId]);
    }
}

// ─── Ping supervisor when a member comments ──────────────────────────────
async function _pingCommentNotification(taskId, taskText, commentText) {
    if (!currentGroup || !currentUser) return;
    const supMember = currentGroup.members.find(m => m.uid === currentGroup.supervisorUid);
    if (!supMember || supMember.uid === currentUser.uid) return;
    try {
        await db.collection('notifications').add({
            toUid:       supMember.uid,
            fromHandle:  currentHandle,
            type:        'comment',
            groupCode:   currentGroup.code,
            taskId:      String(taskId),
            taskText:    taskText || '',
            commentText: commentText,
            createdAt:   firebase.firestore.FieldValue.serverTimestamp(),
            read:        false
        });
    } catch(_) {}
}

// ─── Delete a comment (own comment only) ────────────────────────────────
async function deleteComment(taskId, commentId) {
    const ref = _myTasksDocRef();
    if (!ref) {
        if (_soloActivity[taskId]) {
            _soloActivity[taskId] = _soloActivity[taskId].filter(e => e.id !== commentId);
        }
        _refreshOpenCommentPanel(taskId);
        _renderInlineComments(taskId, _soloActivity[taskId] || []);
        return;
    }
    try {
        const key = `comments_${String(taskId).replace(/[^a-z0-9]/gi,'_')}`;
        const snap = await ref.get();
        if (!snap.exists) return;
        const entries = (snap.data()[key] || []).filter(e => e.id !== commentId);
        await ref.update({ [key]: entries });
        _refreshOpenCommentPanel(taskId);
        loadCommentEntries(taskId).then(all => _renderInlineComments(taskId, all)).catch(() => {});
    } catch(_) {}
}

// ─── Load entries for a task ─────────────────────────────────────────────
// Reads from ALL members' task docs and merges entries for this taskId.
// Each member can only write their own doc but everyone can read group docs.
async function loadCommentEntries(taskId) {
    if (!currentGroup || !db) return _soloActivity[taskId] || [];
    const key = `comments_${String(taskId).replace(/[^a-z0-9]/gi,'_')}`;
    const allEntries = [];
    try {
        // Read all members' task docs
        const memberUids = (currentGroup.members || []).map(m => m.uid);
        const promises = memberUids.map(uid =>
            db.collection('groups').doc(currentGroup.code)
              .collection('tasks').doc(uid).get()
        );
        const snaps = await Promise.all(promises);
        snaps.forEach(snap => {
            if (snap.exists && snap.data()[key]) {
                allEntries.push(...snap.data()[key]);
            }
        });
    } catch(_) {}
    // Sort by ts
    return allEntries.sort((a, b) => a.ts > b.ts ? 1 : -1);
}

// ─── Live listener for the open comments panel ───────────────────────────
let _commentsUnsubscribe = null;
let _commentsOpenTaskId  = null;

function _stopCommentsListener() {
    if (_commentsUnsubscribe) { _commentsUnsubscribe(); _commentsUnsubscribe = null; }
    _commentsOpenTaskId = null;
}

function _startCommentsListener(taskId, ownerUid) {
    _stopCommentsListener();
    _commentsOpenTaskId = taskId;
    if (!currentGroup || !db) return;

    const key = `comments_${String(taskId).replace(/[^a-z0-9]/gi,'_')}`;
    const uidsToWatch = new Set([currentUser?.uid, ownerUid].filter(Boolean));

    // Watch every relevant doc — own doc + task owner's doc (may be same)
    const unsubs = [];
    uidsToWatch.forEach(uid => {
        const ref = db.collection('groups').doc(currentGroup.code).collection('tasks').doc(uid);
        const unsub = ref.onSnapshot(async () => {
            const entries = await loadCommentEntries(taskId);
            _renderCommentFeed(taskId, entries);
        }, () => {});
        unsubs.push(unsub);
    });

    _commentsUnsubscribe = () => unsubs.forEach(u => u());
}

function _refreshOpenCommentPanel(taskId) {
    if (_commentsOpenTaskId !== taskId) return;
    if (_soloActivity[taskId]) _renderCommentFeed(taskId, _soloActivity[taskId]);
    // Also refresh inline strip if it's visible in the team panel member detail
    loadCommentEntries(taskId).then(entries => _renderInlineComments(taskId, entries)).catch(() => {});
}

// ─── Format timestamp ────────────────────────────────────────────────────
function fmtCommentTs(iso) {
    const d = new Date(iso);
    const diff = (Date.now() - d) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ─── Open comments panel ─────────────────────────────────────────────────
async function openComments(taskId, taskText, column, ownerUid) {
    // Remove existing panel if open
    const existing = document.getElementById('task-comments-panel');
    if (existing) {
        _stopCommentsListener();
        existing.remove();
        // If same task re-clicked, just close
        if (_commentsOpenTaskId === taskId) { _commentsOpenTaskId = null; return; }
    }

    const inCollab = !!(currentGroup);
    const panel = document.createElement('div');
    panel.id = 'task-comments-panel';
    panel.className = 'tcp-overlay';

    const modeLabel = inCollab
        ? `<span class="tcp-collab-badge">☁️ Synced</span>`
        : `<span class="tcp-collab-badge tcp-solo">📵 Join a collab to sync</span>`;

    panel.innerHTML = `
        <div class="tcp-panel" id="tcp-inner">
          <div class="tcp-header">
            <div class="tcp-title">
              <span class="tcp-icon">💬</span>
              <div>
                <div class="tcp-task-name">${escHtml(taskText)}</div>
                <div style="margin-top:3px;">${modeLabel}</div>
              </div>
            </div>
            <button class="tcp-close" id="tcp-close-btn">✕</button>
          </div>
          <div class="tcp-feed" id="tcp-feed">
            <div class="tcp-loading">Loading…</div>
          </div>
          <div class="tcp-input-row">
            <input class="tcp-input" id="tcp-input"
              placeholder="${inCollab ? 'Comment… visible to all members (Enter to send)' : 'Note… (Join a collab to sync)'}"
              maxlength="400">
            <button class="tcp-send" id="tcp-send">Send</button>
          </div>
        </div>`;

    document.body.appendChild(panel);

    // Wire close
    document.getElementById('tcp-close-btn').addEventListener('click', () => {
        _stopCommentsListener();
        panel.remove();
    });
    panel.addEventListener('click', e => {
        if (e.target === panel) { _stopCommentsListener(); panel.remove(); }
    });

    // Wire send
    const input = document.getElementById('tcp-input');
    const sendBtn = document.getElementById('tcp-send');
    async function sendComment() {
        const text = input.value.trim();
        if (!text) return;
        sendBtn.disabled = true;
        input.value = '';
        try {
            await addComment(taskId, text, taskText);
            if (!currentGroup) {
                // Solo: re-render manually since no live listener
                const entries = await loadCommentEntries(taskId);
                _renderCommentFeed(taskId, entries);
            }
        } catch(e) {
            _collabToast('⚠️ Failed to save comment');
        }
        sendBtn.disabled = false;
        input.focus();
    }
    input.addEventListener('keydown', e => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); sendComment(); }
        if (e.key === 'Escape') { e.preventDefault(); _stopCommentsListener(); panel.remove(); }
    });
    sendBtn.addEventListener('click', sendComment);

    // Load initial entries then start live listener (watching owner's doc too)
    const entries = await loadCommentEntries(taskId);
    _renderCommentFeed(taskId, entries);
    _startCommentsListener(taskId, ownerUid);
    setTimeout(() => input.focus(), 60);
}

// ─── Render the feed ─────────────────────────────────────────────────────
function _renderCommentFeed(taskId, entries) {
    const feed = document.getElementById('tcp-feed');
    if (!feed) return;
    feed.innerHTML = '';

    if (!entries || entries.length === 0) {
        feed.innerHTML = '<div class="tcp-empty">No comments yet — add the first one!</div>';
        return;
    }

    // Sort by ts ascending
    const sorted = [...entries].sort((a, b) => a.ts > b.ts ? 1 : -1);

    sorted.forEach(entry => {
        const isOwn = entry.authorUid && currentUser && entry.authorUid === currentUser.uid;
        const item = document.createElement('div');
        item.className = `tcp-entry tcp-${entry.type}${isOwn ? ' tcp-own' : ''}`;

        const authorLine = entry.type === 'comment'
            ? `<span class="tcp-author">@${escHtml(entry.authorHandle || 'unknown')}</span>`
            : '';

        item.innerHTML = `
          <div class="tcp-entry-body">
            <div class="tcp-entry-inner">
              ${authorLine}
              <span class="tcp-entry-text">${entry.type === 'activity' ? '⚡ ' : ''}${escHtml(entry.text)}</span>
            </div>
            ${isOwn && entry.type === 'comment' ? `<button class="tcp-del-btn" data-cid="${entry.id}" title="Delete">✕</button>` : ''}
          </div>
          <span class="tcp-ts">${fmtCommentTs(entry.ts)}</span>`;

        feed.appendChild(item);
    });

    // Wire delete buttons
    feed.querySelectorAll('.tcp-del-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            await deleteComment(taskId, parseFloat(btn.dataset.cid));
        });
    });

    feed.scrollTop = feed.scrollHeight;
}

// ─── Inline comment preview helpers ──────────────────────────────────────

// Render the inline comment strip below a task card.
// Only shows entries with type === 'comment' (not activity logs).
function _renderInlineComments(taskId, entries) {
    const strip = document.getElementById(`inline-comments-${taskId}`);
    if (!strip) return;
    const comments = (entries || []).filter(e => e.type === 'comment');
    if (comments.length === 0) {
        strip.innerHTML = '';
        strip.style.display = 'none';
        return;
    }
    strip.style.display = 'block';
    strip.innerHTML = comments.map(c => `
        <div class="ic-entry">
            <span class="ic-author">@${escHtml(c.authorHandle || 'me')}</span>
            <span class="ic-text">${escHtml(c.text)}</span>
            <span class="ic-ts">${fmtCommentTs(c.ts)}</span>
        </div>`).join('');
}

// ─── Wire comment button into task cards (monkey-patch createTaskCard) ────
// This runs AFTER tasky-collab.js's own createTaskCard monkey-patch so all
// patches stack correctly.
const _commentPatchOrigCreateTaskCard = createTaskCard;
createTaskCard = function(task, column) {
    const card = _commentPatchOrigCreateTaskCard(task, column);

    // ── Inline comment strip (always visible below card) ──────────────────
    const inlineStrip = document.createElement('div');
    inlineStrip.className = 'ic-strip';
    inlineStrip.id = `inline-comments-${task.id}`;
    inlineStrip.style.display = 'none';
    card.appendChild(inlineStrip);

    // Load comments async; update inline strip
    if (currentGroup) {
        const key = `comments_${String(task.id).replace(/[^a-z0-9]/gi,'_')}`;
        const memberUids = (currentGroup.members || []).map(m => m.uid);
        Promise.all(
            memberUids.map(uid =>
                db.collection('groups').doc(currentGroup.code)
                  .collection('tasks').doc(uid).get()
            )
        ).then(snaps => {
            let allEntries = [];
            snaps.forEach(snap => {
                if (snap.exists && snap.data()[key]) {
                    allEntries = allEntries.concat(snap.data()[key]);
                }
            });
            allEntries.sort((a, b) => a.ts > b.ts ? 1 : -1);
            _renderInlineComments(task.id, allEntries);
        }).catch(() => {});
    } else {
        // Solo mode — use in-memory activity store
        const soloEntries = _soloActivity[task.id] || [];
        if (soloEntries.length > 0) {
            _renderInlineComments(task.id, soloEntries);
        }
    }
    return card;
};

// ─── Log activity via collab hooks ───────────────────────────────────────
// Wrap moveTask, setPriority, addTaskToTodo to log activity to Firestore.
// These wrap AFTER tasky-collab.js has already wrapped them, so we stack on top.

const _actLogOrigMoveTask = moveTask;
moveTask = function(fromCol, toCol, taskId) {
    _actLogOrigMoveTask(fromCol, toCol, taskId);
    const names = { todo: 'To Do', working: 'Working On', done: 'Done' };
    logActivity(taskId, `Moved: ${names[fromCol]} → ${names[toCol]}`);
};

const _actLogOrigSetPriority = setPriority;
setPriority = function(col, taskId, priority) {
    _actLogOrigSetPriority(col, taskId, priority);
    logActivity(taskId, `Priority → ${priority.charAt(0).toUpperCase() + priority.slice(1)}`);
};

// ─── NEW-TASK PUSH NOTIFICATION for members ───────────────────────────────
// When a task arrives (via startNotifListener), show browser push if granted.
// We hook into the existing startNotifListener by wrapping it.

const _origStartNotifListener = startNotifListener;
startNotifListener = function() {
    _origStartNotifListener();
    _startExtendedNotifListener();
};

// showTaskyToast bridge — collab.js loads before the inline HTML <script> that
// defines showTaskyToast, so we cannot capture it at parse time. We hook it
// lazily once the DOM is fully loaded.
function _collabToast(msg) {
    if (typeof showTaskyToast === 'function') showTaskyToast(msg);
    else if (typeof showToast === 'function') showToast(msg, () => {});
}
// NOTE: the _startExtendedNotifListener below calls _collabToast directly,
// so no module-level capture of showTaskyToast is needed here.

// Extend startNotifListener's Firestore snapshot to also handle comment pings
// and fire a browser notification. We replace the core logic by patching
// stopNotifListener and re-opening with our extended version.
const _origStopNotifListener = stopNotifListener;

function _startExtendedNotifListener() {
    if (!currentUser) return;
    _origStopNotifListener();

    notifListener = db.collection('notifications')
        .where('toUid', '==', currentUser.uid)
        .where('read', '==', false)
        .onSnapshot(snap => {
            snap.docChanges().forEach(change => {
                if (change.type !== 'added') return;
                const n = change.doc.data();
                change.doc.ref.update({ read: true }).catch(() => {});

                if (n.type === 'comment') {
                    // Supervisor receives comment ping
                    const msg = `💬 @${n.fromHandle} commented on "${n.taskText}": ${n.commentText}`;
                    _collabToast(msg);
                    // Browser push
                    if ('Notification' in window && Notification.permission === 'granted') {
                        try {
                            new Notification('Tasky — New Comment', {
                                body: `@${n.fromHandle}: "${n.commentText}" on task "${n.taskText}"`,
                                icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="%238B5CF6"/><text x="16" y="22" text-anchor="middle" font-size="18" fill="white">💬</text></svg>',
                            });
                        } catch(_) {}
                    }
                    // Open the comment panel if it's already open for this task
                    if (_commentsOpenTaskId === n.taskId) {
                        loadCommentEntries(n.taskId).then(e => _renderCommentFeed(n.taskId, e));
                    }
                } else {
                    // Default: task assignment ping
                    const msg = `📋 New task from @${n.fromHandle}: "${n.taskText}"`;
                    _collabToast(msg);
                    if ('Notification' in window && Notification.permission === 'granted') {
                        try {
                            new Notification('Tasky — New Task Assigned', {
                                body: `From @${n.fromHandle}: "${n.taskText}"${n.priority ? ' · ' + n.priority : ''}${n.dueDate ? ' · due ' + n.dueDate : ''}`,
                                icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="%238B5CF6"/><text x="16" y="22" text-anchor="middle" font-size="18" fill="white">✅</text></svg>',
                                requireInteraction: true
                            });
                        } catch(_) {}
                    }
                    syncGroupTasksToBoard();
                }
            });
        });
}

// Override startNotifListener globally to use our extended version
window.startNotifListener = _startExtendedNotifListener;

// ─── Calendar integration ─────────────────────────────────────────────────
// Collab tasks are already merged into `tasks` by syncGroupTasksToBoard,
// so the calendar's _buildTaskMap picks them up automatically.
// This stub exists to satisfy the typeof check in tasky-calendar.js.
window._collabTasksByDate = function() { return {}; };

// ─── Due date notifications ───────────────────────────────────────────────
// Checks every 60s. Fires once per task per day.
// Permission is requested the first time a due date is set.

const _NOTIF_SEEN_KEY = 'tasky_notif_seen_v1';
function _notifSeenLoad() {
    try { return JSON.parse(localStorage.getItem(_NOTIF_SEEN_KEY)) || {}; } catch { return {}; }
}

function checkDueDateNotifications() {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const seen = _notifSeenLoad();
    const now  = new Date();

    ['todo', 'working'].forEach(col => {
        (tasks[col] || []).forEach(task => {
            if (!task.dueDate) return;
            const due       = new Date(task.dueDate);
            const isOverdue = due < now;
            const isDueToday = due.toDateString() === now.toDateString();
            if (!isOverdue && !isDueToday) return;

            const seenKey = `${task.id}_${due.toDateString()}`;
            if (seen[seenKey]) return;

            const label = isOverdue ? '⚠️ Overdue' : '📅 Due Today';
            const body  = `#${task.number} ${task.text}${isOverdue ? ' · was due ' + due.toLocaleDateString('en-US',{month:'short',day:'numeric'}) : ''}`;
            try {
                const n = new Notification(`Tasky: ${label}`, {
                    body,
                    icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="%23dc2626"/><text x="16" y="22" text-anchor="middle" font-size="18" fill="white">📅</text></svg>',
                    tag: seenKey
                });
                n.onclick = () => { window.focus(); n.close(); };
            } catch(_) {}

            seen[seenKey] = true;
        });
    });
    localStorage.setItem(_NOTIF_SEEN_KEY, JSON.stringify(seen));
}

async function requestNotifPermission() {
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    const r = await Notification.requestPermission();
    return r === 'granted';
}

// Ask on first due-date set
const _actLogOrigSetDueDate = setDueDate;
window.setDueDate = function(col, taskId, date) {
    _actLogOrigSetDueDate(col, taskId, date);
    if (date) {
        requestNotifPermission().then(ok => {
            if (ok) {
                _collabToast('🔔 Due-date reminders enabled');
                checkDueDateNotifications();
            }
        });
    }
};

// Enable manually from dropdown
window.enableDueDateNotifications = async function() {
    if (!('Notification' in window)) {
        _collabToast('⚠️ This browser does not support notifications.');
        return;
    }
    const ok = await requestNotifPermission();
    if (ok) {
        _collabToast('🔔 Notifications enabled!');
        // Fire a confirmation push so user sees it's working
        try {
            new Notification('Tasky Notifications Active', {
                body: "You'll be notified for new tasks, comments, and due dates.",
                icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="%238B5CF6"/><text x="16" y="22" text-anchor="middle" font-size="18" fill="white">✅</text></svg>'
            });
        } catch(_) {}
        checkDueDateNotifications();
    } else if (Notification.permission === 'denied') {
        _collabToast('⚠️ Notifications blocked. Go to browser Site Settings to allow them.');
    } else {
        _collabToast('⚠️ Notification permission not granted.');
    }
};

if ('Notification' in window && Notification.permission === 'granted') {
    checkDueDateNotifications();
}
setInterval(checkDueDateNotifications, 60_000);

// ═══════════════════════════════════════════════════════════════════════════
//  TASKY — MESSAGE BOARD  (collaboration workspaces only)
//  Side-panel: full thread replies, emoji reactions, file attachments
//  Notifications: real-time unread badge via Firestore onSnapshot
//  Firestore: groups/{code}/messages/{id}  +  .../replies/{id}
// ═══════════════════════════════════════════════════════════════════════════

let _mbOpen           = false;
let _mbListener       = null;
let _mbReplyOpenId    = null;
let _mbReplyListeners = {};
let _mbMessages       = [];
let _mbUnreadCount    = 0;
let _mbLastSeen       = 0;
let _mbPendingFile    = null;

const MB_REACTIONS = ['👍','❤️','😂','🎉','🔥','👀'];

// ─── Helpers ──────────────────────────────────────────────────────────────
function _mbColRef() {
    return (currentGroup && db)
        ? db.collection('groups').doc(currentGroup.code).collection('messages')
        : null;
}
function _mbMe() { return currentHandle || (currentUser ? currentUser.uid.slice(0,8) : 'anon'); }

function _mbFmtTime(ts) {
    if (!ts) return '';
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    const now = new Date(), diff = now - d;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff/60000) + 'm ago';
    if (d.toDateString() === now.toDateString())
        return d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
    return d.toLocaleDateString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
}

function _mbUnreadLS() {
    const code = currentGroup ? currentGroup.code : null;
    return code ? parseInt(localStorage.getItem('tasky_mb_seen_' + code) || '0') : 0;
}
function _mbMarkSeen() {
    const code = currentGroup ? currentGroup.code : null;
    if (!code) return;
    _mbLastSeen = Date.now();
    localStorage.setItem('tasky_mb_seen_' + code, String(_mbLastSeen));
    _mbUnreadCount = 0;
    _mbSyncBadges();
}
function _mbSyncBadges() {
    // Team column badge (supervisor)
    const b = document.getElementById('tc-board-badge');
    if (b) {
        if (_mbUnreadCount > 0) {
            b.textContent = _mbUnreadCount > 9 ? '9+' : _mbUnreadCount;
            b.style.display = '';
        } else {
            b.style.display = 'none';
        }
    }
    // Member controls badge
    const mb = document.getElementById('mb-member-badge');
    if (mb) {
        if (_mbUnreadCount > 0) {
            mb.textContent = _mbUnreadCount > 9 ? '9+' : _mbUnreadCount;
            mb.style.display = '';
        } else {
            mb.style.display = 'none';
        }
    }
}

// ─── Member controls (Board btn + notif bell, injected for non-supervisors) ─
function _mbInjectMemberControls(badgeEl) {
    let mc = document.getElementById('mb-member-controls');
    if (mc) mc.remove();
    mc = document.createElement('div');
    mc.id = 'mb-member-controls';
    mc.className = 'mb-member-controls mb-member-controls--topright';
    mc.innerHTML = `
        <button class="mb-member-board-btn" id="mb-member-board-btn" title="Message Board">
            💬 Board
            <span class="mb-btn-badge" id="mb-member-badge" style="display:none;"></span>
        </button>
    `;
    mc.querySelector('#mb-member-board-btn').addEventListener('click', () => {
        _mbOpen ? closeMsgBoard() : openMsgBoard();
    });
    // Always place at top-right of page (fixed), not inside badge
    document.body.appendChild(mc);
    _mbSyncBadges();
}

// ─── Open / Close ─────────────────────────────────────────────────────────
function openMsgBoard() {
    if (!currentGroup) { _collabToast('⚠️ Join a collaboration to use the message board'); return; }
    if (!currentUser || currentUser.isAnonymous) { _collabToast('⚠️ Sign in to post messages'); return; }
    _mbOpen = true;
    if (!document.getElementById('mb-panel')) _mbBuildPanel();
    document.getElementById('mb-panel').classList.add('mb-panel--open');
    const ov = document.getElementById('mb-overlay');
    if (ov) ov.classList.add('mb-overlay--visible');
    _mbStartListener();
    _mbMarkSeen();
    // Always render feed immediately in case listener already has messages
    _mbRenderFeed();
    // Update board button states
    const tcBtn = document.getElementById('tc-board-btn');
    if (tcBtn) tcBtn.classList.add('tc-board-btn--active');
    const mBtn = document.getElementById('mb-member-board-btn');
    if (mBtn) mBtn.classList.add('tc-board-btn--active');
    setTimeout(() => { const i = document.getElementById('mb-input'); if (i) i.focus(); }, 200);
}
function closeMsgBoard() {
    _mbOpen = false;
    const panel = document.getElementById('mb-panel');
    if (panel) panel.classList.remove('mb-panel--open');
    const ov = document.getElementById('mb-overlay');
    if (ov) ov.classList.remove('mb-overlay--visible');
    const tcBtn = document.getElementById('tc-board-btn');
    if (tcBtn) tcBtn.classList.remove('tc-board-btn--active');
    const mBtn = document.getElementById('mb-member-board-btn');
    if (mBtn) mBtn.classList.remove('tc-board-btn--active');
}

// ─── Build panel DOM ───────────────────────────────────────────────────────
function _mbBuildPanel() {
    const ov = document.createElement('div');
    ov.id = 'mb-overlay';
    ov.className = 'mb-overlay';
    ov.addEventListener('click', closeMsgBoard);
    document.body.appendChild(ov);

    const panel = document.createElement('div');
    panel.id = 'mb-panel';
    panel.className = 'mb-panel';
    panel.innerHTML = `
        <div class="mb-header">
            <div class="mb-header-left">
                <span class="mb-header-icon">💬</span>
                <div>
                    <div class="mb-header-title">Message Board</div>
                    <div class="mb-header-sub">${currentGroup ? escHtml(currentGroup.name) : ''}</div>
                </div>
            </div>
            <button class="mb-close-btn" id="mb-close-btn">✕</button>
        </div>
        <div class="mb-feed" id="mb-feed">
            <div class="mb-empty" id="mb-empty">
                <div class="mb-empty-icon">💬</div>
                <div>No messages yet</div>
                <div class="mb-empty-sub">Be the first to post something</div>
            </div>
        </div>
        <div class="mb-composer">
            <div class="mb-composer-inner">
                <div class="mb-avatar-sm">${_mbMe()[0].toUpperCase()}</div>
                <div class="mb-composer-right">
                    <textarea id="mb-input" class="mb-input" placeholder="Write a message… (Enter to send)" rows="1" maxlength="1000"></textarea>
                    <div class="mb-composer-actions">
                        <label class="mb-attach-label" title="Attach image or file">📎<input type="file" id="mb-file-input" accept="image/*,.pdf,.doc,.docx,.txt" style="display:none"></label>
                        <div id="mb-attach-preview" class="mb-attach-preview" style="display:none;"></div>
                        <button class="mb-send-btn" id="mb-send-btn">Send ↑</button>
                    </div>
                </div>
            </div>
        </div>
    `;
    panel.querySelector('#mb-close-btn').addEventListener('click', closeMsgBoard);
    const ta = panel.querySelector('#mb-input');
    ta.addEventListener('input', () => { ta.style.height='auto'; ta.style.height=Math.min(ta.scrollHeight,120)+'px'; });
    ta.addEventListener('keydown', e => { if (e.key==='Enter'&&!e.shiftKey){e.preventDefault();_mbSend();} });
    panel.querySelector('#mb-file-input').addEventListener('change', e => _mbHandleFile(e.target));
    panel.querySelector('#mb-send-btn').addEventListener('click', _mbSend);
    document.body.appendChild(panel);
}

// ─── Firestore listener (also drives notification count) ──────────────────
function _mbStartListener() {
    if (_mbListener) return; // already running
    const col = _mbColRef();
    if (!col) return;
    _mbMessages = [];
    _mbLastSeen = _mbUnreadLS();

    _mbListener = col.orderBy('createdAt','asc').onSnapshot(snap => {
        snap.docChanges().forEach(change => {
            const id = change.doc.id;
            const data = { id, ...change.doc.data(), replies: [] };
            if (change.type === 'removed') {
                _mbMessages = _mbMessages.filter(m => m.id !== id);
                if (_mbReplyListeners[id]) { _mbReplyListeners[id](); delete _mbReplyListeners[id]; }
                return;
            }
            const ei = _mbMessages.findIndex(m => m.id === id);
            if (ei >= 0) {
                data.replies = _mbMessages[ei].replies || [];
                _mbMessages[ei] = data;
            } else {
                _mbMessages.push(data);
                // Count unread: new message from someone else, newer than last seen
                const ts = data.createdAt ? (data.createdAt.toMillis ? data.createdAt.toMillis() : 0) : 0;
                if (ts > _mbLastSeen && data.authorHandle !== _mbMe()) {
                    _mbUnreadCount++;
                    // Browser push notification
                    if (!_mbOpen && 'Notification' in window && Notification.permission === 'granted') {
                        try {
                            new Notification('Tasky — New Message', {
                                body: `@${data.authorHandle || '?'}: ${(data.text||'').slice(0,80)}`,
                                icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="%238B5CF6"/><text x="16" y="22" text-anchor="middle" font-size="18" fill="white">💬</text></svg>'
                            });
                        } catch(_) {}
                    }
                }
            }
        });
        _mbMessages.sort((a,b) => {
            const at = a.createdAt ? (a.createdAt.toMillis ? a.createdAt.toMillis() : 0) : 0;
            const bt = b.createdAt ? (b.createdAt.toMillis ? b.createdAt.toMillis() : 0) : 0;
            return at - bt;
        });
        if (_mbOpen) { _mbMarkSeen(); _mbRenderFeed(); }
        else { _mbSyncBadges(); }
        if (_mbReplyOpenId) _mbListenReplies(_mbReplyOpenId);
    });
}
function _mbStopListener() {
    if (_mbListener) { _mbListener(); _mbListener = null; }
    Object.values(_mbReplyListeners).forEach(u => u());
    _mbReplyListeners = {};
    _mbMessages = [];
}
function _mbListenReplies(msgId) {
    if (_mbReplyListeners[msgId]) return;
    const col = _mbColRef(); if (!col) return;
    _mbReplyListeners[msgId] = col.doc(msgId).collection('replies')
        .orderBy('createdAt','asc').onSnapshot(snap => {
            const msg = _mbMessages.find(m => m.id === msgId); if (!msg) return;
            snap.docChanges().forEach(change => {
                const rid = change.doc.id, rd = {id:rid,...change.doc.data()};
                if (change.type==='removed') { msg.replies=msg.replies.filter(r=>r.id!==rid); return; }
                const ri = msg.replies.findIndex(r=>r.id===rid);
                if (ri>=0) msg.replies[ri]=rd; else msg.replies.push(rd);
            });
            msg.replies.sort((a,b)=>{
                const at=a.createdAt?(a.createdAt.toMillis?a.createdAt.toMillis():0):0;
                const bt=b.createdAt?(b.createdAt.toMillis?b.createdAt.toMillis():0):0;
                return at-bt;
            });
            if (_mbOpen) _mbRenderFeed();
        });
}

// ─── Message board notifications ─────────────────────────────────────────
async function _mbPushMessageNotif(text, authorHandle) {
    if (!currentGroup || !currentUser) return;
    const batch = db.batch();
    const preview = (text || '').slice(0, 80);
    currentGroup.members.forEach(m => {
        // Don't notify the sender
        if (m.uid === currentUser.uid) return;
        const ref = db.collection('mb_notifications').doc();
        batch.set(ref, {
            toUid: m.uid,
            groupCode: currentGroup.code,
            groupName: currentGroup.name || '',
            authorHandle: authorHandle || _mbMe(),
            authorUid: currentUser.uid,
            isSupervisor: isSupervisor,
            text: preview,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            seen: false
        });
    });
    try { await batch.commit(); } catch(e) { /* non-critical */ }
}

let _mbNotifListener = null;
let _mbShownNotifIds = new Set();

function _mbStartNotifListener() {
    if (_mbNotifListener || !currentUser || !currentGroup) return;
    _mbNotifListener = db.collection('mb_notifications')
        .where('toUid', '==', currentUser.uid)
        .where('groupCode', '==', currentGroup.code)
        .where('seen', '==', false)
        .orderBy('createdAt', 'desc')
        .limit(10)
        .onSnapshot(snap => {
            snap.docChanges().forEach(change => {
                if (change.type !== 'added') return;
                const id = change.doc.id;
                if (_mbShownNotifIds.has(id)) return;
                const data = change.doc.data();
                // Don't toast for your own messages
                if (data.authorUid === currentUser.uid) return;
                // Don't toast if board is already open
                _mbShownNotifIds.add(id);
                _mbShowNotifToast(id, data);
                // Mark seen
                db.collection('mb_notifications').doc(id).update({ seen: true }).catch(()=>{});
            });
        }, () => {});
}

function _mbStopNotifListener() {
    if (_mbNotifListener) { _mbNotifListener(); _mbNotifListener = null; }
    _mbShownNotifIds.clear();
}

function _mbShowNotifToast(id, data) {
    // Remove any existing toast for same id
    const existing = document.getElementById('mb-notif-' + id);
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'mb-notif-toast';
    toast.id = 'mb-notif-' + id;

    const initial = (data.authorHandle || '?').charAt(0).toUpperCase();
    const isSup = data.isSupervisor;

    toast.innerHTML = `
        <div class="mb-notif-avatar${isSup ? ' sup' : ''}">${initial}</div>
        <div class="mb-notif-body">
            <div class="mb-notif-author">@${escHtml(data.authorHandle || '?')} · ${escHtml(data.groupName || '')}</div>
            <div class="mb-notif-text">${escHtml(data.text || '')}</div>
        </div>
        <span class="mb-notif-label">Board 💬</span>
    `;

    toast.addEventListener('click', () => {
        toast.remove();
        if (!_mbOpen) openMsgBoard();
    });

    document.body.appendChild(toast);
    setTimeout(() => { if (toast.parentNode) toast.remove(); }, 5000);

    // Also use browser notification if permission granted and board closed
    if (!_mbOpen && 'Notification' in window && Notification.permission === 'granted') {
        try {
            new Notification('💬 ' + (data.groupName || 'Message Board'), {
                body: '@' + (data.authorHandle || '?') + ': ' + (data.text || '').slice(0, 80),
                icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="%238B5CF6"/><text x="16" y="22" text-anchor="middle" font-size="18" fill="white">💬</text></svg>'
            });
        } catch(_) {}
    }
}

// ─── Send ─────────────────────────────────────────────────────────────────
async function _mbSend() {
    const input = document.getElementById('mb-input'); if (!input) return;
    const text = input.value.trim();
    if (!text && !_mbPendingFile) return;
    const col = _mbColRef(); if (!col) return;
    const btn = document.getElementById('mb-send-btn');
    if (btn) { btn.disabled=true; btn.textContent='…'; }
    try {
        const msg = {
            text: text||'', authorHandle:_mbMe(),
            authorUid: currentUser?currentUser.uid:'anon',
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            reactions:{}, replyCount:0
        };
        if (_mbPendingFile) msg.attachment = _mbPendingFile;
        const newMsgRef = await col.add(msg);
        // Push notification to all other members
        _mbPushMessageNotif(msg.text || '📎 Attachment', msg.authorHandle);
        input.value=''; input.style.height='auto';
        _mbPendingFile=null;
        const pv=document.getElementById('mb-attach-preview');
        if(pv){pv.innerHTML='';pv.style.display='none';}
        const fi=document.getElementById('mb-file-input'); if(fi) fi.value='';
    } catch(e) { _collabToast('⚠️ Failed to send'); }
    if (btn) { btn.disabled=false; btn.textContent='Send ↑'; }
}
async function _mbSendReply(msgId) {
    const input=document.getElementById('mb-reply-input-'+msgId); if(!input) return;
    const text=input.value.trim(); if(!text) return;
    const col=_mbColRef(); if(!col) return;
    const btn=document.getElementById('mb-reply-send-'+msgId);
    if(btn){btn.disabled=true;btn.textContent='…';}
    try {
        await col.doc(msgId).collection('replies').add({
            text, authorHandle:_mbMe(), authorUid:currentUser?currentUser.uid:'anon',
            createdAt:firebase.firestore.FieldValue.serverTimestamp(), reactions:{}
        });
        await col.doc(msgId).update({replyCount:firebase.firestore.FieldValue.increment(1)});
        input.value='';
    } catch(e){_collabToast('⚠️ Reply failed');}
    if(btn){btn.disabled=false;btn.textContent='↑';}
}

// ─── Reactions ────────────────────────────────────────────────────────────
async function _mbToggleReaction(msgId,emoji,isReply,replyId) {
    const col=_mbColRef(); if(!col) return;
    const me=_mbMe(), key='reactions.'+emoji;
    let ref = isReply&&replyId ? col.doc(msgId).collection('replies').doc(replyId) : col.doc(msgId);
    try {
        const snap=await ref.get(); if(!snap.exists) return;
        const users=(snap.data().reactions||{})[emoji]||[];
        if(users.includes(me)) await ref.update({[key]:firebase.firestore.FieldValue.arrayRemove(me)});
        else await ref.update({[key]:firebase.firestore.FieldValue.arrayUnion(me)});
    } catch(e){}
}

// ─── Delete ───────────────────────────────────────────────────────────────
async function _mbDelete(msgId,isReply,replyId) {
    const col=_mbColRef(); if(!col) return;
    try {
        if(isReply&&replyId){
            await col.doc(msgId).collection('replies').doc(replyId).delete();
            await col.doc(msgId).update({replyCount:firebase.firestore.FieldValue.increment(-1)});
        } else { await col.doc(msgId).delete(); }
    } catch(e){_collabToast('⚠️ Delete failed');}
}

// ─── File attach ──────────────────────────────────────────────────────────
function _mbHandleFile(input) {
    const file=input.files[0]; if(!file) return;
    if(file.size>10*1024*1024){_collabToast('⚠️ Max 10 MB');input.value='';return;}
    const reader=new FileReader();
    reader.onload=e=>{
        _mbPendingFile={name:file.name,type:file.type,dataUrl:e.target.result};
        const pv=document.getElementById('mb-attach-preview'); if(!pv) return;
        pv.style.display='flex';
        const isImg=file.type.startsWith('image/');
        pv.innerHTML=isImg
            ? `<img src="${e.target.result}" class="mb-attach-thumb" alt="${escHtml(file.name)}"><span class="mb-attach-name">${escHtml(file.name)}</span><button class="mb-attach-remove">✕</button>`
            : `<span class="mb-attach-icon">📎</span><span class="mb-attach-name">${escHtml(file.name)}</span><button class="mb-attach-remove">✕</button>`;
        pv.querySelector('.mb-attach-remove').addEventListener('click',()=>{
            _mbPendingFile=null;pv.innerHTML='';pv.style.display='none';input.value='';
        });
    };
    reader.readAsDataURL(file);
}

// ─── Render feed ──────────────────────────────────────────────────────────
function _mbRenderFeed() {
    const feed=document.getElementById('mb-feed'); if(!feed) return;
    const empty=document.getElementById('mb-empty');
    if(empty) empty.style.display=_mbMessages.length?'none':'flex';
    feed.querySelectorAll('.mb-msg').forEach(e=>e.remove());
    const me=_mbMe();

    _mbMessages.forEach(msg=>{
        const isMine=msg.authorHandle===me;
        const card=document.createElement('div');
        card.className='mb-msg'+(isMine?' mb-msg--mine':'');
        card.dataset.id=msg.id;

        let attachHtml='';
        if(msg.attachment){
            const a=msg.attachment;
            attachHtml=a.type&&a.type.startsWith('image/')
                ? `<a href="${a.dataUrl}" target="_blank"><img src="${a.dataUrl}" class="mb-attach-img" alt="${escHtml(a.name)}"></a>`
                : `<a class="mb-file-link" href="${a.dataUrl}" download="${escHtml(a.name)}">📎 ${escHtml(a.name)}</a>`;
        }
        const reactHtml=''; // reactions removed
        const replyCount=msg.replyCount||(msg.replies?msg.replies.length:0);
        const isSup=isSupervisor;
        const canDel=isMine||isSup;

        card.innerHTML=`
            <div class="mb-msg-meta">
                <span class="mb-avatar-sm ${msg.authorUid===(currentGroup&&currentGroup.supervisorUid)?'mb-avatar--sup':''}">${(msg.authorHandle||'?')[0].toUpperCase()}</span>
                <span class="mb-author">@${escHtml(msg.authorHandle||'?')}</span>
                <span class="mb-time">${_mbFmtTime(msg.createdAt)}</span>
                ${canDel?`<button class="mb-del-btn" title="Delete">✕</button>`:''}
            </div>
            ${msg.text?`<div class="mb-msg-text">${escHtml(msg.text)}</div>`:''}
            ${attachHtml}
            <div class="mb-msg-footer">
                <div class="mb-reaction-row" id="mb-reactions-${msg.id}" style="display:none;">
                </div>
                <button class="mb-reply-toggle">💬 ${replyCount?replyCount+' repl'+(replyCount===1?'y':'ies'):'Reply'}</button>
            </div>
            <div class="mb-thread" id="mb-thread-${msg.id}" style="display:${_mbReplyOpenId===msg.id?'block':'none'};">
                <div class="mb-replies" id="mb-replies-${msg.id}"></div>
                <div class="mb-reply-composer">
                    <div class="mb-avatar-xs">${me[0].toUpperCase()}</div>
                    <input type="text" id="mb-reply-input-${msg.id}" class="mb-reply-input" placeholder="Reply…" maxlength="500">
                    <button class="mb-reply-send" id="mb-reply-send-${msg.id}">↑</button>
                </div>
            </div>`;

        if(canDel) card.querySelector('.mb-del-btn').addEventListener('click',()=>_mbDelete(msg.id,false,null));
        // reactions removed
        card.querySelector('.mb-reply-toggle').addEventListener('click',()=>{
            _mbReplyOpenId=(_mbReplyOpenId===msg.id)?null:msg.id;
            if(_mbReplyOpenId) _mbListenReplies(msg.id);
            _mbRenderFeed();
        });
        // reaction btn listeners removed
        feed.appendChild(card);

        if(_mbReplyOpenId===msg.id){
            _mbRenderReplies(msg);
            const ri=card.querySelector('#mb-reply-input-'+msg.id);
            const rs=card.querySelector('#mb-reply-send-'+msg.id);
            if(ri) ri.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();_mbSendReply(msg.id);}});
            if(rs) rs.addEventListener('click',()=>_mbSendReply(msg.id));
        }
    });

    // Auto-scroll if near bottom
    const nearBottom=feed.scrollHeight-feed.scrollTop-feed.clientHeight<120;
    if(nearBottom) feed.scrollTop=feed.scrollHeight;
}

function _mbRenderReplies(msg) {
    const container=document.getElementById('mb-replies-'+msg.id); if(!container) return;
    container.innerHTML='';
    const me=_mbMe();
    (msg.replies||[]).forEach(r=>{
        const isMine=r.authorHandle===me, isSup=isSupervisor;
        const div=document.createElement('div');
        div.className='mb-reply'+(isMine?' mb-reply--mine':'');
        const rh=''; // reactions removed
        div.innerHTML=`
            <div class="mb-msg-meta">
                <span class="mb-avatar-xs">${(r.authorHandle||'?')[0].toUpperCase()}</span>
                <span class="mb-author">@${escHtml(r.authorHandle||'?')}</span>
                <span class="mb-time">${_mbFmtTime(r.createdAt)}</span>
                ${(isMine||isSup)?'<button class="mb-del-btn">✕</button>':''}
            </div>
            <div class="mb-msg-text mb-reply-text">${escHtml(r.text||'')}</div>
            <div class="mb-reaction-row" style="display:none;">${rh}</div>`;
        if(isMine||isSup) div.querySelector('.mb-del-btn').addEventListener('click',()=>_mbDelete(msg.id,true,r.id));
        // reaction listeners removed
        container.appendChild(div);
    });
}

function _mbReactionsHtml(reactions,msgId,isReply,replyId,me) {
    return Object.entries(reactions).filter(([,u])=>u&&u.length>0).map(([emoji,users])=>{
        const active=users.includes(me);
        return `<button class="mb-reaction-btn${active?' mb-reaction-btn--active':''}"
            data-msgid="${msgId}" data-emoji="${emoji}" data-isreply="${isReply}" data-replyid="${replyId||''}"
            title="${users.map(u=>'@'+u).join(', ')}">${emoji} <span>${users.length}</span></button>`;
    }).join('');
}

function _mbShowEmojiPicker(msgId,isReply,replyId,anchor) {
    document.querySelectorAll('.mb-emoji-picker').forEach(p=>p.remove());
    const picker=document.createElement('div'); picker.className='mb-emoji-picker';
    MB_REACTIONS.forEach(emoji=>{
        const btn=document.createElement('button'); btn.className='mb-emoji-opt'; btn.textContent=emoji;
        btn.addEventListener('click',e=>{e.stopPropagation();_mbToggleReaction(msgId,emoji,isReply,replyId);picker.remove();});
        picker.appendChild(btn);
    });
    document.body.appendChild(picker);
    requestAnimationFrame(()=>{
        const rect=anchor.getBoundingClientRect(),pw=picker.offsetWidth,ph=picker.offsetHeight;
        let top=rect.top+window.scrollY-ph-8,left=rect.left+window.scrollX;
        if(left+pw>window.innerWidth-8) left=window.innerWidth-pw-8;
        if(top<8) top=rect.bottom+window.scrollY+8;
        picker.style.top=top+'px'; picker.style.left=left+'px';
    });
    setTimeout(()=>{
        const dismiss=e=>{if(!picker.contains(e.target)){picker.remove();document.removeEventListener('click',dismiss);}};
        document.addEventListener('click',dismiss);
    },10);
}

// ─── Hook renderGroupUI to start/stop listener & update controls ──────────
const _origRenderGroupUI_mb = renderGroupUI;
renderGroupUI = function() {
    _origRenderGroupUI_mb();
    if (currentGroup && currentUser && !currentUser.isAnonymous) {
        // Start background listener for unread count if not already running
        if (!_mbListener) {
            _mbLastSeen = _mbUnreadLS();
            _mbStartListener();
        }
        _mbStartNotifListener();
        _mbSyncBadges();
    } else {
        _mbStopListener();
        _mbStopNotifListener();
        _mbUnreadCount = 0;
        _mbOpen = false;
        const panel = document.getElementById('mb-panel');
        if (panel) panel.remove();
        const ov = document.getElementById('mb-overlay');
        if (ov) ov.remove();
        const mc = document.getElementById('mb-member-controls');
        if (mc) mc.remove();
    }
};

window.openMsgBoard  = openMsgBoard;
window.closeMsgBoard = closeMsgBoard;

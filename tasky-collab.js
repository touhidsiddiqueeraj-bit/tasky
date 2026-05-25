// ═══════════════════════════════════════════════════════════════════════════
//  TASKY — COLLABORATIVE LAYER  (append after tasky.js, or replace it)
//  Adds: groups, supervisor role, task assignment, team panel, member summary
// ═══════════════════════════════════════════════════════════════════════════

// ─── Collab State ─────────────────────────────────────────────────────────
let currentGroup      = null;   // { code, name, supervisorUid, supervisorHandle, members[] }
let currentHandle     = null;   // short username like "jon"
let isSupervisor      = false;
let groupListener     = null;   // Firestore onSnapshot unsubscribe
let tasksListener     = null;   // Firestore onSnapshot for tasks subcollection (supervisor)
let teamPanelMember   = null;   // handle being inspected in team panel

// ─── Handle / Identity ────────────────────────────────────────────────────
async function ensureHandle() {
    if (!currentUser) return null;
    if (currentHandle) return currentHandle;

    // Check localStorage first (written on saveHandle)
    const localHandle = localStorage.getItem('tasky_handle');
    if (localHandle) { currentHandle = localHandle; return currentHandle; }

    // Fall back to Firestore SDK
    try {
        const snap = await db.collection('users').doc(currentUser.uid).get();
        if (snap.exists && snap.data().handle) {
            currentHandle = snap.data().handle;
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
    localStorage.setItem('tasky_handle', handle);
}

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
        members: [{ uid: currentUser.uid, handle: currentHandle, email: currentUser.email }],
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    await db.collection('groups').doc(code).set(groupData);
    await db.collection('users').doc(currentUser.uid).set({ activeGroup: code }, { merge: true });
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
        await ref.update({
            members: firebase.firestore.FieldValue.arrayUnion({
                uid: currentUser.uid,
                handle: currentHandle,
                email: currentUser.email
            })
        });
    }
    await db.collection('users').doc(currentUser.uid).set({ activeGroup: code.toUpperCase() }, { merge: true });
    saveGroupCodeLocally(code.toUpperCase());
    return { ok: true };
}

// ─── Leave Group ──────────────────────────────────────────────────────────
async function leaveGroup() {
    if (!currentUser || !currentGroup) return;
    // Remove self from members (unless supervisor — supervisor must transfer first)
    if (isSupervisor && currentGroup.members.length > 1) {
        showTaskyToast('Transfer supervisor role before leaving.');
        return;
    }
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
    await db.collection('users').doc(currentUser.uid).update({ activeGroup: firebase.firestore.FieldValue.delete() });
    saveGroupCodeLocally(null);
    stopGroupListener();
    currentGroup = null;
    isSupervisor = false;
    teamPanelMember = null;
    renderGroupUI();
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
}

async function loadActiveGroup() {
    if (!currentUser) return;

    // 1. Start immediately from localStorage (instant, zero network dependency)
    const localCode = localStorage.getItem(LS_GROUP_KEY);
    if (localCode) {
        startGroupListener(localCode);
    }

    // 2. Verify from Firestore in background — corrects if user left on another device
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
            isSupervisor = false;
            stopTasksListener();
            renderGroupUI();
            return;
        }

        currentGroup = { ...snap.data(), code };
        isSupervisor = currentGroup.supervisorUid === currentUser.uid;
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
            showTaskyToast(`⚠️ No member "@${parsed.assignedTo}" in this collaboration`);
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
        groupCode: currentGroup.code
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

        showTaskyToast(`✅ Assigned "${task.text}" → @${task.assignedTo}`);
        pushAssignmentNotification(task);
        // Refresh team panel so supervisor sees updated counts immediately
        renderTeamPanel();
    } catch(e) {
        showTaskyToast(`⚠️ Failed to assign task: ${e.message}`);
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
                    showTaskyToast(`📋 New task from @${n.fromHandle}: "${n.taskText}"`);
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
    if (!currentGroup || !currentUser || isSupervisor) return;
    if (_groupSyncTimer) clearTimeout(_groupSyncTimer);
    _groupSyncTimer = setTimeout(writeGroupTasks, 800);
}

async function writeGroupTasks() {
    if (!currentGroup || !currentUser || isSupervisor) return;
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

    // Remove old 4th column if present
    const existing4th = document.getElementById('collab-team-column');
    if (existing4th) existing4th.remove();

    // Update board class
    board.classList.toggle('board-4col', !!(currentGroup && isSupervisor));

    // Update collab badge in header
    renderCollabBadge();

    if (currentGroup && isSupervisor) {
        // Inject 4th column — Team
        const teamCol = buildTeamColumn();
        board.appendChild(teamCol);
        renderTeamPanel();
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
        document.querySelector('.top-menu').appendChild(badge);
    }
    if (currentGroup) {
        badge.style.display = 'flex';
        badge.innerHTML = `
            <span class="collab-badge-dot ${isSupervisor ? 'supervisor' : 'member'}"></span>
            <span>${currentGroup.name}</span>
            <span class="collab-badge-code">${currentGroup.code}</span>
            ${isSupervisor ? '<span class="collab-badge-role">Supervisor</span>' : ''}
        `;
    } else {
        badge.style.display = 'none';
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
            <div class="column-header">
                <div class="column-header-left">
                    <h2 class="column-title">👥 Team</h2>
                </div>
                <div style="display:flex;align-items:center;gap:8px;">
                    <button class="assign-quick-btn" id="assign-quick-btn" title="Assign a task to a member">+ Assign</button>
                    <span class="task-count" id="team-member-count">0</span>
                </div>
            </div>
            <div class="task-list" id="team-list" style="overflow-y:auto;"></div>
        </div>
    `;
    wrapper.querySelector('#assign-quick-btn').addEventListener('click', () => openAssignModal(null));
    return wrapper;
}

async function renderTeamPanel() {
    const list = document.getElementById('team-list');
    const countEl = document.getElementById('team-member-count');
    if (!list || !currentGroup) return;

    await fetchAllMemberTasks();

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

    ['todo', 'working', 'done'].forEach(col => {
        const colTasks = (data.tasks[col] || []);
        if (colTasks.length === 0) return;
        const colHeader = document.createElement('div');
        colHeader.className = 'member-detail-col-label';
        colHeader.textContent = col === 'todo' ? '📝 To Do' : col === 'working' ? '⚡ Working On' : '✅ Done';
        list.appendChild(colHeader);

        colTasks.forEach(t => {
            const item = document.createElement('div');
            item.className = `member-task-item priority-${t.priority}`;
            const isOverdue = t.dueDate && new Date(t.dueDate) < new Date() && col !== 'done';
            item.innerHTML = `
                <span class="member-task-priority">${t.priority === 'high' ? '🔴' : t.priority === 'medium' ? '🟡' : '🟢'}</span>
                <div class="member-task-body">
                    <span class="member-task-text">${escHtml(t.text)}</span>
                    ${t.dueDate ? `<span class="member-task-date ${isOverdue ? 'overdue' : ''}">📅 ${new Date(t.dueDate).toLocaleDateString('en-US',{month:'short',day:'numeric'})}</span>` : ''}
                    ${t.assignedBy ? `<span class="member-task-assigned">from @${t.assignedBy}</span>` : ''}
                </div>
            `;
            list.appendChild(item);
        });
    });

    if ((data.tasks.todo||[]).length + (data.tasks.working||[]).length + (data.tasks.done||[]).length === 0) {
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
        document.querySelector('.container').after(bar);
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
    // Remove old collab items
    document.querySelectorAll('.collab-dd-item').forEach(el => el.remove());

    const dropdown = document.getElementById('dropdown');
    if (!dropdown) return;

    const divider = document.createElement('div');
    divider.className = 'dropdown-divider collab-dd-item';
    dropdown.insertBefore(divider, dropdown.firstChild);

    if (!currentGroup) {
        // Show Create Group + Join Group
        const createBtn = makeDropdownItem('👥', 'Create Collaboration', () => openCollabModal('create'));
        const joinBtn   = makeDropdownItem('🔗', 'Join Collaboration',   () => openCollabModal('join'));
        createBtn.classList.add('collab-dd-item');
        joinBtn.classList.add('collab-dd-item');
        dropdown.insertBefore(joinBtn,   dropdown.firstChild);
        dropdown.insertBefore(createBtn, dropdown.firstChild);
    } else {
        // Show group info + Leave
        const infoBtn  = makeDropdownItem('👥', `${currentGroup.name} (${currentGroup.code})`, () => openCollabModal('info'));
        const leaveBtn = makeDropdownItem('🚪', 'Leave Collaboration', () => leaveGroup());
        infoBtn.style.color = '#a78bfa';
        leaveBtn.style.color = '#ef4444';
        infoBtn.classList.add('collab-dd-item');
        leaveBtn.classList.add('collab-dd-item');
        dropdown.insertBefore(leaveBtn, dropdown.firstChild);
        dropdown.insertBefore(infoBtn,  dropdown.firstChild);
    }
}

function makeDropdownItem(icon, text, onClick) {
    const btn = document.createElement('button');
    btn.className = 'dropdown-item';
    btn.innerHTML = `<span>${icon}</span><span>${text}</span>`;
    btn.addEventListener('click', () => {
        document.getElementById('dropdown').classList.remove('show');
        onClick();
    });
    return btn;
}

// ─── Collab Modal ─────────────────────────────────────────────────────────
function openCollabModal(mode) {
    if (!currentUser || currentUser.isAnonymous) {
        showTaskyToast('Sign in with Google first to use Collaborations.');
        return;
    }
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
                <p class="collab-pane-desc">Choose a short username so teammates can assign tasks to you. You can't change this later.</p>
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
            <div id="collab-pane-info" class="collab-pane" style="display:none;padding:28px;">
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
    showTaskyToast(msg);
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

    // If no handle yet, go to handle pane first
    const handle = await ensureHandle();
    if (!handle && mode !== 'info') {
        document.getElementById('collab-pane-handle').style.display = 'block';
        if (title) title.textContent = '👤 Set Username';
        document.getElementById('collab-handle-input').focus();
        // Store intended mode
        document.getElementById('collab-pane-handle').dataset.nextMode = mode;
        return;
    }

    if (mode === 'create') {
        document.getElementById('collab-pane-create').style.display = 'block';
        if (title) title.textContent = '👥 Create Collaboration';
        document.getElementById('collab-group-name-input').focus();
    } else if (mode === 'join') {
        document.getElementById('collab-pane-join').style.display = 'block';
        if (title) title.textContent = '🔗 Join Collaboration';
        document.getElementById('collab-join-code-input').focus();
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
        <div style="margin-bottom:20px;">
            <div class="tg-field-label">Your Code</div>
            <div style="font-size:28px;font-weight:800;letter-spacing:.3em;color:#a78bfa;margin-top:4px;">${currentGroup.code}</div>
            <button class="tg-icon-btn" onclick="copyGroupCode()" style="margin-top:8px;">📋 Copy Code</button>
        </div>
        <div>
            <div class="tg-field-label">Members (${currentGroup.members.length})</div>
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
        ${isSupervisor ? `
        <div style="margin-top:20px;">
            <div class="tg-field-label">Supervisor Tip</div>
            <div style="font-size:13px;color:rgba(255,255,255,0.45);line-height:1.6;margin-top:6px;background:rgba(139,92,246,0.08);border:1px solid rgba(139,92,246,0.2);border-radius:10px;padding:12px;">
                Assign tasks with: <code style="color:#c4b5fd;">fix auth to::jon priority::high date::20may</code><br>
                Supports: <code style="color:#c4b5fd;">to::</code> <code style="color:#c4b5fd;">priority::</code> <code style="color:#c4b5fd;">date::</code>
            </div>
        </div>` : ''}
    `;
}

function copyGroupCode() {
    const code = currentGroup ? currentGroup.code :
        document.getElementById('collab-share-code')?.textContent;
    if (!code) return;
    navigator.clipboard.writeText(code).then(() => showTaskyToast('📋 Code copied!')).catch(() => {});
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

    // Check uniqueness
    const existing = await db.collection('users').where('handle', '==', handle).get();
    if (!existing.empty) {
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
function setupCollabAuth() {
    firebase.auth(app).onAuthStateChanged(async user => {
        if (user && !user.isAnonymous) {
            // Fully signed-in user
            await ensureHandle();
            await loadActiveGroup();   // reads activeGroup from Firestore server, starts listener
            startNotifListener();

            // currentGroup is now set (or null if not in a collaboration).
            // Immediately write member's current tasks to the group subcollection
            // so the supervisor sees fresh data — bypasses any caching.
            await writeGroupTasks();

            // Pull in tasks assigned to us while we were offline
            await syncGroupTasksToBoard();
        } else if (user && user.isAnonymous) {
            // Anonymous user — collab requires Google sign-in, so teardown collab state
            stopGroupListener();
            stopNotifListener();
            stopTasksListener();
            saveGroupCodeLocally(null);
            currentGroup    = null;
            isSupervisor    = false;
            currentHandle   = null;
            localStorage.removeItem('tasky_handle');
            teamPanelMember = null;
            teamTasksCache  = {};
            if (_groupSyncTimer) { clearTimeout(_groupSyncTimer); _groupSyncTimer = null; }
            renderGroupUI();
        } else {
            // No user at all (transient state before anon auth)
            stopGroupListener();
            stopNotifListener();
            stopTasksListener();
            saveGroupCodeLocally(null);
            currentGroup    = null;
            isSupervisor    = false;
            currentHandle   = null;
            localStorage.removeItem('tasky_handle');
            teamPanelMember = null;
            teamTasksCache  = {};
            if (_groupSyncTimer) { clearTimeout(_groupSyncTimer); _groupSyncTimer = null; }
            renderGroupUI();
        }
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
window.addEventListener('load', setupCollabAuth);

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

// ─── Firestore ref helper ────────────────────────────────────────────────
function commentsDocRef(taskId) {
    if (!currentGroup || !db) return null;
    return db.collection('groups').doc(currentGroup.code)
             .collection('comments').doc(String(taskId));
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

    const ref = commentsDocRef(taskId);
    if (ref) {
        try {
            await ref.set({
                taskId: String(taskId),
                entries: firebase.firestore.FieldValue.arrayUnion(entry)
            }, { merge: true });
        } catch(_) {}
    } else {
        // Solo fallback
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

    const ref = commentsDocRef(taskId);
    if (ref) {
        await ref.set({
            taskId: String(taskId),
            taskText: taskText || '',
            entries: firebase.firestore.FieldValue.arrayUnion(entry)
        }, { merge: true });

        // Ping the supervisor if the commenter is a member (not supervisor)
        if (!isSupervisor && currentGroup) {
            _pingCommentNotification(taskId, taskText, text.trim());
        }
    } else {
        if (!_soloActivity[taskId]) _soloActivity[taskId] = [];
        _soloActivity[taskId].push(entry);
        // Re-render feed if panel is open
        _refreshOpenCommentPanel(taskId);
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
    const ref = commentsDocRef(taskId);
    if (!ref) {
        // Solo fallback
        if (_soloActivity[taskId]) {
            _soloActivity[taskId] = _soloActivity[taskId].filter(e => e.id !== commentId);
        }
        _refreshOpenCommentPanel(taskId);
        return;
    }
    try {
        const snap = await ref.get();
        if (!snap.exists) return;
        const entries = (snap.data().entries || []).filter(e => e.id !== commentId);
        await ref.update({ entries });
        _refreshOpenCommentPanel(taskId);
    } catch(_) {}
}

// ─── Load entries for a task ─────────────────────────────────────────────
async function loadCommentEntries(taskId) {
    const ref = commentsDocRef(taskId);
    if (ref) {
        try {
            const snap = await ref.get();
            if (snap.exists) return snap.data().entries || [];
        } catch(_) {}
        return [];
    }
    return _soloActivity[taskId] || [];
}

// ─── Live listener for the open comments panel ───────────────────────────
let _commentsUnsubscribe = null;
let _commentsOpenTaskId  = null;

function _stopCommentsListener() {
    if (_commentsUnsubscribe) { _commentsUnsubscribe(); _commentsUnsubscribe = null; }
    _commentsOpenTaskId = null;
}

function _startCommentsListener(taskId) {
    _stopCommentsListener();
    _commentsOpenTaskId = taskId;
    const ref = commentsDocRef(taskId);
    if (!ref) return;
    _commentsUnsubscribe = ref.onSnapshot(snap => {
        if (!snap.exists) return;
        _renderCommentFeed(taskId, snap.data().entries || []);
    });
}

function _refreshOpenCommentPanel(taskId) {
    if (_commentsOpenTaskId !== taskId) return;
    if (_soloActivity[taskId]) _renderCommentFeed(taskId, _soloActivity[taskId]);
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
async function openComments(taskId, taskText, column) {
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
            showTaskyToast('⚠️ Failed to save comment');
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

    // Load initial entries then start live listener
    const entries = await loadCommentEntries(taskId);
    _renderCommentFeed(taskId, entries);
    _startCommentsListener(taskId);   // no-op for solo
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

// ─── Wire comment button into task cards (monkey-patch createTaskCard) ────
// This runs AFTER tasky-collab.js's own createTaskCard monkey-patch so all
// patches stack correctly.
const _commentPatchOrigCreateTaskCard = createTaskCard;
createTaskCard = function(task, column) {
    const card = _commentPatchOrigCreateTaskCard(task, column);

    // Count cloud comments from cache if available; just show a 💬 icon
    const commentBtn = document.createElement('button');
    commentBtn.className = 'comment-btn';
    commentBtn.title = 'Comments & Activity';
    commentBtn.innerHTML = '💬';
    commentBtn.addEventListener('click', e => {
        e.stopPropagation();
        openComments(task.id, task.text, column);
    });

    // Badge: update count from Firestore once if in collab
    if (currentGroup) {
        const ref = commentsDocRef(task.id);
        if (ref) {
            ref.get().then(snap => {
                if (snap.exists) {
                    const count = (snap.data().entries || []).filter(e => e.type === 'comment').length;
                    if (count > 0) {
                        commentBtn.innerHTML = `💬<span class="comment-count">${count}</span>`;
                    }
                }
            }).catch(() => {});
        }
    }

    const hoverControls = card.querySelector('.task-hover-controls');
    if (hoverControls) {
        // Insert before delete button
        const delBtn = hoverControls.querySelector('.delete-btn');
        hoverControls.insertBefore(commentBtn, delBtn || null);
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
};

// Extend the notification snapshot to also fire browser push
// We do this by wrapping the global notifListener startup.
// Instead of patching the Firestore snapshot (too deep), we intercept
// showTaskyToast — when a collab assignment comes in, we also fire push.
const _origShowTaskyToast = showTaskyToast;
window.showTaskyToast = function(msg) {
    _origShowTaskyToast(msg);
    // If it looks like a new task assignment notification, fire push
    if (msg.startsWith('📋 New task from @') && 'Notification' in window && Notification.permission === 'granted') {
        try {
            new Notification('Tasky — New Task Assigned', {
                body: msg.replace('📋 ', ''),
                icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="%238B5CF6"/><text x="16" y="22" text-anchor="middle" font-size="18" fill="white">✅</text></svg>',
                requireInteraction: true
            });
        } catch(_) {}
    }
    // Comment ping for supervisor
    if (msg.includes('commented on') && 'Notification' in window && Notification.permission === 'granted') {
        try {
            new Notification('Tasky — New Comment', {
                body: msg,
                icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="%238B5CF6"/><text x="16" y="22" text-anchor="middle" font-size="18" fill="white">💬</text></svg>',
            });
        } catch(_) {}
    }
};

// Extend startNotifListener's Firestore snapshot to also handle comment pings
// and fire a browser notification. We replace the core logic by patching
// stopNotifListener and re-opening with our extended version.
const _origStopNotifListener = stopNotifListener;

function _startExtendedNotifListener() {
    if (!currentUser) return;
    _origStopNotifListener();

    window.notifListener = db.collection('notifications')
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
                    showTaskyToast(msg);
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
                    showTaskyToast(msg);
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
                showTaskyToast('🔔 Due-date reminders enabled');
                checkDueDateNotifications();
            }
        });
    }
};

// Enable manually from dropdown
window.enableDueDateNotifications = async function() {
    const ok = await requestNotifPermission();
    if (ok) {
        showTaskyToast('🔔 Notifications enabled! Reminders for due tasks and new assignments.');
        checkDueDateNotifications();
    } else {
        showTaskyToast('⚠️ Permission denied — check your browser notification settings.');
    }
};

if ('Notification' in window && Notification.permission === 'granted') {
    checkDueDateNotifications();
}
setInterval(checkDueDateNotifications, 60_000);

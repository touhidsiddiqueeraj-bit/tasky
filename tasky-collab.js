// ═══════════════════════════════════════════════════════════════════════════
//  TASKY — COLLABORATIVE LAYER  (append after tasky.js, or replace it)
//  Adds: groups, supervisor role, task assignment, team panel, member summary
// ═══════════════════════════════════════════════════════════════════════════

// ─── Collab State ─────────────────────────────────────────────────────────
let currentGroup      = null;   // { code, name, supervisorUid, supervisorHandle, members[] }
let currentHandle     = null;   // short username like "jon"
let isSupervisor      = false;
let groupListener     = null;   // Firestore onSnapshot unsubscribe
let teamPanelMember   = null;   // handle being inspected in team panel

// ─── Handle / Identity ────────────────────────────────────────────────────
async function ensureHandle() {
    if (!currentUser) return null;
    if (currentHandle) return currentHandle;

    // Try to load from Firestore first
    const ref = db.collection('users').doc(currentUser.uid);
    const snap = await ref.get();
    if (snap.exists && snap.data().handle) {
        currentHandle = snap.data().handle;
        return currentHandle;
    }
    return null;
}

async function saveHandle(handle) {
    if (!currentUser) return;
    await db.collection('users').doc(currentUser.uid).set({ handle, email: currentUser.email }, { merge: true });
    currentHandle = handle;
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
    stopGroupListener();
    currentGroup = null;
    isSupervisor = false;
    teamPanelMember = null;
    renderGroupUI();
}

// ─── Load & Listen to Group ───────────────────────────────────────────────
async function loadActiveGroup() {
    if (!currentUser) return;
    const userSnap = await db.collection('users').doc(currentUser.uid).get();
    const code = userSnap.exists ? userSnap.data().activeGroup : null;
    if (!code) { currentGroup = null; renderGroupUI(); return; }

    startGroupListener(code);
}

function startGroupListener(code) {
    stopGroupListener();
    groupListener = db.collection('groups').doc(code).onSnapshot(snap => {
        if (!snap.exists) { currentGroup = null; isSupervisor = false; renderGroupUI(); return; }
        currentGroup = { ...snap.data(), code };
        isSupervisor = currentGroup.supervisorUid === currentUser.uid;
        renderGroupUI();
        // Real-time: reload tasks for supervisor team view
        if (isSupervisor) renderTeamPanel();
    });
}

function stopGroupListener() {
    if (groupListener) { groupListener(); groupListener = null; }
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
function addTaskToTodo(text) {
    // Only parse assignment syntax if in a group and is supervisor
    if (currentGroup && isSupervisor && text.includes('to::')) {
        const parsed = parseAssignedTask(text);
        // Validate assignee is in group
        const member = currentGroup.members.find(m => m.handle === parsed.assignedTo);
        if (!member) {
            showTaskyToast(`⚠️ No member "@${parsed.assignedTo}" in group`);
            return;
        }
        addCollabTask(parsed);
        return;
    }
    _origAddTaskToTodo(text);
}

function addCollabTask(parsed) {
    const nextNum = getNextNumber();
    taskCounter = Math.max(taskCounter, nextNum);
    const task = {
        id: Date.now() * 1000 + nextNum,
        number: nextNum,
        text: parsed.text,
        priority: parsed.priority || 'medium',
        dueDate: parsed.dueDate || null,
        createdAt: new Date().toISOString(),
        assignedTo: parsed.assignedTo || null,
        assignedBy: currentHandle || null,
        groupCode: currentGroup ? currentGroup.code : null
    };
    tasks.todo.push(task);
    saveAll();
    renderColumn('todo');
    showTaskyToast(`✅ Assigned "${task.text}" → @${task.assignedTo}`);
    // Push notification doc to Firestore for the assignee
    pushAssignmentNotification(task);
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
                    // Also reload tasks from cloud
                    syncFromCloud(true);
                }
            });
        });
}

function stopNotifListener() {
    if (notifListener) { notifListener(); notifListener = null; }
}

// ─── Collab saveAll: writes tasks to group doc too if in a group ──────────
const _origPushToCloud = pushToCloud;
function pushToCloud() {
    _origPushToCloud();
    if (currentGroup && currentUser) {
        pushGroupTasks();
    }
}

let groupPushTimeout = null;
function pushGroupTasks() {
    if (groupPushTimeout) clearTimeout(groupPushTimeout);
    groupPushTimeout = setTimeout(async () => {
        if (!currentGroup || !currentUser) return;
        try {
            await db.collection('groups').doc(currentGroup.code)
                .collection('tasks').doc(currentUser.uid).set({
                    tasks: JSON.parse(JSON.stringify(tasks)),
                    handle: currentHandle,
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                });
        } catch(_) {}
    }, 600);
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
                <span class="task-count" id="team-member-count">0</span>
            </div>
            <div class="task-list" id="team-list" style="overflow-y:auto;"></div>
        </div>
    `;
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
            <button class="member-inspect-btn" title="Inspect member">→</button>
        `;
        card.querySelector('.member-inspect-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            teamPanelMember = m.handle;
            renderTeamPanel();
        });
        list.appendChild(card);
    });
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
                    <span class="member-task-text">${escapeHtml(t.text)}</span>
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
        const createBtn = makeDropdownItem('👥', 'Create Group', () => openCollabModal('create'));
        const joinBtn   = makeDropdownItem('🔗', 'Join Group',   () => openCollabModal('join'));
        createBtn.classList.add('collab-dd-item');
        joinBtn.classList.add('collab-dd-item');
        dropdown.insertBefore(joinBtn,   dropdown.firstChild);
        dropdown.insertBefore(createBtn, dropdown.firstChild);
    } else {
        // Show group info + Leave
        const infoBtn  = makeDropdownItem('👥', `${currentGroup.name} (${currentGroup.code})`, () => openCollabModal('info'));
        const leaveBtn = makeDropdownItem('🚪', 'Leave Group', () => leaveGroup());
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
    if (!currentUser) {
        showTaskyToast('Sign in with Google first to use groups.');
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
            <div class="tg-header-title" id="collab-modal-title">👥 Groups</div>
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
                <p class="collab-pane-desc">Start a new group. You'll be the supervisor and get a shareable 6-character code.</p>
                <div class="tg-field-label" style="margin-top:16px;">Group Name</div>
                <input class="tg-input" id="collab-group-name-input" type="text" placeholder='e.g. "Dev Team", "Sprint 12"' maxlength="40">
                <div id="collab-create-error" style="color:#f87171;font-size:12px;margin-top:6px;display:none;"></div>
                <div style="display:flex;gap:10px;margin-top:16px;">
                    <button class="tg-save-btn" id="collab-create-btn">Create Group</button>
                </div>
            </div>
            <!-- Join pane -->
            <div id="collab-pane-join" class="collab-pane" style="display:none;padding:28px;">
                <p class="collab-pane-desc">Enter the 6-character group code from your supervisor.</p>
                <div class="tg-field-label" style="margin-top:16px;">Group Code</div>
                <input class="tg-input" id="collab-join-code-input" type="text" placeholder="e.g. AB3X7K" maxlength="6"
                    style="text-transform:uppercase;letter-spacing:.2em;font-size:20px;font-weight:700;">
                <div id="collab-join-error" style="color:#f87171;font-size:12px;margin-top:6px;display:none;"></div>
                <div style="display:flex;gap:10px;margin-top:16px;">
                    <button class="tg-save-btn" id="collab-join-btn">Join Group</button>
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
        if (title) title.textContent = '👥 Create Group';
        document.getElementById('collab-group-name-input').focus();
    } else if (mode === 'join') {
        document.getElementById('collab-pane-join').style.display = 'block';
        if (title) title.textContent = '🔗 Join Group';
        document.getElementById('collab-join-code-input').focus();
    } else if (mode === 'info') {
        document.getElementById('collab-pane-info').style.display = 'block';
        if (title) title.textContent = '👥 Group Info';
        renderGroupInfoPane();
    }
}

function renderGroupInfoPane() {
    const el = document.getElementById('collab-info-content');
    if (!el || !currentGroup) return;
    el.innerHTML = `
        <div style="margin-bottom:16px;">
            <div class="tg-field-label">Group Name</div>
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
    if (!name) { errEl.textContent = 'Enter a group name.'; errEl.style.display = 'block'; return; }

    const btn = document.getElementById('collab-create-btn');
    btn.textContent = 'Creating…'; btn.disabled = true;

    try {
        const code = await createGroup(name);
        startGroupListener(code);
        startNotifListener();

        document.querySelectorAll('.collab-pane').forEach(p => p.style.display = 'none');
        document.getElementById('collab-pane-success').style.display = 'block';
        document.getElementById('collab-modal-title').textContent = '✅ Group Created';
        document.getElementById('collab-success-title').textContent = `"${name}" is ready`;
        document.getElementById('collab-success-body').textContent = 'Share the code below with teammates so they can join.';
        document.getElementById('collab-code-display').style.display = 'block';
        document.getElementById('collab-share-code').textContent = code;
    } catch(e) {
        errEl.textContent = 'Failed to create group. Try again.';
        errEl.style.display = 'block';
    }
    btn.textContent = 'Create Group'; btn.disabled = false;
}

async function handleJoinGroup() {
    const input = document.getElementById('collab-join-code-input');
    const errEl = document.getElementById('collab-join-error');
    const code  = input.value.trim().toUpperCase();

    errEl.style.display = 'none';
    if (code.length < 4) { errEl.textContent = 'Enter a valid group code.'; errEl.style.display = 'block'; return; }

    const btn = document.getElementById('collab-join-btn');
    btn.textContent = 'Joining…'; btn.disabled = true;

    const result = await joinGroup(code);
    if (!result.ok) {
        errEl.textContent = result.err;
        errEl.style.display = 'block';
        btn.textContent = 'Join Group'; btn.disabled = false;
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

    btn.textContent = 'Join Group'; btn.disabled = false;
}

// ─── Task card: show assignment badge ────────────────────────────────────
// Monkey-patch createTaskCard to show assignedTo/assignedBy info
const _origCreateTaskCard = createTaskCard;
function createTaskCard(task, column) {
    const card = _origCreateTaskCard(task, column);
    if (task.assignedTo || task.assignedBy) {
        const badge = document.createElement('div');
        badge.className = 'task-assign-badge';
        if (task.assignedTo) {
            badge.innerHTML += `<span class="assign-to">→ @${escapeHtml(task.assignedTo)}</span>`;
        }
        if (task.assignedBy && task.assignedBy !== currentHandle) {
            badge.innerHTML += `<span class="assign-from">from @${escapeHtml(task.assignedBy)}</span>`;
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
// We need to augment setupFirebase's onAuthStateChanged callback
// Rather than override, we add a second listener after the app boots
function setupCollabAuth() {
    firebase.auth(app).onAuthStateChanged(async user => {
        if (user) {
            await ensureHandle();
            await loadActiveGroup();
            startNotifListener();
        } else {
            stopGroupListener();
            stopNotifListener();
            currentGroup  = null;
            isSupervisor  = false;
            currentHandle = null;
            teamPanelMember = null;
            teamTasksCache  = {};
            renderGroupUI();
        }
    });
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

// Patch openFloatingInput to also show assignment hint
const _origOpenFloatingInput = openFloatingInput;
function openFloatingInput() {
    _origOpenFloatingInput();
    updateAssignHintVisibility();
}

// Also update placeholder
function updateInputPlaceholder() {
    const input = document.getElementById('floating-input');
    if (!input) return;
    if (currentGroup && isSupervisor) {
        input.placeholder = 'Add task — or: fix auth to::jon priority::high date::20may';
    } else {
        input.placeholder = 'Type to add task or group name…';
    }
}

// Hook into renderGroupUI to update placeholder — we tag it with a post-hook
// rather than redeclaring (avoids strict-mode duplicate function errors)
const _afterRenderGroupUI = renderGroupUI;
window.renderGroupUI = function() {
    _afterRenderGroupUI.call(this, ...arguments);
    updateInputPlaceholder();
    updateAssignHintVisibility();
};

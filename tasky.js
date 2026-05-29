// ─── State ────────────────────────────────────────────────────────────────
        let workspaces = [];
        let activeWorkspaceId = 1;
        let nextWorkspaceId = 2;
        let tasks = { todo: [], working: [], done: [] };
        let taskCounter = 0;

        // ─── Workspace init & migration ────────────────────────────────────────────
        (function initWorkspaces() {
            var meta = localStorage.getItem('workspaces_meta');
            if (meta) {
                workspaces = JSON.parse(meta);
                activeWorkspaceId = parseInt(localStorage.getItem('ws_active')) || (workspaces[0] ? workspaces[0].id : 1);
                nextWorkspaceId = workspaces.reduce(function(max, w) { return Math.max(max, w.id); }, 0) + 1;
            } else {
                var oldTasks = JSON.parse(localStorage.getItem('tasks'));
                var oldCounter = parseInt(localStorage.getItem('taskCounter')) || 0;
                var oldCode = localStorage.getItem('tasky_groupCode') || null;
                tasks = oldTasks || { todo: [], working: [], done: [] };
                taskCounter = oldCounter;
                workspaces = [{ id: 1, name: 'Personal', collabCode: oldCode }];
                activeWorkspaceId = 1;
                nextWorkspaceId = 2;
                localStorage.setItem('ws_tasks_1', JSON.stringify(tasks));
                localStorage.setItem('ws_counter_1', String(taskCounter));
                localStorage.setItem('workspaces_meta', JSON.stringify(workspaces));
                // Clean up old keys
                var oldKeys = ['tasks', 'taskCounter', 'tasks_local', 'taskCounter_local', 'tasky_groupCode'];
                oldKeys.forEach(function(k) { localStorage.removeItem(k); });
            }
            var ws = workspaces.find(function(w) { return w.id === activeWorkspaceId; });
            if (ws) {
                var saved = localStorage.getItem('ws_tasks_' + ws.id);
                if (saved) tasks = JSON.parse(saved);
                var cnt = localStorage.getItem('ws_counter_' + ws.id);
                if (cnt) taskCounter = parseInt(cnt);
            }
        })();

        // ─── Workspace helpers ─────────────────────────────────────────────────────
        function saveWorkspacesMeta() {
            var meta = workspaces.map(function(w) { return { id: w.id, name: w.name, collabCode: w.collabCode }; });
            localStorage.setItem('workspaces_meta', JSON.stringify(meta));
        }
        function saveCurrentWorkspaceData() {
            localStorage.setItem('ws_tasks_' + activeWorkspaceId, JSON.stringify(tasks));
            localStorage.setItem('ws_counter_' + activeWorkspaceId, String(taskCounter));
        }
        function loadWorkspaceData(id) {
            var saved = localStorage.getItem('ws_tasks_' + id);
            tasks = saved ? JSON.parse(saved) : { todo: [], working: [], done: [] };
            var cnt = localStorage.getItem('ws_counter_' + id);
            taskCounter = cnt ? parseInt(cnt) : 0;
        }
        function createWorkspace(name, collabCode) {
            var id = nextWorkspaceId++;
            var ws = { id: id, name: name || 'Workspace ' + id, collabCode: collabCode || null };
            workspaces.push(ws);
            localStorage.setItem('ws_tasks_' + id, JSON.stringify({ todo: [], working: [], done: [] }));
            localStorage.setItem('ws_counter_' + id, '0');
            saveWorkspacesMeta();
            return id;
        }
        function deleteWorkspace(id) {
            if (id === 1) return;
            var idx = workspaces.findIndex(function(w) { return w.id === id; });
            if (idx === -1) return;
            workspaces.splice(idx, 1);
            localStorage.removeItem('ws_tasks_' + id);
            localStorage.removeItem('ws_counter_' + id);
            saveWorkspacesMeta();
        }
        function switchWorkspace(id) {
            if (id === activeWorkspaceId) return;
            saveCurrentWorkspaceData();
            var prevId = activeWorkspaceId;
            activeWorkspaceId = id;
            var board = document.querySelector('.board');
            if (board) board.classList.add('board-switching');
            setTimeout(function() {
                loadWorkspaceData(id);
                localStorage.setItem('ws_active', String(id));
                renderAllColumns();
                updateDailySummary();
                deselectTask();
                exitTaskSelector();
                renderWorkspaceSwitcher();
                if (board) board.classList.remove('board-switching');
                // Notify collab layer
                if (typeof window.__onWorkspaceSwitch === 'function') {
                    window.__onWorkspaceSwitch(id, prevId);
                }
            }, 170);
        }
        function getWorkspaceByCollab(code) {
            return workspaces.find(function(w) { return w.collabCode === code; }) || null;
        }
        function linkWorkspaceToCollab(id, code, collabName) {
            var ws = workspaces.find(function(w) { return w.id === id; });
            if (!ws) return;
            ws.collabCode = code;
            if (collabName) ws.name = collabName;
            saveWorkspacesMeta();
        }
        function createWorkspaceClick() {
            var id = createWorkspace();
            switchWorkspace(id);
            showToast('New workspace created', function() {});
        }
        async function deleteWorkspaceConfirm(id) {
            if (id === 1) return;
            var t = localStorage.getItem('ws_tasks_' + id);
            var hasTasks = t && JSON.parse(t) && Object.values(JSON.parse(t)).some(function(arr) { return arr.length > 0; });
            if (hasTasks) {
                if (!await showConfirm('Delete Workspace', 'This workspace has tasks. Delete it and all its data? This cannot be undone.', 'Delete')) return;
            }
            var isActive = id === activeWorkspaceId;
            deleteWorkspace(id);
            if (isActive) switchWorkspace(1);
            renderWorkspaceSwitcher();
            showToast('Workspace deleted', function() {});
        }

        // ─── Expose globals for HTML onclick handlers ──────────────────────────────
        window.switchWorkspace = switchWorkspace;
        window.createWorkspaceClick = createWorkspaceClick;
        window.deleteWorkspaceConfirm = deleteWorkspaceConfirm;
        window.createWorkspace = createWorkspace;
        window.getWorkspaceByCollab = getWorkspaceByCollab;
        window.linkWorkspaceToCollab = linkWorkspaceToCollab;
        window.renderWorkspaceSwitcher = renderWorkspaceSwitcher;

        // Returns the lowest positive integer not already used as a task number.
        // This lets deleted numbers be reused instead of incrementing forever.
        function getNextNumber() {
            const used = new Set();
            ['todo', 'working', 'done'].forEach(col =>
                (tasks[col] || []).forEach(t => used.add(t.number)));
            let n = 1;
            while (used.has(n)) n++;
            return n;
        }
        let isLightMode = localStorage.getItem('theme') === 'light';
        let customBg = localStorage.getItem('customBg') || null;
        let cardOpacity = parseInt(localStorage.getItem('cardOpacity')) || 100;
        let selectedTask = null;   // { column, taskId }
        let activeFilters = { todo: null, working: null, done: null };
        let taskSelectorActive = false;
        let taskSelectorBuffer = '';

        // ─── Migration: sanitize decimal task IDs (Date.now()+Math.random() produced
        //     floats like 1779562537655.4753 which are invalid CSS selectors and crash
        //     querySelector, causing an infinite reload loop on returning users).
        //     Uses a Set to guarantee uniqueness — Math.round() alone can collide. ────
        (function migrateDecimalIds() {
            let dirty = false;
            const seen = new Set();
            // Collect all existing integer IDs first so we don't collide with them
            ['todo', 'working', 'done'].forEach(col => {
                (tasks[col] || []).forEach(task => {
                    if (Number.isInteger(task.id)) seen.add(task.id);
                });
            });
            let nextId = Date.now();
            ['todo', 'working', 'done'].forEach(col => {
                (tasks[col] || []).forEach(task => {
                    if (!Number.isInteger(task.id)) {
                        while (seen.has(nextId)) nextId++;
                        task.id = nextId;
                        seen.add(nextId);
                        nextId++;
                        dirty = true;
                    }
                });
            });
            if (dirty) {
                localStorage.setItem('tasks', JSON.stringify(tasks));
            }
        })();
        let voiceRecognition = null;
        let voiceActive      = false;
        let spaceHeld        = false;
        let voiceSR           = null;
        let voiceAccumulated  = '';
        let voiceSession       = 0;        // incremented each startVoice; stale onend calls are ignored
        let currentUser = null;       // Firebase user object
        let app = null;              // Firebase app instance
        let db = null;               // Firestore instance
        let syncTimeout = null;      // debounce for cloud sync

        // ─── Init ─────────────────────────────────────────────────────────────────
        if (isLightMode) {
            document.body.classList.add('light-mode');
            updateThemeButton();
        }
        // NOTE: Onboarding visibility is handled entirely in the HTML <script> block.
        // tasky.js no longer touches #onboarding (that id does not exist in the HTML).

        if (customBg) applyCustomBg();
        initOpacity();

        // ─── Firebase / Cloud Sync ─────────────────────────────────────────────────
        app = firebase.initializeApp({
            apiKey: "AIzaSyBN8ZJil4vWWJ6XPPGgp20htp8IBxDLL_o",
            authDomain: "tasky-95785.firebaseapp.com",
            projectId: "tasky-95785",
            storageBucket: "tasky-95785.firebasestorage.app",
            messagingSenderId: "285483279389",
            appId: "1:285483279389:web:383a6cb7683e6e4e1d12f4"
        });
        db = firebase.firestore(app);

        renderAllColumns();
        renderWorkspaceSwitcher();
        updateDailySummary();
        setupKeyboard();          // single unified keyboard handler
        setupDelegatedListeners();
        setupVoice();             // speech recognition
        setupFirebase();          // Firebase cloud sync



        // ─── Custom background upload ─────────────────────────────────────────────
        var bgInput = document.getElementById('bg-upload-input');
        if (bgInput) {
            bgInput.addEventListener('change', function(e) {
                var file = e.target.files[0];
                if (!file) return;
                var reader = new FileReader();
                reader.onload = function(ev) {
                    customBg = ev.target.result;
                    try {
                        localStorage.setItem('customBg', customBg);
                        applyCustomBg();
                        showToast('Background set', () => {});
                    } catch(_) {
                        showToast('Image too large to save', () => {});
                        customBg = null;
                    }
                };
                reader.readAsDataURL(file);
                this.value = '';
            });
        }

        // ─── Card opacity slider ────────────────────────────────────────────────────
        var opacitySlider = document.getElementById('card-opacity-slider');
        if (opacitySlider) {
            opacitySlider.addEventListener('input', function() {
                setCardOpacity(parseInt(this.value));
            });
        }

        // ─── Firebase Auth ─────────────────────────────────────────────────────────
        function setupFirebase() {
            firebase.auth(app).onAuthStateChanged(user => {
                const prevUid = currentUser ? currentUser.uid : null;
                currentUser = user;
                window.currentUser = user; // expose for tasky-collab.js

                if (user) {
                    if (user.uid !== prevUid) {
                        syncFromCloud(!!prevUid);
                    }
                } else {
                    // No user — stay signed out and work from localStorage only.
                    // (Anonymous auth is disabled in this Firebase project.)
                }

                updateAuthUI();
                // Fire a simple event so tasky-collab.js can react without
                // needing to patch updateAuthUI (which is a local function here).
                window.dispatchEvent(new CustomEvent('tasky:authchange', { detail: { user } }));
            });
        }

        function signInWithGoogle() {
            const provider = new firebase.auth.GoogleAuthProvider();
            const dd = document.getElementById('dropdown');
            if (dd) dd.classList.remove('show');

            // Use popup flow — works on any domain (file://, localhost, custom hosts).
            // signInWithRedirect requires the exact domain whitelisted in Firebase Console.
            firebase.auth(app).signInWithPopup(provider).then(result => {
                if (result && result.user) {
                    pushToCloud();
                    showToast('☁️ Signed in & synced', () => {});
                }
            }).catch(err => {
                if (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request') {
                    // User closed popup — no action needed
                } else if (err.code === 'auth/credential-already-in-use' || err.code === 'auth/email-already-in-use') {
                    firebase.auth(app).signInWithPopup(new firebase.auth.GoogleAuthProvider()).catch(() => {});
                } else {
                    console.warn('Sign-in popup error:', err.code, err.message);
                    showToast('⚠️ Sign-in failed. Check your connection.', () => {});
                }
            });
        }

        function signOut() {
            // Cancel any in-flight sync so the Google user's tasks don't get
            // written to Firestore one last time after state is cleared.
            if (syncTimeout) { clearTimeout(syncTimeout); syncTimeout = null; }

            // Wipe local board state BEFORE signing out. The auth state change
            // will trigger syncFromCloud on the new anon account; if tasks are
            // still in localStorage at that point, pushToCloud writes them into
            // the anon doc and they bleed back on the next Google login.
            tasks = { todo: [], working: [], done: [] };
            taskCounter = 0;
            localStorage.setItem('tasks',             JSON.stringify(tasks));
            localStorage.setItem('taskCounter',       '0');
            localStorage.setItem('tasks_local',       JSON.stringify(tasks));
            localStorage.setItem('taskCounter_local', '0');
            renderAllColumns();

            firebase.auth(app).signOut().catch(() => {});

            const dd = document.getElementById('dropdown');
            if (dd) dd.classList.remove('show');
        }

        function updateAuthUI() {
            const authBtn    = document.getElementById('auth-btn');
            const signoutBtn = document.getElementById('signout-btn');
            const userInfo   = document.getElementById('user-info');
            const avatar     = document.getElementById('user-avatar');
            const email      = document.getElementById('user-email');
            const syncEl     = document.getElementById('sync-status');

            if (currentUser && !currentUser.isAnonymous) {
                // Signed in with a real account (Google etc.)
                if (authBtn)    authBtn.style.display    = 'none';
                if (signoutBtn) signoutBtn.style.display = 'flex';
                if (userInfo)   userInfo.style.display   = 'flex';
                if (avatar)     avatar.textContent = currentUser.email ? currentUser.email[0].toUpperCase() : '?';
                if (email)      email.textContent  = currentUser.email || '';
                setSyncStatus('synced');
            } else if (currentUser && currentUser.isAnonymous) {
                // Anonymous — show Sign In button, hide signout/user info, show quiet sync indicator
                if (authBtn)    authBtn.style.display    = 'flex';
                if (signoutBtn) signoutBtn.style.display = 'none';
                if (userInfo)   userInfo.style.display   = 'none';
                // Show a subtle "local" sync status so user knows data is being saved
                if (syncEl) {
                    syncEl.classList.remove('synced', 'syncing', 'offline');
                    syncEl.classList.add('visible', 'synced');
                    syncEl.textContent = '☁️ Auto-saved';
                }
            } else {
                // No user (should only briefly happen before anon auth kicks in)
                if (authBtn)    authBtn.style.display    = 'flex';
                if (signoutBtn) signoutBtn.style.display = 'none';
                if (userInfo)   userInfo.style.display   = 'none';
                if (syncEl)     syncEl.classList.remove('visible');
            }
        }

        function setSyncStatus(state) {
            const el = document.getElementById('sync-status');
            if (!el) return;
            el.classList.remove('synced', 'syncing', 'offline', 'visible');
            if (!currentUser) return;
            // For anonymous users, only show if explicitly set (updateAuthUI handles anon label)
            if (currentUser.isAnonymous && state !== 'syncing') return;
            el.classList.add('visible', state);
            const labels = { synced: '☁️ Synced', syncing: '☁️ Syncing…', offline: '☁️ Offline' };
            el.textContent = labels[state] || '';
        }

        function getUserDocRef() {
            if (!currentUser) return null;
            return db.collection('users').doc(currentUser.uid);
        }

        function pushToCloud() {
            if (!currentUser) return;
            setSyncStatus('syncing');
            if (syncTimeout) clearTimeout(syncTimeout);
            syncTimeout = setTimeout(() => {
                const docRef = getUserDocRef();
                if (!docRef) return;
                var cloudData = {
                    workspaces: workspaces.map(function(w) { return { id: w.id, name: w.name, collabCode: w.collabCode }; }),
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                };
                workspaces.forEach(function(w) {
                    var t = localStorage.getItem('ws_tasks_' + w.id);
                    var c = localStorage.getItem('ws_counter_' + w.id);
                    if (t) cloudData['ws_tasks_' + w.id] = JSON.parse(t);
                    if (c) cloudData['ws_counter_' + w.id] = parseInt(c);
                });
                docRef.set(cloudData, { merge: true })
                    .then(function() { setSyncStatus('synced'); })
                    .catch(function() { setSyncStatus('offline'); });
            }, 500);
        }

        function syncFromCloud(replace) {
            if (!currentUser) return;
            const docRef = getUserDocRef();
            if (!docRef) return;
            setSyncStatus('syncing');
            docRef.get().then(snap => {
                if (!snap.exists) {
                    if (replace) {
                        workspaces = [{ id: 1, name: 'Personal', collabCode: null }];
                        activeWorkspaceId = 1;
                        tasks = { todo: [], working: [], done: [] };
                        taskCounter = 0;
                        saveCurrentWorkspaceData();
                        saveWorkspacesMeta();
                    } else {
                        pushToCloud();
                    }
                    renderAllColumns();
                    updateDailySummary();
                    renderWorkspaceSwitcher();
                    setSyncStatus('synced');
                    return;
                }
                var cloudData = snap.data();
                if (replace) {
                    // Replace local workspaces with cloud data
                    if (cloudData.workspaces && cloudData.workspaces.length > 0) {
                        workspaces = cloudData.workspaces.map(function(w) { return { id: w.id, name: w.name, collabCode: w.collabCode }; });
                        nextWorkspaceId = workspaces.reduce(function(max, w) { return Math.max(max, w.id); }, 0) + 1;
                        workspaces.forEach(function(w) {
                            var t = cloudData['ws_tasks_' + w.id];
                            var c = cloudData['ws_counter_' + w.id];
                            if (t) localStorage.setItem('ws_tasks_' + w.id, JSON.stringify(t));
                            if (c !== undefined) localStorage.setItem('ws_counter_' + w.id, String(c));
                        });
                        saveWorkspacesMeta();
                    }
                    activeWorkspaceId = parseInt(localStorage.getItem('ws_active')) || workspaces[0].id;
                    loadWorkspaceData(activeWorkspaceId);
                } else {
                    // Merge: merge each workspace's data
                    if (cloudData.workspaces && cloudData.workspaces.length > 0) {
                        cloudData.workspaces.forEach(function(cw) {
                            var lw = workspaces.find(function(w) { return w.id === cw.id; });
                            if (lw) {
                                lw.collabCode = cw.collabCode || lw.collabCode;
                                if (cw.name) lw.name = cw.name;
                                var cTasks = cloudData['ws_tasks_' + cw.id];
                                var cCounter = cloudData['ws_counter_' + cw.id];
                                if (cTasks) {
                                    var lTasks = localStorage.getItem('ws_tasks_' + cw.id);
                                    var localT = lTasks ? JSON.parse(lTasks) : { todo: [], working: [], done: [] };
                                    var localC = parseInt(localStorage.getItem('ws_counter_' + cw.id)) || 0;
                                    var merged = mergeTasks(localT, cTasks, localC, cCounter || 0);
                                    localStorage.setItem('ws_tasks_' + cw.id, JSON.stringify(merged.tasks));
                                    localStorage.setItem('ws_counter_' + cw.id, String(merged.taskCounter));
                                }
                            } else {
                                workspaces.push({ id: cw.id, name: cw.name, collabCode: cw.collabCode });
                                var ct = cloudData['ws_tasks_' + cw.id];
                                var cc = cloudData['ws_counter_' + cw.id];
                                if (ct) localStorage.setItem('ws_tasks_' + cw.id, JSON.stringify(ct));
                                localStorage.setItem('ws_counter_' + cw.id, String(cc || 0));
                            }
                        });
                        nextWorkspaceId = workspaces.reduce(function(max, w) { return Math.max(max, w.id); }, 0) + 1;
                        saveWorkspacesMeta();
                    }
                    loadWorkspaceData(activeWorkspaceId);
                }
                renderAllColumns();
                updateDailySummary();
                renderWorkspaceSwitcher();
                setSyncStatus('synced');
            }).catch(() => setSyncStatus('offline'));
        }

        function mergeTasks(localTasks, cloudTasks, localCounter, cloudCounter) {
            const merged = { todo: [], working: [], done: [] };
            for (const col of ['todo', 'working', 'done']) {
                const byNumber = {};
                const local = localTasks[col] || [];
                const cloud = cloudTasks[col] || [];
                [...local, ...cloud].forEach(t => {
                    if (!t || !t.number) return;
                    const existing = byNumber[t.number];
                    if (!existing || new Date(t.createdAt) > new Date(existing.createdAt)) {
                        byNumber[t.number] = t;
                    }
                });
                merged[col] = Object.values(byNumber).sort((a, b) => a.number - b.number);
            }
            return { tasks: merged, taskCounter: Math.max(localCounter, cloudCounter) };
        }

        // ─── Public task API (used by Task Groups expansion in HTML) ───────────────
        function addTask(text, column, priority) {
            const nextNum = getNextNumber();
            taskCounter = Math.max(taskCounter, nextNum);
            const task = {
                id: Date.now() * 1000 + nextNum,
                number: nextNum,
                text: text,
                priority: priority || 'medium',
                dueDate: null,
                createdAt: new Date().toISOString()
            };
            tasks[column] = tasks[column] || [];
            tasks[column].push(task);
            saveAll();
            renderColumn(column);
        }

        // ─── Unified keyboard handler ─────────────────────────────────────────────
        function setupKeyboard() {
            const container = document.getElementById('floating-container');
            const input     = document.getElementById('floating-input');

            // ── Input-specific keys ───────────────────────────────────────────────
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    const text = input.value.trim();
                    if (text) {
                        addTaskToTodo(text);
                        input.value = '';
                    }
                    closeFloatingInput();
                    e.stopPropagation();
                    return;
                }
                if (e.key === 'Escape') {
                    input.value = '';
                    closeFloatingInput();
                    e.stopPropagation();
                    return;
                }
                // Stop ALL keys from bubbling to the document handler while input is active
                e.stopPropagation();
            });

            // Close input when clicking outside
            document.addEventListener('click', (e) => {
                if (taskSelectorActive && !e.target.closest('#task-selector')) {
                    exitTaskSelector();
                }
                if (
                    !container.contains(e.target) &&
                    !e.target.closest('.task-card') &&
                    !e.target.closest('#mobile-add-btn')
                ) {
                    if (!input.value.trim()) {
                        closeFloatingInput();
                    }
                }
            });

            // ── Global keys ───────────────────────────────────────────────────────
            document.addEventListener('keydown', (e) => {
                const tag = e.target.tagName;
                if (tag === 'TEXTAREA' || tag === 'SELECT') return;
                if (tag === 'INPUT' && e.target !== input) return;
                if (e.ctrlKey || e.metaKey) return;

                const key = e.key;

                // ── Alt combinations ──────────────────────────────────────────────
                if (e.altKey) {
                    if (taskSelectorActive) exitTaskSelector();

                    if (key === 'g' || key === 'G') {
                        e.preventDefault();
                        deselectTask();
                        enterTaskSelector();
                        return;
                    }

                    if (key >= '1' && key <= '9') {
                        e.preventDefault();
                        const num = parseInt(key);
                        const found = findTaskByNumber(num);
                        if (found) {
                            deselectTask();
                            selectTask(found.column, found.task.id);
                            scrollTaskIntoView(found.task.id);
                        }
                        return;
                    }

                    return;
                }

                // ── If a task is selected: shortcut mode ──────────────────────────
                if (selectedTask) {
                    const { column, taskId } = selectedTask;

                    if (key === 'ArrowLeft')  { e.preventDefault(); moveTaskBackward(column, taskId); return; }
                    if (key === 'ArrowRight') { e.preventDefault(); moveTaskForward(column, taskId);  return; }
                    if (key === '1') { e.preventDefault(); setPriority(column, taskId, 'high');   return; }
                    if (key === '2') { e.preventDefault(); setPriority(column, taskId, 'medium'); return; }
                    if (key === '3') { e.preventDefault(); setPriority(column, taskId, 'low');    return; }
                    if (key === 'Delete' || key === 'Backspace') {
                        e.preventDefault();
                        const col = column, id = taskId;
                        deselectTask();
                        deleteTaskWithUndo(col, id);
                        return;
                    }
                    if (key === 'Escape') { e.preventDefault(); deselectTask(); return; }
                    // Any other key while selected → fall through to open input
                }

                // ── No task selected ──────────────────────────────────────────────
                if (key === 'Escape' || key === 'Delete') return;
                if (key === 'ArrowLeft' || key === 'ArrowRight' ||
                    key === 'ArrowUp'   || key === 'ArrowDown') return;

                // ── Goto mode (Alt+G) ─────────────────────────────────────────────
                if (taskSelectorActive) {
                    e.preventDefault();
                    if (key >= '0' && key <= '9') {
                        taskSelectorBuffer += key;
                        updateTaskSelectorUI();
                    } else if (key === 'Backspace') {
                        taskSelectorBuffer = taskSelectorBuffer.slice(0, -1);
                        updateTaskSelectorUI();
                    } else if (key === 'Enter') {
                        if (taskSelectorBuffer) {
                            const num = parseInt(taskSelectorBuffer);
                            const found = findTaskByNumber(num);
                            if (found) {
                                deselectTask();
                                selectTask(found.column, found.task.id);
                                scrollTaskIntoView(found.task.id);
                            }
                        }
                        exitTaskSelector();
                    } else if (key === 'Escape') {
                        exitTaskSelector();
                    }
                    return;
                }

                // Space held → start voice
                if (key === ' ') {
                    e.preventDefault();
                    if (!spaceHeld) {
                        spaceHeld = true;
                        startVoice();
                    }
                    return;
                }

                // Block other keys while voice is active
                if (voiceActive) {
                    e.preventDefault();
                    return;
                }

                if (key.length === 1) {
                    openFloatingInput();
                }
            });

            window.addEventListener('keyup', (e) => {
                if (e.key === ' ' && spaceHeld) {
                    spaceHeld = false;
                    stopVoice();
                }
            }, true);

            window.addEventListener('blur', () => {
                if (spaceHeld) { spaceHeld = false; stopVoice(); }
            });

            document.addEventListener('visibilitychange', () => {
                if (document.hidden && spaceHeld) { spaceHeld = false; stopVoice(); }
            });
        }

        function mobileFabTap() {
            openFloatingInput();
        }

        function openFloatingInput() {
            if (taskSelectorActive) exitTaskSelector();
            const container = document.getElementById('floating-container');
            const input     = document.getElementById('floating-input');
            const fab       = document.getElementById('mobile-add-btn');
            container.classList.add('active');
            if (fab) fab.classList.add('hidden');
            input.focus();
        }

        function closeFloatingInput() {
            const container = document.getElementById('floating-container');
            const input     = document.getElementById('floating-input');
            const fab       = document.getElementById('mobile-add-btn');
            container.classList.remove('active');
            if (fab) fab.classList.remove('hidden');
            input.blur();
        }

        // Also expose as hideFloatingInput for the Task Groups suggestion code
        function hideFloatingInput() { closeFloatingInput(); }

        // ─── Voice input ──────────────────────────────────────────────────────────
        function setupVoice() {
            voiceSR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
            setupMobileMic();
        }

        function makeRecognition() {
            const rec     = new voiceSR();
            const session = voiceSession;

            rec.continuous     = false;
            rec.interimResults = true;
            rec.lang           = 'en-US';

            rec.onresult = (e) => {
                if (voiceSession !== session) return;
                let interim = '', final = '';
                for (let i = e.resultIndex; i < e.results.length; i++) {
                    const t = e.results[i][0].transcript;
                    if (e.results[i].isFinal) final += t;
                    else interim += t;
                }
                if (final) voiceAccumulated += (voiceAccumulated ? ' ' : '') + final.trim();
                const el = document.getElementById('voice-transcript');
                if (el) el.textContent = voiceAccumulated + (interim ? ' ' + interim : '');
            };

            rec.onerror = (e) => {
                if (voiceSession !== session) return;
                if (e.error === 'not-allowed') {
                    showToast('Mic permission denied — enable it in browser settings', () => {});
                    forceStopVoice();
                }
            };

            rec.onend = () => {
                if (voiceSession !== session) return;
                if (!voiceActive) return;
                voiceRecognition = makeRecognition();
                try { voiceRecognition.start(); } catch (_) {}
            };

            return rec;
        }

        function startVoice(isMobile = false) {
            if (!voiceSR || voiceActive) return;
            voiceSession    += 1;
            voiceActive      = true;
            voiceAccumulated = '';
            const overlay    = document.getElementById('voice-overlay');
            const transcript = document.getElementById('voice-transcript');
            const hint       = document.getElementById('voice-hint');
            if (transcript) transcript.textContent = '';
            if (hint && isMobile) hint.textContent = 'Release button to confirm';
            if (hint && !isMobile) hint.innerHTML = 'Release <kbd style="background:rgba(255,255,255,0.15);padding:2px 7px;border-radius:4px;border:1px solid rgba(255,255,255,0.3)">Space</kbd> to confirm';
            if (overlay) overlay.classList.add('active');
            voiceRecognition = makeRecognition();
            try { voiceRecognition.start(); } catch (_) { forceStopVoice(); }
        }

        function stopVoice() {
            if (!voiceActive) return;
            voiceActive   = false;
            voiceSession += 1;
            const overlay = document.getElementById('voice-overlay');
            if (overlay) overlay.classList.remove('active');
            const el   = document.getElementById('voice-transcript');
            const text = (voiceAccumulated + (el ? ' ' + el.textContent : '')).trim();
            try { voiceRecognition.stop(); } catch (_) {}
            voiceRecognition = null;
            if (text) {
                const input = document.getElementById('floating-input');
                input.value = text;
                openFloatingInput();
            }
        }

        function forceStopVoice() {
            voiceActive   = false;
            voiceSession += 1;
            const overlay = document.getElementById('voice-overlay');
            if (overlay) overlay.classList.remove('active');
            try { if (voiceRecognition) voiceRecognition.stop(); } catch (_) {}
            voiceRecognition = null;
        }

        // ─── Mobile mic: hold-to-talk ─────────────────────────────────────────────
        function setupMobileMic() {
            const btn = document.getElementById('mobile-mic-btn');
            if (!btn) return;

            btn.style.touchAction = 'none';

            function onPress(e) {
                e.preventDefault();
                if (!voiceSR) {
                    showToast('Voice not supported in this browser', () => {});
                    return;
                }
                btn.setPointerCapture(e.pointerId);
                startVoice(true);
            }

            function onRelease(e) {
                e.preventDefault();
                stopVoice();
            }

            btn.addEventListener('pointerdown',   onPress);
            btn.addEventListener('pointerup',     onRelease);
            btn.addEventListener('pointercancel', onRelease);
        }

        // ─── Task selection ───────────────────────────────────────────────────────
        function selectTask(column, taskId) {
            deselectTask();
            selectedTask = { column, taskId };
            const card = document.getElementById(`task-${taskId}`);
            if (card) card.classList.add('selected');
        }

        function deselectTask() {
            if (selectedTask) {
                const card = document.getElementById(`task-${selectedTask.taskId}`);
                if (card) card.classList.remove('selected');
                selectedTask = null;
            }
        }

        function restoreSelection() {
            if (!selectedTask) return;
            const card = document.getElementById(`task-${selectedTask.taskId}`);
            if (card) {
                card.classList.add('selected');
            } else {
                selectedTask = null;
            }
        }

        // ─── Task selector helpers (Alt+G) ────────────────────────────────────────
        function findTaskByNumber(num) {
            for (const col of ['todo', 'working', 'done']) {
                const task = tasks[col].find(t => t.number === num);
                if (task) return { column: col, task };
            }
            return null;
        }

        function enterTaskSelector() {
            taskSelectorActive = true;
            taskSelectorBuffer = '';
            const el = document.getElementById('task-selector');
            if (el) el.classList.add('active');
            updateTaskSelectorUI();
        }

        function exitTaskSelector() {
            taskSelectorActive = false;
            taskSelectorBuffer = '';
            const el = document.getElementById('task-selector');
            if (el) el.classList.remove('active');
        }

        function updateTaskSelectorUI() {
            const buf = document.getElementById('task-selector-buffer');
            if (buf) buf.textContent = taskSelectorBuffer;
        }

        function scrollTaskIntoView(taskId) {
            const card = document.getElementById(`task-${taskId}`);
            if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }

        // ─── Movement helpers ─────────────────────────────────────────────────────
        function moveTaskForward(column, taskId) {
            if (column === 'todo')    moveTaskWithUndo('todo',    'working', taskId);
            else if (column === 'working') moveTaskWithUndo('working', 'done', taskId);
        }

        function moveTaskBackward(column, taskId) {
            if (column === 'done')    moveTaskWithUndo('done',    'working', taskId);
            else if (column === 'working') moveTaskWithUndo('working', 'todo', taskId);
        }

        // ─── CRUD ─────────────────────────────────────────────────────────────────
        function addTaskToTodo(text) {
            const nextNum = getNextNumber();
            taskCounter = Math.max(taskCounter, nextNum);
            const task = {
                id: Date.now() * 1000 + nextNum,
                number: nextNum,
                text: text,
                priority: 'medium',
                dueDate: null,
                createdAt: new Date().toISOString()
            };
            tasks.todo.push(task);
            saveAll();
            appendCardToColumn('todo', task);
        }

        function deleteTask(column, taskId) {
            tasks[column] = tasks[column].filter(t => t.id !== taskId);
            saveAll();
            removeCardFromColumn(column, taskId);
        }

        function deleteTaskWithUndo(column, taskId) {
            const task = tasks[column].find(t => t.id === taskId);
            if (!task) return;

            const snapshot = { column, task: { ...task } };
            tasks[column] = tasks[column].filter(t => t.id !== taskId);
            saveAll();
            removeCardFromColumn(column, taskId);

            showToast(`Deleted "#${task.number} ${task.text}"`, () => {
                tasks[snapshot.column].push(snapshot.task);
                saveAll();
                appendCardToColumn(snapshot.column, snapshot.task);
            });
        }

        function moveTask(fromColumn, toColumn, taskId) {
            const idx = tasks[fromColumn].findIndex(t => t.id === taskId);
            if (idx === -1) return;
            const [task] = tasks[fromColumn].splice(idx, 1);
            tasks[toColumn].push(task);
            saveAll();
            removeCardFromColumn(fromColumn, taskId);
            appendCardToColumn(toColumn, task);
            if (toColumn === 'done') updateDailySummary();
        }

        function moveTaskWithUndo(fromColumn, toColumn, taskId) {
            const task = tasks[fromColumn].find(t => t.id === taskId);
            if (!task) return;

            moveTask(fromColumn, toColumn, taskId);

            if (selectedTask && selectedTask.taskId === taskId) {
                selectedTask.column = toColumn;
                restoreSelection();
            }

            const arrow = (toColumn === 'working' && fromColumn === 'todo') ||
                          (toColumn === 'done'    && fromColumn === 'working') ? '→' : '←';
            showToast(`Moved ${arrow} "${task.text}"`, () => {
                const idx = tasks[toColumn].findIndex(t => t.id === taskId);
                if (idx !== -1) {
                    const [movedTask] = tasks[toColumn].splice(idx, 1);
                    tasks[fromColumn].push(movedTask);
                    saveAll();
                    removeCardFromColumn(toColumn, taskId);
                    appendCardToColumn(fromColumn, movedTask);
                    if (fromColumn === 'done' || toColumn === 'done') updateDailySummary();
                    if (selectedTask && selectedTask.taskId === taskId) {
                        selectedTask.column = fromColumn;
                        restoreSelection();
                    }
                }
            });
        }

        function setPriority(column, taskId, priority) {
            const task = tasks[column].find(t => t.id === taskId);
            if (!task) return;
            task.priority = priority;
            saveAll();
            renderColumn(column);
            restoreSelection();
        }

        function cyclePriority(column, taskId) {
            const task = tasks[column].find(t => t.id === taskId);
            if (!task) return;
            const priorities = ['low', 'medium', 'high'];
            task.priority = priorities[(priorities.indexOf(task.priority) + 1) % 3];
            saveAll();
            if (activeFilters[column]) {
                renderColumn(column);
            } else {
                replaceCardInColumn(column, task);
            }
            restoreSelection();
        }

        function setDueDate(column, taskId, date) {
            const task = tasks[column].find(t => t.id === taskId);
            if (!task) return;
            task.dueDate = date || null;
            saveAll();
            if (activeFilters[column]) {
                renderColumn(column);
            } else {
                replaceCardInColumn(column, task);
            }
            restoreSelection();
        }

        // ─── Filters ──────────────────────────────────────────────────────────────
        function toggleFilter(column, priority, dotElement) {
            if (activeFilters[column] === priority) {
                activeFilters[column] = null;
                dotElement.classList.remove('active');
            } else {
                dotElement.closest('.column').querySelectorAll('.filter-dot')
                    .forEach(d => d.classList.remove('active'));
                activeFilters[column] = priority;
                dotElement.classList.add('active');
            }
            renderColumn(column);
        }

        // ─── Done column ──────────────────────────────────────────────────────────
        async function clearDoneTasks() {
            if (tasks.done.length === 0) return;
            if (!await showConfirm('Clear Completed', 'Remove all done tasks? You can undo this.', 'Clear All')) return;
            const cleared = [...tasks.done];
            tasks.done = [];
            saveAll();
            renderColumn('done');
            updateDailySummary();
            showToast(`Cleared ${cleared.length} completed tasks`, () => {
                tasks.done = cleared;
                saveAll();
                renderColumn('done');
                updateDailySummary();
            });
        }

        // ─── Persistence ──────────────────────────────────────────────────────────
        var _saveAllTimer = null;
        function saveAll() {
            if (_saveAllTimer) return;
            _saveAllTimer = requestAnimationFrame(function() {
                _saveAllTimer = null;
                saveCurrentWorkspaceData();
                pushToCloud();
            });
        }

        // ─── Toast ────────────────────────────────────────────────────────────────
        function showToast(message, undoCallback) {
            const container = document.getElementById('toast-container');
            const toast = document.createElement('div');
            toast.className = 'toast';

            const msgSpan = document.createElement('span');
            msgSpan.textContent = message;

            const undoBtn = document.createElement('button');
            undoBtn.className = 'toast-undo-btn';
            undoBtn.textContent = 'Undo';
            undoBtn.onclick = () => {
                toast.remove();
                if (undoCallback) undoCallback();
            };

            toast.appendChild(msgSpan);
            toast.appendChild(undoBtn);
            container.appendChild(toast);

            setTimeout(() => { if (toast.parentNode) toast.remove(); }, 3000);
        }

        // ─── Daily summary ────────────────────────────────────────────────────────
        function updateDailySummary() {
            const today = new Date().toDateString();
            const doneToday = tasks.done.filter(t => new Date(t.createdAt).toDateString() === today).length;
            const el = document.getElementById('daily-summary');
            if (el) el.textContent = doneToday > 0 ? `Today: ${doneToday}` : '';
        }

        // ─── Render ───────────────────────────────────────────────────────────────
        function renderAllColumns() {
            renderColumn('todo');
            renderColumn('working');
            renderColumn('done');
        }

        function renderWorkspaceSwitcher() {
            var container = document.getElementById('workspace-switcher');
            if (!container) return;
            var html = '<span class="ws-bar-label">Workspaces</span>';
            workspaces.forEach(function(w) {
                var isActive = w.id === activeWorkspaceId;
                var t = localStorage.getItem('ws_tasks_' + w.id);
                var wsTasks = t ? JSON.parse(t) : { todo: [], working: [], done: [] };
                var total = wsTasks.todo.length + wsTasks.working.length + wsTasks.done.length;
                html += '<div class="ws-pill' + (isActive ? ' ws-active' : '') + '" onclick="switchWorkspace(' + w.id + ')">';
                if (w.collabCode) html += '<span class="ws-pill-collab" title="Collaboration: ' + w.collabCode + '">👥</span>';
                html += '<span class="ws-pill-name">' + escapeHtml(w.name) + '</span>';
                html += '<span class="ws-pill-count">' + total + '</span>';
                if (w.id !== 1) html += '<button class="ws-pill-del" onclick="event.stopPropagation();deleteWorkspaceConfirm(' + w.id + ')" title="Delete workspace">✕</button>';
                html += '</div>';
            });
            html += '<button class="ws-pill-add" onclick="createWorkspaceClick()" title="New workspace">＋ New Workspace</button>';
            container.innerHTML = html;
        }

        // ─── Targeted DOM helpers ────────────────────────────────────────────
        function appendCardToColumn(column, task) {
            var list = document.getElementById(column + '-list');
            if (!list) return;
            var emptyEl = list.querySelector('.empty-state');
            if (emptyEl) emptyEl.remove();
            list.appendChild(createTaskCard(task, column));
            updateColumnCount(column);
        }

        function removeCardFromColumn(column, taskId) {
            var card = document.getElementById('task-' + taskId);
            if (!card) return;
            card.remove();
            var list = document.getElementById(column + '-list');
            if (list && list.children.length === 0) {
                var filter = activeFilters[column];
                list.innerHTML = filter
                    ? '<div class="empty-state"><div class="empty-state-icon">🔍</div><div>No ' + filter + ' priority tasks</div></div>'
                    : getEmptyState(column);
            }
            updateColumnCount(column);
        }

        function replaceCardInColumn(column, task) {
            var list = document.getElementById(column + '-list');
            if (!list) return;
            var oldCard = document.getElementById('task-' + task.id);
            if (oldCard) {
                var newCard = createTaskCard(task, column);
                list.replaceChild(newCard, oldCard);
            } else {
                appendCardToColumn(column, task);
            }
            updateColumnCount(column);
        }

        function updateColumnCount(column) {
            var count = document.getElementById(column + '-count');
            if (count) {
                var actual = tasks[column].length;
                if (count.textContent !== String(actual)) {
                    count.classList.add('pulse');
                    setTimeout(function() { count.classList.remove('pulse'); }, 400);
                }
                count.textContent = actual;
            }
        }

        function renderColumn(column) {
            const list   = document.getElementById(`${column}-list`);
            const count  = document.getElementById(`${column}-count`);
            const filter = activeFilters[column];

            let columnTasks = tasks[column];
            if (filter) columnTasks = columnTasks.filter(t => t.priority === filter);

            list.innerHTML = '';

            if (columnTasks.length === 0) {
                list.innerHTML = filter
                    ? `<div class="empty-state"><div class="empty-state-icon">🔍</div><div>No ${filter} priority tasks</div></div>`
                    : getEmptyState(column);
            } else {
                columnTasks.forEach(task => list.appendChild(createTaskCard(task, column)));
            }

            const actual = tasks[column].length;
            if (count.textContent !== String(actual)) {
                count.classList.add('pulse');
                setTimeout(() => count.classList.remove('pulse'), 400);
            }
            count.textContent = actual;
        }

        function getEmptyState(column) {
            const states = {
                todo:    `<div class="empty-state"><div class="empty-state-icon">⌨️</div><div>Start typing to add tasks</div><div style="font-size:11px;opacity:0.6;">Press any key to begin</div></div>`,
                working: `<div class="empty-state"><div class="empty-state-icon">↔️</div><div>Drag tasks here</div><div style="font-size:11px;opacity:0.6;">Or use arrow keys to move</div></div>`,
                done:    `<div class="empty-state"><div class="empty-state-icon">🎉</div><div>Complete something!</div><div style="font-size:11px;opacity:0.6;">Move tasks here when finished</div></div>`
            };
            return states[column];
        }

        function createTaskCard(task, column) {
            const card = document.createElement('div');
            card.className = `task-card priority-${task.priority}`;
            card.draggable = true;
            card.id = `task-${task.id}`;
            card.dataset.taskId = task.id;
            card.dataset.column = column;

            const isOverdue = task.dueDate && new Date(task.dueDate) < new Date() && column !== 'done';
            const dateDisplay = task.dueDate
                ? new Date(task.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                : '';
            const priorityLabel = task.priority.charAt(0).toUpperCase() + task.priority.slice(1);

            card.innerHTML = `
                <div class="drag-handle">⋮⋮</div>
                <div class="task-header">
                    <span class="task-number">#${task.number}</span>
                    <span class="task-text" title="Double-click to edit">${escapeHtml(task.text)}</span>
                    <input class="task-edit-input" type="text" value="${escapeHtml(task.text)}"
                        maxlength="200" style="display:none;" aria-label="Edit task text">
                </div>
                <div class="task-meta">
                    <div class="task-left">
                            <span class="priority-badge ${task.priority}" data-action="priority" title="Click to cycle priority (or press 1/2/3 when selected)">
                            ${task.priority === 'high' ? '🔴' : task.priority === 'medium' ? '🟡' : '🟢'} ${priorityLabel}
                        </span>
                        ${task.dueDate ? `<span class="due-date ${isOverdue ? 'overdue' : ''}">📅 ${dateDisplay}</span>` : ''}
                    </div>
                    <div class="task-hover-controls">
                        <button class="edit-btn" data-action="edit" title="Edit task text (double-click)">✏️</button>
                        <button class="date-btn" data-action="date" title="Set due date">
                            📅 ${task.dueDate ? 'Change' : 'Date'}
                        </button>
                        <input type="date" id="date-picker-${task.id}" data-action="date-input" value="${task.dueDate || ''}"
                               style="position:absolute;opacity:0;width:0;height:0;pointer-events:none;">
                        ${column === 'todo'    ? `<button class="move-btn" data-action="move-todo" title="Move to Working On (→)">→</button>` : ''}
                        ${column === 'working' ? `<button class="move-btn back-btn" data-action="move-working-back" title="Move back to To Do (←)">←</button><button class="move-btn fwd-btn" data-action="move-working-fwd" title="Move to Done (→)">→</button>` : ''}
                        ${column === 'done'    ? `<button class="move-btn" data-action="move-done" title="Move back to Working On (←)">←</button>` : ''}
                        <button class="delete-btn" data-action="delete" title="Delete (Del)">✕</button>
                    </div>
                </div>
            `;

            // ── Inline edit ──────────────────────────────────────────────────────
            const taskTextEl  = card.querySelector('.task-text');
            const editInput   = card.querySelector('.task-edit-input');
            const editBtn     = card.querySelector('.edit-btn');

            function startEditing() {
                taskTextEl.style.display = 'none';
                editInput.style.display  = 'block';
                editInput.value          = task.text;
                editInput.focus();
                editInput.select();
                card.classList.add('editing');
                editBtn.textContent = '✓';
                editBtn.title = 'Save (Enter)';
            }

            function commitEdit() {
                const newText = editInput.value.trim();
                card.classList.remove('editing');
                editInput.style.display  = 'none';
                taskTextEl.style.display = '';
                editBtn.textContent = '✏️';
                editBtn.title = 'Edit task text (double-click)';
                if (newText && newText !== task.text) {
                    const t = tasks[column].find(t => t.id === task.id);
                    if (t) {
                        t.text = newText;
                        task.text = newText;
                        taskTextEl.textContent = newText;
                        saveAll();
                    }
                }
            }

            function cancelEdit() {
                card.classList.remove('editing');
                editInput.style.display  = 'none';
                taskTextEl.style.display = '';
                editBtn.textContent = '✏️';
                editBtn.title = 'Edit task text (double-click)';
            }

            editBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (card.classList.contains('editing')) {
                    commitEdit();
                } else {
                    startEditing();
                }
            });

            taskTextEl.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                startEditing();
            });

            editInput.addEventListener('keydown', (e) => {
                e.stopPropagation();
                if (e.key === 'Enter')  { e.preventDefault(); commitEdit(); }
                if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
            });

            editInput.addEventListener('blur', () => {
                setTimeout(() => {
                    if (card.classList.contains('editing')) commitEdit();
                }, 150);
            });

            // ── Touch drag ────────────────────────────────────────────────────────
            setupTouchDrag(card, task.id, column);

            return card;
        }

        // ─── Delegated listeners (one per column, not per card) ────────────────
        function setupDelegatedListeners() {
            ['todo', 'working', 'done'].forEach(function(col) {
                var list = document.getElementById(col + '-list');
                if (!list) return;

                list.addEventListener('click', function(e) {
                    var card = e.target.closest('.task-card');
                    if (!card) return;

                    // Action buttons via data-action attribute
                    var btn = e.target.closest('[data-action]');
                    if (btn) {
                        var action = btn.dataset.action;
                        var tid = parseInt(card.dataset.taskId);
                        var c = card.dataset.column;
                        e.stopPropagation();
                        switch (action) {
                            case 'priority':       cyclePriority(c, tid); break;
                            case 'date':           openDatePicker(tid); break;
                            case 'delete':         if (selectedTask && selectedTask.taskId === tid) deselectTask(); deleteTaskWithUndo(c, tid); break;
                            case 'move-todo':      moveTaskWithUndo(c, 'working', tid); break;
                            case 'move-working-back': moveTaskWithUndo(c, 'todo', tid); break;
                            case 'move-working-fwd':  moveTaskWithUndo(c, 'done', tid); break;
                            case 'move-done':      moveTaskWithUndo(c, 'working', tid); break;
                            // 'edit' is handled by per-card listeners
                        }
                        return;
                    }

                    // Card selection (ignore clicks on buttons/badges)
                    if (e.target.closest('button, .priority-badge, input')) return;
                    if (taskSelectorActive) exitTaskSelector();
                    if (selectedTask && selectedTask.taskId === parseInt(card.dataset.taskId)) {
                        deselectTask();
                    } else {
                        selectTask(card.dataset.column, parseInt(card.dataset.taskId));
                    }
                });

                list.addEventListener('change', function(e) {
                    var input = e.target.closest('input[data-action="date-input"]');
                    if (!input) return;
                    var card = input.closest('.task-card');
                    if (!card) return;
                    setDueDate(card.dataset.column, parseInt(card.dataset.taskId), input.value);
                });

                list.addEventListener('dragstart', function(e) {
                    var card = e.target.closest('.task-card');
                    if (!card) return;
                    e.dataTransfer.setData('text/plain', JSON.stringify({ taskId: parseInt(card.dataset.taskId), fromColumn: card.dataset.column }));
                    card.style.opacity = '0.4';
                    deselectTask();
                });

                list.addEventListener('dragend', function(e) {
                    var card = e.target.closest('.task-card');
                    if (card) card.style.opacity = '';
                });
            });
        }

        function escapeHtml(str) {
            return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        }

        // ─── Date picker ──────────────────────────────────────────────────────────
        function openDatePicker(taskId) {
            const picker = document.getElementById(`date-picker-${taskId}`);
            if (!picker) return;
            Object.assign(picker.style, { position:'relative', opacity:'1', width:'auto', height:'auto', pointerEvents:'all' });
            try { picker.showPicker(); } catch (_) { picker.click(); }
            setTimeout(() => {
                Object.assign(picker.style, { position:'absolute', opacity:'0', width:'0', height:'0', pointerEvents:'none' });
            }, 100);
        }

        // ─── Drag & drop (desktop HTML5) ──────────────────────────────────────────
        function allowDrop(e) { e.preventDefault(); }

        function drop(e) {
            e.preventDefault();
            const data = JSON.parse(e.dataTransfer.getData('text/plain'));
            const listEl = e.target.closest('.task-list');
            if (!listEl) return;
            const toColumn = listEl.id.replace('-list', '');
            if (data.fromColumn !== toColumn) {
                moveTaskWithUndo(data.fromColumn, toColumn, data.taskId);
                updateDailySummary();
            }
        }

        // ─── Touch drag (mobile / Capacitor) ─────────────────────────────────────
        // Long-press 400 ms to start drag, then drag to a column to drop.
        // A ghost clone follows the finger. Column zones highlight on entry.
        let _touchDrag = null;   // { taskId, fromColumn, ghost, scrollEl }

        function setupTouchDrag(card, taskId, column) {
            let pressTimer = null;
            let dragStarted = false;
            let startX = 0, startY = 0;

            card.addEventListener('touchstart', (e) => {
                // Don't hijack taps on buttons / badges
                if (e.target.closest('button, .priority-badge, input')) return;
                const t = e.touches[0];
                startX = t.clientX; startY = t.clientY;
                dragStarted = false;
                pressTimer = setTimeout(() => {
                    dragStarted = true;
                    _startTouchDrag(card, taskId, column, t.clientX, t.clientY);
                }, 400);
            }, { passive: true });

            card.addEventListener('touchmove', (e) => {
                if (!dragStarted && pressTimer) {
                    // Cancel long-press if finger moved more than 8px (it's a scroll)
                    const t = e.touches[0];
                    if (Math.abs(t.clientX - startX) > 8 || Math.abs(t.clientY - startY) > 8) {
                        clearTimeout(pressTimer); pressTimer = null;
                    }
                }
                if (!dragStarted || !_touchDrag) return;
                e.preventDefault();
                _moveTouchDrag(e.touches[0].clientX, e.touches[0].clientY);
            }, { passive: false });

            card.addEventListener('touchend', (e) => {
                clearTimeout(pressTimer); pressTimer = null;
                if (!dragStarted || !_touchDrag) return;
                e.preventDefault();
                const t = e.changedTouches[0];
                _endTouchDrag(t.clientX, t.clientY);
                dragStarted = false;
            }, { passive: false });

            card.addEventListener('touchcancel', () => {
                clearTimeout(pressTimer); pressTimer = null;
                if (_touchDrag) _cancelTouchDrag();
                dragStarted = false;
            }, { passive: true });
        }

        function _startTouchDrag(card, taskId, column, x, y) {
            const ghost = card.cloneNode(true);
            ghost.id = 'touch-drag-ghost';
            const rect = card.getBoundingClientRect();
            Object.assign(ghost.style, {
                position:      'fixed',
                left:          rect.left + 'px',
                top:           rect.top  + 'px',
                width:         rect.width + 'px',
                opacity:       '0.75',
                pointerEvents: 'none',
                zIndex:        '9999',
                transform:     'scale(1.03)',
                transition:    'transform 0.15s',
                boxShadow:     '0 12px 40px rgba(0,0,0,0.5)',
                borderRadius:  '14px',
            });
            document.body.appendChild(ghost);
            card.style.opacity = '0.3';

            // Highlight potential drop zones
            document.querySelectorAll('.task-list').forEach(el => {
                el.classList.add('drop-zone-active');
            });

            // Cache column list rects for hit-testing during drag
            var _columnRects = [];
            document.querySelectorAll('.task-list').forEach(function(el) {
                _columnRects.push({ el: el, rect: el.getBoundingClientRect() });
            });
            _touchDrag = { taskId, fromColumn: column, ghost, card,
                           offsetX: x - rect.left, offsetY: y - rect.top,
                           columnRects: _columnRects };

            // Haptic feedback if available
            if (navigator.vibrate) navigator.vibrate(30);
        }

        function _moveTouchDrag(x, y) {
            if (!_touchDrag) return;
            const { ghost, offsetX, offsetY, columnRects } = _touchDrag;
            ghost.style.left = (x - offsetX) + 'px';
            ghost.style.top  = (y - offsetY) + 'px';

            // Highlight the column the ghost is over (using cached rects)
            columnRects.forEach(function(item) {
                var r = item.rect;
                var over = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
                item.el.classList.toggle('drop-zone-hover', over);
            });
        }

        function _endTouchDrag(x, y) {
            if (!_touchDrag) return;
            const { taskId, fromColumn, ghost, card } = _touchDrag;

            ghost.remove();
            card.style.opacity = '';
            document.querySelectorAll('.task-list').forEach(el => {
                el.classList.remove('drop-zone-active', 'drop-zone-hover');
            });

            // Find which column list the finger lifted over
            const target = document.elementFromPoint(x, y);
            const listEl = target && target.closest('.task-list');
            if (listEl) {
                const toColumn = listEl.id.replace('-list', '');
                if (toColumn && toColumn !== fromColumn) {
                    moveTaskWithUndo(fromColumn, toColumn, taskId);
                    updateDailySummary();
                    if (navigator.vibrate) navigator.vibrate(15);
                }
            }

            _touchDrag = null;
        }

        function _cancelTouchDrag() {
            if (!_touchDrag) return;
            _touchDrag.ghost.remove();
            _touchDrag.card.style.opacity = '';
            document.querySelectorAll('.task-list').forEach(el => {
                el.classList.remove('drop-zone-active', 'drop-zone-hover');
            });
            _touchDrag = null;
        }

        // ─── Menu ─────────────────────────────────────────────────────────────────
        function toggleMenu() {
            document.getElementById('dropdown').classList.toggle('show');
        }

        document.addEventListener('click', (e) => {
            if (!document.querySelector('.top-menu').contains(e.target)) {
                document.getElementById('dropdown').classList.remove('show');
            }
        });

        function toggleTheme() {
            document.body.classList.toggle('light-mode');
            isLightMode = document.body.classList.contains('light-mode');
            localStorage.setItem('theme', isLightMode ? 'light' : 'dark');
            updateThemeButton();
        }

        function updateThemeButton() {
            const icon = document.getElementById('theme-icon');
            const text = document.getElementById('theme-text');
            if (icon) icon.textContent = isLightMode ? '🌙' : '☀️';
            if (text) text.textContent = isLightMode ? 'Dark Mode' : 'Light Mode';
        }

        // ─── Custom background ─────────────────────────────────────────────────────
        function applyCustomBg() {
            var img = document.getElementById('custom-bg-img');
            var container = document.getElementById('custom-bg');
            if (!img || !container) return;
            img.src = customBg;
            container.style.display = 'block';
            var rm = document.getElementById('bg-remove-inline-btn');
            if (rm) rm.style.display = 'inline-flex';
            var st = document.getElementById('bg-status-label');
            if (st) st.style.display = 'block';
            var stRm = document.getElementById('st-bg-remove-btn');
            if (stRm) stRm.style.display = '';
            var stSt = document.getElementById('st-bg-status');
            if (stSt) stSt.style.display = 'block';
        }

        function triggerBgUpload() {
            document.getElementById('bg-upload-input').click();
            var dd = document.getElementById('dropdown');
            if (dd) dd.classList.remove('show');
        }

        function removeCustomBg() {
            customBg = null;
            localStorage.removeItem('customBg');
            document.getElementById('custom-bg').style.display = 'none';
            var rm = document.getElementById('bg-remove-inline-btn');
            if (rm) rm.style.display = 'none';
            var st = document.getElementById('bg-status-label');
            if (st) st.style.display = 'none';
            var stRm = document.getElementById('st-bg-remove-btn');
            if (stRm) stRm.style.display = 'none';
            var stSt = document.getElementById('st-bg-status');
            if (stSt) stSt.style.display = 'none';
            var dd = document.getElementById('dropdown');
            if (dd) dd.classList.remove('show');
        }

        // ─── Background modal ───────────────────────────────────────────────────────
        function openBgModal() {
            var overlay = document.getElementById('bg-modal-overlay');
            if (overlay) {
                overlay.classList.remove('hidden');
                overlay.classList.add('visible');
                var slider = document.getElementById('card-opacity-slider');
                if (slider) slider.value = cardOpacity;
                var val = document.getElementById('card-opacity-value');
                if (val) val.textContent = cardOpacity + '%';
            }
            var dd = document.getElementById('dropdown');
            if (dd) dd.classList.remove('show');
        }

        function closeBgModal() {
            var overlay = document.getElementById('bg-modal-overlay');
            if (overlay) {
                overlay.classList.remove('visible');
                overlay.classList.add('hidden');
                setTimeout(function() { overlay.classList.remove('hidden'); }, 270);
            }
        }

        function bgOverlayClick(e) {
            if (e.target === document.getElementById('bg-modal-overlay')) closeBgModal();
        }

        var _opacityDebounceTimer = null;
        function setCardOpacity(val) {
            cardOpacity = Math.max(40, Math.min(100, val));
            var darkAlpha = 0.01 + (cardOpacity - 40) * (0.08 - 0.01) / 60;
            var lightAlpha = 0.35 + (cardOpacity - 40) * (0.75 - 0.35) / 60;
            document.documentElement.style.setProperty('--column-bg', 'rgba(255, 255, 255, ' + darkAlpha + ')');
            document.documentElement.style.setProperty('--column-bg-light', 'rgba(255, 255, 255, ' + lightAlpha + ')');
            if (_opacityDebounceTimer) cancelAnimationFrame(_opacityDebounceTimer);
            _opacityDebounceTimer = requestAnimationFrame(function() {
                localStorage.setItem('cardOpacity', cardOpacity);
                _opacityDebounceTimer = null;
            });
            var valEl = document.getElementById('card-opacity-value');
            if (valEl) valEl.textContent = cardOpacity + '%';
            var stVal = document.getElementById('st-opacity-val');
            if (stVal) stVal.textContent = cardOpacity + '%';
            var stSlider = document.getElementById('st-opacity-slider');
            if (stSlider) stSlider.value = cardOpacity;
        }

        function initOpacity() {
            setCardOpacity(cardOpacity);
        }

        // ─── CSV export ───────────────────────────────────────────────────────────
        function exportToCSV() {
            const rows = [];
            Object.keys(tasks).forEach(status => {
                tasks[status].forEach(task => {
                    rows.push({
                        Number:    task.number,
                        Task:      task.text,
                        Status:    status === 'todo' ? 'To Do' : status === 'working' ? 'Working On' : 'Done',
                        Priority:  task.priority,
                        'Due Date': task.dueDate || 'None',
                        Created:   new Date(task.createdAt).toLocaleDateString()
                    });
                });
            });

            rows.sort((a, b) => a.Number - b.Number);
            const headers = ['Number', 'Task', 'Status', 'Priority', 'Due Date', 'Created'];
            const csv = [
                headers.join(','),
                ...rows.map(r => headers.map(h => `"${String(r[h]).replace(/"/g, '""')}"`).join(','))
            ].join('\n');

            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = `tasky_tasks_${new Date().toISOString().split('T')[0]}.csv`;
            link.style.display = 'none';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            document.getElementById('dropdown').classList.remove('show');
        }

        // ─── Reset ────────────────────────────────────────────────────────────────
        async function resetAllData() {
            if (!await showConfirm('Reset Everything', 'Delete all tasks and reset Tasky? This cannot be undone.')) return;
            workspaces.forEach(function(w) {
                localStorage.setItem('ws_tasks_' + w.id, JSON.stringify({ todo: [], working: [], done: [] }));
                localStorage.setItem('ws_counter_' + w.id, '0');
            });
            tasks = { todo: [], working: [], done: [] };
            taskCounter = 0;
            if (currentUser) {
                const docRef = getUserDocRef();
                if (docRef) docRef.delete().catch(() => {});
            }
            saveAll();
            renderAllColumns();
            updateDailySummary();
            renderWorkspaceSwitcher();
            deselectTask();
            exitTaskSelector();
            document.getElementById('dropdown').classList.remove('show');
            showToast('All data reset', () => {});
        }

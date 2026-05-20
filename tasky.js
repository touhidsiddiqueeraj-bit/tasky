// ─── State ────────────────────────────────────────────────────────────────
        let tasks = JSON.parse(localStorage.getItem('tasks')) || { todo: [], working: [], done: [] };
        let taskCounter = parseInt(localStorage.getItem('taskCounter')) || 0;
        let isLightMode = localStorage.getItem('theme') === 'light';
        let hasOnboarded = localStorage.getItem('hasOnboarded') === 'true';
        let selectedTask = null;   // { column, taskId }
        let activeFilters = { todo: null, working: null, done: null };
        let taskSelectorActive = false;
        let taskSelectorBuffer = '';
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
        if (hasOnboarded) {
            document.getElementById('onboarding').style.display = 'none';
        }

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
        db.enablePersistence().catch(() => {});

        renderAllColumns();
        updateDailySummary();
        setupKeyboard();          // single unified keyboard handler
        setupVoice();             // speech recognition
        setupFirebase();          // Firebase cloud sync

        // ─── Onboarding ───────────────────────────────────────────────────────────
        function dismissOnboarding() {
            document.getElementById('onboarding').style.display = 'none';
            localStorage.setItem('hasOnboarded', 'true');
        }

        function setupFirebase() {
            firebase.auth(app).onAuthStateChanged(user => {
                const wasLoggedIn = !!currentUser;
                currentUser = user;
                if (user && !wasLoggedIn) syncFromCloud();
                updateAuthUI();
            });
        }

        function signInWithGoogle() {
            const provider = new firebase.auth.GoogleAuthProvider();
            firebase.auth(app).signInWithPopup(provider).catch(() => {});
            document.getElementById('dropdown').classList.remove('show');
        }

        function signOut() {
            firebase.auth(app).signOut().catch(() => {});
            document.getElementById('dropdown').classList.remove('show');
        }

        function updateAuthUI() {
            const authBtn = document.getElementById('auth-btn');
            const signoutBtn = document.getElementById('signout-btn');
            const userInfo = document.getElementById('user-info');
            const avatar = document.getElementById('user-avatar');
            const email = document.getElementById('user-email');
            const authText = document.getElementById('auth-text');
            const syncEl = document.getElementById('sync-status');

            if (currentUser) {
                if (authBtn) authBtn.style.display = 'none';
                if (signoutBtn) signoutBtn.style.display = 'flex';
                if (userInfo) userInfo.style.display = 'flex';
                if (avatar) avatar.textContent = currentUser.email ? currentUser.email[0].toUpperCase() : '?';
                if (email) email.textContent = currentUser.email || '';
                if (authText) authText.textContent = 'Sign in with Google';
                setSyncStatus('synced');
            } else {
                if (authBtn) authBtn.style.display = 'flex';
                if (signoutBtn) signoutBtn.style.display = 'none';
                if (userInfo) userInfo.style.display = 'none';
                if (syncEl) syncEl.classList.remove('visible');
            }
        }

        function setSyncStatus(state) {
            const el = document.getElementById('sync-status');
            if (!el) return;
            el.classList.remove('synced', 'syncing', 'offline', 'visible');
            if (!currentUser) return;
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
                docRef.set({
                    tasks: JSON.parse(JSON.stringify(tasks)),
                    taskCounter: taskCounter,
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                }).then(() => setSyncStatus('synced')).catch(() => setSyncStatus('offline'));
            }, 500);
        }

        function syncFromCloud() {
            if (!currentUser) return;
            const docRef = getUserDocRef();
            if (!docRef) return;
            setSyncStatus('syncing');
            docRef.get().then(snap => {
                if (!snap.exists) {
                    pushToCloud();
                    return;
                }
                const cloudData = snap.data();
                if (!cloudData || !cloudData.tasks) {
                    pushToCloud();
                    return;
                }
                const merged = mergeTasks(tasks, cloudData.tasks, taskCounter, cloudData.taskCounter || 0);
                tasks = merged.tasks;
                taskCounter = merged.taskCounter;
                saveAll();
                renderAllColumns();
                updateDailySummary();
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

        // ─── Unified keyboard handler ─────────────────────────────────────────────
        //
        // FIX: previously two separate keydown listeners competed with each other.
        // Now there is ONE listener that decides, in order:
        //   1. If the floating input is focused → only handle Enter / Escape there.
        //   2. If a task is selected → run shortcut keys (← → 1 2 3 Del Esc).
        //      Consume those keys so they never reach the "open input" path.
        //   3. Otherwise → printable characters open the floating input.
        //
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

            // Close input when clicking outside.
            // Exclude the FAB — its onclick opens the input; if we don't
            // exclude it the document click fires on the same tap and
            // immediately closes what the FAB just opened.
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
                // Ignore while browser-native controls have focus (other than our input)
                const tag = e.target.tagName;
                if (tag === 'TEXTAREA' || tag === 'SELECT') return;
                if (tag === 'INPUT' && e.target !== input) return;
                // Ignore modifier combos (Ctrl+Z, Cmd+C, etc.)
                if (e.ctrlKey || e.metaKey) return;

                const key = e.key;

                // ── Alt combinations ────────────────────────────────────────────────
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

                    return; // block all other Alt combos
                }

                // ── If a task is selected: shortcut mode ──────────────────────────
                if (selectedTask) {
                    const { column, taskId } = selectedTask;

                    if (key === 'ArrowLeft') {
                        e.preventDefault();
                        moveTaskBackward(column, taskId);
                        return;
                    }
                    if (key === 'ArrowRight') {
                        e.preventDefault();
                        moveTaskForward(column, taskId);
                        return;
                    }
                    if (key === '1') {
                        e.preventDefault();
                        setPriority(column, taskId, 'high');
                        return;
                    }
                    if (key === '2') {
                        e.preventDefault();
                        setPriority(column, taskId, 'medium');
                        return;
                    }
                    if (key === '3') {
                        e.preventDefault();
                        setPriority(column, taskId, 'low');
                        return;
                    }
                    if (key === 'Delete' || key === 'Backspace') {
                        e.preventDefault();
                        const col = column, id = taskId;
                        deselectTask();
                        deleteTaskWithUndo(col, id);
                        return;
                    }
                    if (key === 'Escape') {
                        e.preventDefault();
                        deselectTask();
                        return;
                    }
                    // Any other key while selected → fall through to open input
                }

                // ── No task selected: open floating input with typed character ─────
                // FIX: Backspace while no task is selected and input is closed has
                // no sensible action, so skip it.
                if (key === 'Escape' || key === 'Delete') return;
                if (key === 'ArrowLeft' || key === 'ArrowRight' ||
                    key === 'ArrowUp'   || key === 'ArrowDown') return;

                // ── Goto mode digits (after Alt+G) ──────────────────────────────
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

                // Space held → start voice (only when input is closed)
                if (key === ' ') {
                    e.preventDefault();
                    if (!spaceHeld) {
                        spaceHeld = true;
                        startVoice();
                    }
                    // Always return here — block auto-repeat from falling
                    // through to the printable-character handler below.
                    return;
                }

                // While voice is active swallow ALL other keys so nothing
                // accidentally opens the text input mid-dictation.
                if (voiceActive) {
                    e.preventDefault();
                    return;
                }

                if (key.length === 1) {          // printable character
                    // Just show + focus the input. The browser will insert the
                    // character naturally via its own default keydown handling.
                    // DO NOT manually append `key` here — doing so before focus()
                    // causes the character to be written twice (once by us, once
                    // by the browser's default input behaviour after focus lands).
                    openFloatingInput();
                }
            });

            // Space/Shift keyup → stop voice
            // Use window (not document) so it fires even if a child element
            // called stopPropagation on keydown or if focus shifted mid-hold.
            window.addEventListener('keyup', (e) => {
                if (e.key === ' ' && spaceHeld) {
                    spaceHeld = false;
                    stopVoice();
                }
            }, true); // capture phase — runs before any stopPropagation

            // Safety net: if the window loses focus while space is held
            // (e.g. alt-tab, OS notification), the keyup never fires.
            // Stop voice whenever the page becomes hidden or window blurs.
            window.addEventListener('blur', () => {
                if (spaceHeld) {
                    spaceHeld = false;
                    stopVoice();
                }
            });
            document.addEventListener('visibilitychange', () => {
                if (document.hidden && spaceHeld) {
                    spaceHeld = false;
                    stopVoice();
                }
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


        // ─── Voice input ──────────────────────────────────────────────────────────
        //
        // Chrome fires onend after ~1s silence even with continuous:true, and
        // reusing the same instance across stop/start is unreliable — it can
        // throw "already started" or silently fail. The robust pattern is:
        //   • Create a fresh SpeechRecognition instance for every session.
        //   • In onend, if Space is still held, spawn a new instance and start it.
        //   • Ignore non-fatal errors (no-speech, aborted) while Space is held;
        //     only onerror:'not-allowed' should surface to the user.
        //
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
                // other errors (no-speech etc.) — onend fires next, handles restart
            };

            rec.onend = () => {
                if (voiceSession !== session) return;
                if (!voiceActive) return;   // stopVoice() already closed everything
                // Space still held — browser auto-stopped; restart immediately
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
            if (hint) hint.textContent = isMobile ? 'Release button to confirm' : '';
            if (hint && !isMobile) hint.innerHTML = 'Release <kbd style="background:rgba(255,255,255,0.15);padding:2px 7px;border-radius:4px;border:1px solid rgba(255,255,255,0.3)">Space</kbd> to confirm';
            if (overlay) overlay.classList.add('active');
            voiceRecognition = makeRecognition();
            try { voiceRecognition.start(); } catch (_) { forceStopVoice(); }
        }

        function stopVoice() {
            if (!voiceActive) return;
            // Mark inactive and increment session FIRST — this makes every
            // pending onend callback a no-op, so nothing can restart after this.
            voiceActive   = false;
            voiceSession += 1;
            // Close the overlay immediately — don't wait for onend.
            const overlay = document.getElementById('voice-overlay');
            if (overlay) overlay.classList.remove('active');
            // Grab whatever transcript is showing right now and commit it.
            const el   = document.getElementById('voice-transcript');
            const text = (voiceAccumulated + (el ? ' ' + el.textContent : '')).trim();
            // Tell the current instance to stop (fire-and-forget).
            try { voiceRecognition.stop(); } catch (_) {}
            voiceRecognition = null;
            // Commit
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
        // Uses pointer events (covers both touch and mouse) so the button starts
        // voice on press and stops on release — mirroring Space on desktop.
        function setupMobileMic() {
            const btn = document.getElementById('mobile-mic-btn');
            if (!btn) return;

            btn.style.touchAction = 'none'; // prevent browser scroll-delay swallowing pointerdown

            function onPress(e) {
                e.preventDefault();           // prevent ghost click / text selection
                if (!voiceSR) {
                    showToast('Voice not supported in this browser', () => {});
                    return;
                }
                btn.setPointerCapture(e.pointerId); // keep events even if finger drifts off
                startVoice(true);             // true = mobile (shows different hint)
            }

            function onRelease(e) {
                e.preventDefault();
                stopVoice();
            }

            btn.addEventListener('pointerdown',   onPress);
            btn.addEventListener('pointerup',     onRelease);
            btn.addEventListener('pointercancel', onRelease); // call dropped, finger lifted outside, etc.
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

        // FIX: After moving/priority-change the selection must survive re-render.
        // restoreSelection() re-applies the 'selected' class to the newly rendered card.
        function restoreSelection() {
            if (!selectedTask) return;
            const card = document.getElementById(`task-${selectedTask.taskId}`);
            if (card) {
                card.classList.add('selected');
            } else {
                selectedTask = null;
            }
        }

        // ─── Task selector helpers (Alt+G / Alt+N) ────────────────────────────
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
            else if (column === 'working') moveTaskWithUndo('working', 'done',    taskId);
            // 'done' has no forward column
        }

        function moveTaskBackward(column, taskId) {
            if (column === 'done')    moveTaskWithUndo('done',    'working', taskId);
            else if (column === 'working') moveTaskWithUndo('working', 'todo',    taskId);
            // 'todo' has no backward column
        }

        // ─── CRUD ─────────────────────────────────────────────────────────────────
        function addTaskToTodo(text) {
            taskCounter++;
            const task = {
                id: Date.now(),
                number: taskCounter,
                text: text,
                priority: 'medium',
                dueDate: null,
                createdAt: new Date().toISOString()
            };
            tasks.todo.push(task);
            saveAll();
            renderColumn('todo');
        }

        function deleteTask(column, taskId) {
            tasks[column] = tasks[column].filter(t => t.id !== taskId);
            saveAll();
            renderColumn(column);
        }

        function deleteTaskWithUndo(column, taskId) {
            const task = tasks[column].find(t => t.id === taskId);
            if (!task) return;

            const snapshot = { column, task: { ...task } };
            tasks[column] = tasks[column].filter(t => t.id !== taskId);
            saveAll();
            renderColumn(column);

            showToast(`Deleted "#${task.number} ${task.text}"`, () => {
                tasks[snapshot.column].push(snapshot.task);
                saveAll();
                renderColumn(snapshot.column);
            });
        }

        function moveTask(fromColumn, toColumn, taskId) {
            const idx = tasks[fromColumn].findIndex(t => t.id === taskId);
            if (idx === -1) return;
            const [task] = tasks[fromColumn].splice(idx, 1);
            tasks[toColumn].push(task);
            saveAll();
            renderColumn(fromColumn);
            renderColumn(toColumn);
            if (toColumn === 'done') updateDailySummary();
        }

        function moveTaskWithUndo(fromColumn, toColumn, taskId) {
            const task = tasks[fromColumn].find(t => t.id === taskId);
            if (!task) return;

            moveTask(fromColumn, toColumn, taskId);

            // FIX: update selectedTask.column so subsequent arrow keys work correctly
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
                    renderColumn(fromColumn);
                    renderColumn(toColumn);
                    if (fromColumn === 'done' || toColumn === 'done') updateDailySummary();
                    // Restore selection after undo
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
            // FIX: re-apply selection highlight after renderColumn rebuilds the DOM
            restoreSelection();
        }

        function cyclePriority(column, taskId) {
            const task = tasks[column].find(t => t.id === taskId);
            if (!task) return;
            const priorities = ['low', 'medium', 'high'];
            task.priority = priorities[(priorities.indexOf(task.priority) + 1) % 3];
            saveAll();
            renderColumn(column);
            restoreSelection();
        }

        function setDueDate(column, taskId, date) {
            const task = tasks[column].find(t => t.id === taskId);
            if (!task) return;
            task.dueDate = date || null;
            saveAll();
            renderColumn(column);
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
        function clearDoneTasks() {
            if (tasks.done.length === 0) return;
            if (!confirm('Clear all completed tasks?')) return;
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
        function saveAll() {
            localStorage.setItem('tasks', JSON.stringify(tasks));
            localStorage.setItem('taskCounter', taskCounter.toString());
            pushToCloud();
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
                undoCallback();
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

        function renderColumn(column) {
            const list  = document.getElementById(`${column}-list`);
            const count = document.getElementById(`${column}-count`);
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

            const isOverdue = task.dueDate && new Date(task.dueDate) < new Date() && column !== 'done';
            const dateDisplay = task.dueDate
                ? new Date(task.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                : '';
            const priorityLabel = task.priority.charAt(0).toUpperCase() + task.priority.slice(1);

            // Build DOM programmatically to avoid inline-event injection of serialized callbacks
            card.innerHTML = `
                <div class="drag-handle">⋮⋮</div>
                <div class="task-header">
                    <span class="task-number">#${task.number}</span>
                    <span class="task-text">${escapeHtml(task.text)}</span>
                </div>
                <div class="task-meta">
                    <div class="task-left">
                        <span class="priority-badge ${task.priority}" title="Click to cycle priority (or press 1/2/3 when selected)">
                            ${task.priority === 'high' ? '🔴' : task.priority === 'medium' ? '🟡' : '🟢'} ${priorityLabel}
                        </span>
                        ${task.dueDate ? `<span class="due-date ${isOverdue ? 'overdue' : ''}">📅 ${dateDisplay}</span>` : ''}
                    </div>
                    <div class="task-hover-controls">
                        <button class="date-btn" title="Set due date">
                            📅 ${task.dueDate ? 'Change' : 'Date'}
                        </button>
                        <input type="date" id="date-picker-${task.id}" value="${task.dueDate || ''}"
                               style="position:absolute;opacity:0;width:0;height:0;pointer-events:none;">
                        ${column === 'todo'    ? `<button class="move-btn" title="Move to Working On (→)">→</button>` : ''}
                        ${column === 'working' ? `<button class="move-btn back-btn" title="Move back to To Do (←)">←</button><button class="move-btn fwd-btn" title="Move to Done (→)">→</button>` : ''}
                        ${column === 'done'    ? `<button class="move-btn" title="Move back to Working On (←)">←</button>` : ''}
                        <button class="delete-btn" title="Delete (Del)">✕</button>
                    </div>
                </div>
            `;

            // ── Attach events safely (no eval/toString) ───────────────────────────
            card.querySelector('.priority-badge').addEventListener('click', (e) => {
                e.stopPropagation();
                cyclePriority(column, task.id);
            });

            card.querySelector('.date-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                openDatePicker(task.id);
            });

            card.querySelector(`#date-picker-${task.id}`).addEventListener('change', (e) => {
                setDueDate(column, task.id, e.target.value);
            });

            card.querySelector('.delete-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                if (selectedTask && selectedTask.taskId === task.id) deselectTask();
                deleteTaskWithUndo(column, task.id);
            });

            // Move buttons
            if (column === 'todo') {
                card.querySelector('.move-btn').addEventListener('click', (e) => {
                    e.stopPropagation();
                    moveTaskWithUndo('todo', 'working', task.id);
                });
            }
            if (column === 'working') {
                card.querySelector('.back-btn').addEventListener('click', (e) => {
                    e.stopPropagation();
                    moveTaskWithUndo('working', 'todo', task.id);
                });
                card.querySelector('.fwd-btn').addEventListener('click', (e) => {
                    e.stopPropagation();
                    moveTaskWithUndo('working', 'done', task.id);
                });
            }
            if (column === 'done') {
                card.querySelector('.move-btn').addEventListener('click', (e) => {
                    e.stopPropagation();
                    moveTaskWithUndo('done', 'working', task.id);
                });
            }

            // Click to select/deselect
            card.addEventListener('click', (e) => {
                if (e.target.closest('button') || e.target.closest('.priority-badge')) return;
                if (taskSelectorActive) exitTaskSelector();
                if (selectedTask && selectedTask.taskId === task.id) {
                    deselectTask();
                } else {
                    selectTask(column, task.id);
                }
            });

            // Drag
            card.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('text/plain', JSON.stringify({ taskId: task.id, fromColumn: column }));
                card.style.opacity = '0.4';
                deselectTask();
            });
            card.addEventListener('dragend', () => { card.style.opacity = '1'; });

            return card;
        }

        function escapeHtml(str) {
            return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        }

        // ─── Date picker ──────────────────────────────────────────────────────────
        function openDatePicker(taskId) {
            const picker = document.getElementById(`date-picker-${taskId}`);
            if (!picker) return;
            // Briefly make it visible so showPicker() works cross-browser
            Object.assign(picker.style, { position:'relative', opacity:'1', width:'auto', height:'auto', pointerEvents:'all' });
            try { picker.showPicker(); } catch (_) { picker.click(); }
            setTimeout(() => {
                Object.assign(picker.style, { position:'absolute', opacity:'0', width:'0', height:'0', pointerEvents:'none' });
            }, 100);
        }

        // ─── Drag & drop ──────────────────────────────────────────────────────────
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
            document.getElementById('theme-icon').textContent = isLightMode ? '🌙' : '☀️';
            document.getElementById('theme-text').textContent = isLightMode ? 'Dark Mode' : 'Light Mode';
        }

        // ─── CSV export ───────────────────────────────────────────────────────────
        function exportToCSV() {
            const rows = [];
            Object.keys(tasks).forEach(status => {
                tasks[status].forEach(task => {
                    rows.push({
                        Number:   task.number,
                        Task:     task.text,
                        Status:   status === 'todo' ? 'To Do' : status === 'working' ? 'Working On' : 'Done',
                        Priority: task.priority,
                        'Due Date': task.dueDate || 'None',
                        Created:  new Date(task.createdAt).toLocaleDateString()
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
        function resetAllData() {
            if (!confirm('Delete all tasks and reset Tasky? This cannot be undone.')) return;
            tasks = { todo: [], working: [], done: [] };
            taskCounter = 0;
            localStorage.removeItem('hasOnboarded');
            if (currentUser) {
                const docRef = getUserDocRef();
                if (docRef) docRef.delete().catch(() => {});
            }
            saveAll();
            renderAllColumns();
            updateDailySummary();
            deselectTask();
            exitTaskSelector();
            document.getElementById('dropdown').classList.remove('show');
            showToast('All data reset', () => {});
        }

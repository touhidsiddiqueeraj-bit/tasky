// ─── State ────────────────────────────────────────────────────────────────
        let tasks = JSON.parse(localStorage.getItem('tasks')) || { todo: [], working: [], done: [] };
        let taskCounter = parseInt(localStorage.getItem('taskCounter')) || 0;

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
        updateDailySummary();
        setupKeyboard();          // single unified keyboard handler
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
            // Handle the redirect result FIRST — this resolves the sign-in that
            // happened after signInWithRedirect returned from the Google OAuth page.
            // Must run before onAuthStateChanged so the user object is already
            // linked/upgraded by the time our state handler fires.
            firebase.auth(app).getRedirectResult().then(result => {
                if (result && result.user) {
                    // Redirect completed — push local tasks to link any offline changes
                    pushToCloud();
                    showToast('☁️ Signed in & synced', () => {});
                }
            }).catch(err => {
                // auth/credential-already-in-use: anon had data, Google account exists elsewhere.
                // Fall back to a plain redirect (data on the Google account will be used on sync).
                if (err.code === 'auth/credential-already-in-use' || err.code === 'auth/email-already-in-use') {
                    const provider = new firebase.auth.GoogleAuthProvider();
                    firebase.auth(app).signInWithRedirect(provider).catch(() => {});
                } else if (err.code !== 'auth/no-auth-event' && err.code !== 'auth/null-user') {
                    console.warn('Redirect result error:', err.code);
                }
            });

            firebase.auth(app).onAuthStateChanged(user => {
                const prevUid = currentUser ? currentUser.uid : null;
                currentUser = user;
                window.currentUser = user; // expose for tasky-collab.js

                if (user) {
                    if (user.uid !== prevUid) {
                        syncFromCloud(!!prevUid);
                    }
                } else {
                    // No user at all — sign in anonymously to preserve data
                    firebase.auth(app).signInAnonymously().catch(err => {
                        console.warn('Anonymous sign-in failed:', err);
                        // Fallback: keep using localStorage only
                    });
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

            // Use redirect flow — popups are blocked in Android WebView (Capacitor).
            // On web browsers this is also reliable (no popup-blocker issues).
            // getRedirectResult() at the top of setupFirebase() handles the return.
            if (currentUser && currentUser.isAnonymous) {
                // Link the anonymous account so locally-created tasks survive sign-in
                currentUser.linkWithRedirect(provider).catch(err => {
                    // If linking fails (account already exists), just do a plain redirect.
                    // syncFromCloud will merge tasks on arrival.
                    if (err.code === 'auth/credential-already-in-use' || err.code === 'auth/email-already-in-use') {
                        firebase.auth(app).signInWithRedirect(provider).catch(() => {});
                    } else {
                        console.warn('Link redirect error:', err.code);
                    }
                });
            } else {
                firebase.auth(app).signInWithRedirect(provider).catch(err => {
                    console.warn('Sign-in redirect error:', err.code);
                });
            }
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

            firebase.auth(app).signOut().then(() => {
                firebase.auth(app).signInAnonymously().catch(() => {});
            }).catch(() => {});

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
                docRef.set({
                    tasks: JSON.parse(JSON.stringify(tasks)),
                    taskCounter: taskCounter,
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                }, { merge: true }).then(() => setSyncStatus('synced')).catch(() => setSyncStatus('offline'));
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
                        tasks = { todo: [], working: [], done: [] };
                        taskCounter = 0;
                    } else {
                        pushToCloud();
                    }
                    saveAll();
                    renderAllColumns();
                    updateDailySummary();
                    setSyncStatus('synced');
                    return;
                }
                const cloudData = snap.data();
                if (!cloudData || !cloudData.tasks) {
                    if (replace) {
                        tasks = { todo: [], working: [], done: [] };
                        taskCounter = 0;
                    } else {
                        pushToCloud();
                    }
                    saveAll();
                    renderAllColumns();
                    updateDailySummary();
                    setSyncStatus('synced');
                    return;
                }
                if (replace) {
                    tasks = JSON.parse(JSON.stringify(cloudData.tasks));
                    taskCounter = cloudData.taskCounter || 0;
                } else {
                    const merged = mergeTasks(tasks, cloudData.tasks, taskCounter, cloudData.taskCounter || 0);
                    tasks = merged.tasks;
                    taskCounter = merged.taskCounter;
                }
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
        function saveAll() {
            localStorage.setItem('tasks', JSON.stringify(tasks));
            localStorage.setItem('taskCounter', taskCounter.toString());
            // Keep a local snapshot so we can restore state on logout
            localStorage.setItem('tasks_local', JSON.stringify(tasks));
            localStorage.setItem('taskCounter_local', taskCounter.toString());
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
                        <span class="priority-badge ${task.priority}" title="Click to cycle priority (or press 1/2/3 when selected)">
                            ${task.priority === 'high' ? '🔴' : task.priority === 'medium' ? '🟡' : '🟢'} ${priorityLabel}
                        </span>
                        ${task.dueDate ? `<span class="due-date ${isOverdue ? 'overdue' : ''}">📅 ${dateDisplay}</span>` : ''}
                    </div>
                    <div class="task-hover-controls">
                        <button class="edit-btn" title="Edit task text (double-click)">✏️</button>
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

            card.querySelector('.priority-badge').addEventListener('click', (e) => {
                e.stopPropagation();
                cyclePriority(column, task.id);
            });

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
                        task.text = newText;          // keep local ref in sync
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
                // Small delay so click on ✓ button fires before blur
                setTimeout(() => {
                    if (card.classList.contains('editing')) commitEdit();
                }, 150);
            });

            card.querySelector('.date-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                openDatePicker(task.id);
            });

            card.querySelector('input[type="date"]').addEventListener('change', (e) => {
                setDueDate(column, task.id, e.target.value);
            });

            card.querySelector('.delete-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                if (selectedTask && selectedTask.taskId === task.id) deselectTask();
                deleteTaskWithUndo(column, task.id);
            });


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

            card.addEventListener('click', (e) => {
                if (e.target.closest('button') || e.target.closest('.priority-badge')) return;
                if (taskSelectorActive) exitTaskSelector();
                if (selectedTask && selectedTask.taskId === task.id) {
                    deselectTask();
                } else {
                    selectTask(column, task.id);
                }
            });

            card.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('text/plain', JSON.stringify({ taskId: task.id, fromColumn: column }));
                card.style.opacity = '0.4';
                deselectTask();
            });
            card.addEventListener('dragend', () => { card.style.opacity = ''; });

            // ── Touch drag (mobile / Capacitor) ──────────────────────────────
            setupTouchDrag(card, task.id, column);

            return card;
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

            _touchDrag = { taskId, fromColumn: column, ghost, card,
                           offsetX: x - rect.left, offsetY: y - rect.top };

            // Haptic feedback if available
            if (navigator.vibrate) navigator.vibrate(30);
        }

        function _moveTouchDrag(x, y) {
            if (!_touchDrag) return;
            const { ghost, offsetX, offsetY } = _touchDrag;
            ghost.style.left = (x - offsetX) + 'px';
            ghost.style.top  = (y - offsetY) + 'px';

            // Highlight the column the ghost is over
            document.querySelectorAll('.task-list').forEach(el => {
                const r = el.getBoundingClientRect();
                const over = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
                el.classList.toggle('drop-zone-hover', over);
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

        function setCardOpacity(val) {
            cardOpacity = Math.max(40, Math.min(100, val));
            document.body.style.setProperty('--card-opacity', cardOpacity / 100);
            localStorage.setItem('cardOpacity', cardOpacity);
            var valEl = document.getElementById('card-opacity-value');
            if (valEl) valEl.textContent = cardOpacity + '%';
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
            tasks = { todo: [], working: [], done: [] };
            taskCounter = 0;
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

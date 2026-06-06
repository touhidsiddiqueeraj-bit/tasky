// ─── State ────────────────────────────────────────────────────────────────
        let workspaces = [];
        let activeWorkspaceId = 1;
        let nextWorkspaceId = 2;
        let tasks = { todo: [], working: [], done: [] };
        let taskCounter = 0;

        // ─── Workspace init & migration ────────────────────────────────────────────
        // NOTE: workspace data is fully populated in boot() below, which handles both
        // encrypted and plaintext paths. These defaults are overwritten before first render.
        (function initWorkspacesDefaults() {
            // Set up minimal defaults so the app has a valid state if boot() is delayed
            var meta = localStorage.getItem('workspaces_meta');
            if (meta) {
                try {
                    workspaces = JSON.parse(meta);
                    activeWorkspaceId = parseInt(localStorage.getItem('ws_active')) || (workspaces[0] ? workspaces[0].id : 1);
                    nextWorkspaceId = workspaces.reduce(function(max, w) { return Math.max(max, w.id); }, 0) + 1;
                    var ws = workspaces.find(function(w) { return w.id === activeWorkspaceId; });
                    if (ws) {
                        var saved = localStorage.getItem('ws_tasks_' + ws.id);
                        if (saved) tasks = JSON.parse(saved);
                        var cnt = localStorage.getItem('ws_counter_' + ws.id);
                        if (cnt) taskCounter = parseInt(cnt);
                    }
                } catch(e) { /* will be fixed by boot() */ }
            } else if (localStorage.getItem('_encSalt')) {
                // Encrypted mode — boot() will handle decryption; skip here
            } else {
                // First-ever launch: migrate legacy keys if present
                var oldTasks = localStorage.getItem('tasks');
                if (oldTasks) {
                    var oldCounter = parseInt(localStorage.getItem('taskCounter')) || 0;
                    var oldCode = localStorage.getItem('tasky_groupCode') || null;
                    try { tasks = JSON.parse(oldTasks); } catch(_) { tasks = { todo: [], working: [], done: [] }; }
                    taskCounter = oldCounter;
                    workspaces = [{ id: 1, name: 'Personal', collabCode: oldCode }];
                    activeWorkspaceId = 1; nextWorkspaceId = 2;
                    try { localStorage.setItem('ws_tasks_1', oldTasks); } catch(_) {}
                    try { localStorage.setItem('ws_counter_1', String(taskCounter)); } catch(_) {}
                    try { localStorage.setItem('workspaces_meta', JSON.stringify(workspaces)); } catch(_) {}
                    ['tasks','taskCounter','tasks_local','taskCounter_local','tasky_groupCode'].forEach(function(k){localStorage.removeItem(k);});
                }
            }
        })();

        // ─── Workspace helpers ─────────────────────────────────────────────────────
        function _safeSetItem(key, value) {
            try { localStorage.setItem(key, value); return true; } catch(_) {
                showToast('⚠️ Storage full — could not save data', function() {});
                return false;
            }
        }
        function saveWorkspacesMeta() {
            var meta = workspaces.map(function(w) { return { id: w.id, name: w.name, collabCode: w.collabCode }; });
            if (_encKey && _allWorkspaceData) {
                _allWorkspaceData.workspaces = meta;
            } else {
                _safeSetItem('workspaces_meta', JSON.stringify(meta));
            }
        }
        function saveCurrentWorkspaceData() {
            if (_encKey && _allWorkspaceData) {
                _allWorkspaceData['ws_tasks_' + activeWorkspaceId] = JSON.parse(JSON.stringify(tasks));
                _allWorkspaceData['ws_counter_' + activeWorkspaceId] = taskCounter;
            } else {
                _safeSetItem('ws_tasks_' + activeWorkspaceId, JSON.stringify(tasks));
                _safeSetItem('ws_counter_' + activeWorkspaceId, String(taskCounter));
            }
        }
        function loadWorkspaceData(id) {
            if (_encKey && _allWorkspaceData) {
                var saved = _allWorkspaceData['ws_tasks_' + id];
                tasks = saved ? JSON.parse(JSON.stringify(saved)) : { todo: [], working: [], done: [] };
                var cnt = _allWorkspaceData['ws_counter_' + id];
                taskCounter = cnt !== undefined ? cnt : 0;
            } else {
                var saved = localStorage.getItem('ws_tasks_' + id);
                tasks = saved ? (() => { try { return JSON.parse(saved); } catch(_) { return { todo: [], working: [], done: [] }; } })() : { todo: [], working: [], done: [] };
                var cnt = localStorage.getItem('ws_counter_' + id);
                taskCounter = cnt ? parseInt(cnt) : 0;
            }
        }
        function createWorkspace(name, collabCode) {
            // Find the lowest available workspace number >= 2
            var usedNumbers = workspaces.map(function(w) { return w.id; });
            var id = 2;
            while (usedNumbers.indexOf(id) !== -1) id++;
            nextWorkspaceId = Math.max(nextWorkspaceId, id + 1);
            var ws = { id: id, name: name || 'Workspace ' + id, collabCode: collabCode || null };
            workspaces.push(ws);
            if (_encKey && _allWorkspaceData) {
                _allWorkspaceData['ws_tasks_' + id] = { todo: [], working: [], done: [] };
                _allWorkspaceData['ws_counter_' + id] = 0;
            } else {
                _safeSetItem('ws_tasks_' + id, JSON.stringify({ todo: [], working: [], done: [] }));
                _safeSetItem('ws_counter_' + id, '0');
            }
            saveWorkspacesMeta();
            return id;
        }
        function deleteWorkspace(id) {
            if (id === 1) return;
            var idx = workspaces.findIndex(function(w) { return w.id === id; });
            if (idx === -1) return;
            workspaces.splice(idx, 1);
            if (_encKey && _allWorkspaceData) {
                delete _allWorkspaceData['ws_tasks_' + id];
                delete _allWorkspaceData['ws_counter_' + id];
            } else {
                localStorage.removeItem('ws_tasks_' + id);
                localStorage.removeItem('ws_counter_' + id);
            }
            saveWorkspacesMeta();
            pushToCloud();
        }
        function switchWorkspace(id) {
            if (id === activeWorkspaceId) return;
            saveCurrentWorkspaceData();
            var prevId = activeWorkspaceId;
            var board = document.querySelector('.board');
            if (board) board.classList.add('board-switching');
            setTimeout(function() {
                activeWorkspaceId = id;
                loadWorkspaceData(id);
                _safeSetItem('ws_active', String(id));
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
            var hasTasks = false;
            if (_encKey && _allWorkspaceData) {
                var wsTasks = _allWorkspaceData['ws_tasks_' + id] || { todo: [], working: [], done: [] };
                hasTasks = wsTasks.todo.length > 0 || wsTasks.working.length > 0 || wsTasks.done.length > 0;
            } else {
                var t = localStorage.getItem('ws_tasks_' + id);
                hasTasks = t && (function() { try { var p = JSON.parse(t); return p && Object.values(p).some(function(arr) { return arr.length > 0; }); } catch(_) { return false; } })();
            }
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
        window._updateEncIndicator = _updateEncIndicator;
        window._setupEncryption = _setupEncryption;
        window._unlockEncryption = _unlockEncryption;
        window._encryptStoredData = _encryptStoredData;

        // ─── Expose Task Groups API ────────────────────────────────────────────────
        window.addTask = addTask;
        window.hideFloatingInput = hideFloatingInput;
        Object.defineProperty(window, 'tasks', { get: () => tasks, configurable: true });

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
        const WIP_LIMIT = 3;
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
                // Save to the correct workspace key (not the old 'tasks' key)
                try { localStorage.setItem('ws_tasks_' + activeWorkspaceId, JSON.stringify(tasks)); } catch(_) {}
            }
        })();
        let voiceRecognition = null;
        let voiceActive      = false;
        let spaceHeld        = false;
        let voiceSR           = null;
        let voiceAccumulated  = '';
        let voiceSession       = 0;
        let currentUser = null;
        let app = null;
        let db = null;
        let syncTimeout = null;
        let _lastUndoCallback = null;

        // ─── Encryption state ───────────────────────────────────────────────────────
        let _encKey = null;
        let _encSalt = null;
        let _allWorkspaceData = null;  // { workspaces, ws_tasks_1, ws_counter_1, ... }

        // ─── Encryption utils ───────────────────────────────────────────────────────
        function _bytesToBase64(bytes) {
            var binary = '';
            for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
            return btoa(binary);
        }
        function _base64ToBytes(str) {
            var binary = atob(str);
            var bytes = new Uint8Array(binary.length);
            for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            return bytes;
        }
        async function _deriveKey(passphrase, salt) {
            var enc = new TextEncoder();
            var keyMaterial = await crypto.subtle.importKey(
                'raw', enc.encode(passphrase), 'PBKDF2', false,
                ['deriveKey']
            );
            return crypto.subtle.deriveKey(
                {
                    name: 'PBKDF2',
                    salt: salt,
                    iterations: 100000,
                    hash: 'SHA-256'
                },
                keyMaterial,
                { name: 'AES-GCM', length: 256 },
                false,
                ['encrypt', 'decrypt']
            );
        }
        async function _encryptString(plain) {
            if (!_encKey) return plain;
            var enc = new TextEncoder();
            var iv = crypto.getRandomValues(new Uint8Array(12));
            var ciphertext = await crypto.subtle.encrypt(
                { name: 'AES-GCM', iv: iv },
                _encKey,
                enc.encode(plain)
            );
            var combined = new Uint8Array(iv.length + ciphertext.byteLength);
            combined.set(iv, 0);
            combined.set(new Uint8Array(ciphertext), iv.length);
            return 'enc_v1:' + _bytesToBase64(combined);
        }
        async function _decryptString(enc) {
            if (!enc || typeof enc !== 'string' || !enc.startsWith('enc_v1:')) return enc;
            var raw = _base64ToBytes(enc.slice(7));
            var iv = raw.slice(0, 12);
            var data = raw.slice(12);
            var dec = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: iv },
                _encKey,
                data
            );
            return new TextDecoder().decode(dec);
        }
        async function _verifyEncryptionKey() {
            var stored = localStorage.getItem('_enc_verify');
            if (!stored) return false;
            try {
                var dec = await _decryptString(stored);
                return dec === '__tasky_ok__';
            } catch(_) { return false; }
        }
        async function _storeEncryptionVerify() {
            var enc = await _encryptString('__tasky_ok__');
            try { localStorage.setItem('_enc_verify', enc); } catch(_) {}
        }

        // ─── Encryption passphrase modals ──────────────────────────────────────────
        function _showEncModal(type) {
            return new Promise(function(resolve) {
                var overlay = document.getElementById('enc-' + type + '-overlay');
                if (!overlay) { resolve(''); return; }
                var input = overlay.querySelector('.enc-pass-input');
                var confirmInput = overlay.querySelector('.enc-pass-confirm');
                var errorEl = overlay.querySelector('.enc-error');
                var submitBtn = overlay.querySelector('.enc-submit-btn');
                var warningEl = overlay.querySelector('.enc-warning');
                if (confirmInput) confirmInput.value = '';
                input.value = '';
                errorEl.style.display = 'none';
                overlay.classList.remove('hidden');
                overlay.classList.add('visible');
                input.focus();

                function cleanup() {
                    overlay.classList.remove('visible');
                    overlay.classList.add('hidden');
                    setTimeout(function() { overlay.classList.remove('hidden'); }, 270);
                }

                submitBtn.onclick = function() {
                    var val = input.value;
                    if (type === 'setup') {
                        if (val.length < 4) {
                            errorEl.textContent = 'Passphrase must be at least 4 characters';
                            errorEl.style.display = 'block';
                            return;
                        }
                        if (val !== confirmInput.value) {
                            errorEl.textContent = 'Passphrases do not match';
                            errorEl.style.display = 'block';
                            return;
                        }
                    } else {
                        if (!val) {
                            errorEl.textContent = 'Enter your passphrase';
                            errorEl.style.display = 'block';
                            return;
                        }
                    }
                    submitBtn.disabled = true;
                    submitBtn.textContent = type === 'setup' ? 'Setting up…' : 'Unlocking…';
                    // On Enter we will resolve; actual key derivation happens in boot()
                    resolve(val);
                    cleanup();
                };

                input.onkeydown = function(e) {
                    if (e.key === 'Enter') submitBtn.click();
                };
                if (confirmInput) {
                    confirmInput.onkeydown = function(e) {
                        if (e.key === 'Enter') submitBtn.click();
                    };
                }
            });
        }

        async function _setupEncryption(passphrase) {
            _encSalt = crypto.getRandomValues(new Uint8Array(16));
            try { localStorage.setItem('_encSalt', _bytesToBase64(_encSalt)); } catch(_) {}
            _encKey = await _deriveKey(passphrase, _encSalt);
            await _storeEncryptionVerify();
            // Build initial allWorkspaceData from existing plaintext keys
            _allWorkspaceData = {
                workspaces: workspaces.map(function(w) { return { id: w.id, name: w.name, collabCode: w.collabCode }; })
            };
            workspaces.forEach(function(w) {
                var t = localStorage.getItem('ws_tasks_' + w.id);
                var c = localStorage.getItem('ws_counter_' + w.id);
                if (t) try { _allWorkspaceData['ws_tasks_' + w.id] = JSON.parse(t); } catch(_) { _allWorkspaceData['ws_tasks_' + w.id] = { todo: [], working: [], done: [] }; }
                if (c !== null) _allWorkspaceData['ws_counter_' + w.id] = parseInt(c) || 0;
                // Remove plaintext keys
                localStorage.removeItem('ws_tasks_' + w.id);
                localStorage.removeItem('ws_counter_' + w.id);
            });
            localStorage.removeItem('workspaces_meta');
            await _encryptStoredData();
            _updateEncIndicator();
        }

        async function _unlockEncryption(passphrase) {
            var storedSalt = localStorage.getItem('_encSalt');
            if (!storedSalt) return false;
            _encSalt = _base64ToBytes(storedSalt);
            _encKey = await _deriveKey(passphrase, _encSalt);
            var ok = await _verifyEncryptionKey();
            if (!ok) {
                _encKey = null;
                _encSalt = null;
                return false;
            }
            // Load encrypted data
            var encData = localStorage.getItem('_enc_data');
            if (encData) {
                var plain = await _decryptString(encData);
                try { _allWorkspaceData = JSON.parse(plain); } catch(_) { _allWorkspaceData = null; }
            } else {
                _allWorkspaceData = {
                    workspaces: workspaces.map(function(w) { return { id: w.id, name: w.name, collabCode: w.collabCode }; })
                };
            }
            _updateEncIndicator();
            return true;
        }

        // Fallback for localStorage writes that survive encryption failure
        function _writeLocalEncFallback(key, data) {
            try { localStorage.setItem(key, JSON.stringify(data)); } catch(_) {}
        }
        function _encryptStoredData() {
            if (!_encKey || !_allWorkspaceData) return Promise.resolve();
            _allWorkspaceData.workspaces = workspaces.map(function(w) { return { id: w.id, name: w.name, collabCode: w.collabCode }; });
            var plain = JSON.stringify(_allWorkspaceData);
            return _encryptString(plain).then(function(enc) {
                localStorage.setItem('_enc_data', enc);
            }).catch(function(err) {
                console.warn('Encryption failed — falling back to plaintext:', err);
                // Fall back: write plaintext to individual keys so data is never lost
                workspaces.forEach(function(w) {
                    _writeLocalEncFallback('ws_tasks_' + w.id, _allWorkspaceData['ws_tasks_' + w.id]);
                    var c = _allWorkspaceData['ws_counter_' + w.id];
                    if (c !== undefined) _writeLocalEncFallback('ws_counter_' + w.id, c);
                });
                _encKey = null;
                _encSalt = null;
                localStorage.removeItem('_enc_data');
                localStorage.removeItem('_encSalt');
                localStorage.removeItem('_enc_verify');
                _updateEncIndicator();
                if (typeof showToast === 'function') showToast('🔓 Encryption error — switched to plaintext', function() {});
            });
        }

        function _updateEncIndicator() {
            var el = document.getElementById('enc-indicator');
            if (!el) return;
            if (_encKey) {
                el.textContent = '🔒';
                el.className = 'enc-indicator active';
                el.title = 'Encryption: Active';
            } else {
                el.textContent = '';
                el.className = 'enc-indicator';
                el.title = '';
            }
        }

        // ─── Boot (async) ──────────────────────────────────────────────────────────
        (async function boot() {
            // Sync init before any async
            if (isLightMode) {
                document.body.classList.add('light-mode');
                updateThemeButton();
            }
            if (customBg) applyCustomBg();
            initOpacity();

            // Populate workspaces/tasks from either encrypted or plaintext storage
            var storedSalt = localStorage.getItem('_encSalt');
            if (storedSalt) {
                // Encryption is active — unlock required
                var unlocked = false;
                while (!unlocked) {
                    var passphrase = await _showEncModal('unlock');
                    if (!passphrase) break;
                    unlocked = await _unlockEncryption(passphrase);
                    if (!unlocked) {
                        var errEl = document.querySelector('#enc-unlock-overlay .enc-error');
                        if (errEl) {
                            errEl.textContent = 'Wrong passphrase';
                            errEl.style.display = 'block';
                        }
                    }
                }
                if (_allWorkspaceData) {
                    workspaces = _allWorkspaceData.workspaces || [];
                    activeWorkspaceId = parseInt(localStorage.getItem('ws_active')) || (workspaces[0] ? workspaces[0].id : 1);
                    nextWorkspaceId = workspaces.reduce(function(max, w) { return Math.max(max, w.id); }, 0) + 1;
                    var ws = workspaces.find(function(w) { return w.id === activeWorkspaceId; });
                    if (ws) {
                        var saved = _allWorkspaceData['ws_tasks_' + ws.id];
                        tasks = saved ? JSON.parse(JSON.stringify(saved)) : { todo: [], working: [], done: [] };
                        var cnt = _allWorkspaceData['ws_counter_' + ws.id];
                        taskCounter = cnt !== undefined ? cnt : 0;
                    }
                }
            } else {
                // No encryption — original sync initWorkspaces
                var meta = localStorage.getItem('workspaces_meta');
                if (meta) {
                    try { workspaces = JSON.parse(meta); } catch(_) { workspaces = []; }
                    activeWorkspaceId = parseInt(localStorage.getItem('ws_active')) || (workspaces[0] ? workspaces[0].id : 1);
                    nextWorkspaceId = workspaces.reduce(function(max, w) { return Math.max(max, w.id); }, 0) + 1;
                } else {
                    var oldTasks;
                    try { oldTasks = JSON.parse(localStorage.getItem('tasks')); } catch(_) { oldTasks = null; }
                    var oldCounter = parseInt(localStorage.getItem('taskCounter')) || 0;
                    var oldCode = localStorage.getItem('tasky_groupCode') || null;
                    tasks = oldTasks || { todo: [], working: [], done: [] };
                    taskCounter = oldCounter;
                    workspaces = [{ id: 1, name: 'Personal', collabCode: oldCode }];
                    activeWorkspaceId = 1;
                    nextWorkspaceId = 2;
                    _safeSetItem('ws_tasks_1', JSON.stringify(tasks));
                    _safeSetItem('ws_counter_1', String(taskCounter));
                    _safeSetItem('workspaces_meta', JSON.stringify(workspaces));
                    var oldKeys = ['tasks', 'taskCounter', 'tasks_local', 'taskCounter_local', 'tasky_groupCode'];
                    oldKeys.forEach(function(k) { localStorage.removeItem(k); });
                }
                var ws = workspaces.find(function(w) { return w.id === activeWorkspaceId; });
                if (ws) {
                    var saved = localStorage.getItem('ws_tasks_' + ws.id);
                    if (saved) try { tasks = JSON.parse(saved); } catch(_) { tasks = { todo: [], working: [], done: [] }; }
                    var cnt = localStorage.getItem('ws_counter_' + ws.id);
                    if (cnt) taskCounter = parseInt(cnt);
                }
            }

            // Expose encryption state for settings
            window._encKey = _encKey;
            window._encSalt = _encSalt;

            // ── Read-only view mode: skip full app init ──────────────────────────
            // When ?view=CODE is present, tasky-collab.js takes over the page.
            // We still need Firebase initialised (for Firestore reads), but we must
            // NOT render the normal board UI or remove the loading splash — that is
            // handled entirely by _mountReadOnlyBoard in tasky-collab.js.
            var _isReadOnlyView = (new URLSearchParams(window.location.search)).get('view');
            if (_isReadOnlyView && _isReadOnlyView.length >= 3) {
                setTimeout(function() {
                    app = firebase.initializeApp({
                        apiKey: "AIzaSyBN8ZJil4vWWJ6XPPGgp20htp8IBxDLL_o",
                        authDomain: "tasky-95785.firebaseapp.com",
                        projectId: "tasky-95785",
                        storageBucket: "tasky-95785.firebasestorage.app",
                        messagingSenderId: "285483279389",
                        appId: "1:285483279389:web:383a6cb7683e6e4e1d12f4"
                    });
                    db = firebase.firestore(app);
                    window.db = db;
                    // tasky-collab.js will boot read-only mode once db is ready
                }, 0);
                return; // bail out — do not run the rest of the normal app init
            }

            // Chunk 1 — Firebase + first render (deferred to release main thread)
            setTimeout(function() {
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

                // Chunk 2 — keyboard, voice, Firebase auth, deferred listeners
                setTimeout(function() {
                    setupKeyboard();
                    setupDelegatedListeners();
                    setupVoice();
                    setupFirebase();

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

                    var opacitySlider = document.getElementById('card-opacity-slider');
                    if (opacitySlider) {
                        opacitySlider.addEventListener('input', function() {
                            setCardOpacity(parseInt(this.value));
                        });
                    }

                    document.documentElement.classList.add('ready');
                    // Don't remove loading splash if first-run onboarding will overlay it
                    var _hasOnboarded = localStorage.getItem('tasky_onboarding') || localStorage.getItem('hasOnboarded') === 'true' || localStorage.getItem('tasky_onboarding_seen_v4');
                    if (_hasOnboarded) {
                        requestAnimationFrame(function() {
                            var ls = document.getElementById('loading-splash');
                            if (ls) {
                                ls.style.transition = 'opacity 0.2s ease';
                                ls.style.opacity = '0';
                                setTimeout(function() { if (ls.parentNode) ls.remove(); }, 250);
                            }
                        });
                    } else {
                        // Fallback: ensure splash eventually disappears even if onboarding doesn't fire
                        setTimeout(function() {
                            var ls = document.getElementById('loading-splash');
                            if (ls) { ls.style.transition = 'opacity 0.3s ease'; ls.style.opacity = '0'; setTimeout(function() { if (ls.parentNode) ls.remove(); }, 300); }
                        }, 8000);
                    }
                }, 0);
            }, 0);
        })();

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
            if (syncTimeout) { clearTimeout(syncTimeout); syncTimeout = null; }

            // Snapshot for offline recovery — if cloud sync fails on re-auth,
            // syncFromCloud will restore from this backup
            window.__signOutBackup = JSON.parse(JSON.stringify({
                tasks: tasks,
                taskCounter: taskCounter,
                workspaces: workspaces,
                activeWorkspaceId: activeWorkspaceId,
                allWorkspaceData: _allWorkspaceData || null
            }));

            tasks = { todo: [], working: [], done: [] };
            taskCounter = 0;
            saveCurrentWorkspaceData();
            renderAllColumns();

            firebase.auth(app).signOut()
                .catch(function() {
                    // Sign out failed — restore from backup
                    var b = window.__signOutBackup;
                    if (b) {
                        tasks = b.tasks;
                        taskCounter = b.taskCounter;
                        workspaces = b.workspaces;
                        activeWorkspaceId = b.activeWorkspaceId;
                        _allWorkspaceData = b.allWorkspaceData;
                        saveCurrentWorkspaceData();
                        renderAllColumns();
                        renderWorkspaceSwitcher();
                        showToast('⚠️ Sign out failed. Please try again.', function() {});
                    }
                    window.__signOutBackup = null;
                });

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
            if (currentUser.isAnonymous && state !== 'syncing') return;
            el.classList.add('visible', state);
            var label = '';
            if (state === 'synced') label = _encKey ? '🔒 Synced' : '☁️ Synced';
            else if (state === 'syncing') label = _encKey ? '🔒 Syncing…' : '☁️ Syncing…';
            else if (state === 'offline') label = _encKey ? '🔒 Offline' : '☁️ Offline';
            el.textContent = label;
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
                if (_encKey && _allWorkspaceData) {
                    workspaces.forEach(function(w) {
                        var t = _allWorkspaceData['ws_tasks_' + w.id];
                        var c = _allWorkspaceData['ws_counter_' + w.id];
                        if (t) cloudData['ws_tasks_' + w.id] = t;
                        if (c !== undefined) cloudData['ws_counter_' + w.id] = c;
                    });
                } else {
                    workspaces.forEach(function(w) {
                        var t = localStorage.getItem('ws_tasks_' + w.id);
                        var c = localStorage.getItem('ws_counter_' + w.id);
                        if (t) try { cloudData['ws_tasks_' + w.id] = JSON.parse(t); } catch(_) { cloudData['ws_tasks_' + w.id] = null; }
                        if (c) cloudData['ws_counter_' + w.id] = parseInt(c);
                    });
                }
                // Fetch existing doc first so we can explicitly delete
                // stale ws_tasks_N / ws_counter_N fields from deleted workspaces.
                // merge:true alone never removes fields, causing deleted workspaces
                // to resurrect on the next reload.
                docRef.get().then(function(snap) {
                    if (snap.exists) {
                        var activeIds = new Set(workspaces.map(function(w) { return w.id; }));
                        Object.keys(snap.data()).forEach(function(key) {
                            var m = key.match(/^ws_(?:tasks|counter)_(\d+)$/);
                            if (m && !activeIds.has(parseInt(m[1]))) {
                                cloudData[key] = firebase.firestore.FieldValue.delete();
                            }
                        });
                    }
                    return docRef.set(cloudData, { merge: true });
                }).then(function() { setSyncStatus('synced'); })
                  .catch(function() { setSyncStatus('offline'); });
            }, 500);
        }

        function _writeLocalWorkspaceData(id, tasksData, counter) {
            if (_encKey && _allWorkspaceData) {
                _allWorkspaceData['ws_tasks_' + id] = JSON.parse(JSON.stringify(tasksData));
                _allWorkspaceData['ws_counter_' + id] = counter;
            } else {
                _safeSetItem('ws_tasks_' + id, JSON.stringify(tasksData));
                _safeSetItem('ws_counter_' + id, String(counter));
            }
        }
        function _readLocalWorkspaceData(id) {
            if (_encKey && _allWorkspaceData) {
                var t = _allWorkspaceData['ws_tasks_' + id];
                var c = _allWorkspaceData['ws_counter_' + id];
                return { tasks: t ? JSON.parse(JSON.stringify(t)) : null, counter: c !== undefined ? c : null };
            }
            var t = localStorage.getItem('ws_tasks_' + id);
            var c = localStorage.getItem('ws_counter_' + id);
            return { tasks: t ? (() => { try { return JSON.parse(t); } catch(_) { return null; } })() : null, counter: c !== undefined ? parseInt(c) : null };
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
                    if (_encKey) _encryptStoredData();
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
                            _writeLocalWorkspaceData(w.id, t || { todo: [], working: [], done: [] }, c !== undefined ? c : 0);
                        });
                        saveWorkspacesMeta();
                    }
                    activeWorkspaceId = parseInt(localStorage.getItem('ws_active')) || (workspaces[0] ? workspaces[0].id : 1);
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
                                    var local = _readLocalWorkspaceData(cw.id);
                                    var localT = local.tasks || { todo: [], working: [], done: [] };
                                    var localC = local.counter !== null ? local.counter : 0;
                                    var merged = mergeTasks(localT, cTasks, localC, cCounter || 0);
                                    _writeLocalWorkspaceData(cw.id, merged.tasks, merged.taskCounter);
                                }
                            } else {
                                workspaces.push({ id: cw.id, name: cw.name, collabCode: cw.collabCode });
                                var ct = cloudData['ws_tasks_' + cw.id];
                                var cc = cloudData['ws_counter_' + cw.id];
                                _writeLocalWorkspaceData(cw.id, ct || { todo: [], working: [], done: [] }, cc || 0);
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
                if (_encKey) _encryptStoredData();
            }).catch(function() {
                setSyncStatus('offline');
                // Offline sign-out recovery: restore from backup if cloud is unreachable
                var _sb = window.__signOutBackup;
                if (replace && _sb) {
                    tasks = _sb.tasks;
                    taskCounter = _sb.taskCounter;
                    workspaces = _sb.workspaces;
                    activeWorkspaceId = _sb.activeWorkspaceId;
                    if (_sb.allWorkspaceData) _allWorkspaceData = _sb.allWorkspaceData;
                    saveCurrentWorkspaceData();
                    renderAllColumns();
                    renderWorkspaceSwitcher();
                    showToast('⚠️ Could not reach cloud — restored local data', function() {});
                    window.__signOutBackup = null;
                }
            });
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
                // Bail if calendar is open — tasky-calendar.js handles all keys
                if (document.getElementById('cal-overlay') && document.getElementById('cal-overlay').classList.contains('visible')) return;
                // Alt+M → open calendar view
                if ((e.key === 'm' || e.key === 'M') && e.altKey) {
                    e.preventDefault();
                    if (typeof openCalendarView === 'function') openCalendarView();
                    return;
                }
                // Esc → undo last action (highest priority)
                if (e.key === 'Escape') {
                    if (_lastUndoCallback) {
                        e.preventDefault();
                        var _cb = _lastUndoCallback;
                        _lastUndoCallback = null;
                        _cb();
                        return;
                    }
                    // Close shortcuts overlay if open
                    var _so = document.getElementById('shortcuts-overlay');
                    if (_so && _so.classList.contains('visible')) {
                        closeShortcuts();
                        return;
                    }
                }

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
                if (key === 'Escape' || key === 'Delete') { e.preventDefault(); return; }
                if (key === 'ArrowLeft' || key === 'ArrowRight' ||
                    key === 'ArrowUp'   || key === 'ArrowDown') { e.preventDefault(); return; }

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
            if (!container || !input) return;
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

            if (toColumn === 'working' && tasks.working.length >= WIP_LIMIT) {
                showToast(`⚠️ WIP limit (${WIP_LIMIT}) — move or complete tasks first`, () => {});
                return;
            }

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
        var _saveAllPending = false;
        function saveAll() {
            if (_saveAllTimer) return;
            _saveAllTimer = setTimeout(function() {
                _saveAllTimer = null;
                _saveAllPending = false;
                saveCurrentWorkspaceData();
                if (_encKey) _encryptStoredData();
                pushToCloud();
            }, 0);
        }
        // Flush pending saves on page unload — rAF is paused in background tabs
        window.addEventListener('beforeunload', function() {
            if (_saveAllTimer) {
                clearTimeout(_saveAllTimer);
                _saveAllTimer = null;
            }
            saveCurrentWorkspaceData();
            if (_encKey) _encryptStoredData();
        });

        // ─── Toast ────────────────────────────────────────────────────────────────
        function showToast(message, undoCallback) {
            _lastUndoCallback = undoCallback || null;
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
                _lastUndoCallback = null;
                if (undoCallback) undoCallback();
            };

            toast.appendChild(msgSpan);
            toast.appendChild(undoBtn);
            container.appendChild(toast);

            setTimeout(function() {
                if (toast.parentNode) {
                    toast.remove();
                    _lastUndoCallback = null;
                }
            }, 3000);
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
                var total = 0;
                if (_encKey && _allWorkspaceData) {
                    var wsTasks = _allWorkspaceData['ws_tasks_' + w.id] || { todo: [], working: [], done: [] };
                    total = wsTasks.todo.length + wsTasks.working.length + wsTasks.done.length;
                } else {
                    var t = localStorage.getItem('ws_tasks_' + w.id);
                    var wsTasks = t ? (() => { try { return JSON.parse(t); } catch(_) { return { todo: [], working: [], done: [] }; } })() : { todo: [], working: [], done: [] };
                    total = wsTasks.todo.length + wsTasks.working.length + wsTasks.done.length;
                }
                html += '<div class="ws-pill' + (isActive ? ' ws-active' : '') + '" onclick="switchWorkspace(' + w.id + ')">';
                if (w.collabCode) html += '<span class="ws-pill-collab" title="Collaboration: ' + escapeHtml(w.collabCode || '') + '">👥</span>';
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
                var display = column === 'working' ? actual + ' / ' + WIP_LIMIT : String(actual);
                if (count.textContent !== display) {
                    count.classList.add('pulse');
                    setTimeout(function() { count.classList.remove('pulse'); }, 400);
                }
                count.textContent = display;
                count.classList.toggle('wip-limit', column === 'working' && actual >= WIP_LIMIT);
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
            const display = column === 'working' ? `${actual} / ${WIP_LIMIT}` : String(actual);
            if (count.textContent !== display) {
                count.classList.add('pulse');
                setTimeout(() => count.classList.remove('pulse'), 400);
            }
            count.textContent = display;
            count.classList.toggle('wip-limit', column === 'working' && actual >= WIP_LIMIT);
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
            return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#x27;');
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
            let data;
            try { data = JSON.parse(e.dataTransfer.getData('text/plain')); } catch(_) { return; }
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

            card.addEventListener('touchstart', function(e) {
                if (e.target.closest('button, .priority-badge, input')) return;
                var t = e.touches[0];
                startX = t.clientX; startY = t.clientY;
                dragStarted = false;
                pressTimer = setTimeout(function() {
                    dragStarted = true;
                    _startTouchDrag(card, taskId, column, t.clientX, t.clientY);
                }, 400);
            }, { passive: true });

            card.addEventListener('touchmove', function(e) {
                var t = e.touches[0];
                var dx = t.clientX - startX;
                var dy = t.clientY - startY;

                if (!dragStarted) {
                    // Swipe visual feedback (only on horizontal movement)
                    if (Math.abs(dx) > 10 && Math.abs(dy) < 40) {
                        card.style.transform = 'translateX(' + (dx * 0.65) + 'px)';
                        card.style.opacity = Math.max(0.4, 1 - Math.abs(dx) / 300);
                        card.classList.toggle('swiping-right', dx > 0);
                        card.classList.toggle('swiping-left', dx < 0);
                    }
                    // Cancel long-press on vertical movement (scroll)
                    if (pressTimer && Math.abs(dy) > 8) {
                        clearTimeout(pressTimer); pressTimer = null;
                        card.style.transform = '';
                        card.style.opacity = '';
                        card.classList.remove('swiping-left', 'swiping-right');
                    }
                    return;
                }
                if (_touchDrag) {
                    e.preventDefault();
                    _moveTouchDrag(t.clientX, t.clientY);
                }
            }, { passive: false });

            card.addEventListener('touchend', function(e) {
                clearTimeout(pressTimer); pressTimer = null;
                card.style.transform = '';
                card.style.opacity = '';
                card.classList.remove('swiping-left', 'swiping-right');

                if (!dragStarted) {
                    var t = e.changedTouches[0];
                    var dx = t.clientX - startX;
                    var dy = t.clientY - startY;
                    if (Math.abs(dx) > 20 && Math.abs(dy) < 40) {
                        e.preventDefault();
                        if (dx > 0) {
                            if (column === 'todo') moveTaskWithUndo(column, 'working', taskId);
                            else if (column === 'working') moveTaskWithUndo(column, 'done', taskId);
                        } else {
                            if (column === 'done') moveTaskWithUndo(column, 'working', taskId);
                            else if (column === 'working') moveTaskWithUndo(column, 'todo', taskId);
                        }
                        return;
                    }
                    return;
                }
                if (_touchDrag) {
                    e.preventDefault();
                    const t = e.changedTouches[0];
                    _endTouchDrag(t.clientX, t.clientY);
                    dragStarted = false;
                }
            }, { passive: false });

            card.addEventListener('touchcancel', function() {
                clearTimeout(pressTimer); pressTimer = null;
                card.style.transform = '';
                card.style.opacity = '';
                card.classList.remove('swiping-left', 'swiping-right');
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
            const topMenu = document.querySelector('.top-menu');
            const dropdown = document.getElementById('dropdown');
            if (topMenu && dropdown && !topMenu.contains(e.target)) {
                dropdown.classList.remove('show');
            }
        });

        function toggleTheme() {
            document.body.classList.toggle('light-mode');
            isLightMode = document.body.classList.contains('light-mode');
                _safeSetItem('theme', isLightMode ? 'light' : 'dark');
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
                _safeSetItem('cardOpacity', cardOpacity);
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
            if (_encKey && _allWorkspaceData) {
                workspaces.forEach(function(w) {
                    _allWorkspaceData['ws_tasks_' + w.id] = { todo: [], working: [], done: [] };
                    _allWorkspaceData['ws_counter_' + w.id] = 0;
                });
            } else {
                workspaces.forEach(function(w) {
                    _safeSetItem('ws_tasks_' + w.id, JSON.stringify({ todo: [], working: [], done: [] }));
                    _safeSetItem('ws_counter_' + w.id, '0');
                });
            }
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

        // ─── Floating toolbox ────────────────────────────────────────────────
        (function _initToolbox() {
            var toolbox = document.getElementById('toolbox');
            if (!toolbox) return;

            function makeBtn(id, label, title, action) {
                var btn = document.createElement('button');
                btn.className = 'tb-btn';
                btn.id = id;
                btn.title = title;
                btn.textContent = label;
                btn.addEventListener('click', action);
                toolbox.appendChild(btn);
            }

            makeBtn('tb-subtask', '\u2610 Subtasks', 'Subtasks (select a task first)', function() {
                if (!selectedTask) { showToast('Select a task first', function(){}); return; }
                var card = document.getElementById('task-' + selectedTask.taskId);
                if (!card) return;
                var container = card.querySelector('.subtask-container');
                if (container) container.style.display = container.style.display === 'none' ? '' : 'none';
            });

            makeBtn('tb-timer', '\u23F1 Timer', 'Timer (select a task first)', function() {
                if (!selectedTask) { showToast('Select a task first', function(){}); return; }
                var card = document.getElementById('task-' + selectedTask.taskId);
                if (!card) return;
                var container = card.querySelector('.tmr-container');
                if (container) container.style.display = container.style.display === 'none' ? '' : 'none';
            });

            makeBtn('tb-comments', '\uD83D\uDCAC Comments', 'Comments (select a task first)', function() {
                if (!selectedTask) { showToast('Select a task first', function(){}); return; }
                var task = _stFindTask(selectedTask.taskId);
                if (!task) { showToast('Task not found', function(){}); return; }
                if (typeof openComments === 'function') {
                    openComments(selectedTask.taskId, task.text, selectedTask.column);
                } else {
                    showToast('Comments not available', function(){});
                }
            });

            makeBtn('tb-recur', '\uD83D\uDD01 Recurring', 'Set recurring schedule (select a task first)', function() {
                if (!selectedTask) { showToast('Select a task first', function(){}); return; }
                if (typeof openRecurModal === 'function') {
                    openRecurModal(selectedTask.column, selectedTask.taskId);
                } else {
                    showToast('Recurring tasks not available', function(){});
                }
            });

            makeBtn('tb-deps', '\uD83D\uDD17 Deps', 'Manage dependencies (select a task first)', function() {
                if (!selectedTask) { showToast('Select a task first', function(){}); return; }
                var col = selectedTask.column;
                var task = (tasks[col] || []).find(function(t) { return t.id === selectedTask.taskId; });
                if (!task) { showToast('Task not found', function(){}); return; }
                if (typeof openDepModal === 'function') {
                    openDepModal(task, col);
                } else {
                    showToast('Dependencies not available', function(){});
                }
            });
        })();

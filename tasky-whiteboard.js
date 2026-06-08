var _wbOpen = false;
var _wbCanvas = null;
var _wbCtx = null;
var _wbStrokes = [];
var _wbUndoStack = [];
var _wbRedoStack = [];
var _wbDrawing = false;
var _wbColor = '#8B5CF6';
var _wbWidth = 3;
var _wbTool = 'pen';
var _wbStartX = 0;
var _wbStartY = 0;
var _wbPoints = [];
var _wbRemoteCursors = {};
var _wbFBListener = null;
var _wbFBUnsub = null;
var _wbCursorThrottle = false;
var _wbCursorRenderThrottle = false;
var _wbProcessedCount = 0;
var _wbPendingBatch = [];
var _wbBatchTimer = null;

var WB_COLORS = ['#8B5CF6','#3B82F6','#10B981','#F59E0B','#EF4444','#EC4899','#ffffff','#000000'];

// ─── DataChannel receive handler (called by tasky-voice.js) ───
window._wbDCReceive = function(peerUid, data) {
    try { var p = JSON.parse(data); } catch(e) { return; }
    _wbProcessPayload(p);
};

function openWhiteboard(fromRemote) {
    var overlay = document.getElementById('wb-overlay');
    if (!overlay) _wbBuild();
    overlay = document.getElementById('wb-overlay');
    _wbOpen = true;
    overlay.classList.add('visible');
    _wbStartFBSync();
    _wbLoadArchive();
    setTimeout(function() { _wbResize(); _wbRenderAll(); }, 50);
    if (!fromRemote) {
        var ref = _wbDocRef();
        if (ref) ref.set({ active: true }, { merge: true }).catch(function() {});
    }
}

function closeWhiteboard() {
    var overlay = document.getElementById('wb-overlay');
    if (overlay) overlay.classList.remove('visible');
    _wbOpen = false;
}

// ─── Firestore archive load (late-joiner catch-up) ───
function _wbLoadArchive() {
    var ref = _wbDocRef();
    if (!ref) return;
    ref.get().then(function(snap) {
        if (!snap.exists) return;
        var data = snap.data();
        var strokes = data.strokes || [];
        strokes.forEach(function(p) { _wbProcessPayload(p); });
        _wbProcessedCount = strokes.length;
        if (_wbOpen && _wbCtx) _wbRenderAll();
    }).catch(function(e) {
        console.warn('[WB] archive load error:', e);
    });
}

// ─── Primary send: DC when call active, Firestore fallback ───
function _wbSend(payload, opts) {
    opts = opts || {};
    payload.uid = typeof currentUser !== 'undefined' && currentUser ? currentUser.uid : 'anon';
    var dcs = window._wbDCs || {};
    var hasDC = false;
    for (var k in dcs) { if (dcs[k].readyState === 'open') { hasDC = true; break; } }

    if (hasDC) {
        var msg = JSON.stringify(payload);
        for (var uid in dcs) {
            try { if (dcs[uid].readyState === 'open') dcs[uid].send(msg); } catch(e) {}
        }
        if (payload.type !== 'cursor') {
            if (opts.immediate) {
                _wbSendFB(payload);
            } else {
                _wbEnqueueBatch(payload);
            }
        }
    } else {
        _wbSendFB(payload);
    }
}

// ─── Debounced Firestore archive batch ───
function _wbEnqueueBatch(payload) {
    _wbPendingBatch.push(payload);
    if (!_wbBatchTimer) _wbBatchTimer = setTimeout(_wbFlushBatch, 3000);
}

function _wbFlushBatch() {
    _wbBatchTimer = null;
    if (_wbPendingBatch.length === 0) return;
    var batch = _wbPendingBatch;
    _wbPendingBatch = [];
    var ref = _wbDocRef();
    if (!ref) return;
    var union = firebase.firestore.FieldValue.arrayUnion;
    ref.update({
        strokes: union.apply(null, batch),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }).catch(function() {
        ref.set({
            strokes: batch,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }).catch(function() {});
    });
}

// ─── Process incoming payload (stroke/cursor/clear) ───
function _wbProcessPayload(p) {
    var myUid = typeof currentUser !== 'undefined' && currentUser ? currentUser.uid : null;
    if (p.uid === myUid) return;
    if (p.type === 'stroke') {
        if (_wbStrokes.some(function(s) { return s._ts === p.ts && s._handle === p.handle; })) return;
        var s = p.stroke;
        s._ts = p.ts;
        s._handle = p.handle;
        _wbStrokes.push(s);
        _wbUndoStack.push(_wbStrokes.length - 1);
        if (_wbOpen && _wbCtx) _wbRenderStroke(s);
    } else if (p.type === 'cursor') {
        if (!_wbCursorRenderThrottle) {
            _wbCursorRenderThrottle = true;
            _wbUpdateRemoteCursor(p.handle, p.x, p.y, p.color);
            setTimeout(function() { _wbCursorRenderThrottle = false; }, 50);
        }
    } else if (p.type === 'clear') {
        _wbStrokes = []; _wbUndoStack = []; _wbRedoStack = [];
        if (_wbOpen && _wbCtx) _wbRenderAll();
    }
}

function _wbBuild() {
    var overlay = document.createElement('div');
    overlay.id = 'wb-overlay';
    overlay.addEventListener('click', function(e) { if (e.target === overlay) closeWhiteboard(); });

    var panel = document.createElement('div');
    panel.id = 'wb-panel';

    var bar = document.createElement('div');
    bar.className = 'wb-bar';
    bar.innerHTML = '<span class="wb-bar-title">🎨 Whiteboard</span>';
    var tools = ['pen','rect','circle','line','eraser'];
    var toolIcons = { pen: '✏️', rect: '▭', circle: '○', line: '╱', eraser: '🧹' };
    tools.forEach(function(t) {
        var btn = document.createElement('button');
        btn.className = 'wb-tool' + (t === _wbTool ? ' active' : '');
        btn.textContent = toolIcons[t] || t;
        btn.title = t;
        btn.addEventListener('click', function() { _wbSetTool(t); });
        bar.appendChild(btn);
    });

    var sep = document.createElement('span');
    sep.style.cssText = 'width:1px;height:20px;background:rgba(255,255,255,0.06);margin:0 4px;';
    bar.appendChild(sep);

    WB_COLORS.forEach(function(c) {
        var btn = document.createElement('button');
        btn.className = 'wb-color-btn' + (c === _wbColor ? ' active' : '');
        btn.style.background = c;
        btn.style.borderColor = c === '#ffffff' ? 'rgba(255,255,255,0.2)' : 'transparent';
        if (c === '#000000') btn.style.borderColor = 'rgba(255,255,255,0.3)';
        btn.title = c;
        btn.addEventListener('click', function() { _wbSetColor(c); });
        bar.appendChild(btn);
    });

    var widthLabel = document.createElement('span');
    widthLabel.style.cssText = 'font-size:11px;color:rgba(255,255,255,0.3);margin-left:4px;';
    widthLabel.textContent = 'Size';
    bar.appendChild(widthLabel);
    var widthSlider = document.createElement('input');
    widthSlider.type = 'range';
    widthSlider.className = 'wb-width-slider';
    widthSlider.min = '1';
    widthSlider.max = '20';
    widthSlider.value = _wbWidth;
    widthSlider.addEventListener('input', function() { _wbWidth = parseInt(this.value); });
    bar.appendChild(widthSlider);

    var controls = document.createElement('div');
    controls.className = 'wb-controls';
    controls.innerHTML = '<button class="wb-ctrl" id="wb-undo" title="Undo">↩ Undo</button><button class="wb-ctrl" id="wb-redo" title="Redo">↪ Redo</button><button class="wb-ctrl wb-ctrl--danger" id="wb-clear" title="Clear all">🗑 Clear</button><button class="wb-ctrl" id="wb-close" title="Close">✕</button>';
    bar.appendChild(controls);
    panel.appendChild(bar);

    var wrap = document.createElement('div');
    wrap.id = 'wb-canvas-wrap';
    var canvas = document.createElement('canvas');
    canvas.id = 'wb-canvas';
    wrap.appendChild(canvas);
    panel.appendChild(wrap);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    _wbCanvas = canvas;
    _wbCtx = canvas.getContext('2d');

    canvas.addEventListener('pointerdown', _wbPointerDown);
    canvas.addEventListener('pointermove', _wbPointerMove);
    canvas.addEventListener('pointerup', _wbPointerUp);
    canvas.addEventListener('pointerleave', _wbPointerUp);

    document.getElementById('wb-undo').addEventListener('click', _wbUndo);
    document.getElementById('wb-redo').addEventListener('click', _wbRedo);
    document.getElementById('wb-clear').addEventListener('click', _wbClearAll);
    document.getElementById('wb-close').addEventListener('click', closeWhiteboard);

    window.addEventListener('resize', _wbResize);
}

function _wbResize() {
    if (!_wbCanvas) return;
    var wrap = document.getElementById('wb-canvas-wrap');
    if (!wrap) return;
    var rect = wrap.getBoundingClientRect();
    _wbCanvas.width = rect.width;
    _wbCanvas.height = rect.height;
    _wbRenderAll();
}

function _wbSetTool(tool) {
    _wbTool = tool;
    document.querySelectorAll('.wb-tool').forEach(function(b) { b.classList.toggle('active', b.title === tool); });
}

function _wbSetColor(c) {
    _wbColor = c;
    document.querySelectorAll('.wb-color-btn').forEach(function(b) { b.classList.toggle('active', b.style.background === c || b.title === c); });
}

function _wbGetPos(e) {
    var rect = _wbCanvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function _wbPointerDown(e) {
    _wbDrawing = true;
    var pos = _wbGetPos(e);
    _wbStartX = pos.x;
    _wbStartY = pos.y;
    _wbPoints = [pos];
    _wbRedoStack = [];

    if (_wbTool === 'pen' || _wbTool === 'eraser') {
        _wbCtx.beginPath();
        _wbCtx.moveTo(pos.x, pos.y);
    }
}

function _wbPointerMove(e) {
    if (!_wbDrawing) {
        _wbBroadcastCursor(e);
        return;
    }
    var pos = _wbGetPos(e);
    _wbPoints.push(pos);

    if (_wbTool === 'pen' || _wbTool === 'eraser') {
        _wbCtx.lineWidth = _wbTool === 'eraser' ? _wbWidth * 4 : _wbWidth;
        _wbCtx.lineCap = 'round';
        _wbCtx.lineJoin = 'round';
        _wbCtx.strokeStyle = _wbTool === 'eraser' ? _wbCanvas.style.background || '#1a1828' : _wbColor;
        _wbCtx.lineTo(pos.x, pos.y);
        _wbCtx.stroke();
        _wbCtx.beginPath();
        _wbCtx.moveTo(pos.x, pos.y);
    }
}

function _wbPointerUp(e) {
    if (!_wbDrawing) return;
    _wbDrawing = false;
    _wbCtx.beginPath();

    var pos = e ? _wbGetPos(e) : _wbPoints[_wbPoints.length - 1];

    if (_wbTool === 'rect') {
        _wbDrawShape('rect', _wbStartX, _wbStartY, pos.x, pos.y);
    } else if (_wbTool === 'circle') {
        _wbDrawShape('circle', _wbStartX, _wbStartY, pos.x, pos.y);
    } else if (_wbTool === 'line') {
        _wbDrawShape('line', _wbStartX, _wbStartY, pos.x, pos.y);
    }

    var stroke = {
        tool: _wbTool === 'eraser' ? 'eraser' : _wbTool,
        points: _wbTool === 'pen' || _wbTool === 'eraser' ? _wbPoints : [{ x: _wbStartX, y: _wbStartY }, { x: pos.x, y: pos.y }],
        color: _wbTool === 'eraser' ? null : _wbColor,
        width: _wbWidth
    };
    _wbStrokes.push(stroke);
    _wbUndoStack.push(_wbStrokes.length - 1);
    _wbBroadcastStroke(stroke);
}

function _wbDrawShape(shape, x1, y1, x2, y2) {
    _wbCtx.lineWidth = _wbWidth;
    _wbCtx.strokeStyle = _wbColor;
    _wbCtx.lineCap = 'round';

    if (shape === 'rect') {
        _wbCtx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    } else if (shape === 'circle') {
        var cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
        var rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2;
        _wbCtx.beginPath();
        _wbCtx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        _wbCtx.stroke();
    } else if (shape === 'line') {
        _wbCtx.beginPath();
        _wbCtx.moveTo(x1, y1);
        _wbCtx.lineTo(x2, y2);
        _wbCtx.stroke();
    }
}

function _wbRenderAll() {
    if (!_wbCtx || !_wbCanvas) return;
    _wbCtx.clearRect(0, 0, _wbCanvas.width, _wbCanvas.height);
    _wbStrokes.forEach(function(s) {
        _wbRenderStroke(s);
    });
}

function _wbRenderStroke(s) {
    if (!_wbCtx) return;
    _wbCtx.lineCap = 'round';
    _wbCtx.lineJoin = 'round';

    if (s.tool === 'pen' || s.tool === 'eraser') {
        if (!s.points || s.points.length < 2) return;
        _wbCtx.beginPath();
        _wbCtx.lineWidth = s.tool === 'eraser' ? (s.width || 3) * 4 : (s.width || 3);
        _wbCtx.strokeStyle = s.tool === 'eraser' ? (_wbCanvas.style.background || '#1a1828') : (s.color || _wbColor);
        _wbCtx.moveTo(s.points[0].x, s.points[0].y);
        for (var i = 1; i < s.points.length; i++) {
            _wbCtx.lineTo(s.points[i].x, s.points[i].y);
        }
        _wbCtx.stroke();
    } else if (s.tool === 'rect' || s.tool === 'circle' || s.tool === 'line') {
        if (!s.points || s.points.length < 2) return;
        _wbCtx.lineWidth = s.width || _wbWidth;
        _wbCtx.strokeStyle = s.color || _wbColor;
        var p1 = s.points[0], p2 = s.points[s.points.length - 1];
        _wbDrawShape(s.tool, p1.x, p1.y, p2.x, p2.y);
    }
}

// ─── Broadcast ───
function _wbBroadcastCursor(e) {
    if (_wbCursorThrottle) return;
    _wbCursorThrottle = true;
    setTimeout(function() { _wbCursorThrottle = false; }, 50);
    var pos = _wbGetPos(e);
    var me = typeof currentHandle !== 'undefined' && currentHandle ? currentHandle : 'Me';
    var payload = { type: 'cursor', handle: me, x: pos.x, y: pos.y, color: _wbColor };
    _wbSend(payload);
}

function _wbBroadcastStroke(stroke) {
    var me = typeof currentHandle !== 'undefined' && currentHandle ? currentHandle : 'Me';
    var payload = { type: 'stroke', handle: me, stroke: JSON.parse(JSON.stringify(stroke)), ts: Date.now() };
    _wbSend(payload);
}

// ─── Firestore ───
function _wbDocRef() {
    if (typeof currentGroup === 'undefined' || !currentGroup || typeof db === 'undefined' || !db) return null;
    return db.collection('groups').doc(currentGroup.code).collection('whiteboard').doc('wb_' + currentGroup.code);
}

function _wbSendFB(payload) {
    var ref = _wbDocRef();
    if (!ref) return;
    ref.update({
        strokes: firebase.firestore.FieldValue.arrayUnion(payload),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }).catch(function() {
        ref.set({
            strokes: [payload],
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }).catch(function() {});
    });
}

function _wbStartFBSync(retries) {
    retries = retries || 0;
    if (_wbFBUnsub) return;
    if (typeof currentGroup === 'undefined' || !currentGroup || typeof db === 'undefined' || !db) {
        if (retries < 10) { setTimeout(function() { _wbStartFBSync(retries + 1); }, 500); }
        else { console.warn('[WB] db/group not ready after 10 retries'); }
        return;
    }
    var ref = _wbDocRef();
    if (!ref) {
        if (retries < 10) { setTimeout(function() { _wbStartFBSync(retries + 1); }, 500); }
        else { console.warn('[WB] doc ref null after 10 retries'); }
        return;
    }
    console.log('[WB] listener starting');
    _wbFBUnsub = ref.onSnapshot(function(snap) {
        if (!snap.exists) { console.log('[WB] doc not exists'); return; }
        var data = snap.data();
        var myUid = typeof currentUser !== 'undefined' && currentUser ? currentUser.uid : null;

        // Auto-open detection (always via Firestore)
        if (data.active && !_wbOpen) { console.log('[WB] auto-open triggered'); openWhiteboard(true); return; }

        // Check if DataChannels are active — if so, strokes come via DC, skip Firestore iteration
        var dcs = window._wbDCs || {};
        var hasDC = false;
        for (var k in dcs) { if (dcs[k].readyState === 'open') { hasDC = true; break; } }

        if (!hasDC) {
            var remoteStrokes = data.strokes || [];
            var startIdx = Math.min(_wbProcessedCount, remoteStrokes.length);
            for (var i = startIdx; i < remoteStrokes.length; i++) {
                _wbProcessPayload(remoteStrokes[i]);
            }
            _wbProcessedCount = remoteStrokes.length;
        } else {
            // DC active — just track array length so archive read stays in sync
            _wbProcessedCount = (data.strokes || []).length;
        }
    }, function(err) { console.warn('[WB] snapshot error:', err); });
}

function _wbStopFBSync() {
    if (_wbFBUnsub) { _wbFBUnsub(); _wbFBUnsub = null; }
}

function _wbUpdateRemoteCursor(handle, x, y, color) {
    var id = 'wb-cursor-' + handle.replace(/[^a-z0-9]/gi, '_');
    var el = document.getElementById(id);
    if (!el) {
        el = document.createElement('div');
        el.className = 'wb-user-cursor';
        el.id = id;
        el.style.background = color || '#8B5CF6';
        document.getElementById('wb-canvas-wrap').appendChild(el);

        var label = document.createElement('div');
        label.className = 'wb-user-label';
        label.textContent = handle;
        el.appendChild(label);
    }
    el.style.left = x + 'px';
    el.style.top = y + 'px';
}

function _wbUndo() {
    if (_wbUndoStack.length === 0) return;
    var idx = _wbUndoStack.pop();
    _wbRedoStack.push(idx);
    _wbStrokes.splice(idx, 1);
    _wbRenderAll();
}

function _wbRedo() {
    if (_wbRedoStack.length === 0) return;
    var idx = _wbRedoStack.pop();
    _wbRedoStack.push(idx);
}

function _wbClearAll() {
    if (_wbStrokes.length === 0) return;
    function doClear() {
        // Flush pending batch before clearing so archive order is correct
        if (_wbBatchTimer) { clearTimeout(_wbBatchTimer); _wbBatchTimer = null; _wbFlushBatch(); }
        _wbStrokes = [];
        _wbUndoStack = [];
        _wbRedoStack = [];
        _wbRenderAll();
        var me = typeof currentHandle !== 'undefined' && currentHandle ? currentHandle : 'Me';
        var myUid = typeof currentUser !== 'undefined' && currentUser ? currentUser.uid : null;
        _wbSend({ type: 'clear', uid: myUid, handle: me }, { immediate: true });
    }
    if (typeof showConfirm === 'function') {
        showConfirm('Clear whiteboard?', 'This clears the canvas for everyone.', 'Clear').then(function(ok) {
            if (!ok) return;
            doClear();
        });
    } else {
        doClear();
    }
}

// Inject whiteboard button into video grid controls
(function _wbInject() {
    if (window.innerWidth < 768) return;
    var check = setInterval(function() {
        if (document.getElementById('vv-btn-cam')) {
            clearInterval(check);
            var controls = document.getElementById('vv-grid-toolbar');
            if (!controls) return;
            var camBtn = document.getElementById('vv-btn-cam');
            if (!camBtn) return;
            var sep = document.createElement('span');
            sep.style.cssText = 'width:1px;height:20px;background:rgba(255,255,255,0.08);margin:0 4px;display:inline-block;vertical-align:middle;';
            controls.insertBefore(sep, camBtn.nextSibling);
            var wbBtn = document.createElement('button');
            wbBtn.className = 'vv-ctrl';
            wbBtn.id = 'vv-btn-whiteboard';
            wbBtn.title = 'Whiteboard';
            wbBtn.textContent = '🎨';
            wbBtn.addEventListener('click', function() { openWhiteboard(false); });
            controls.insertBefore(wbBtn, camBtn.nextSibling);
            _wbStartFBSync();
        }
    }, 1000);
})();

window.openWhiteboard = openWhiteboard;
window.closeWhiteboard = closeWhiteboard;

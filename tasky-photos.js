// ═══════════════════════════════════════════════════════════════════════════
//  TASKY — PHOTO EDITOR  (tasky-photos.js)
//  Full-screen image editor for message board attachments.
//  Loads after tasky-collab.js; hooks into _mbHandleFile via window._photoOpenEditor.
// ═══════════════════════════════════════════════════════════════════════════

/* ── State ────────────────────────────────────────────────────────────── */
var _photoOverlay      = null;
var _photoImgEl        = null;
var _photoCanvas       = null;   // overlay canvas for highlight drawing
var _photoCtx          = null;
var _photoOrigDataUrl  = null;
var _photoFileName     = null;
var _photoOnDone       = null;
var _photoOnSend       = null;
var _photoStrokes      = [];     // [{color, width, points: [{x,y}]}]
var _photoStroke       = [];     // current in-progress stroke points
var _photoDrawing      = false;
var _photoMode         = null;   // null | 'highlight'
var _photoImgW         = 0;
var _photoImgH         = 0;
var _photoViewW        = 0;
var _photoViewH        = 0;
var _photoScale        = 1;


/* ── Inject styles ────────────────────────────────────────────────────── */
(function() {
    if (document.getElementById('tp-styles')) return;
    var s = document.createElement('style');
    s.id = 'tp-styles';
    s.textContent = `
.tp-overlay {
    position: fixed; inset: 0; z-index: 99999;
    background: rgba(8,6,16,0.94);
    display: flex; flex-direction: column;
    font-family: -apple-system,BlinkMacSystemFont,sans-serif;
}
.tp-topbar {
    display: flex; align-items: center; justify-content: center;
    padding: 10px 16px; flex-shrink: 0;
}
.tp-topbar .tp-title { font-size: 15px; font-weight: 700; color: #c4b5fd; }
.tp-body {
    flex: 1; display: flex; align-items: center; justify-content: center;
    position: relative; overflow: hidden; margin: 0 16px;
}
.tp-body img {
    max-width: 100%; max-height: 100%;
    object-fit: contain; border-radius: 4px;
    display: block;
}
.tp-body .tp-hl-canvas {
    position: absolute; top: 50%; left: 50%;
    transform: translate(-50%,-50%);
    pointer-events: none; border-radius: 4px;
}
.tp-body .tp-hl-canvas.active { pointer-events: auto; cursor: crosshair; }
.tp-bottombar {
    display: flex; align-items: center; justify-content: center;
    gap: 12px; padding: 10px 16px 16px; flex-shrink: 0;
}
.tp-tool-btn {
    display: flex; flex-direction: column; align-items: center; gap: 2px;
    background: rgba(139,92,246,0.1); border: 1px solid rgba(139,92,246,0.2);
    border-radius: 10px; padding: 8px 14px; cursor: pointer;
    color: #a78bfa; font-size: 11px; font-weight: 600;
    transition: background .12s, border-color .12s;
    min-width: 56px;
}
.tp-tool-btn:hover { background: rgba(139,92,246,0.18); }
.tp-tool-btn.active { background: rgba(139,92,246,0.25); border-color: #a78bfa; }
.tp-tool-btn .tp-tool-icon { font-size: 18px; line-height: 1; }
.tp-send-btn { background: rgba(16,185,129,0.2) !important; border-color: rgba(16,185,129,0.35) !important; color: #6ee7b7 !important; }
.tp-send-btn:hover { background: rgba(16,185,129,0.3) !important; }
    `;
    document.head.appendChild(s);
})();

/* ── Helpers ──────────────────────────────────────────────────────────── */
function _tpPoint(e) {
    var r = _photoImgEl.getBoundingClientRect();
    var t = e.touches ? e.touches[0] : e;
    return { x: t.clientX - r.left, y: t.clientY - r.top };
}
function _tpLoadImg(dataUrl) {
    return new Promise(function(resolve) {
        var img = new Image();
        img.onload = function() { resolve(img); };
        img.src = dataUrl;
    });
}

function _tpComposite(cb) {
    var scale = _photoImgW / _photoViewW;
    var c = document.createElement('canvas');
    c.width = _photoImgW; c.height = _photoImgH;
    var ctx = c.getContext('2d');
    var img = new Image();
    img.onload = function() {
        ctx.drawImage(img, 0, 0, _photoImgW, _photoImgH);
        // Draw strokes scaled to original image coords
        _photoStrokes.forEach(function(s) {
            ctx.beginPath();
            s.points.forEach(function(p, i) {
                var px = p.x * scale, py = p.y * scale;
                i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
            });
            ctx.strokeStyle = s.color;
            ctx.lineWidth = s.width * scale;
            ctx.lineCap = 'round'; ctx.lineJoin = 'round';
            ctx.stroke();
        });
        var result = c.toDataURL('image/jpeg', 0.85);
        if (typeof cb === 'function') cb(result);
        else _photoOnDone(result);
    };
    img.src = _photoImgEl.src;
}

function _tpRepaintCanvas() {
    // Update the highlight canvas to match img element dimensions
    var r = _photoImgEl.getBoundingClientRect();
    _photoViewW = r.width;
    _photoViewH = r.height;
    _photoCanvas.width = _photoViewW;
    _photoCanvas.height = _photoViewH;
    _photoCanvas.style.width = _photoViewW + 'px';
    _photoCanvas.style.height = _photoViewH + 'px';
    // Redraw all strokes
    _photoCtx.clearRect(0, 0, _photoViewW, _photoViewH);
    _photoStrokes.forEach(function(s) {
        _photoCtx.beginPath();
        s.points.forEach(function(p, i) {
            i === 0 ? _photoCtx.moveTo(p.x, p.y) : _photoCtx.lineTo(p.x, p.y);
        });
        _photoCtx.strokeStyle = s.color;
        _photoCtx.lineWidth = s.width;
        _photoCtx.lineCap = 'round'; _photoCtx.lineJoin = 'round';
        _photoCtx.stroke();
    });
}

function _tpUpdateDisplay(dataUrl) {
    // Reload display with new data URL (after rotate/reset), recompute dims
    var img = new Image();
    img.onload = function() {
        _photoImgW = img.naturalWidth || img.width;
        _photoImgH = img.naturalHeight || img.height;
        _photoImgEl.src = dataUrl;
        // Wait for layout, then repaint canvas
        requestAnimationFrame(function() {
            _tpRepaintCanvas();
        });
    };
    img.src = dataUrl;
}

/* ── Highlight drawing ────────────────────────────────────────────────── */
function _tpHighlightStart(e) {
    if (_photoMode !== 'highlight') return;
    e.preventDefault();
    _photoDrawing = true;
    _photoStroke = [_tpPoint(e)];
}

function _tpHighlightMove(e) {
    if (!_photoDrawing) return;
    e.preventDefault();
    var p = _tpPoint(e);
    _photoStroke.push(p);
    // Draw segment on canvas
    var len = _photoStroke.length;
    if (len < 2) return;
    var prev = _photoStroke[len - 2];
    _photoCtx.beginPath();
    _photoCtx.moveTo(prev.x, prev.y);
    _photoCtx.lineTo(p.x, p.y);
    _photoCtx.strokeStyle = 'rgba(255,200,50,0.85)';
    _photoCtx.lineWidth = 3;
    _photoCtx.lineCap = 'round'; _photoCtx.lineJoin = 'round';
    _photoCtx.stroke();
}

function _tpHighlightEnd(e) {
    if (!_photoDrawing) return;
    _photoDrawing = false;
    if (_photoStroke.length > 0) {
        _photoStrokes.push({ color: 'rgba(255,200,50,0.85)', width: 3, points: _photoStroke.slice() });
    }
    _photoStroke = [];
}

/* ── Main entry ────────────────────────────────────────────────────────── */
function _photoOpenEditor(dataUrl, fileName, onDone, onSend) {
    if (_photoOverlay) { _photoOverlay.remove(); _photoOverlay = null; }

    _photoOrigDataUrl = dataUrl;
    _photoFileName    = fileName || 'photo';
    _photoOnDone      = onDone || function() {};
    _photoOnSend      = onSend || null;
    _photoStrokes     = [];
    _photoStroke      = [];
    _photoMode        = null;

    // Load image to get dimensions
    _tpLoadImg(dataUrl).then(function(img) {
        _photoImgW = img.naturalWidth || img.width;
        _photoImgH = img.naturalHeight || img.height;

        // Build overlay
        _photoOverlay = document.createElement('div');
        _photoOverlay.className = 'tp-overlay';

        _photoOverlay.innerHTML = `
            <div class="tp-topbar">
                <span class="tp-title">Edit Photo</span>
            </div>
            <div class="tp-body" id="tp-body">
                <img id="tp-img" src="${dataUrl}" alt="${fileName}">
                <canvas class="tp-hl-canvas" id="tp-hl-canvas"></canvas>
            </div>
            <div class="tp-bottombar">
                <button class="tp-tool-btn" data-tool="cancel">
                    <span class="tp-tool-icon">✕</span> Cancel
                </button>
                <button class="tp-tool-btn" data-tool="highlight">
                    <span class="tp-tool-icon">✏️</span> Pencil
                </button>
                <button class="tp-tool-btn" data-tool="rotate">
                    <span class="tp-tool-icon">🔄</span> Rotate
                </button>
                <button class="tp-tool-btn" data-tool="reset">
                    <span class="tp-tool-icon">↩️</span> Reset
                </button>
                <button class="tp-tool-btn tp-send-btn" data-tool="send">
                    <span class="tp-tool-icon">📤</span> Send
                </button>
            </div>`;

        document.body.appendChild(_photoOverlay);

        // Cache refs
        _photoImgEl   = document.getElementById('tp-img');
        _photoCanvas  = document.getElementById('tp-hl-canvas');
        _photoCtx     = _photoCanvas.getContext('2d');

        // Compute display dimensions after layout
        requestAnimationFrame(function() {
            var r = _photoImgEl.getBoundingClientRect();
            _photoViewW = r.width;
            _photoViewH = r.height;
            _photoCanvas.width = _photoViewW;
            _photoCanvas.height = _photoViewH;
            _photoCanvas.style.width = _photoViewW + 'px';
            _photoCanvas.style.height = _photoViewH + 'px';
        });

        // Highlight drawing
        _photoCanvas.addEventListener('mousedown', _tpHighlightStart);
        _photoCanvas.addEventListener('mousemove', _tpHighlightMove);
        _photoCanvas.addEventListener('mouseup', _tpHighlightEnd);
        _photoCanvas.addEventListener('mouseleave', _tpHighlightEnd);
        _photoCanvas.addEventListener('touchstart', _tpHighlightStart, { passive: false });
        _photoCanvas.addEventListener('touchmove', _tpHighlightMove, { passive: false });
        _photoCanvas.addEventListener('touchend', _tpHighlightEnd);

        // Tool buttons
        _photoOverlay.querySelectorAll('.tp-tool-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
                var tool = btn.dataset.tool;
                if (tool === 'highlight') {
                    if (_photoMode === 'highlight') {
                        _photoMode = null;
                        btn.classList.remove('active');
                        _photoCanvas.classList.remove('active');
                        return;
                    }
                    _photoMode = 'highlight';
                    btn.classList.add('active');
                    _photoCanvas.classList.add('active');
                } else if (tool === 'rotate') {
                    // Composite existing strokes, rotate, reload
                    var scale = _photoImgW / _photoViewW;
                    var c = document.createElement('canvas');
                    c.width = _photoImgH; c.height = _photoImgW; // swap for 90°
                    var ctx = c.getContext('2d');
                    ctx.translate(c.width / 2, c.height / 2);
                    ctx.rotate(Math.PI / 2);
                    ctx.drawImage(_photoImgEl, -_photoImgW / 2, -_photoImgH / 2, _photoImgW, _photoImgH);
                    // Draw existing strokes scaled
                    _photoStrokes.forEach(function(s) {
                        ctx.beginPath();
                        s.points.forEach(function(p, i) {
                            var px = (p.x * scale) - _photoImgW / 2;
                            var py = (p.y * scale) - _photoImgH / 2;
                            // Rotate points
                            var rx = py, ry = -px;
                            i === 0 ? ctx.moveTo(rx, ry) : ctx.lineTo(rx, ry);
                        });
                        ctx.strokeStyle = s.color;
                        ctx.lineWidth = s.width * scale;
                        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
                        ctx.stroke();
                    });
                    _photoStrokes = [];
                    var newW = _photoImgH, newH = _photoImgW;
                    _photoImgW = newW; _photoImgH = newH;
                    btn.classList.remove('active');
                    _photoMode = null;
                    _photoCanvas.classList.remove('active');
                    _tpUpdateDisplay(c.toDataURL('image/jpeg', 0.85));
                } else if (tool === 'cancel') {
                    _photoOverlay.remove(); _photoOverlay = null;
                    _photoOnDone(null);
                } else if (tool === 'send') {
                    _tpComposite(function(editedUrl) {
                        if (typeof _photoOnSend === 'function') _photoOnSend(editedUrl);
                        _photoOverlay.remove();
                        _photoOverlay = null;
                    });
                    return;
                } else if (tool === 'reset') {
                    _photoStrokes = [];
                    _photoMode = null;
                    _photoCanvas.classList.remove('active');
                    btn.classList.remove('active');
                    document.querySelectorAll('.tp-tool-btn').forEach(function(b) { b.classList.remove('active'); });
                    _photoImgW = img.naturalWidth || img.width;
                    _photoImgH = img.naturalHeight || img.height;
                    _photoImgEl.src = _photoOrigDataUrl;
                    requestAnimationFrame(function() {
                        var r = _photoImgEl.getBoundingClientRect();
                        _photoViewW = r.width;
                        _photoViewH = r.height;
                        _photoCanvas.width = _photoViewW;
                        _photoCanvas.height = _photoViewH;
                        _photoCanvas.style.width = _photoViewW + 'px';
                        _photoCanvas.style.height = _photoViewH + 'px';
                        _photoCtx.clearRect(0, 0, _photoViewW, _photoViewH);
                    });
                }
            });
        });
    });
}
window._photoOpenEditor = _photoOpenEditor;

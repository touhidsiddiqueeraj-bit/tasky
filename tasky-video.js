// ═══════════════════════════════════════════════════════════════════════════
//  TASKY — VIDEO CALL LAYER  (load after tasky-voice.js)
//  Extends existing WebRTC voice calls with:
//    • Camera on/off toggle + video tracks in existing PeerConnections
//    • Screen sharing via getDisplayMedia()
//    • Grid view (2×2, 3×3) and Speaker view (active speaker large)
//    • Call recording → Firebase Storage (MediaRecorder, WebM/Opus)
//    • Picture-in-Picture mode (documentPictureInPicture / standard API)
//    • Bandwidth management (HD 720p / SD 360p toggle)
//    • Per-peer video <video> elements wired to existing WebRTC mesh
//
//  INTEGRATION NOTES:
//  - Reads / patches vcLocalStream, vcPeers, vcParticipants, vcActive from
//    tasky-voice.js scope via window.*  (same-page globals)
//  - Calls _vcToast() and _vcRenderParticipants() from tasky-voice.js
//  - Firebase Storage accessed via window.firebase.storage()
//  - All new state lives in this file; tasky-voice.js is NOT modified
// ═══════════════════════════════════════════════════════════════════════════

// ─── Video State ─────────────────────────────────────────────────────────
let vvCameraOn        = false;
let vvScreenOn        = false;
let vvCameraStream    = null;   // getUserMedia video-only stream
let vvScreenStream    = null;   // getDisplayMedia stream
let vvQuality         = 'hd';  // 'hd' | 'sd'
let vvLayout          = 'grid'; // 'grid' | 'speaker'
let vvSpeakerUid      = null;   // uid of pinned/active speaker in speaker view
let vvRecording       = false;
let vvMediaRecorder   = null;
let vvRecordChunks    = [];
let vvRecordStartTime = null;
let vvRecordInterval  = null;
let vvPipWindow       = null;   // Picture-in-Picture window ref
let vvPipActive       = false;
let vvVideoGrid       = null;   // the floating video grid panel DOM node
let vvGridVisible     = false;
let vvActiveSpeaker   = null;   // uid with highest VAD recently

// Quality presets
const VV_QUALITY = {
    hd: { width: 1280, height: 720,  frameRate: 30, bitrate: 1500000 },
    sd: { width: 640,  height: 360,  frameRate: 15, bitrate: 400000  }
};

// ─── Accessors (mirrors pattern in tasky-voice.js) ────────────────────────
function _vvUser()      { return window.currentUser || null; }
function _vvMe()        { const u = _vvUser(); return u ? u.uid : null; }
function _vvGroup()     { return window.currentGroup || null; }
function _vvIsActive()  { return !!window.vcActive; }
function _vvPeers()     { return window.vcPeers || {}; }
function _vvPartic()    { return window.vcParticipants || {}; }
function _vvEsc(s)      { return typeof escHtml === 'function' ? escHtml(s) : String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function _vvLocalStream(){ return window.vcLocalStream || null; }

function _vvToast(msg) {
    if (typeof _vcToast === 'function') { _vcToast(msg); return; }
    if (typeof _collabToast === 'function') { _collabToast(msg); return; }
    const t = document.createElement('div');
    t.className = 'vc-toast'; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3200);
}

// ─── Firebase Storage ref ─────────────────────────────────────────────────
function _vvStorageRef() {
    try {
        const storage = firebase.storage();
        const group   = _vvGroup();
        if (!storage || !group) return null;
        const ts   = new Date().toISOString().replace(/[:.]/g, '-');
        const me   = _vvMe();
        return storage.ref(`call_recordings/${group.code}/${me}_${ts}.webm`);
    } catch(e) { return null; }
}

// ─── Quality constraint builder ───────────────────────────────────────────
function _vvCamConstraints() {
    const q = VV_QUALITY[vvQuality] || VV_QUALITY.hd;
    return {
        video: { width: { ideal: q.width }, height: { ideal: q.height }, frameRate: { ideal: q.frameRate } },
        audio: false
    };
}

// ══════════════════════════════════════════════════════════════════════════
//  CAMERA
// ══════════════════════════════════════════════════════════════════════════
async function vvToggleCamera() {
    if (!_vvIsActive()) { _vvToast('⚠️ Join a call first'); return; }

    if (vvCameraOn) {
        // Turn off
        _vvRemoveCameraTrack();
        if (vvCameraStream) { vvCameraStream.getTracks().forEach(t => t.stop()); vvCameraStream = null; }
        vvCameraOn = false;
        _vvToast('📷 Camera off');
    } else {
        // Turn on — stop screen share first if active (can only share one video source)
        if (vvScreenOn) await vvToggleScreen();
        try {
            vvCameraStream = await navigator.mediaDevices.getUserMedia(_vvCamConstraints());
        } catch(e) {
            _vvToast('📷 Camera access denied'); console.warn('[VV] camera', e); return;
        }
        vvCameraOn = true;
        _vvAddVideoTrackToPeers(vvCameraStream.getVideoTracks()[0]);
        _vvToast('📷 Camera on');
    }
    _vvUpdateVideoControls();
    _vvRefreshLocalTile();
    _vvRenderVideoGrid();
}

// ══════════════════════════════════════════════════════════════════════════
//  SCREEN SHARE
// ══════════════════════════════════════════════════════════════════════════
async function vvToggleScreen() {
    if (!_vvIsActive()) { _vvToast('⚠️ Join a call first'); return; }

    if (vvScreenOn) {
        _vvRemoveCameraTrack();
        if (vvScreenStream) { vvScreenStream.getTracks().forEach(t => t.stop()); vvScreenStream = null; }
        vvScreenOn = false;
        _vvToast('🖥️ Screen share stopped');
    } else {
        if (vvCameraOn) await vvToggleCamera();
        try {
            const q = VV_QUALITY[vvQuality] || VV_QUALITY.hd;
            vvScreenStream = await navigator.mediaDevices.getDisplayMedia({
                video: { width: { ideal: q.width }, height: { ideal: q.height }, frameRate: { ideal: q.frameRate } },
                audio: true
            });
            // Auto-stop when user clicks browser's "Stop sharing" button
            vvScreenStream.getVideoTracks()[0].addEventListener('ended', () => {
                if (vvScreenOn) vvToggleScreen();
            });
        } catch(e) {
            _vvToast('🖥️ Screen share cancelled'); console.warn('[VV] screen', e); return;
        }
        vvScreenOn = true;
        _vvAddVideoTrackToPeers(vvScreenStream.getVideoTracks()[0]);
        _vvToast('🖥️ Sharing screen');
    }
    _vvUpdateVideoControls();
    _vvRefreshLocalTile();
    _vvRenderVideoGrid();
}

// ─── Attach / replace video track in all existing peer connections ─────────
function _vvAddVideoTrackToPeers(track) {
    const peers = _vvPeers();
    const stream = vvCameraOn ? vvCameraStream : vvScreenStream;
    Object.values(peers).forEach(peer => {
        if (!peer.pc || peer.pc.signalingState === 'closed') return;
        const senders = peer.pc.getSenders();
        const videoSender = senders.find(s => s.track && s.track.kind === 'video');
        if (videoSender) {
            videoSender.replaceTrack(track).catch(e => console.warn('[VV] replaceTrack', e));
            _vvSetSenderBitrate(videoSender);
        } else {
            try { peer.pc.addTrack(track, stream); } catch(e) {}
        }
    });
}

function _vvRemoveCameraTrack() {
    const peers = _vvPeers();
    Object.values(peers).forEach(peer => {
        if (!peer.pc || peer.pc.signalingState === 'closed') return;
        const senders = peer.pc.getSenders();
        const vs = senders.find(s => s.track && s.track.kind === 'video');
        if (vs) { vs.replaceTrack(null).catch(() => {}); }
    });
}

async function _vvSetSenderBitrate(sender) {
    if (!sender || !sender.getParameters) return;
    try {
        const params = sender.getParameters();
        if (!params.encodings || !params.encodings.length) params.encodings = [{}];
        params.encodings[0].maxBitrate = VV_QUALITY[vvQuality].bitrate;
        await sender.setParameters(params);
    } catch(e) {}
}

// ─── Patch _vcCreatePC to also handle video tracks ────────────────────────
// We monkey-patch by wrapping the global vcPeers assignment after each peer is created
function _vvPatchPeerOnTrack(pc, peerUid) {
    const origOntrack = pc.ontrack;
    pc.ontrack = (e) => {
        if (origOntrack) origOntrack.call(pc, e);
        const track = e.track;
        if (!track || track.kind !== 'video') return;
        _vvAttachRemoteVideo(peerUid, e.streams[0]);
    };
}

function _vvAttachRemoteVideo(peerUid, stream) {
    let el = document.getElementById('vv-video-' + peerUid);
    if (!el) {
        el = document.createElement('video');
        el.id = 'vv-video-' + peerUid;
        el.autoplay = true; el.playsInline = true; el.muted = false;
        el.style.display = 'none';
        document.body.appendChild(el);
    }
    el.srcObject = stream;
    _vvPartic()[peerUid] = _vvPartic()[peerUid] || {};
    _vvPartic()[peerUid].hasVideo = true;
    _vvRefreshGridTile(peerUid);
    _vvUpdateActiveSpeaker();
}

// ─── Intercept vcPeers additions so we can patch ontrack ──────────────────
// Called every time tasky-voice creates a new PC (after _vcCreatePC returns)
function _vvWatchPeers() {
    // Poll for new peer connections and patch them
    const seen = new Set(Object.keys(_vvPeers()));
    setInterval(() => {
        const peers = _vvPeers();
        Object.entries(peers).forEach(([uid, peer]) => {
            if (!seen.has(uid) && peer.pc) {
                seen.add(uid);
                _vvPatchPeerOnTrack(peer.pc, uid);
                // If we already have camera/screen, send that track to the new peer
                const vidTrack = (vvCameraOn && vvCameraStream?.getVideoTracks()[0])
                              || (vvScreenOn && vvScreenStream?.getVideoTracks()[0]);
                if (vidTrack) {
                    const stream = vvCameraOn ? vvCameraStream : vvScreenStream;
                    try { peer.pc.addTrack(vidTrack, stream); } catch(e) {}
                }
            }
        });
        // Remove stale video elements for disconnected peers
        seen.forEach(uid => {
            if (!peers[uid]) {
                seen.delete(uid);
                document.getElementById('vv-video-' + uid)?.remove();
                _vvRefreshGridTile(uid, true);
            }
        });
    }, 800);
}

// ══════════════════════════════════════════════════════════════════════════
//  RECORDING
// ══════════════════════════════════════════════════════════════════════════
async function vvToggleRecording() {
    if (!_vvIsActive()) { _vvToast('⚠️ Join a call first'); return; }

    if (vvRecording) {
        _vvStopRecording();
    } else {
        await _vvStartRecording();
    }
}

async function _vvStartRecording() {
    // Build a composite stream: local audio + local video (if any) + remote audio
    const tracks = [];

    // Local audio
    const ls = _vvLocalStream();
    if (ls) ls.getAudioTracks().forEach(t => tracks.push(t));

    // Local video
    const vid = vvCameraOn ? vvCameraStream : (vvScreenOn ? vvScreenStream : null);
    if (vid) vid.getVideoTracks().forEach(t => tracks.push(t));

    // Remote audio elements — capture via Web Audio + MediaStreamDestination
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const dest = ctx.createMediaStreamDestination();
    document.querySelectorAll('[id^="vc-audio-"]').forEach(el => {
        if (el.srcObject) {
            try {
                const src = ctx.createMediaStreamSource(el.srcObject);
                src.connect(dest);
            } catch(e) {}
        }
    });
    dest.stream.getAudioTracks().forEach(t => tracks.push(t));

    const composite = new MediaStream(tracks);

    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
        ? 'video/webm;codecs=vp9,opus'
        : MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
        ? 'video/webm;codecs=vp8,opus'
        : 'video/webm';

    try {
        vvMediaRecorder = new MediaRecorder(composite, { mimeType, videoBitsPerSecond: VV_QUALITY[vvQuality].bitrate });
    } catch(e) {
        _vvToast('⚠️ Recording not supported in this browser'); return;
    }

    vvRecordChunks    = [];
    vvRecordStartTime = Date.now();
    vvRecording       = true;

    vvMediaRecorder.ondataavailable = e => { if (e.data.size > 0) vvRecordChunks.push(e.data); };
    vvMediaRecorder.onstop = () => _vvSaveRecording(ctx);

    vvMediaRecorder.start(1000); // 1-second chunks
    vvRecordInterval = setInterval(_vvUpdateRecordTimer, 1000);

    _vvUpdateVideoControls();
    _vvToast('⏺️ Recording started');
}

function _vvStopRecording() {
    if (!vvMediaRecorder || !vvRecording) return;
    vvRecording = false;
    clearInterval(vvRecordInterval); vvRecordInterval = null;
    vvMediaRecorder.stop();
    _vvUpdateVideoControls();
    _vvToast('⏹️ Processing recording…');
}

async function _vvSaveRecording(ctx) {
    if (ctx) ctx.close().catch(() => {});
    const blob = new Blob(vvRecordChunks, { type: 'video/webm' });
    vvRecordChunks = [];

    // Try Firebase Storage first
    const storageRef = _vvStorageRef();
    if (storageRef) {
        try {
            _vvToast('☁️ Uploading recording to cloud…');
            const task = await storageRef.put(blob, { contentType: 'video/webm' });
            const url  = await task.ref.getDownloadURL();
            _vvToast('✅ Recording saved to cloud');
            // Also offer local download
            _vvDownloadBlob(blob, 'tasky-call-recording.webm');
            return;
        } catch(e) {
            console.warn('[VV] Firebase Storage upload failed, falling back to download', e);
        }
    }

    // Fallback: local download
    _vvDownloadBlob(blob, 'tasky-call-recording.webm');
    _vvToast('💾 Recording downloaded');
}

function _vvDownloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 3000);
}

function _vvUpdateRecordTimer() {
    const el = document.getElementById('vv-rec-timer');
    if (!el || !vvRecordStartTime) return;
    const s = Math.floor((Date.now() - vvRecordStartTime) / 1000);
    el.textContent = `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
}

// ══════════════════════════════════════════════════════════════════════════
//  PICTURE-IN-PICTURE
// ══════════════════════════════════════════════════════════════════════════
async function vvTogglePiP() {
    if (vvPipActive) {
        _vvClosePiP(); return;
    }

    // Choose video source: local cam > screen > first remote
    let srcEl = document.getElementById('vv-local-video');
    if (!srcEl || !srcEl.srcObject) {
        // Try first remote video
        const remoteVid = document.querySelector('[id^="vv-video-"]');
        if (remoteVid) srcEl = remoteVid;
    }

    if (!srcEl || !srcEl.srcObject) {
        _vvToast('⚠️ No video to put in PiP — turn camera on first'); return;
    }

    // Standard HTML5 PiP
    if (document.pictureInPictureEnabled) {
        try {
            srcEl.style.display = 'block'; // must be visible
            await srcEl.requestPictureInPicture();
            vvPipActive = true;
            srcEl.addEventListener('leavepictureinpicture', () => {
                vvPipActive = false; _vvUpdateVideoControls();
            }, { once: true });
            _vvToast('📺 Picture-in-Picture active');
            _vvUpdateVideoControls(); return;
        } catch(e) { console.warn('[VV] PiP', e); }
    }

    // Document PiP (Chrome 116+)
    if (window.documentPictureInPicture) {
        try {
            vvPipWindow = await window.documentPictureInPicture.requestWindow({ width: 320, height: 240 });
            const cloneVid = srcEl.cloneNode(false);
            cloneVid.srcObject = srcEl.srcObject;
            cloneVid.style.cssText = 'width:100%;height:100%;object-fit:cover;background:#000';
            vvPipWindow.document.body.style.cssText = 'margin:0;background:#000';
            vvPipWindow.document.body.appendChild(cloneVid);
            cloneVid.play().catch(() => {});
            vvPipActive = true;
            vvPipWindow.addEventListener('pagehide', () => {
                vvPipActive = false; vvPipWindow = null; _vvUpdateVideoControls();
            });
            _vvToast('📺 Document PiP active');
            _vvUpdateVideoControls(); return;
        } catch(e) { console.warn('[VV] docPiP', e); }
    }

    _vvToast('⚠️ Picture-in-Picture not supported in this browser');
}

function _vvClosePiP() {
    if (document.pictureInPictureElement) {
        document.exitPictureInPicture().catch(() => {});
    }
    if (vvPipWindow) { try { vvPipWindow.close(); } catch(_) {} vvPipWindow = null; }
    vvPipActive = false;
    _vvUpdateVideoControls();
    _vvToast('📺 PiP closed');
}

// ══════════════════════════════════════════════════════════════════════════
//  BANDWIDTH / QUALITY
// ══════════════════════════════════════════════════════════════════════════
async function vvToggleQuality() {
    vvQuality = (vvQuality === 'hd') ? 'sd' : 'hd';

    // Apply new bitrate to all video senders
    const peers = _vvPeers();
    for (const peer of Object.values(peers)) {
        if (!peer.pc) continue;
        const vs = peer.pc.getSenders().find(s => s.track?.kind === 'video');
        if (vs) await _vvSetSenderBitrate(vs);
    }

    // If camera is on, restart with new constraints
    if (vvCameraOn && vvCameraStream) {
        const track = vvCameraStream.getVideoTracks()[0];
        if (track) {
            const q = VV_QUALITY[vvQuality];
            try {
                await track.applyConstraints({ width: { ideal: q.width }, height: { ideal: q.height }, frameRate: { ideal: q.frameRate } });
            } catch(e) {}
        }
    }

    _vvUpdateVideoControls();
    _vvToast(`📶 Quality: ${vvQuality.toUpperCase()}`);
}

// ══════════════════════════════════════════════════════════════════════════
//  LAYOUT SWITCHING
// ══════════════════════════════════════════════════════════════════════════
function vvToggleLayout() {
    vvLayout = (vvLayout === 'grid') ? 'speaker' : 'grid';
    _vvRenderVideoGrid();
    _vvUpdateVideoControls();
    _vvToast(vvLayout === 'grid' ? '⊞ Grid view' : '👤 Speaker view');
}

function _vvUpdateActiveSpeaker() {
    // Find participant with highest speaking level
    const partic = _vvPartic();
    for (const [uid, p] of Object.entries(partic)) {
        if (p.speaking && !p.muted) { vvActiveSpeaker = uid; break; }
    }
    if (vvLayout === 'speaker') _vvRenderVideoGrid();
}

function vvPinSpeaker(uid) {
    vvSpeakerUid = (vvSpeakerUid === uid) ? null : uid;
    if (vvLayout !== 'speaker') { vvLayout = 'speaker'; _vvUpdateVideoControls(); }
    _vvRenderVideoGrid();
}

// ══════════════════════════════════════════════════════════════════════════
//  VIDEO GRID PANEL
// ══════════════════════════════════════════════════════════════════════════
function vvToggleVideoGrid() {
    if (vvGridVisible) {
        _vvHideVideoGrid();
    } else {
        _vvShowVideoGrid();
    }
}

function _vvShowVideoGrid() {
    vvGridVisible = true;
    if (!vvVideoGrid) _vvBuildVideoGrid();
    vvVideoGrid.style.display = 'flex';
    _vvRenderVideoGrid();
    _vvUpdateVideoControls();
}

function _vvHideVideoGrid() {
    vvGridVisible = false;
    if (vvVideoGrid) vvVideoGrid.style.display = 'none';
    _vvUpdateVideoControls();
}

function _vvBuildVideoGrid() {
    const grid = document.createElement('div');
    grid.id = 'vv-grid';
    grid.className = 'vv-grid';

    grid.innerHTML = `
        <div class="vv-grid-bar">
            <div class="vv-grid-title">
                <span class="vv-grid-icon">🎬</span>
                <span id="vv-grid-label">Video</span>
            </div>
            <div class="vv-grid-controls">
                <span class="vv-rec-badge" id="vv-rec-badge" style="display:none;">
                    <span class="vv-rec-dot"></span>REC <span id="vv-rec-timer">00:00</span>
                </span>
                <button class="vv-ctrl" id="vv-btn-cam"    title="Camera">📷</button>
                <button class="vv-ctrl" id="vv-btn-screen" title="Screen share">🖥️</button>
                <button class="vv-ctrl" id="vv-btn-rec"    title="Record">⏺️</button>
                <button class="vv-ctrl" id="vv-btn-pip"    title="Picture-in-Picture">📺</button>
                <button class="vv-ctrl" id="vv-btn-quality"title="HD/SD">📶</button>
                <button class="vv-ctrl" id="vv-btn-layout" title="Layout">⊞</button>
                <button class="vv-ctrl vv-ctrl--close" id="vv-btn-close" title="Close video panel">✕</button>
            </div>
        </div>
        <div class="vv-tiles" id="vv-tiles"></div>`;

    document.body.appendChild(grid);
    vvVideoGrid = grid;

    // Make draggable
    _vvMakeDraggable(grid, grid.querySelector('.vv-grid-bar'));

    // Wire buttons
    grid.querySelector('#vv-btn-cam').addEventListener('click',    vvToggleCamera);
    grid.querySelector('#vv-btn-screen').addEventListener('click', vvToggleScreen);
    grid.querySelector('#vv-btn-rec').addEventListener('click',    vvToggleRecording);
    grid.querySelector('#vv-btn-pip').addEventListener('click',    vvTogglePiP);
    grid.querySelector('#vv-btn-quality').addEventListener('click',vvToggleQuality);
    grid.querySelector('#vv-btn-layout').addEventListener('click', vvToggleLayout);
    grid.querySelector('#vv-btn-close').addEventListener('click',  _vvHideVideoGrid);
}

function _vvMakeDraggable(el, handle) {
    let sx, sy, ex, ey;
    handle.style.cursor = 'move';
    handle.addEventListener('mousedown', e => {
        sx = e.clientX; sy = e.clientY;
        const r = el.getBoundingClientRect();
        ex = r.left; ey = r.top;
        el.style.transition = 'none';
        const move = ev => {
            const nx = ex + ev.clientX - sx;
            const ny = ey + ev.clientY - sy;
            el.style.left   = Math.max(0, Math.min(window.innerWidth  - el.offsetWidth,  nx)) + 'px';
            el.style.top    = Math.max(0, Math.min(window.innerHeight - el.offsetHeight, ny)) + 'px';
            el.style.right  = 'auto';
            el.style.bottom = 'auto';
        };
        const up = () => {
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', up);
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
    });
}

function _vvRenderVideoGrid() {
    const tiles = document.getElementById('vv-tiles');
    if (!tiles) return;

    const partic  = _vvPartic();
    const me      = _vvMe();
    const entries = Object.entries(partic);
    const count   = entries.length + 1; // +1 for local self tile

    // Determine grid class
    const gridClass = count <= 1 ? 'vv-tiles--1'
                    : count <= 2 ? 'vv-tiles--2'
                    : count <= 4 ? 'vv-tiles--4'
                    : 'vv-tiles--9';

    // Speaker view: determine featured uid
    const featured = vvSpeakerUid || vvActiveSpeaker || me;

    tiles.className = `vv-tiles ${gridClass} ${vvLayout === 'speaker' ? 'vv-tiles--speaker' : ''}`;
    tiles.innerHTML = '';

    // Build tile list: in speaker view, featured goes first and gets .vv-tile--featured
    const allTiles = [{ uid: me, isLocal: true, p: { handle: window.currentHandle || 'You', muted: false } }];
    entries.forEach(([uid, p]) => { if (uid !== me) allTiles.push({ uid, isLocal: false, p }); });

    if (vvLayout === 'speaker') {
        // Sort: featured first
        allTiles.sort((a, b) => (a.uid === featured ? -1 : b.uid === featured ? 1 : 0));
    }

    allTiles.forEach(({ uid, isLocal, p }) => {
        const isFeatured = vvLayout === 'speaker' && uid === featured;
        const tile = _vvMakeTile(uid, isLocal, p, isFeatured);
        tiles.appendChild(tile);
    });

    // Label
    const label = document.getElementById('vv-grid-label');
    if (label) label.textContent = `Video · ${allTiles.length} ${allTiles.length === 1 ? 'person' : 'people'}`;

    // Rec badge
    const badge = document.getElementById('vv-rec-badge');
    if (badge) badge.style.display = vvRecording ? 'flex' : 'none';
}

function _vvMakeTile(uid, isLocal, p, isFeatured) {
    const tile = document.createElement('div');
    tile.className = `vv-tile ${isFeatured ? 'vv-tile--featured' : ''} ${p.speaking && !p.muted ? 'vv-tile--speaking' : ''}`;
    tile.dataset.uid = uid;
    tile.id = 'vv-tile-' + uid;

    const hasVideo = isLocal
        ? (vvCameraOn || vvScreenOn)
        : !!document.getElementById('vv-video-' + uid)?.srcObject;

    const videoEl = _vvGetOrCreateVideoEl(uid, isLocal);

    tile.appendChild(videoEl);

    // Avatar overlay (shown when no video)
    const ov = document.createElement('div');
    ov.className = `vv-tile-overlay ${hasVideo ? 'vv-tile-overlay--hidden' : ''}`;
    ov.id = 'vv-ov-' + uid;
    const handle = p.handle || (isLocal ? (window.currentHandle || 'You') : uid.slice(0,6));
    ov.innerHTML = `<div class="vv-tile-avatar">${handle[0].toUpperCase()}</div>
                    <div class="vv-tile-name">@${_vvEsc(handle)}${isLocal ? ' (you)' : ''}</div>`;
    tile.appendChild(ov);

    // Bottom bar
    const bar = document.createElement('div');
    bar.className = 'vv-tile-bar';
    bar.innerHTML = `<span class="vv-tile-handle">@${_vvEsc(handle)}${isLocal ? ' (you)' : ''}</span>
        <div class="vv-tile-icons">
            ${p.muted ? '<span title="Muted">🔇</span>' : ''}
            ${isLocal && (vvCameraOn || vvScreenOn) ? (vvScreenOn ? '<span title="Sharing screen">🖥️</span>' : '<span title="Camera on">📷</span>') : ''}
            ${!isLocal && hasVideo ? '<span title="Camera on">📷</span>' : ''}
        </div>`;
    tile.appendChild(bar);

    // Pin button (speaker view)
    if (!isLocal) {
        const pinBtn = document.createElement('button');
        pinBtn.className = 'vv-pin-btn';
        pinBtn.title = 'Pin / spotlight';
        pinBtn.textContent = vvSpeakerUid === uid ? '📌' : '📍';
        pinBtn.addEventListener('click', (e) => { e.stopPropagation(); vvPinSpeaker(uid); });
        tile.appendChild(pinBtn);
    }

    // Double-click → fullscreen
    tile.addEventListener('dblclick', () => {
        if (!document.fullscreenElement) {
            tile.requestFullscreen?.() || tile.webkitRequestFullscreen?.();
        } else {
            document.exitFullscreen?.() || document.webkitExitFullscreen?.();
        }
    });

    return tile;
}

function _vvGetOrCreateVideoEl(uid, isLocal) {
    const videoId = isLocal ? 'vv-local-video' : 'vv-video-' + uid;
    let el = document.getElementById(videoId);
    if (!el) {
        el = document.createElement('video');
        el.id = videoId;
        el.autoplay = true; el.playsInline = true;
        if (isLocal) el.muted = true; // no echo
    }
    el.className = 'vv-tile-video';

    if (isLocal) {
        const src = vvCameraOn ? vvCameraStream : (vvScreenOn ? vvScreenStream : null);
        if (src && el.srcObject !== src) el.srcObject = src;
        el.style.display = (vvCameraOn || vvScreenOn) ? 'block' : 'none';
    }
    return el;
}

function _vvRefreshLocalTile() {
    const tile = document.getElementById('vv-tile-' + _vvMe());
    const ov   = document.getElementById('vv-ov-' + _vvMe());
    const vid  = document.getElementById('vv-local-video');
    const hasVideo = vvCameraOn || vvScreenOn;
    if (vid) {
        vid.srcObject = hasVideo ? (vvCameraOn ? vvCameraStream : vvScreenStream) : null;
        vid.style.display = hasVideo ? 'block' : 'none';
    }
    if (ov) ov.className = `vv-tile-overlay ${hasVideo ? 'vv-tile-overlay--hidden' : ''}`;
    if (tile) tile.className = `vv-tile ${_vvPartic()[_vvMe()]?.speaking ? 'vv-tile--speaking' : ''}`;
}

function _vvRefreshGridTile(uid, remove) {
    if (remove) { document.getElementById('vv-tile-' + uid)?.remove(); return; }
    _vvRenderVideoGrid();
}

// ══════════════════════════════════════════════════════════════════════════
//  VIDEO CONTROLS UPDATE
// ══════════════════════════════════════════════════════════════════════════
function _vvUpdateVideoControls() {
    _vvSetBtn('vv-btn-cam',    vvCameraOn,   '📷', '📷');
    _vvSetBtn('vv-btn-screen', vvScreenOn,   '🖥️', '🖥️');
    _vvSetBtn('vv-btn-rec',    vvRecording,  '⏹️', '⏺️');
    _vvSetBtn('vv-btn-pip',    vvPipActive,  '📺', '📺');
    _vvSetBtn('vv-btn-quality',false, vvQuality === 'hd' ? 'HD📶' : 'SD📶', '');
    _vvSetBtn('vv-btn-layout', false, vvLayout === 'grid' ? '⊞' : '👤', '');

    // Call button badge (injected into vc-panel controls)
    const vidPanelBtn = document.getElementById('vv-panel-btn');
    if (vidPanelBtn) {
        vidPanelBtn.className = `vc-ctrl-btn ${vvGridVisible ? 'vc-ctrl-btn--active' : ''}`;
        vidPanelBtn.innerHTML = `📹<span>Video</span>`;
    }
}

function _vvSetBtn(id, active, activeLabel, inactiveLabel) {
    const btn = document.getElementById(id); if (!btn) return;
    btn.className = `vv-ctrl ${active ? 'vv-ctrl--active' : ''}`;
    if (activeLabel) btn.textContent = active ? activeLabel : inactiveLabel;
}

// ─── Inject Video button into vc-panel controls bar ───────────────────────
function _vvInjectPanelButton() {
    if (document.getElementById('vv-panel-btn')) return;
    const leaveBtn = document.getElementById('vc-leave-btn');
    if (!leaveBtn) return;
    const btn = document.createElement('button');
    btn.id = 'vv-panel-btn';
    btn.className = 'vc-ctrl-btn';
    btn.innerHTML = '📹<span>Video</span>';
    btn.addEventListener('click', vvToggleVideoGrid);
    leaveBtn.parentNode.insertBefore(btn, leaveBtn);
}

// ─── Patch _vcRenderPanel to inject video button ──────────────────────────
function _vvPatchRenderPanel() {
    const origRender = window._vcRenderPanel;
    // Since _vcRenderPanel is not exported to window, we watch for panel creation
    const obs = new MutationObserver(() => {
        const panel = document.getElementById('vc-panel');
        if (panel && !document.getElementById('vv-panel-btn')) {
            _vvInjectPanelButton();
        }
    });
    obs.observe(document.body, { childList: true });
}

// ──────────────────────────────────────────────────────────────────────────
//  CLEANUP — extend vcLeave to teardown video
// ──────────────────────────────────────────────────────────────────────────
function _vvCleanup() {
    if (vvRecording) _vvStopRecording();

    _vvClosePiP();

    if (vvCameraStream)  { vvCameraStream.getTracks().forEach(t => t.stop());  vvCameraStream  = null; }
    if (vvScreenStream)  { vvScreenStream.getTracks().forEach(t => t.stop());  vvScreenStream  = null; }

    vvCameraOn = false; vvScreenOn = false;

    // Remove all vv video elements
    document.querySelectorAll('[id^="vv-video-"]').forEach(el => { el.srcObject = null; el.remove(); });
    const lv = document.getElementById('vv-local-video');
    if (lv) { lv.srcObject = null; lv.remove(); }

    _vvHideVideoGrid();
    _vvUpdateVideoControls();
}

// ─── Patch vcLeave to call cleanup ────────────────────────────────────────
function _vvPatchVcLeave() {
    const origLeave = window.vcLeave;
    if (!origLeave) { setTimeout(_vvPatchVcLeave, 300); return; }
    window.vcLeave = async function() {
        _vvCleanup();
        return origLeave.apply(this, arguments);
    };
}

// ── Also patch VAD speaking detection to update active speaker ─────────────
function _vvPatchVAD() {
    // Hook into vcParticipants changes by polling speaking state
    setInterval(() => {
        const partic = _vvPartic();
        for (const [uid, p] of Object.entries(partic)) {
            if (p.speaking && !p.muted && uid !== vvActiveSpeaker) {
                vvActiveSpeaker = uid;
                if (vvLayout === 'speaker' && !vvSpeakerUid) _vvRenderVideoGrid();
                break;
            }
        }
    }, 500);
}

// ══════════════════════════════════════════════════════════════════════════
//  INITIALISATION
// ══════════════════════════════════════════════════════════════════════════
window.addEventListener('load', function _vvInit() {
    _vvPatchVcLeave();
    _vvPatchRenderPanel();
    _vvWatchPeers();
    _vvPatchVAD();

    // If there's already a panel open (rejoining), inject button immediately
    setTimeout(() => {
        if (document.getElementById('vc-panel')) _vvInjectPanelButton();
    }, 300);
});

// ─── Exports ──────────────────────────────────────────────────────────────
window.vvToggleCamera    = vvToggleCamera;
window.vvToggleScreen    = vvToggleScreen;
window.vvToggleRecording = vvToggleRecording;
window.vvTogglePiP       = vvTogglePiP;
window.vvToggleQuality   = vvToggleQuality;
window.vvToggleLayout    = vvToggleLayout;
window.vvToggleVideoGrid = vvToggleVideoGrid;
window.vvPinSpeaker      = vvPinSpeaker;

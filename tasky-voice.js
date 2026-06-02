// ═══════════════════════════════════════════════════════════════════════════
//  TASKY — VOICE CALL LAYER  (load after tasky-collab.js)
//  WebRTC mesh voice calls for collab groups via Firebase Firestore signaling
//  Supports: group call, mute, deafen, speaker indicators, supervisor kick
// ═══════════════════════════════════════════════════════════════════════════

// ─── Constants ───────────────────────────────────────────────────────────
const VC_COLLECTION   = 'voice_sessions';  // Firestore root: voice_sessions/{groupCode}
const VC_ICE_SERVERS  = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
];
const VC_OFFER_TIMEOUT_MS  = 15000;
const VC_RECONNECT_DELAY   = 3000;
const VC_SPEAKING_THRESHOLD = -50;   // dB — anything above this is "speaking"
const VC_SPEAKING_INTERVAL  = 200;   // ms between VAD polls

// ─── State ────────────────────────────────────────────────────────────────
let vcActive          = false;       // Are we in a call?
let vcLocalStream     = null;        // MediaStream (mic)
let vcPeers           = {};          // { uid: { pc, audioEl, offerPending } }
let vcParticipants    = {};          // { uid: { handle, muted, speaking } }
let vcMuted           = false;
let vcDeafened        = false;
let vcSessionRef      = null;        // Firestore doc ref for our session
let vcPresenceRef     = null;        // our presence entry
let vcSessionListener = null;        // onSnapshot unsub
let vcPresenceUnsub   = null;
let vcAudioCtx        = null;
let vcAnalysers       = {};          // { uid: AnalyserNode }  (uid='local' for self)
let vcVadInterval     = null;
let vcCallStartTime   = null;
let vcDurationInterval = null;
let _vcPanelOpen      = false;
let _vcOfferQueue     = [];          // deferred offers to process after getUserMedia

// ─── Helpers ──────────────────────────────────────────────────────────────
function _vcMe()   { return currentUser  ? currentUser.uid    : null; }
function _vcHnd()  { return currentHandle || 'me'; }
function _vcDb()   { return window.db || (typeof firebase !== 'undefined' ? firebase.firestore() : null); }
function _vcLog(...a) { console.log('[VC]', ...a); }

function _vcToast(msg) {
    if (typeof _collabToast === 'function') { _collabToast(msg); return; }
    const t = document.createElement('div');
    t.className = 'vc-toast'; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
}

function _vcGroupRef() {
    const d = _vcDb(); if (!d || !currentGroup) return null;
    return d.collection(VC_COLLECTION).doc(currentGroup.code);
}

function _vcMyPresenceRef() {
    const g = _vcGroupRef(); if (!g) return null;
    return g.collection('participants').doc(_vcMe());
}

// ─── Audio / VAD ──────────────────────────────────────────────────────────
function _vcInitAudioCtx() {
    if (!vcAudioCtx) vcAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
}

function _vcTrackVAD(uid, stream) {
    _vcInitAudioCtx();
    try {
        const src = vcAudioCtx.createMediaStreamSource(stream);
        const analyser = vcAudioCtx.createAnalyser();
        analyser.fftSize = 256;
        src.connect(analyser);
        vcAnalysers[uid] = analyser;
    } catch(e) { _vcLog('VAD init error', e); }
}

function _vcRemoveVAD(uid) {
    delete vcAnalysers[uid];
}

function _vcGetLevel(analyser) {
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

function _vcStartVAD() {
    if (vcVadInterval) return;
    vcVadInterval = setInterval(() => {
        let changed = false;
        for (const [uid, analyser] of Object.entries(vcAnalysers)) {
            const dB = _vcGetLevel(analyser);
            const speaking = dB > VC_SPEAKING_THRESHOLD;
            const realUid = uid === 'local' ? _vcMe() : uid;
            if (!vcParticipants[realUid]) continue;
            if (vcParticipants[realUid].speaking !== speaking) {
                vcParticipants[realUid].speaking = speaking;
                changed = true;
                // Broadcast our own speaking state
                if (uid === 'local' && vcPresenceRef && !vcMuted) {
                    vcPresenceRef.update({ speaking }).catch(() => {});
                }
            }
        }
        if (changed) _vcRenderParticipants();
    }, VC_SPEAKING_INTERVAL);
}

function _vcStopVAD() {
    if (vcVadInterval) { clearInterval(vcVadInterval); vcVadInterval = null; }
    vcAnalysers = {};
}

// ─── WebRTC Peer Connection ────────────────────────────────────────────────
function _vcCreatePC(peerUid) {
    const pc = new RTCPeerConnection({ iceServers: VC_ICE_SERVERS });

    // Add local tracks
    if (vcLocalStream) {
        vcLocalStream.getTracks().forEach(t => pc.addTrack(t, vcLocalStream));
    }

    // Receive remote audio
    pc.ontrack = (e) => {
        _vcLog('Track from', peerUid);
        let el = document.getElementById('vc-audio-' + peerUid);
        if (!el) {
            el = document.createElement('audio');
            el.id = 'vc-audio-' + peerUid;
            el.autoplay = true;
            el.style.display = 'none';
            document.body.appendChild(el);
        }
        el.srcObject = e.streams[0];
        if (vcDeafened) el.muted = true;
        // VAD on remote stream
        _vcTrackVAD(peerUid, e.streams[0]);
        vcPeers[peerUid] = vcPeers[peerUid] || {};
        vcPeers[peerUid].audioEl = el;
    };

    // ICE candidate → Firestore
    pc.onicecandidate = (e) => {
        if (!e.candidate) return;
        const gRef = _vcGroupRef(); if (!gRef) return;
        gRef.collection('signals')
            .add({
                from: _vcMe(),
                to:   peerUid,
                type: 'candidate',
                candidate: e.candidate.toJSON(),
                ts: firebase.firestore.FieldValue.serverTimestamp()
            }).catch(() => {});
    };

    pc.onconnectionstatechange = () => {
        _vcLog('PC state with', peerUid, ':', pc.connectionState);
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
            _vcHandlePeerDisconnect(peerUid);
        }
        _vcRenderParticipants();
    };

    vcPeers[peerUid] = vcPeers[peerUid] || {};
    vcPeers[peerUid].pc = pc;
    return pc;
}

async function _vcOffer(peerUid) {
    _vcLog('Offering to', peerUid);
    const pc = _vcCreatePC(peerUid);
    try {
        const offer = await pc.createOffer({ offerToReceiveAudio: true });
        await pc.setLocalDescription(offer);
        const gRef = _vcGroupRef(); if (!gRef) return;
        await gRef.collection('signals').add({
            from: _vcMe(),
            to:   peerUid,
            type: 'offer',
            sdp:  pc.localDescription.sdp,
            ts:   firebase.firestore.FieldValue.serverTimestamp()
        });
    } catch(e) { _vcLog('Offer error', e); }
}

async function _vcAnswer(peerUid, sdp) {
    _vcLog('Answering', peerUid);
    let pc = vcPeers[peerUid]?.pc;
    if (!pc || pc.signalingState === 'closed') {
        pc = _vcCreatePC(peerUid);
    }
    try {
        if (pc.signalingState !== 'stable') {
            await pc.setRemoteDescription({ type: 'offer', sdp });
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            const gRef = _vcGroupRef(); if (!gRef) return;
            await gRef.collection('signals').add({
                from: _vcMe(),
                to:   peerUid,
                type: 'answer',
                sdp:  pc.localDescription.sdp,
                ts:   firebase.firestore.FieldValue.serverTimestamp()
            });
        }
    } catch(e) { _vcLog('Answer error', e); }
}

async function _vcHandleAnswer(peerUid, sdp) {
    const pc = vcPeers[peerUid]?.pc;
    if (!pc || pc.signalingState === 'closed') return;
    try {
        if (pc.signalingState === 'have-local-offer') {
            await pc.setRemoteDescription({ type: 'answer', sdp });
        }
    } catch(e) { _vcLog('Handle answer error', e); }
}

async function _vcHandleCandidate(peerUid, candidate) {
    const pc = vcPeers[peerUid]?.pc;
    if (!pc || pc.signalingState === 'closed') return;
    try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch(e) { /* ignore stale candidates */ }
}

function _vcHandlePeerDisconnect(peerUid) {
    // Attempt reconnect after delay if we're still in call
    setTimeout(() => {
        if (!vcActive || !vcParticipants[peerUid]) return;
        // Offer side reconnects (lower UID lexicographically offers)
        if (_vcMe() < peerUid) _vcOffer(peerUid);
    }, VC_RECONNECT_DELAY);
}

// ─── Firestore Signaling Listener ─────────────────────────────────────────
function _vcStartSignalingListener() {
    const gRef = _vcGroupRef(); if (!gRef) return;
    const me = _vcMe();

    // Watch signals addressed to me
    const sigRef = gRef.collection('signals').where('to', '==', me);
    const sigUnsub = sigRef.onSnapshot(snap => {
        snap.docChanges().forEach(async change => {
            if (change.type !== 'added') return;
            const sig = change.doc.data();
            const from = sig.from;
            // Delete after processing (keep Firestore clean)
            change.doc.ref.delete().catch(() => {});

            if (sig.type === 'offer') {
                // Only answer if we're in the call
                if (vcActive) await _vcAnswer(from, sig.sdp);
            } else if (sig.type === 'answer') {
                await _vcHandleAnswer(from, sig.sdp);
            } else if (sig.type === 'candidate') {
                await _vcHandleCandidate(from, sig.candidate);
            }
        });
    });

    // Watch participant presence
    const presRef = gRef.collection('participants');
    const presUnsub = presRef.onSnapshot(snap => {
        const me = _vcMe();
        snap.docChanges().forEach(change => {
            const uid = change.doc.id;
            const data = change.doc.data();

            if (change.type === 'removed') {
                if (uid !== me) _vcRemovePeer(uid);
                return;
            }

            if (uid === me) {
                // Our own presence updated
                vcParticipants[me] = { ...vcParticipants[me], ...data };
            } else {
                const wasHere = !!vcParticipants[uid];
                vcParticipants[uid] = { handle: data.handle || uid, muted: !!data.muted, speaking: !!data.speaking };

                if (!wasHere && vcActive) {
                    // New peer joined — if our UID is lower, we offer
                    _vcLog('New peer joined:', uid);
                    if (me < uid) {
                        setTimeout(() => _vcOffer(uid), 500);
                    }
                }
            }
        });
        _vcRenderParticipants();
        _vcUpdateCallBtn();
    });

    vcPresenceUnsub = () => { sigUnsub(); presUnsub(); };
}

function _vcRemovePeer(uid) {
    _vcLog('Removing peer', uid);
    const peer = vcPeers[uid];
    if (peer) {
        if (peer.pc) { try { peer.pc.close(); } catch(_) {} }
        if (peer.audioEl) { peer.audioEl.srcObject = null; peer.audioEl.remove(); }
    }
    delete vcPeers[uid];
    delete vcParticipants[uid];
    _vcRemoveVAD(uid);
}

// ─── Join / Leave Call ─────────────────────────────────────────────────────
async function vcJoin() {
    if (vcActive) return;
    if (!currentGroup || !currentUser || currentUser.isAnonymous) {
        _vcToast('⚠️ Sign in to join calls'); return;
    }

    try {
        vcLocalStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch(e) {
        _vcToast('🎙️ Microphone access denied');
        _vcLog('getUserMedia error', e);
        return;
    }

    vcActive      = true;
    vcMuted       = false;
    vcDeafened    = false;
    vcCallStartTime = Date.now();
    vcPeers       = {};
    vcParticipants = {};

    // VAD on local stream
    _vcTrackVAD('local', vcLocalStream);
    _vcStartVAD();

    // Write presence
    vcPresenceRef = _vcMyPresenceRef();
    await vcPresenceRef.set({
        handle:  _vcHnd(),
        uid:     _vcMe(),
        muted:   false,
        speaking: false,
        joinedAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    // Start listeners
    _vcStartSignalingListener();

    // Start duration timer
    vcDurationInterval = setInterval(_vcUpdateDuration, 1000);

    _vcRenderPanel();
    _vcToast('🎙️ Joined voice call');
    _vcUpdateCallBtn();
    _vcLog('Joined call in group', currentGroup.code);
}

async function vcLeave() {
    if (!vcActive) return;
    vcActive = false;

    _vcStopVAD();
    if (vcDurationInterval) { clearInterval(vcDurationInterval); vcDurationInterval = null; }
    if (vcPresenceUnsub) { vcPresenceUnsub(); vcPresenceUnsub = null; }

    // Remove presence
    if (vcPresenceRef) { await vcPresenceRef.delete().catch(() => {}); vcPresenceRef = null; }

    // Close all peer connections + audio elements
    for (const uid of Object.keys(vcPeers)) _vcRemovePeer(uid);
    vcPeers = {}; vcParticipants = {};

    // Stop local stream
    if (vcLocalStream) {
        vcLocalStream.getTracks().forEach(t => t.stop());
        vcLocalStream = null;
    }

    if (vcAudioCtx) { vcAudioCtx.close().catch(() => {}); vcAudioCtx = null; }

    // Clean up stale signals (best-effort)
    try {
        const gRef = _vcGroupRef();
        if (gRef) {
            const stale = await gRef.collection('signals').where('from', '==', _vcMe()).get();
            stale.forEach(d => d.ref.delete());
        }
    } catch(_) {}

    _vcClosePanel();
    _vcToast('📵 Left voice call');
    _vcUpdateCallBtn();
    _vcLog('Left call');
}

// ─── Mute / Deafen ────────────────────────────────────────────────────────
function vcToggleMute() {
    if (!vcActive || !vcLocalStream) return;
    vcMuted = !vcMuted;
    vcLocalStream.getAudioTracks().forEach(t => { t.enabled = !vcMuted; });
    if (vcPresenceRef) vcPresenceRef.update({ muted: vcMuted, speaking: false }).catch(() => {});
    _vcRenderParticipants();
    _vcUpdateControls();
    _vcToast(vcMuted ? '🔇 Muted' : '🎙️ Unmuted');
}

function vcToggleDeafen() {
    if (!vcActive) return;
    vcDeafened = !vcDeafened;
    // Mute all remote audio elements
    document.querySelectorAll('[id^="vc-audio-"]').forEach(el => { el.muted = vcDeafened; });
    // Also mute mic when deafened (standard UX)
    if (vcDeafened && !vcMuted) vcToggleMute();
    _vcUpdateControls();
    _vcToast(vcDeafened ? '🔕 Deafened' : '🔊 Undeafened');
}

// ─── Supervisor Kick ──────────────────────────────────────────────────────
async function vcKickFromCall(uid) {
    if (!isSupervisor || !currentGroup) return;
    const gRef = _vcGroupRef(); if (!gRef) return;
    // Write a kick signal
    await gRef.collection('signals').add({
        from: _vcMe(),
        to:   uid,
        type: 'kick',
        ts:   firebase.firestore.FieldValue.serverTimestamp()
    });
    _vcToast('🦶 Kicked from call');
}

// Receive kick
function _vcHandleKick() {
    vcLeave();
    _vcToast('🚫 You were removed from the call by the supervisor');
}

// Patch signaling listener to handle kick signals
const _origStartSig = _vcStartSignalingListener;

// ─── Duration ─────────────────────────────────────────────────────────────
function _vcUpdateDuration() {
    const el = document.getElementById('vc-duration');
    if (!el || !vcCallStartTime) return;
    const s = Math.floor((Date.now() - vcCallStartTime) / 1000);
    const m = Math.floor(s / 60), sec = s % 60;
    el.textContent = `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

// ─── UI — Call Button ─────────────────────────────────────────────────────
function _vcUpdateCallBtn() {
    // Find existing button or inject
    let btn = document.getElementById('vc-call-btn');
    if (!btn) return;
    if (vcActive) {
        btn.className = 'vc-call-btn vc-call-btn--active';
        btn.innerHTML = `<span class="vc-btn-pulse"></span>🔴 In Call`;
    } else {
        btn.className = 'vc-call-btn';
        btn.innerHTML = `🎙️ Voice Call`;
    }
}

// ─── UI — Panel ──────────────────────────────────────────────────────────
function vcOpenPanel() {
    if (document.getElementById('vc-panel')) { _vcPanelOpen = true; return; }
    _vcPanelOpen = true;
    _vcRenderPanel();
}

function _vcClosePanel() {
    const panel = document.getElementById('vc-panel');
    if (panel) panel.remove();
    const overlay = document.getElementById('vc-overlay');
    if (overlay) overlay.remove();
    _vcPanelOpen = false;
}

function _vcRenderPanel() {
    let panel = document.getElementById('vc-panel');
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'vc-panel';
        panel.className = 'vc-panel';
        document.body.appendChild(panel);
    }

    const partCount = Object.keys(vcParticipants).length;

    panel.innerHTML = `
        <div class="vc-panel-header">
            <div class="vc-panel-title">
                <span class="vc-live-dot"></span>
                <span>Voice Call</span>
                ${currentGroup ? `<span class="vc-group-name">${escHtml ? escHtml(currentGroup.name) : currentGroup.name}</span>` : ''}
            </div>
            <div class="vc-header-right">
                <span class="vc-duration" id="vc-duration">00:00</span>
                <button class="vc-close-btn" id="vc-panel-close" title="Hide panel">✕</button>
            </div>
        </div>
        <div class="vc-participants" id="vc-participants">
            ${partCount === 0 ? '<div class="vc-empty">Waiting for others to join…</div>' : ''}
        </div>
        <div class="vc-controls" id="vc-controls">
            <button class="vc-ctrl-btn ${vcMuted ? 'vc-ctrl-btn--active' : ''}" id="vc-mute-btn" title="${vcMuted ? 'Unmute' : 'Mute'}">
                ${vcMuted ? '🔇' : '🎙️'}
                <span>${vcMuted ? 'Unmute' : 'Mute'}</span>
            </button>
            <button class="vc-ctrl-btn ${vcDeafened ? 'vc-ctrl-btn--active' : ''}" id="vc-deafen-btn" title="${vcDeafened ? 'Undeafen' : 'Deafen'}">
                ${vcDeafened ? '🔕' : '🔊'}
                <span>${vcDeafened ? 'Undeafen' : 'Deafen'}</span>
            </button>
            <button class="vc-ctrl-btn vc-ctrl-btn--leave" id="vc-leave-btn" title="Leave call">
                📵 <span>Leave</span>
            </button>
        </div>
    `;

    panel.querySelector('#vc-panel-close').addEventListener('click', () => {
        _vcPanelOpen = false;
        panel.classList.add('vc-panel--minimized');
        // Show mini indicator
        _vcShowMiniBar();
    });
    panel.querySelector('#vc-mute-btn').addEventListener('click', vcToggleMute);
    panel.querySelector('#vc-deafen-btn').addEventListener('click', vcToggleDeafen);
    panel.querySelector('#vc-leave-btn').addEventListener('click', vcLeave);

    _vcRenderParticipants();
    _vcUpdateDuration();
}

function _vcShowMiniBar() {
    let bar = document.getElementById('vc-mini-bar');
    if (bar) return;
    bar = document.createElement('div');
    bar.id = 'vc-mini-bar';
    bar.className = 'vc-mini-bar';
    bar.innerHTML = `
        <span class="vc-live-dot"></span>
        <span id="vc-mini-count">${Object.keys(vcParticipants).length} in call</span>
        <button class="vc-mini-expand" id="vc-mini-expand" title="Open call">▲</button>
        <button class="vc-mini-mute" id="vc-mini-mute" title="${vcMuted ? 'Unmute' : 'Mute'}">${vcMuted ? '🔇' : '🎙️'}</button>
        <button class="vc-mini-leave" id="vc-mini-leave" title="Leave">📵</button>
    `;
    document.body.appendChild(bar);
    bar.querySelector('#vc-mini-expand').addEventListener('click', () => {
        bar.remove();
        const p = document.getElementById('vc-panel');
        if (p) p.classList.remove('vc-panel--minimized');
        _vcPanelOpen = true;
    });
    bar.querySelector('#vc-mini-mute').addEventListener('click', () => {
        vcToggleMute();
        bar.querySelector('#vc-mini-mute').textContent = vcMuted ? '🔇' : '🎙️';
        bar.querySelector('#vc-mini-mute').title = vcMuted ? 'Unmute' : 'Mute';
    });
    bar.querySelector('#vc-mini-leave').addEventListener('click', () => {
        bar.remove(); vcLeave();
    });
}

function _vcRenderParticipants() {
    const container = document.getElementById('vc-participants');
    if (!container) return;

    const me = _vcMe();
    const entries = Object.entries(vcParticipants);
    if (entries.length === 0) {
        container.innerHTML = '<div class="vc-empty">Waiting for others to join…</div>';
        return;
    }

    container.innerHTML = '';
    entries.forEach(([uid, p]) => {
        const isMe = uid === me;
        const isSup = currentGroup && uid === currentGroup.supervisorUid;
        const pcState = vcPeers[uid]?.pc?.connectionState || (isMe ? 'connected' : 'connecting');
        const isConnected = isMe || pcState === 'connected';

        const card = document.createElement('div');
        card.className = `vc-p-card ${p.speaking && !p.muted ? 'vc-p-card--speaking' : ''}`;
        card.innerHTML = `
            <div class="vc-p-avatar ${p.speaking && !p.muted ? 'vc-p-avatar--speaking' : ''} ${isSup ? 'vc-p-avatar--sup' : ''}">
                ${(p.handle || 'U')[0].toUpperCase()}
            </div>
            <div class="vc-p-info">
                <span class="vc-p-name">@${p.handle || uid.slice(0,6)}${isMe ? ' (you)' : ''}${isSup ? ' 👑' : ''}</span>
                <span class="vc-p-status">
                    ${p.muted ? '<span class="vc-status-chip muted">🔇 Muted</span>' : ''}
                    ${p.speaking && !p.muted ? '<span class="vc-status-chip speaking">🎙️ Speaking</span>' : ''}
                    ${!isConnected ? '<span class="vc-status-chip connecting">⏳ Connecting</span>' : ''}
                </span>
            </div>
            <div class="vc-p-actions">
                ${isSupervisor && !isMe ? `<button class="vc-kick-btn" data-uid="${uid}" title="Remove from call">✕</button>` : ''}
            </div>
        `;
        card.querySelectorAll('.vc-kick-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                vcKickFromCall(btn.dataset.uid);
            });
        });
        container.appendChild(card);
    });

    // Update mini bar count if visible
    const miniCount = document.getElementById('vc-mini-count');
    if (miniCount) miniCount.textContent = `${entries.length} in call`;
}

function _vcUpdateControls() {
    const muteBtn = document.getElementById('vc-mute-btn');
    const deafBtn = document.getElementById('vc-deafen-btn');
    if (muteBtn) {
        muteBtn.className = `vc-ctrl-btn ${vcMuted ? 'vc-ctrl-btn--active' : ''}`;
        muteBtn.innerHTML = `${vcMuted ? '🔇' : '🎙️'} <span>${vcMuted ? 'Unmute' : 'Mute'}</span>`;
    }
    if (deafBtn) {
        deafBtn.className = `vc-ctrl-btn ${vcDeafened ? 'vc-ctrl-btn--active' : ''}`;
        deafBtn.innerHTML = `${vcDeafened ? '🔕' : '🔊'} <span>${vcDeafened ? 'Undeafen' : 'Deafen'}</span>`;
    }
    const miniMute = document.getElementById('vc-mini-mute');
    if (miniMute) { miniMute.textContent = vcMuted ? '🔇' : '🎙️'; }
}

// ─── Inject Call Button into Team Column / Member Controls ───────────────
function _vcInjectCallButton() {
    // For supervisors: inject into the Team column header action area
    const tcMeta = document.querySelector('.tc-meta-row');
    if (tcMeta && !document.getElementById('vc-call-btn')) {
        const btn = document.createElement('button');
        btn.id = 'vc-call-btn';
        btn.className = 'vc-call-btn';
        btn.innerHTML = '🎙️ Voice Call';
        btn.title = 'Start or join a group voice call';
        btn.addEventListener('click', () => {
            if (vcActive) {
                const panel = document.getElementById('vc-panel');
                if (panel) {
                    panel.classList.remove('vc-panel--minimized');
                    _vcPanelOpen = true;
                    const bar = document.getElementById('vc-mini-bar');
                    if (bar) bar.remove();
                } else {
                    _vcRenderPanel();
                }
            } else {
                vcJoin();
            }
        });
        tcMeta.appendChild(btn);
        _vcUpdateCallBtn();
    }

    // For members: inject into the member controls bar
    const mc = document.getElementById('mb-member-controls');
    if (mc && !document.getElementById('vc-call-btn-member')) {
        const btn = document.createElement('button');
        btn.id = 'vc-call-btn-member';
        btn.className = 'vc-call-btn vc-call-btn--member';
        btn.innerHTML = '🎙️ Call';
        btn.title = 'Join group voice call';
        btn.addEventListener('click', () => {
            if (vcActive) {
                const panel = document.getElementById('vc-panel');
                if (panel) {
                    panel.classList.remove('vc-panel--minimized');
                    _vcPanelOpen = true;
                    const bar = document.getElementById('vc-mini-bar');
                    if (bar) bar.remove();
                } else {
                    _vcRenderPanel();
                }
            } else {
                vcJoin();
            }
        });
        mc.appendChild(btn);
    }
}

// ─── Cleanup on group leave ───────────────────────────────────────────────
const _vcOrigLeaveGroup = typeof leaveGroup === 'function' ? leaveGroup : null;
if (_vcOrigLeaveGroup) {
    window.leaveGroup = async function() {
        if (vcActive) await vcLeave();
        return _vcOrigLeaveGroup.apply(this, arguments);
    };
}

// ─── Hook into renderGroupUI to inject the call button ───────────────────
const _vcOrigRenderGroupUI = renderGroupUI;
renderGroupUI = function() {
    _vcOrigRenderGroupUI.apply(this, arguments);
    // Defer to let DOM settle
    setTimeout(_vcInjectCallButton, 50);
    // If we left a group while in call, clean up
    if (!currentGroup && vcActive) vcLeave();
};

// ─── Handle kick signals in signaling listener ────────────────────────────
// We patch onSnapshot to also handle kick type
const _vcRealStartSignaling = _vcStartSignalingListener;

function _vcStartSignalingListener() {
    const gRef = _vcGroupRef(); if (!gRef) return;
    const me = _vcMe();

    const sigRef = gRef.collection('signals').where('to', '==', me);
    const sigUnsub = sigRef.onSnapshot(snap => {
        snap.docChanges().forEach(async change => {
            if (change.type !== 'added') return;
            const sig = change.doc.data();
            const from = sig.from;
            change.doc.ref.delete().catch(() => {});

            if (sig.type === 'offer') {
                if (vcActive) await _vcAnswer(from, sig.sdp);
            } else if (sig.type === 'answer') {
                await _vcHandleAnswer(from, sig.sdp);
            } else if (sig.type === 'candidate') {
                await _vcHandleCandidate(from, sig.candidate);
            } else if (sig.type === 'kick') {
                _vcHandleKick();
            }
        });
    });

    const presRef = gRef.collection('participants');
    const presUnsub = presRef.onSnapshot(snap => {
        const me = _vcMe();
        snap.docChanges().forEach(change => {
            const uid = change.doc.id;
            const data = change.doc.data();

            if (change.type === 'removed') {
                if (uid !== me) _vcRemovePeer(uid);
                return;
            }

            if (uid === me) {
                vcParticipants[me] = { ...vcParticipants[me], ...data };
            } else {
                const wasHere = !!vcParticipants[uid];
                vcParticipants[uid] = {
                    handle: data.handle || uid,
                    muted: !!data.muted,
                    speaking: !!data.speaking
                };
                if (!wasHere && vcActive) {
                    _vcLog('New peer joined:', uid);
                    if (me < uid) setTimeout(() => _vcOffer(uid), 500);
                }
            }
        });
        _vcRenderParticipants();
        _vcUpdateCallBtn();
    });

    vcPresenceUnsub = () => { sigUnsub(); presUnsub(); };
}


// ─── Exports ──────────────────────────────────────────────────────────────
window.vcJoin          = vcJoin;
window.vcLeave         = vcLeave;
window.vcToggleMute    = vcToggleMute;
window.vcToggleDeafen  = vcToggleDeafen;
window.vcKickFromCall  = vcKickFromCall;
window.vcOpenPanel     = vcOpenPanel;

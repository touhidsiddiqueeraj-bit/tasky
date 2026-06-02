// ═══════════════════════════════════════════════════════════════════════════
//  TASKY — VOICE CALL LAYER  (load after tasky-collab.js)
//  WebRTC mesh voice calls for collab groups via Firebase Firestore signaling
//  Features: ring notifications, incoming call modal, mute, deafen,
//            speaking indicators (VAD), supervisor kick, minimize to bar
// ═══════════════════════════════════════════════════════════════════════════

// ─── Constants ───────────────────────────────────────────────────────────
const VC_COLLECTION      = 'voice_sessions';
const VC_ICE_SERVERS     = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
];
const VC_SPEAKING_THRESHOLD = -50;   // dB
const VC_SPEAKING_INTERVAL  = 200;   // ms
const VC_RING_TIMEOUT_MS    = 30000; // auto-decline after 30 s
const VC_RECONNECT_DELAY    = 3000;

// ─── State ────────────────────────────────────────────────────────────────
let vcActive          = false;
let vcLocalStream     = null;
let vcPeers           = {};          // { uid: { pc, audioEl } }
let vcParticipants    = {};          // { uid: { handle, muted, speaking } }
let vcMuted           = false;
let vcDeafened        = false;
let vcPresenceRef     = null;
let vcPresenceUnsub   = null;
let vcAudioCtx        = null;
let vcAnalysers       = {};
let vcVadInterval     = null;
let vcCallStartTime   = null;
let vcDurationInterval= null;
let _vcPanelOpen      = false;

// Ringing state
let vcRingTimeout     = null;   // auto-decline timer
let vcIncomingCallerId= null;   // uid of whoever is calling us
let vcIncomingCallerH = null;   // their handle
let vcOutgoingRingInt = null;   // interval to pulse outgoing ring UI
let vcRingUnsubscribe = null;   // Firestore ring doc listener

// ─── Helpers ──────────────────────────────────────────────────────────────
function _vcMe()  { return window.currentUser ? window.currentUser.uid : null; }
function _vcHnd() { return window.currentHandle || 'me'; }
function _vcDb()  { return window.db || null; }
function _vcLog(...a) { console.log('[VC]', ...a); }

function _vcToast(msg) {
    if (typeof _collabToast === 'function') { _collabToast(msg); return; }
    const t = document.createElement('div');
    t.className = 'vc-toast'; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
}

function _vcGroupRef() {
    const d = _vcDb();
    if (!d || !window.currentGroup) return null;
    return d.collection(VC_COLLECTION).doc(window.currentGroup.code);
}
function _vcMyPresenceRef() {
    const g = _vcGroupRef(); if (!g) return null;
    return g.collection('participants').doc(_vcMe());
}

// ─── Ringtone (Web Audio API, no external file needed) ────────────────────
function _vcPlayRing(type) {
    // type: 'incoming' | 'outgoing' | 'stop'
    _vcStopRing();
    if (type === 'stop') return;

    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        let stopped = false;
        const stopFn = () => { stopped = true; ctx.close().catch(() => {}); };
        window._vcRingCtx = ctx;
        window._vcRingStop = stopFn;

        if (type === 'incoming') {
            // Ascending double-beep ring pattern
            let count = 0;
            const beep = () => {
                if (stopped) return;
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain); gain.connect(ctx.destination);
                osc.frequency.value = count % 2 === 0 ? 880 : 1046;
                gain.gain.setValueAtTime(0, ctx.currentTime);
                gain.gain.linearRampToValueAtTime(0.25, ctx.currentTime + 0.02);
                gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.18);
                osc.start(ctx.currentTime);
                osc.stop(ctx.currentTime + 0.2);
                count++;
                if (!stopped) setTimeout(beep, count % 2 === 0 ? 500 : 200);
            };
            beep();
        } else {
            // Outgoing: low pulse every 1.5 s
            const pulse = () => {
                if (stopped) return;
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain); gain.connect(ctx.destination);
                osc.frequency.value = 440;
                osc.type = 'sine';
                gain.gain.setValueAtTime(0, ctx.currentTime);
                gain.gain.linearRampToValueAtTime(0.15, ctx.currentTime + 0.05);
                gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.4);
                osc.start(ctx.currentTime);
                osc.stop(ctx.currentTime + 0.45);
                if (!stopped) setTimeout(pulse, 1500);
            };
            pulse();
        }
    } catch(e) { _vcLog('Ring audio error', e); }
}

function _vcStopRing() {
    if (window._vcRingStop) { window._vcRingStop(); window._vcRingStop = null; }
    if (window._vcRingCtx)  { window._vcRingCtx = null; }
}

// ─── Ring Notification (Firestore) ────────────────────────────────────────
// Schema: voice_sessions/{groupCode}/ring  — a single document:
// { callerUid, callerHandle, startedAt, active: true }
// Members watch this doc; when active=true and not callerUid, show incoming UI.

async function _vcStartCall() {
    // Write ring doc → all members get notified
    const gRef = _vcGroupRef(); if (!gRef) return;
    await gRef.collection('ring').doc('current').set({
        callerUid:    _vcMe(),
        callerHandle: _vcHnd(),
        startedAt:    firebase.firestore.FieldValue.serverTimestamp(),
        active:       true,
        groupCode:    window.currentGroup.code
    });
    _vcLog('Ring broadcast sent');
}

async function _vcCancelRing() {
    const gRef = _vcGroupRef(); if (!gRef) return;
    await gRef.collection('ring').doc('current').delete().catch(() => {});
}

function _vcStartRingListener() {
    const gRef = _vcGroupRef(); if (!gRef) return;
    const me = _vcMe();

    if (vcRingUnsubscribe) { vcRingUnsubscribe(); vcRingUnsubscribe = null; }

    vcRingUnsubscribe = gRef.collection('ring').doc('current')
        .onSnapshot(snap => {
            if (!snap.exists) {
                // Ring cancelled — dismiss incoming UI if showing
                _vcDismissIncoming();
                return;
            }
            const data = snap.data();
            if (!data.active) { _vcDismissIncoming(); return; }
            if (data.callerUid === me) return; // we are the caller
            if (vcActive) {
                // Already in call — auto-join silently (already connected via presence)
                return;
            }
            // Show incoming call UI
            vcIncomingCallerId = data.callerUid;
            vcIncomingCallerH  = data.callerHandle;
            _vcShowIncomingModal(data.callerHandle);
        });
}

function _vcStopRingListener() {
    if (vcRingUnsubscribe) { vcRingUnsubscribe(); vcRingUnsubscribe = null; }
}

// ─── Incoming Call Modal ──────────────────────────────────────────────────
function _vcShowIncomingModal(callerHandle) {
    if (document.getElementById('vc-incoming-modal')) return;
    _vcPlayRing('incoming');

    const modal = document.createElement('div');
    modal.id = 'vc-incoming-modal';
    modal.className = 'vc-incoming-modal';
    modal.innerHTML = `
        <div class="vc-incoming-inner">
            <div class="vc-incoming-ring-anim">
                <div class="vc-ring-circle vc-ring-c1"></div>
                <div class="vc-ring-circle vc-ring-c2"></div>
                <div class="vc-ring-circle vc-ring-c3"></div>
                <div class="vc-incoming-avatar">${(callerHandle||'?')[0].toUpperCase()}</div>
            </div>
            <div class="vc-incoming-label">Incoming call</div>
            <div class="vc-incoming-caller">@${callerHandle || 'Someone'}</div>
            <div class="vc-incoming-group">${window.currentGroup ? window.currentGroup.name : ''}</div>
            <div class="vc-incoming-btns">
                <button class="vc-incoming-btn vc-incoming-btn--decline" id="vc-decline-btn">
                    📵 Decline
                </button>
                <button class="vc-incoming-btn vc-incoming-btn--accept" id="vc-accept-btn">
                    🎙️ Answer
                </button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    modal.querySelector('#vc-accept-btn').addEventListener('click',  vcAnswerCall);
    modal.querySelector('#vc-decline-btn').addEventListener('click', vcDeclineCall);

    // Auto-decline after timeout
    vcRingTimeout = setTimeout(() => {
        vcDeclineCall();
        _vcToast('📵 Missed call from @' + callerHandle);
    }, VC_RING_TIMEOUT_MS);

    // Animate in
    requestAnimationFrame(() => modal.classList.add('vc-incoming-modal--visible'));
}

function _vcDismissIncoming() {
    _vcStopRing();
    if (vcRingTimeout) { clearTimeout(vcRingTimeout); vcRingTimeout = null; }
    const modal = document.getElementById('vc-incoming-modal');
    if (modal) {
        modal.classList.remove('vc-incoming-modal--visible');
        setTimeout(() => modal.remove(), 300);
    }
    vcIncomingCallerId = null;
    vcIncomingCallerH  = null;
}

// ─── Answer / Decline ─────────────────────────────────────────────────────
async function vcAnswerCall() {
    _vcDismissIncoming();
    await vcJoin();
}

function vcDeclineCall() {
    _vcDismissIncoming();
}

// ─── Audio / VAD ──────────────────────────────────────────────────────────
function _vcInitAudioCtx() {
    if (!vcAudioCtx) vcAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
}

function _vcTrackVAD(uid, stream) {
    _vcInitAudioCtx();
    try {
        const src = vcAudioCtx.createMediaStreamSource(stream);
        const an  = vcAudioCtx.createAnalyser();
        an.fftSize = 256;
        src.connect(an);
        vcAnalysers[uid] = an;
    } catch(e) { _vcLog('VAD init error', e); }
}

function _vcRemoveVAD(uid) { delete vcAnalysers[uid]; }

function _vcGetLevel(an) {
    const buf = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

function _vcStartVAD() {
    if (vcVadInterval) return;
    vcVadInterval = setInterval(() => {
        let changed = false;
        for (const [uid, an] of Object.entries(vcAnalysers)) {
            const speaking = _vcGetLevel(an) > VC_SPEAKING_THRESHOLD;
            const realUid = uid === 'local' ? _vcMe() : uid;
            if (!vcParticipants[realUid]) continue;
            if (vcParticipants[realUid].speaking !== speaking) {
                vcParticipants[realUid].speaking = speaking;
                changed = true;
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

// ─── WebRTC ───────────────────────────────────────────────────────────────
function _vcCreatePC(peerUid) {
    const pc = new RTCPeerConnection({ iceServers: VC_ICE_SERVERS });
    if (vcLocalStream) vcLocalStream.getTracks().forEach(t => pc.addTrack(t, vcLocalStream));

    pc.ontrack = (e) => {
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
        _vcTrackVAD(peerUid, e.streams[0]);
        vcPeers[peerUid] = vcPeers[peerUid] || {};
        vcPeers[peerUid].audioEl = el;
    };

    pc.onicecandidate = (e) => {
        if (!e.candidate) return;
        const g = _vcGroupRef(); if (!g) return;
        g.collection('signals').add({
            from: _vcMe(), to: peerUid, type: 'candidate',
            candidate: e.candidate.toJSON(),
            ts: firebase.firestore.FieldValue.serverTimestamp()
        }).catch(() => {});
    };

    pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
            setTimeout(() => {
                if (vcActive && vcParticipants[peerUid] && _vcMe() < peerUid) _vcOffer(peerUid);
            }, VC_RECONNECT_DELAY);
        }
        _vcRenderParticipants();
    };

    vcPeers[peerUid] = vcPeers[peerUid] || {};
    vcPeers[peerUid].pc = pc;
    return pc;
}

async function _vcOffer(peerUid) {
    const pc = _vcCreatePC(peerUid);
    try {
        const offer = await pc.createOffer({ offerToReceiveAudio: true });
        await pc.setLocalDescription(offer);
        const g = _vcGroupRef(); if (!g) return;
        await g.collection('signals').add({
            from: _vcMe(), to: peerUid, type: 'offer',
            sdp: pc.localDescription.sdp,
            ts: firebase.firestore.FieldValue.serverTimestamp()
        });
    } catch(e) { _vcLog('Offer error', e); }
}

async function _vcAnswer(peerUid, sdp) {
    let pc = vcPeers[peerUid]?.pc;
    if (!pc || pc.signalingState === 'closed') pc = _vcCreatePC(peerUid);
    try {
        if (pc.signalingState !== 'stable') return; // ignore duplicate offers
        await pc.setRemoteDescription({ type: 'offer', sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        const g = _vcGroupRef(); if (!g) return;
        await g.collection('signals').add({
            from: _vcMe(), to: peerUid, type: 'answer',
            sdp: pc.localDescription.sdp,
            ts: firebase.firestore.FieldValue.serverTimestamp()
        });
    } catch(e) { _vcLog('Answer error', e); }
}

async function _vcHandleAnswer(peerUid, sdp) {
    const pc = vcPeers[peerUid]?.pc;
    if (!pc || pc.signalingState !== 'have-local-offer') return;
    try { await pc.setRemoteDescription({ type: 'answer', sdp }); } catch(e) {}
}

async function _vcHandleCandidate(peerUid, candidate) {
    const pc = vcPeers[peerUid]?.pc;
    if (!pc || pc.signalingState === 'closed') return;
    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch(e) {}
}

function _vcRemovePeer(uid) {
    const peer = vcPeers[uid];
    if (peer) {
        if (peer.pc)      { try { peer.pc.close(); } catch(_) {} }
        if (peer.audioEl) { peer.audioEl.srcObject = null; peer.audioEl.remove(); }
    }
    delete vcPeers[uid];
    delete vcParticipants[uid];
    _vcRemoveVAD(uid);
}

// ─── Signaling + Presence Listener ────────────────────────────────────────
function _vcStartListeners() {
    const gRef = _vcGroupRef(); if (!gRef) return;
    const me = _vcMe();

    const sigUnsub = gRef.collection('signals').where('to', '==', me)
        .onSnapshot(snap => {
            snap.docChanges().forEach(async change => {
                if (change.type !== 'added') return;
                const sig = change.doc.data();
                change.doc.ref.delete().catch(() => {});
                if (sig.type === 'offer')     { if (vcActive) await _vcAnswer(sig.from, sig.sdp); }
                else if (sig.type === 'answer')    { await _vcHandleAnswer(sig.from, sig.sdp); }
                else if (sig.type === 'candidate') { await _vcHandleCandidate(sig.from, sig.candidate); }
                else if (sig.type === 'kick')      { vcLeave(); _vcToast('🚫 Removed from call by supervisor'); }
            });
        });

    const presUnsub = gRef.collection('participants')
        .onSnapshot(snap => {
            snap.docChanges().forEach(change => {
                const uid  = change.doc.id;
                const data = change.doc.data();
                if (change.type === 'removed') {
                    if (uid !== me) { _vcRemovePeer(uid); }
                    return;
                }
                if (uid === me) {
                    vcParticipants[me] = { ...vcParticipants[me], ...data };
                } else {
                    const wasHere = !!vcParticipants[uid];
                    vcParticipants[uid] = { handle: data.handle || uid, muted: !!data.muted, speaking: !!data.speaking };
                    if (!wasHere && vcActive && me < uid) {
                        setTimeout(() => _vcOffer(uid), 500);
                    }
                }
            });
            _vcRenderParticipants();
            _vcUpdateCallBtn();
        });

    vcPresenceUnsub = () => { sigUnsub(); presUnsub(); };
}

// ─── Join Call ────────────────────────────────────────────────────────────
async function vcJoin() {
    if (vcActive) return;
    if (!window.currentGroup || !window.currentUser || window.currentUser.isAnonymous) {
        _vcToast('⚠️ Sign in to join calls'); return;
    }

    // Request mic
    try {
        vcLocalStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch(e) {
        _vcToast('🎙️ Microphone access denied'); _vcLog('getUserMedia', e); return;
    }

    vcActive       = true;
    vcMuted        = false;
    vcDeafened     = false;
    vcCallStartTime= Date.now();
    vcPeers        = {};
    vcParticipants = {};

    _vcTrackVAD('local', vcLocalStream);
    _vcStartVAD();

    // Write own presence
    vcPresenceRef = _vcMyPresenceRef();
    await vcPresenceRef.set({
        handle: _vcHnd(), uid: _vcMe(),
        muted: false, speaking: false,
        joinedAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    _vcStartListeners();

    // If we are the initiator, broadcast ring + start outgoing UI
    const gRef = _vcGroupRef();
    const ringSnap = gRef ? await gRef.collection('ring').doc('current').get().catch(() => null) : null;
    const ringData = ringSnap && ringSnap.exists ? ringSnap.data() : null;
    const weAreInitiator = !ringData || !ringData.active;

    if (weAreInitiator) {
        await _vcStartCall();
        _vcShowOutgoingRing();
        // Cancel ring after 30 s if nobody joined
        vcRingTimeout = setTimeout(async () => {
            await _vcCancelRing();
            _vcHideOutgoingRing();
            if (Object.keys(vcParticipants).length <= 1) {
                _vcToast('📵 No one answered');
            }
        }, VC_RING_TIMEOUT_MS);
    } else {
        // We are answering — clear the ring doc
        await _vcCancelRing();
    }

    vcDurationInterval = setInterval(_vcUpdateDuration, 1000);
    _vcRenderPanel();
    _vcUpdateCallBtn();
    _vcToast('🎙️ Joined voice call');
}

// ─── Leave Call ───────────────────────────────────────────────────────────
async function vcLeave() {
    if (!vcActive) return;
    vcActive = false;

    _vcStopVAD();
    _vcStopRing();
    _vcHideOutgoingRing();
    if (vcRingTimeout) { clearTimeout(vcRingTimeout); vcRingTimeout = null; }
    if (vcDurationInterval) { clearInterval(vcDurationInterval); vcDurationInterval = null; }
    if (vcPresenceUnsub) { vcPresenceUnsub(); vcPresenceUnsub = null; }

    if (vcPresenceRef) { await vcPresenceRef.delete().catch(() => {}); vcPresenceRef = null; }

    // Clean up stale signals
    try {
        const gRef = _vcGroupRef();
        if (gRef) {
            const stale = await gRef.collection('signals').where('from', '==', _vcMe()).get();
            stale.forEach(d => d.ref.delete());
            // Also cancel ring if we were the caller
            const ringSnap = await gRef.collection('ring').doc('current').get();
            if (ringSnap.exists && ringSnap.data().callerUid === _vcMe()) {
                await gRef.collection('ring').doc('current').delete();
            }
        }
    } catch(_) {}

    for (const uid of Object.keys(vcPeers)) _vcRemovePeer(uid);
    vcPeers = {}; vcParticipants = {};

    if (vcLocalStream) { vcLocalStream.getTracks().forEach(t => t.stop()); vcLocalStream = null; }
    if (vcAudioCtx)    { vcAudioCtx.close().catch(() => {}); vcAudioCtx = null; }

    _vcClosePanel();
    _vcToast('📵 Left voice call');
    _vcUpdateCallBtn();
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
    document.querySelectorAll('[id^="vc-audio-"]').forEach(el => { el.muted = vcDeafened; });
    if (vcDeafened && !vcMuted) vcToggleMute();
    _vcUpdateControls();
    _vcToast(vcDeafened ? '🔕 Deafened' : '🔊 Undeafened');
}

// ─── Supervisor Kick ──────────────────────────────────────────────────────
async function vcKickFromCall(uid) {
    if (!window.isSupervisor || !window.currentGroup) return;
    const gRef = _vcGroupRef(); if (!gRef) return;
    await gRef.collection('signals').add({
        from: _vcMe(), to: uid, type: 'kick',
        ts: firebase.firestore.FieldValue.serverTimestamp()
    });
}

// ─── Outgoing Ring UI ─────────────────────────────────────────────────────
function _vcShowOutgoingRing() {
    _vcPlayRing('outgoing');
    const btn = document.getElementById('vc-call-btn') || document.getElementById('vc-call-btn-member');
    if (btn) btn.classList.add('vc-call-btn--ringing');
    // Update panel if open
    const panelStatus = document.getElementById('vc-call-status');
    if (panelStatus) panelStatus.textContent = 'Calling…';
}

function _vcHideOutgoingRing() {
    _vcStopRing();
    const btn = document.getElementById('vc-call-btn') || document.getElementById('vc-call-btn-member');
    if (btn) btn.classList.remove('vc-call-btn--ringing');
    const panelStatus = document.getElementById('vc-call-status');
    if (panelStatus) panelStatus.textContent = '';
}

// ─── Duration ─────────────────────────────────────────────────────────────
function _vcUpdateDuration() {
    const el = document.getElementById('vc-duration');
    if (!el || !vcCallStartTime) return;
    const s = Math.floor((Date.now() - vcCallStartTime) / 1000);
    el.textContent = `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
}

// ─── Inject Call Button ───────────────────────────────────────────────────
// Placed alongside the 💬 Board button — in the Team column for supervisors
// and in the member controls bar for members.

function _vcInjectCallButtons() {
    _vcInjectSupervisorBtn();
    _vcInjectMemberBtn();
}

function _vcInjectSupervisorBtn() {
    if (document.getElementById('vc-call-btn')) return;
    // In supervisor Team column header, next to the Board button
    const boardBtn = document.getElementById('tc-board-btn');
    if (!boardBtn) return;
    const btn = document.createElement('button');
    btn.id = 'vc-call-btn';
    btn.className = 'vc-call-btn tc-board-btn';
    btn.title = 'Start a group voice call';
    btn.innerHTML = `🎙️ Call`;
    btn.addEventListener('click', _vcHandleCallBtnClick);
    boardBtn.insertAdjacentElement('afterend', btn);
    _vcUpdateCallBtn();
}

function _vcInjectMemberBtn() {
    if (document.getElementById('vc-call-btn-member')) return;
    // In the fixed member controls bar, next to Board button
    const mc = document.getElementById('mb-member-controls');
    if (!mc) return;
    const btn = document.createElement('button');
    btn.id = 'vc-call-btn-member';
    btn.className = 'vc-call-btn mb-member-board-btn';
    btn.title = 'Join group voice call';
    btn.innerHTML = `🎙️ Call`;
    btn.addEventListener('click', _vcHandleCallBtnClick);
    mc.appendChild(btn);
    _vcUpdateCallBtn();
}

function _vcHandleCallBtnClick() {
    if (vcActive) {
        // Reopen panel
        const panel = document.getElementById('vc-panel');
        if (panel) {
            panel.classList.remove('vc-panel--minimized');
            const bar = document.getElementById('vc-mini-bar');
            if (bar) bar.remove();
            _vcPanelOpen = true;
        } else {
            _vcRenderPanel();
        }
    } else {
        vcJoin();
    }
}

// ─── Call Button State ────────────────────────────────────────────────────
function _vcUpdateCallBtn() {
    ['vc-call-btn', 'vc-call-btn-member'].forEach(id => {
        const btn = document.getElementById(id);
        if (!btn) return;
        if (vcActive) {
            btn.innerHTML = `<span class="vc-btn-pulse"></span> In Call`;
            btn.classList.add('vc-call-btn--active');
            btn.classList.remove('vc-call-btn--ringing');
        } else {
            btn.innerHTML = `🎙️ Call`;
            btn.classList.remove('vc-call-btn--active', 'vc-call-btn--ringing');
        }
    });
}

// ─── Panel ────────────────────────────────────────────────────────────────
function _vcClosePanel() {
    document.getElementById('vc-panel')?.remove();
    document.getElementById('vc-mini-bar')?.remove();
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

    panel.innerHTML = `
        <div class="vc-panel-header">
            <div class="vc-panel-title">
                <span class="vc-live-dot"></span>
                <span>Voice Call</span>
                ${window.currentGroup ? `<span class="vc-group-name">${(typeof escHtml === 'function' ? escHtml(window.currentGroup.name) : window.currentGroup.name)}</span>` : ''}
            </div>
            <div class="vc-header-right">
                <span class="vc-call-status" id="vc-call-status"></span>
                <span class="vc-duration" id="vc-duration">00:00</span>
                <button class="vc-close-btn" id="vc-panel-close" title="Minimise">─</button>
            </div>
        </div>
        <div class="vc-participants" id="vc-participants">
            <div class="vc-empty">Waiting for others…</div>
        </div>
        <div class="vc-controls">
            <button class="vc-ctrl-btn ${vcMuted ? 'vc-ctrl-btn--active' : ''}" id="vc-mute-btn">
                ${vcMuted ? '🔇' : '🎙️'}<span>${vcMuted ? 'Unmute' : 'Mute'}</span>
            </button>
            <button class="vc-ctrl-btn ${vcDeafened ? 'vc-ctrl-btn--active' : ''}" id="vc-deafen-btn">
                ${vcDeafened ? '🔕' : '🔊'}<span>${vcDeafened ? 'Undeafen' : 'Deafen'}</span>
            </button>
            <button class="vc-ctrl-btn vc-ctrl-btn--leave" id="vc-leave-btn">
                📵<span>Leave</span>
            </button>
        </div>
    `;

    panel.querySelector('#vc-panel-close').addEventListener('click', () => {
        panel.classList.add('vc-panel--minimized');
        _vcPanelOpen = false;
        _vcShowMiniBar();
    });
    panel.querySelector('#vc-mute-btn').addEventListener('click',   vcToggleMute);
    panel.querySelector('#vc-deafen-btn').addEventListener('click', vcToggleDeafen);
    panel.querySelector('#vc-leave-btn').addEventListener('click',  vcLeave);

    _vcRenderParticipants();
    _vcUpdateDuration();
    _vcPanelOpen = true;
}

function _vcShowMiniBar() {
    if (document.getElementById('vc-mini-bar')) return;
    const bar = document.createElement('div');
    bar.id = 'vc-mini-bar';
    bar.className = 'vc-mini-bar';
    bar.innerHTML = `
        <span class="vc-live-dot"></span>
        <span id="vc-mini-count">${Object.keys(vcParticipants).length} in call</span>
        <button id="vc-mini-expand" title="Open">▲</button>
        <button id="vc-mini-mute"   title="${vcMuted ? 'Unmute' : 'Mute'}">${vcMuted ? '🔇' : '🎙️'}</button>
        <button class="vc-mini-leave" id="vc-mini-leave" title="Leave">📵</button>
    `;
    document.body.appendChild(bar);
    bar.querySelector('#vc-mini-expand').addEventListener('click', () => {
        bar.remove();
        const p = document.getElementById('vc-panel');
        if (p) { p.classList.remove('vc-panel--minimized'); _vcPanelOpen = true; }
        else _vcRenderPanel();
    });
    bar.querySelector('#vc-mini-mute').addEventListener('click', () => {
        vcToggleMute();
        const btn = bar.querySelector('#vc-mini-mute');
        btn.textContent = vcMuted ? '🔇' : '🎙️';
        btn.title = vcMuted ? 'Unmute' : 'Mute';
    });
    bar.querySelector('#vc-mini-leave').addEventListener('click', () => { bar.remove(); vcLeave(); });
}

function _vcRenderParticipants() {
    const container = document.getElementById('vc-participants');
    if (!container) return;
    const me = _vcMe();
    const entries = Object.entries(vcParticipants);
    if (entries.length === 0) {
        container.innerHTML = '<div class="vc-empty">Waiting for others…</div>';
        const status = document.getElementById('vc-call-status');
        if (status && !status.textContent) status.textContent = 'Calling…';
        return;
    }
    // Clear "Calling…" once someone joins
    const status = document.getElementById('vc-call-status');
    if (status && entries.length > 1) { status.textContent = ''; _vcHideOutgoingRing(); }

    container.innerHTML = '';
    entries.forEach(([uid, p]) => {
        const isMe  = uid === me;
        const isSup = window.currentGroup && uid === window.currentGroup.supervisorUid;
        const pcState = vcPeers[uid]?.pc?.connectionState || (isMe ? 'connected' : 'new');
        const connected = isMe || pcState === 'connected';

        const card = document.createElement('div');
        card.className = `vc-p-card ${p.speaking && !p.muted ? 'vc-p-card--speaking' : ''}`;
        card.innerHTML = `
            <div class="vc-p-avatar ${p.speaking && !p.muted ? 'vc-p-avatar--speaking' : ''} ${isSup ? 'vc-p-avatar--sup' : ''}">
                ${(p.handle || 'U')[0].toUpperCase()}
            </div>
            <div class="vc-p-info">
                <span class="vc-p-name">@${p.handle || uid.slice(0,6)}${isMe ? ' (you)' : ''}${isSup ? ' 👑' : ''}</span>
                <span class="vc-p-status">
                    ${p.muted ? '<span class="vc-status-chip muted">🔇</span>' : ''}
                    ${p.speaking && !p.muted ? '<span class="vc-status-chip speaking">🎙️</span>' : ''}
                    ${!connected ? '<span class="vc-status-chip connecting">⏳</span>' : ''}
                </span>
            </div>
            <div class="vc-p-actions">
                ${window.isSupervisor && !isMe ? `<button class="vc-kick-btn" data-uid="${uid}" title="Remove from call">✕</button>` : ''}
            </div>
        `;
        card.querySelectorAll('.vc-kick-btn').forEach(b => {
            b.addEventListener('click', e => { e.stopPropagation(); vcKickFromCall(b.dataset.uid); });
        });
        container.appendChild(card);
    });

    const mini = document.getElementById('vc-mini-count');
    if (mini) mini.textContent = `${entries.length} in call`;
}

function _vcUpdateControls() {
    const mb = document.getElementById('vc-mute-btn');
    const db = document.getElementById('vc-deafen-btn');
    if (mb) { mb.className = `vc-ctrl-btn ${vcMuted ? 'vc-ctrl-btn--active' : ''}`; mb.innerHTML = `${vcMuted ? '🔇' : '🎙️'}<span>${vcMuted ? 'Unmute' : 'Mute'}</span>`; }
    if (db) { db.className = `vc-ctrl-btn ${vcDeafened ? 'vc-ctrl-btn--active' : ''}`; db.innerHTML = `${vcDeafened ? '🔕' : '🔊'}<span>${vcDeafened ? 'Undeafen' : 'Deafen'}</span>`; }
    const mm = document.getElementById('vc-mini-mute');
    if (mm) { mm.textContent = vcMuted ? '🔇' : '🎙️'; }
}

// ─── Hook into renderGroupUI ──────────────────────────────────────────────
const _vcOrigRenderGroupUI = renderGroupUI;
renderGroupUI = function() {
    _vcOrigRenderGroupUI.apply(this, arguments);
    setTimeout(_vcInjectCallButtons, 60);

    if (window.currentGroup && window.currentUser && !window.currentUser.isAnonymous) {
        _vcStartRingListener();
    } else {
        _vcStopRingListener();
        if (vcActive) vcLeave();
    }
};

// ─── Hook group leave ─────────────────────────────────────────────────────
const _vcOrigLeaveGroup = typeof leaveGroup === 'function' ? leaveGroup : null;
if (_vcOrigLeaveGroup) {
    window.leaveGroup = async function() {
        if (vcActive) await vcLeave();
        return _vcOrigLeaveGroup.apply(this, arguments);
    };
}

// ─── Firestore Rules (reference comment) ──────────────────────────────────
/*
  match /voice_sessions/{groupCode} {
    allow read: if request.auth != null && exists(/databases/$(database)/documents/groups/$(groupCode));
    allow write: if false;

    match /ring/{doc} {
      allow read: if request.auth != null && exists(/databases/$(database)/documents/groups/$(groupCode));
      allow create, update: if request.auth != null
        && exists(/databases/$(database)/documents/groups/$(groupCode))
        && request.resource.data.callerUid == request.auth.uid;
      allow delete: if request.auth != null && (
        resource.data.callerUid == request.auth.uid
        || get(/databases/$(database)/documents/groups/$(groupCode)).data.supervisorUid == request.auth.uid
      );
    }
    match /participants/{uid} {
      allow read: if request.auth != null && exists(/databases/$(database)/documents/groups/$(groupCode));
      allow create, update: if request.auth.uid == uid && request.resource.data.uid == request.auth.uid;
      allow delete: if request.auth.uid == uid
        || get(/databases/$(database)/documents/groups/$(groupCode)).data.supervisorUid == request.auth.uid;
    }
    match /signals/{signalId} {
      allow read: if request.auth != null && exists(/databases/$(database)/documents/groups/$(groupCode));
      allow create: if request.auth != null
        && exists(/databases/$(database)/documents/groups/$(groupCode))
        && request.resource.data.from == request.auth.uid;
      allow delete: if resource.data.from == request.auth.uid || resource.data.to == request.auth.uid;
      allow update: if false;
    }
  }
*/

// ─── Exports ──────────────────────────────────────────────────────────────
window.vcJoin          = vcJoin;
window.vcLeave         = vcLeave;
window.vcAnswerCall    = vcAnswerCall;
window.vcDeclineCall   = vcDeclineCall;
window.vcToggleMute    = vcToggleMute;
window.vcToggleDeafen  = vcToggleDeafen;
window.vcKickFromCall  = vcKickFromCall;

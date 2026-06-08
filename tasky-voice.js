// ═══════════════════════════════════════════════════════════════════════════
//  TASKY — VOICE CALL LAYER  (load after tasky-collab.js)
//  WebRTC mesh voice calls for collab groups via Firebase Firestore signaling
//  Features: ring notifications, incoming call modal, mute, deafen,
//            speaking indicators (VAD), supervisor kick, minimize to bar
//
//  VARIABLE SCOPE NOTES:
//  - window.currentUser  → set by tasky.js closure; read via window.currentUser
//  - currentGroup, currentHandle, isSupervisor, escHtml, renderGroupUI,
//    leaveGroup → top-level lets in tasky-collab.js; accessible by plain name
//  - window.db           → set by tasky.js closure
// ═══════════════════════════════════════════════════════════════════════════

// ─── Constants ───────────────────────────────────────────────────────────
const VC_COLLECTION         = 'voice_sessions';
const VC_ICE_SERVERS        = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
];
const VC_SPEAKING_THRESHOLD = -50;    // dB
const VC_SPEAKING_INTERVAL  = 200;   // ms
const VC_RING_TIMEOUT_MS    = 30000; // auto-decline after 30 s
const VC_RECONNECT_DELAY    = 3000;

// ─── State ────────────────────────────────────────────────────────────────
let vcActive          = false;
let vcLocalStream     = null;
let vcPeers           = {};   // { uid: { pc, audioEl } }
let vcParticipants    = {};   // { uid: { handle, muted, speaking } }
let vcMuted           = false;
let vcDeafened        = false;
let vcPresenceRef     = null;
let vcPresenceUnsub   = null;
let vcAudioCtx        = null;
let vcAnalysers       = {};
let vcVadInterval     = null;
let vcCallStartTime   = null;
let vcDurationInterval= null;
let vcRingTimeout     = null;
let vcIncomingCallerId= null;
let vcIncomingCallerH = null;
let vcRingUnsubscribe = null;

// ─── Accessors (correct scope) ────────────────────────────────────────────
// Always call these as functions — never cache the result at module load time
// because auth/group state changes after the script loads.
function _vcUser()       { return window.currentUser || null; }
function _vcMe()         { const u = _vcUser(); return u ? u.uid : null; }
function _vcIsAnon()     { const u = _vcUser(); return !u || u.isAnonymous; }
function _vcHnd()        { return window.currentHandle || (typeof currentHandle !== 'undefined' ? currentHandle : null); }
function _vcGroup()      { return window.currentGroup  || (typeof currentGroup  !== 'undefined' ? currentGroup  : null); }
function _vcIsSup()      { return window.isSupervisor  != null ? window.isSupervisor : (typeof isSupervisor !== 'undefined' ? isSupervisor : false); }
function _vcDb()         { return window.db || (typeof db !== 'undefined' ? db : null); }
function _vcEsc(s)       { return typeof escHtml === 'function' ? escHtml(s) : String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }


// ─── Avatar helper ────────────────────────────────────────────────────────
// Returns an <img> or initial letter for a participant tile.
// Looks up window._vcAvatarCache[uid] which is populated from Firestore
// users/{uid}.avatarDataUrl or avatarUrl fields.
function _vcAvatarHtml(uid, handle, extraClass) {
    const cls   = extraClass || '';
    const init  = (handle || 'U')[0].toUpperCase();
    const cache = window._vcAvatarCache || {};
    const url   = cache[uid];
    if (url) {
        return `<img src="${url.replace(/"/g,'&quot;')}" alt="${init}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;display:block;">`;
    }
    // Cache miss — fire one-shot Firestore read as fallback
    if (uid && !(window._vcAvatarFetching || {})[uid]) {
        if (!window._vcAvatarFetching) window._vcAvatarFetching = {};
        window._vcAvatarFetching[uid] = true;
        const _db = _vcDb();
        if (_db) {
            _db.collection('users').doc(uid).get().then(snap => {
                window._vcAvatarFetching[uid] = false;
                const u = snap.data()?.avatarDataUrl || snap.data()?.avatarUrl;
                if (u) {
                    if (!window._vcAvatarCache) window._vcAvatarCache = {};
                    window._vcAvatarCache[uid] = u;
                    if (typeof _vcRenderParticipants === 'function') _vcRenderParticipants();
                }
            }).catch(() => { window._vcAvatarFetching[uid] = false; });
        } else {
            window._vcAvatarFetching[uid] = false;
        }
    }
    return init;
}

// Pre-fetch avatars for a list of uids from Firestore users collection
async function _vcPrefetchAvatars(uids) {
    if (!window._vcAvatarCache) window._vcAvatarCache = {};
    const db = _vcDb();
    if (!db) return;
    const toFetch = uids.filter(uid => !(uid in window._vcAvatarCache) && !(window._vcAvatarFetching || {})[uid]);
    if (!toFetch.length) return;
    if (!window._vcAvatarFetching) window._vcAvatarFetching = {};
    toFetch.forEach(uid => window._vcAvatarFetching[uid] = true);
    await Promise.all(toFetch.map(async uid => {
        try {
            const snap = await db.collection('users').doc(uid).get();
            const data = snap.data() || {};
            window._vcAvatarCache[uid] = data.avatarDataUrl || data.avatarUrl || null;
        } catch(e) { window._vcAvatarCache[uid] = null; }
    }));
    toFetch.forEach(uid => window._vcAvatarFetching[uid] = false);
    // Re-render if any avatar was found
    const hasNew = toFetch.some(uid => !!(window._vcAvatarCache[uid]));
    if (hasNew) {
        if (typeof window._vcRenderParticipants === 'function') window._vcRenderParticipants();
        toFetch.forEach(uid => { if (typeof window._vvRefreshTileAvatar === 'function') window._vvRefreshTileAvatar(uid); });
    }
}

function _vcGroupRef() {
    const d = _vcDb(), g = _vcGroup();
    if (!d || !g) return null;
    return d.collection(VC_COLLECTION).doc(g.code);
}
function _vcMyPresenceRef() {
    const r = _vcGroupRef(); if (!r) return null;
    return r.collection('participants').doc(_vcMe());
}

// ─── Toast ────────────────────────────────────────────────────────────────
function _vcToast(msg) {
    if (typeof _collabToast === 'function') { _collabToast(msg); return; }
    const t = document.createElement('div');
    t.className = 'vc-toast'; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
}

// ─── Ringtone (Web Audio API — no external files) ────────────────────────
function _vcPlayRing(type) {
    _vcStopRing();
    if (type === 'stop') return;
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        let stopped = false;
        window._vcRingCtx  = ctx;
        window._vcRingStop = () => { stopped = true; ctx.close().catch(() => {}); };

        if (type === 'incoming') {
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
            // outgoing: low pulse every 1.5 s
            const pulse = () => {
                if (stopped) return;
                const osc  = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain); gain.connect(ctx.destination);
                osc.frequency.value = 440; osc.type = 'sine';
                gain.gain.setValueAtTime(0, ctx.currentTime);
                gain.gain.linearRampToValueAtTime(0.15, ctx.currentTime + 0.05);
                gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.4);
                osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.45);
                if (!stopped) setTimeout(pulse, 1500);
            };
            pulse();
        }
    } catch(e) { console.warn('[VC] ring audio error', e); }
}
function _vcStopRing() {
    if (window._vcRingStop) { window._vcRingStop(); window._vcRingStop = null; window._vcRingCtx = null; }
}

// ─── Firestore Ring Doc ───────────────────────────────────────────────────
async function _vcWriteRing() {
    const gRef = _vcGroupRef(); if (!gRef) return;
    await gRef.collection('ring').doc('current').set({
        callerUid:    _vcMe(),
        callerHandle: _vcHnd() || 'someone',
        startedAt:    firebase.firestore.FieldValue.serverTimestamp(),
        active:       true,
        groupCode:    _vcGroup().code
    });
}
async function _vcDeleteRing() {
    const gRef = _vcGroupRef(); if (!gRef) return;
    await gRef.collection('ring').doc('current').delete().catch(() => {});
}

// ─── Ring Listener (runs whenever in a group) ─────────────────────────────
function _vcStartRingListener() {
    const gRef = _vcGroupRef(); if (!gRef) return;
    if (vcRingUnsubscribe) { vcRingUnsubscribe(); vcRingUnsubscribe = null; }

    vcRingUnsubscribe = gRef.collection('ring').doc('current')
        .onSnapshot(snap => {
            if (!snap.exists) { _vcDismissIncoming(); return; }
            const data = snap.data();
            if (!data || !data.active) { _vcDismissIncoming(); return; }
            if (data.callerUid === _vcMe()) return; // we are the caller
            if (vcActive) { _vcDismissIncoming(); return; } // already in call, dismiss modal if open
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
    const g = _vcGroup();
    modal.innerHTML = `
        <div class="vc-incoming-inner">
            <div class="vc-incoming-ring-anim">
                <div class="vc-ring-circle vc-ring-c1"></div>
                <div class="vc-ring-circle vc-ring-c2"></div>
                <div class="vc-ring-circle vc-ring-c3"></div>
                <div class="vc-incoming-avatar">${_vcAvatarHtml(vcIncomingCallerId || '', callerHandle)}</div>
            </div>
            <div class="vc-incoming-label">Incoming voice call</div>
            <div class="vc-incoming-caller">@${_vcEsc(callerHandle || 'Someone')}</div>
            <div class="vc-incoming-group">${g ? _vcEsc(g.name) : ''}</div>
            <div class="vc-incoming-btns">
                <button class="vc-incoming-btn vc-incoming-btn--decline" id="vc-decline-btn">📵 Decline</button>
                <button class="vc-incoming-btn vc-incoming-btn--accept"  id="vc-accept-btn">🎙️ Answer</button>
            </div>
        </div>`;
    document.body.appendChild(modal);
    // Fetch caller avatar asynchronously and update modal when loaded
    const _callerUid = vcIncomingCallerId || '';
    if (_callerUid && !(window._vcAvatarCache || {})[_callerUid]) {
        const _adb = _vcDb();
        if (_adb) {
            _adb.collection('users').doc(_callerUid).get().then(snap => {
                const _url = snap.data()?.avatarDataUrl || snap.data()?.avatarUrl;
                if (_url) {
                    if (!window._vcAvatarCache) window._vcAvatarCache = {};
                    window._vcAvatarCache[_callerUid] = _url;
                    const _avEl = document.querySelector('#vc-incoming-modal .vc-incoming-avatar');
                    if (_avEl) {
                        const _init = (callerHandle || 'U')[0].toUpperCase();
                        _avEl.innerHTML = '<img src="' + _url.replace(/"/g,'&quot;') + '" alt="' + _init + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%;display:block;">';
                    }
                }
            }).catch(() => {});
        }
    }
    modal.querySelector('#vc-accept-btn').addEventListener('click',  vcAnswerCall);
    modal.querySelector('#vc-decline-btn').addEventListener('click', vcDeclineCall);

    vcRingTimeout = setTimeout(() => {
        vcDeclineCall();
        _vcToast('📵 Missed call from @' + callerHandle);
    }, VC_RING_TIMEOUT_MS);

    requestAnimationFrame(() => modal.classList.add('vc-incoming-modal--visible'));
}

function _vcDismissIncoming() {
    _vcStopRing();
    if (vcRingTimeout) { clearTimeout(vcRingTimeout); vcRingTimeout = null; }
    const modal = document.getElementById('vc-incoming-modal');
    if (modal) { modal.classList.remove('vc-incoming-modal--visible'); setTimeout(() => modal.remove(), 300); }
    vcIncomingCallerId = null; vcIncomingCallerH = null;
}

async function vcAnswerCall() { _vcDismissIncoming(); await window.vcJoin(false); }
function vcDeclineCall()      { _vcDismissIncoming(); }

// ─── VAD ──────────────────────────────────────────────────────────────────
function _vcInitAudioCtx() {
    if (!vcAudioCtx) vcAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
}
function _vcTrackVAD(uid, stream) {
    _vcInitAudioCtx();
    try {
        const src = vcAudioCtx.createMediaStreamSource(stream);
        const an  = vcAudioCtx.createAnalyser(); an.fftSize = 256;
        src.connect(an); vcAnalysers[uid] = an;
    } catch(e) {}
}
function _vcRemoveVAD(uid) { delete vcAnalysers[uid]; }
function _vcGetLevel(an) {
    const buf = new Float32Array(an.fftSize); an.getFloatTimeDomainData(buf);
    let sum = 0; for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length); return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}
function _vcStartVAD() {
    if (vcVadInterval) return;
    vcVadInterval = setInterval(() => {
        let changed = false;
        for (const [uid, an] of Object.entries(vcAnalysers)) {
            const speaking = _vcGetLevel(an) > VC_SPEAKING_THRESHOLD;
            const realUid  = uid === 'local' ? _vcMe() : uid;
            if (!vcParticipants[realUid]) continue;
            if (vcParticipants[realUid].speaking !== speaking) {
                vcParticipants[realUid].speaking = speaking;
                changed = true;
                if (uid === 'local' && vcPresenceRef && !vcMuted)
                    vcPresenceRef.update({ speaking }).catch(() => {});
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
            el.id = 'vc-audio-' + peerUid; el.autoplay = true; el.style.display = 'none';
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
        const gRef = _vcGroupRef(); if (!gRef) return;
        gRef.collection('signals').add({
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
        const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
        await pc.setLocalDescription(offer);
        const gRef = _vcGroupRef(); if (!gRef) return;
        await gRef.collection('signals').add({
            from: _vcMe(), to: peerUid, type: 'offer',
            sdp: offer.sdp,
            ts: firebase.firestore.FieldValue.serverTimestamp()
        });
    } catch(e) { console.warn('[VC] offer error', e); }
}
async function _vcAnswer(peerUid, sdp) {
    let pc = vcPeers[peerUid]?.pc;
    if (!pc || pc.signalingState === 'closed') pc = _vcCreatePC(peerUid);

    // Handle glare: if we also sent an offer (have-local-offer), roll back
    // our local description so we can accept the incoming offer.
    // This is required for renegotiation (e.g. when a peer adds a video track).
    if (pc.signalingState === 'have-local-offer') {
        try {
            await pc.setLocalDescription({ type: 'rollback' });
        } catch(e) {
            console.warn('[VC] answer rollback failed, dropping offer', e);
            return;
        }
    }

    if (pc.signalingState !== 'stable') return;
    try {
        await pc.setRemoteDescription({ type: 'offer', sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        const gRef = _vcGroupRef(); if (!gRef) return;
        await gRef.collection('signals').add({
            from: _vcMe(), to: peerUid, type: 'answer',
            sdp: answer.sdp,
            ts: firebase.firestore.FieldValue.serverTimestamp()
        });
    } catch(e) { console.warn('[VC] answer error', e); }
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
    delete vcPeers[uid]; delete vcParticipants[uid]; _vcRemoveVAD(uid);
}

// ─── Signaling + Presence Listeners ──────────────────────────────────────
function _vcStartListeners() {
    const gRef = _vcGroupRef(); if (!gRef) return;
    const me = _vcMe();

    const sigUnsub = gRef.collection('signals').where('to', '==', me)
        .onSnapshot(snap => {
            snap.docChanges().forEach(async change => {
                if (change.type !== 'added') return;
                const sig = change.doc.data();
                change.doc.ref.delete().catch(() => {});
                if      (sig.type === 'offer')     { if (vcActive) await _vcAnswer(sig.from, sig.sdp); }
                else if (sig.type === 'answer')    { await _vcHandleAnswer(sig.from, sig.sdp); }
                else if (sig.type === 'candidate') { await _vcHandleCandidate(sig.from, sig.candidate); }
                else if (sig.type === 'kick')      { await window.vcLeave(); _vcToast('🚫 Removed from call by supervisor'); }
            });
        });

    const presUnsub = gRef.collection('participants').onSnapshot(snap => {
        const me = _vcMe();
        snap.docChanges().forEach(change => {
            const uid = change.doc.id, data = change.doc.data();
            if (change.type === 'removed') {
                if (uid !== me) _vcRemovePeer(uid);
                return;
            }
            if (uid === me) {
                // Keep local participant entry in sync with Firestore (muted/speaking state)
                vcParticipants[me] = {
                    handle:   data.handle  || _vcHnd() || 'you',
                    muted:    data.muted   != null ? data.muted   : vcMuted,
                    speaking: data.speaking != null ? data.speaking : false
                };
            } else {
                const wasHere = !!vcParticipants[uid];
                vcParticipants[uid] = { handle: data.handle || uid.slice(0,6), muted: !!data.muted, speaking: !!data.speaking };
                // Offer WebRTC connection to new peer (lower uid initiates to avoid glare)
                if (!wasHere && vcActive && me < uid) setTimeout(() => _vcOffer(uid), 500);
            }
        });
        _vcRenderParticipants();
        _vcUpdateCallBtn();
    });

    vcPresenceUnsub = () => { sigUnsub(); presUnsub(); };
}

// ─── Join ─────────────────────────────────────────────────────────────────
// isInitiator=true → caller; false → answerer (already passed through vcAnswerCall)
async function vcJoin(isInitiator = true) {
    if (vcActive) return;

    // ── Guard: must be signed in (non-anonymous) and in a group ──
    const user  = _vcUser();
    const group = _vcGroup();

    if (!user) {
        _vcToast('⚠️ Sign in to join calls'); return;
    }
    if (user.isAnonymous) {
        _vcToast('⚠️ Sign in with Google to join calls'); return;
    }
    if (!group) {
        _vcToast('⚠️ Join a collaboration first'); return;
    }

    // Request microphone
    try {
        vcLocalStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch(e) {
        _vcToast('🎙️ Microphone access denied'); console.warn('[VC] getUserMedia', e); return;
    }

    vcActive       = true;
    vcMuted        = false;
    vcDeafened     = false;
    vcCallStartTime= Date.now();
    vcPeers        = {};
    vcParticipants = {};

    _vcTrackVAD('local', vcLocalStream);
    _vcStartVAD();

    // Write own presence to Firestore
    vcPresenceRef = _vcMyPresenceRef();
    if (!vcPresenceRef) {
        // Group ref not available yet — clean up and bail
        vcActive = false;
        if (vcLocalStream) { vcLocalStream.getTracks().forEach(t => t.stop()); vcLocalStream = null; }
        _vcToast('⚠️ Not in a collaboration group'); return;
    }

    // Add self to local participants immediately so panel renders correctly
    const myHandle = _vcHnd() || user.email?.split('@')[0] || 'user';
    vcParticipants[_vcMe()] = { handle: myHandle, muted: false, speaking: false };

    await vcPresenceRef.set({
        handle:   myHandle,
        uid:      _vcMe(),
        muted:    false,
        speaking: false,
        joinedAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    _vcStartListeners();

    if (isInitiator) {
        // Broadcast ring to all other members
        await _vcWriteRing();
        _vcShowOutgoingRing();
        // Auto-cancel ring after timeout if no one joins
        vcRingTimeout = setTimeout(async () => {
            await _vcDeleteRing();
            _vcHideOutgoingRing();
            if (Object.keys(vcParticipants).length <= 1) _vcToast('📵 No one answered');
        }, VC_RING_TIMEOUT_MS);
    }
    // Note: answerer does NOT delete the ring doc — other members should still be able to join

    vcDurationInterval = setInterval(_vcUpdateDuration, 1000);
    _vcRenderPanel();
    _vcUpdateCallBtn();
    _vcToast('🎙️ Joined voice call');
}

// ─── Leave ────────────────────────────────────────────────────────────────
async function vcLeave() {
    if (!vcActive) return;
    vcActive = false;

    _vcStopVAD(); _vcStopRing(); _vcHideOutgoingRing();
    if (vcRingTimeout)      { clearTimeout(vcRingTimeout);    vcRingTimeout = null; }
    if (vcDurationInterval) { clearInterval(vcDurationInterval); vcDurationInterval = null; }
    if (vcPresenceUnsub)    { vcPresenceUnsub(); vcPresenceUnsub = null; }

    if (vcPresenceRef) { await vcPresenceRef.delete().catch(() => {}); vcPresenceRef = null; }

    // Clean up own signals + ring doc if we were caller
    try {
        const gRef = _vcGroupRef();
        if (gRef) {
            const stale = await gRef.collection('signals').where('from', '==', _vcMe()).get();
            stale.forEach(d => d.ref.delete());
            const ring = await gRef.collection('ring').doc('current').get();
            if (ring.exists && ring.data().callerUid === _vcMe()) await ring.ref.delete();
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
    _vcRenderParticipants(); _vcUpdateControls();
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
    if (!_vcIsSup()) return;
    const gRef = _vcGroupRef(); if (!gRef) return;
    await gRef.collection('signals').add({
        from: _vcMe(), to: uid, type: 'kick',
        ts: firebase.firestore.FieldValue.serverTimestamp()
    });
}

// ─── Outgoing ring UI ─────────────────────────────────────────────────────
function _vcShowOutgoingRing() {
    _vcPlayRing('outgoing');
    ['vc-call-btn', 'vc-call-btn-member'].forEach(id => {
        document.getElementById(id)?.classList.add('vc-call-btn--ringing');
    });
    const s = document.getElementById('vc-call-status');
    if (s) s.textContent = 'Calling…';
}
function _vcHideOutgoingRing() {
    _vcStopRing();
    ['vc-call-btn', 'vc-call-btn-member'].forEach(id => {
        document.getElementById(id)?.classList.remove('vc-call-btn--ringing');
    });
    const s = document.getElementById('vc-call-status');
    if (s) s.textContent = '';
}

// ─── Duration ─────────────────────────────────────────────────────────────
function _vcUpdateDuration() {
    const el = document.getElementById('vc-duration');
    if (!el || !vcCallStartTime) return;
    const s = Math.floor((Date.now() - vcCallStartTime) / 1000);
    el.textContent = `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
}

// ─── Inject buttons (called after renderGroupUI settles) ──────────────────
function _vcInjectCallButtons() {
    // Only inject if the collab lock is active for this workspace
    if (typeof window._isCollabLockActive !== 'function' || !window._isCollabLockActive()) return;
    // Supervisor: inject after #tc-board-btn in the Team column header
    if (!document.getElementById('vc-call-btn')) {
        const boardBtn = document.getElementById('tc-board-btn');
        if (boardBtn) {
            const btn = document.createElement('button');
            btn.id        = 'vc-call-btn';
            btn.className = 'tc-board-btn vc-call-btn-style';
            btn.title     = 'Start a group voice call';
            btn.innerHTML = '🎙️ Call';
            btn.addEventListener('click', _vcCallBtnClick);
            boardBtn.insertAdjacentElement('afterend', btn);
        }
    }
    // Member: inject after #mb-member-board-btn in the fixed controls bar
    if (!document.getElementById('vc-call-btn-member')) {
        const boardBtn = document.getElementById('mb-member-board-btn');
        if (boardBtn) {
            const btn = document.createElement('button');
            btn.id        = 'vc-call-btn-member';
            btn.className = 'mb-member-board-btn vc-call-btn-style';
            btn.title     = 'Join group voice call';
            btn.innerHTML = '🎙️ Call';
            btn.addEventListener('click', _vcCallBtnClick);
            boardBtn.insertAdjacentElement('afterend', btn);
        }
    }
    _vcUpdateCallBtn();
}

function _vcCallBtnClick() {
    if (vcActive) {
        _vcSurfacePanel();
    } else {
        window.vcJoin(true).then(() => {
            if (vcActive) _vcSurfacePanel();
        }).catch(() => {});
    }
}

function _vcSurfacePanel() {
    const bar = document.getElementById('vc-mini-bar');
    if (bar) bar.remove();
    let panel = document.getElementById('vc-panel');
    if (panel) {
        panel.classList.remove('vc-panel--minimized');
        document.body.appendChild(panel); // re-append = guaranteed top of stacking order
    } else {
        _vcRenderPanel();
    }
}

// ─── Call button state ────────────────────────────────────────────────────
function _vcUpdateCallBtn() {
    ['vc-call-btn', 'vc-call-btn-member'].forEach(id => {
        const btn = document.getElementById(id);
        if (!btn) return;
        if (vcActive) {
            btn.innerHTML = '<span class="vc-btn-pulse"></span> In Call';
            btn.classList.add('vc-call-btn--active');
            btn.classList.remove('vc-call-btn--ringing');
        } else {
            btn.innerHTML = '🎙️ Call';
            btn.classList.remove('vc-call-btn--active', 'vc-call-btn--ringing');
        }
    });
}

// ─── Panel ────────────────────────────────────────────────────────────────
function _vcClosePanel() {
    document.getElementById('vc-panel')?.remove();
    document.getElementById('vc-mini-bar')?.remove();
}
function _vcRenderPanel() {
    let panel = document.getElementById('vc-panel');
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'vc-panel';
        panel.className = 'vc-panel';
        document.body.appendChild(panel);
    }
    const g = _vcGroup();
    panel.innerHTML = `
        <div class="vc-panel-header">
            <div class="vc-panel-title">
                <span class="vc-live-dot"></span>
                <span>Voice Call</span>
                ${g ? `<span class="vc-group-name">${_vcEsc(g.name)}</span>` : ''}
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
            <button class="vc-ctrl-btn ${vcMuted   ? 'vc-ctrl-btn--active' : ''}" id="vc-mute-btn">
                ${vcMuted   ? '🔇' : '🎙️'}<span>${vcMuted ? 'Unmute' : 'Mute'}</span>
            </button>
            <button class="vc-ctrl-btn ${vcDeafened ? 'vc-ctrl-btn--active' : ''}" id="vc-deafen-btn">
                ${vcDeafened ? '🔕' : '🔊'}<span>${vcDeafened ? 'Undeafen' : 'Deafen'}</span>
            </button>
            <button class="vc-ctrl-btn vc-ctrl-btn--leave" id="vc-leave-btn">
                📵<span>Leave</span>
            </button>
        </div>`;
    panel.querySelector('#vc-panel-close').addEventListener('click', () => {
        panel.classList.add('vc-panel--minimized');
        _vcShowMiniBar();
    });
    panel.querySelector('#vc-mute-btn').addEventListener('click',   vcToggleMute);
    panel.querySelector('#vc-deafen-btn').addEventListener('click', vcToggleDeafen);
    panel.querySelector('#vc-leave-btn').addEventListener('click',  window.vcLeave);
    _vcRenderParticipants();
    _vcUpdateDuration();
}

function _vcShowMiniBar() {
    if (document.getElementById('vc-mini-bar')) return;
    const bar = document.createElement('div');
    bar.id = 'vc-mini-bar'; bar.className = 'vc-mini-bar';
    bar.innerHTML = `
        <span class="vc-live-dot"></span>
        <span id="vc-mini-count">${Object.keys(vcParticipants).length} in call</span>
        <button id="vc-mini-expand" title="Open">▲</button>
        <button id="vc-mini-mute"   title="${vcMuted ? 'Unmute' : 'Mute'}">${vcMuted ? '🔇' : '🎙️'}</button>
        <button class="vc-mini-leave" id="vc-mini-leave" title="Leave">📵</button>`;
    document.body.appendChild(bar);
    bar.querySelector('#vc-mini-expand').addEventListener('click', () => {
        bar.remove();
        const p = document.getElementById('vc-panel');
        if (p) p.classList.remove('vc-panel--minimized'); else _vcRenderPanel();
    });
    bar.querySelector('#vc-mini-mute').addEventListener('click', () => {
        vcToggleMute();
        const b = bar.querySelector('#vc-mini-mute');
        b.textContent = vcMuted ? '🔇' : '🎙️'; b.title = vcMuted ? 'Unmute' : 'Mute';
    });
    bar.querySelector('#vc-mini-leave').addEventListener('click', () => { bar.remove(); window.vcLeave(); });
}

function _vcRenderParticipants() {
    const container = document.getElementById('vc-participants');
    if (!container) return;
    const me      = _vcMe();
    const entries = Object.entries(vcParticipants);

    // Cancel "Calling…" status and ring timeout once a second person joins
    if (entries.length > 1) {
        _vcHideOutgoingRing();
        if (vcRingTimeout) { clearTimeout(vcRingTimeout); vcRingTimeout = null; }
    }

    container.innerHTML = '';

    if (entries.length === 0) {
        container.innerHTML = '<div class="vc-empty">Connecting…</div>';
        const mini = document.getElementById('vc-mini-count');
        if (mini) mini.textContent = '1 in call';
        return;
    }

    // Prefetch avatars for all participants (no-op if already cached)
    _vcPrefetchAvatars(entries.map(([uid]) => uid)).then(() => {
        // Re-render after avatars load if any were missing
        const wasEmpty = entries.some(([uid]) => !(window._vcAvatarCache || {})[uid] && !(window._vcAvatarCache || {})[uid] === null);
        if (wasEmpty) _vcRenderParticipants();
    });

    entries.forEach(([uid, p]) => {
        const isMe  = uid === me;
        const isSup = _vcGroup()?.supervisorUid === uid;
        const connected = isMe || vcPeers[uid]?.pc?.connectionState === 'connected';
        const card = document.createElement('div');
        card.className = `vc-p-card ${p.speaking && !p.muted ? 'vc-p-card--speaking' : ''}`;
        card.innerHTML = `
            <div class="vc-p-avatar ${p.speaking && !p.muted ? 'vc-p-avatar--speaking' : ''} ${isSup ? 'vc-p-avatar--sup' : ''}">
                ${_vcAvatarHtml(uid, p.handle)}
            </div>
            <div class="vc-p-info">
                <span class="vc-p-name">@${_vcEsc(p.handle || uid.slice(0,6))}${isMe ? ' (you)' : ''}${isSup ? ' 👑' : ''}</span>
                <span class="vc-p-status">
                    ${p.muted                    ? '<span class="vc-status-chip muted">🔇</span>'      : ''}
                    ${p.speaking && !p.muted     ? '<span class="vc-status-chip speaking">🎙️</span>'  : ''}
                    ${!connected && !isMe        ? '<span class="vc-status-chip connecting">⏳</span>' : ''}
                </span>
            </div>
            <div class="vc-p-actions">
                ${_vcIsSup() && !isMe ? `<button class="vc-kick-btn" data-uid="${uid}" title="Remove">✕</button>` : ''}
            </div>`;
        card.querySelectorAll('.vc-kick-btn').forEach(b =>
            b.addEventListener('click', e => { e.stopPropagation(); vcKickFromCall(b.dataset.uid); }));
        container.appendChild(card);
    });

    // Show helpful hints when only self is present
    if (entries.length === 1 && entries[0][0] === me) {
        const hintWrap = document.createElement('div');
        hintWrap.innerHTML = `
            <div class="vc-empty" style="margin-bottom:8px;">Waiting for others to join…</div>
            <div class="vc-hint-row">
                <span class="vc-hint-icon">🔇</span>
                <span class="vc-hint-text"><strong>Mute / Unmute</strong> with the button below, or press <strong>M</strong></span>
            </div>
            <div class="vc-hint-row">
                <span class="vc-hint-icon">📹</span>
                <span class="vc-hint-text"><strong>Video &amp; screen share</strong> available once you click the Video button</span>
            </div>
            <div class="vc-hint-row">
                <span class="vc-hint-icon">─</span>
                <span class="vc-hint-text">Click <strong>─</strong> to minimise this panel without leaving the call</span>
            </div>`;
        container.appendChild(hintWrap);
    }

    const mini = document.getElementById('vc-mini-count');
    if (mini) mini.textContent = `${entries.length} in call`;
}

function _vcUpdateControls() {
    const mb = document.getElementById('vc-mute-btn');
    const db = document.getElementById('vc-deafen-btn');
    if (mb) { mb.className = `vc-ctrl-btn ${vcMuted    ? 'vc-ctrl-btn--active' : ''}`; mb.innerHTML = `${vcMuted    ? '🔇' : '🎙️'}<span>${vcMuted    ? 'Unmute'   : 'Mute'}</span>`; }
    if (db) { db.className = `vc-ctrl-btn ${vcDeafened ? 'vc-ctrl-btn--active' : ''}`; db.innerHTML = `${vcDeafened ? '🔕' : '🔊'}<span>${vcDeafened ? 'Undeafen' : 'Deafen'}</span>`; }
    const mm = document.getElementById('vc-mini-mute');
    if (mm) { mm.textContent = vcMuted ? '🔇' : '🎙️'; }
    if (typeof window._vvUpdateVideoControls === 'function') window._vvUpdateVideoControls();
}

// ─── Install hooks after all scripts have parsed ─────────────────────────
// Wrapped in load event so tasky-collab.js chain is fully built first.
window.addEventListener('load', function _vcInstallHooks() {

    // Patch renderGroupUI
    if (typeof renderGroupUI === 'function') {
        const _vcOrig = renderGroupUI;
        renderGroupUI = function() {
            _vcOrig.apply(this, arguments);
            const u = _vcUser(), g = _vcGroup();
            var lockActive = typeof window._isCollabLockActive === 'function' && window._isCollabLockActive();
            if (g && u && !u.isAnonymous && lockActive) {
                setTimeout(_vcInjectCallButtons, 80);
                _vcStartRingListener();
            } else {
                // No active collab on this workspace — remove all call buttons and panels
                ['vc-call-btn', 'vc-call-btn-member'].forEach(function(id) {
                    var el = document.getElementById(id);
                    if (el) el.remove();
                });
                var panel = document.getElementById('vc-panel');
                if (panel) panel.remove();
                var miniBar = document.getElementById('vc-mini-bar');
                if (miniBar) miniBar.remove();
                var incomingModal = document.getElementById('vc-incoming-modal');
                if (incomingModal) incomingModal.remove();
                _vcStopRingListener();
                if (vcActive) window.vcLeave();
            }
        };
    }

    // Patch leaveGroup
    if (typeof leaveGroup === 'function') {
        const _vcOrigLeave = leaveGroup;
        window.leaveGroup = async function() {
            if (vcActive) await window.vcLeave();
            _vcStopRingListener();
            return _vcOrigLeave.apply(this, arguments);
        };
    }

    // Trigger initial injection in case group is already active on load
    setTimeout(_vcInjectCallButtons, 200);
    const u = _vcUser(), g = _vcGroup();
    var lockActive = typeof window._isCollabLockActive === 'function' && window._isCollabLockActive();
    if (g && u && !u.isAnonymous && lockActive) _vcStartRingListener();
});

// ─── Exports ──────────────────────────────────────────────────────────────
window.vcJoin         = vcJoin;
window.vcLeave        = vcLeave;
window.vcAnswerCall   = vcAnswerCall;
window.vcDeclineCall  = vcDeclineCall;
window.vcToggleMute   = vcToggleMute;
window.vcToggleDeafen = vcToggleDeafen;
window.vcKickFromCall = vcKickFromCall;
window._vcAnswer             = _vcAnswer;
window._vcRenderParticipants = _vcRenderParticipants;

// Expose live references so tasky-video.js can read them without closures.
// These are read-only getters — tasky-video must never reassign them.
Object.defineProperty(window, '_vcParticipantsRef', { get: () => vcParticipants, configurable: true });
Object.defineProperty(window, '_vcPeersRef',        { get: () => vcPeers,        configurable: true });
Object.defineProperty(window, '_vcLocalStreamRef',  { get: () => vcLocalStream,  configurable: true });
Object.defineProperty(window, '_vcMutedRef',        { get: () => vcMuted,        configurable: true });
Object.defineProperty(window, '_vcDeafenedRef',     { get: () => vcDeafened,     configurable: true });

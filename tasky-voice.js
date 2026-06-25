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
//
// ICE SERVERS — STUN by default, TURN as opt-in fallback for mobile / CGNAT.
//
// Pure STUN-only P2P works for ~80% of network pairs (home WiFi, office WiFi,
// most wired broadband).  It CANNOT work when either peer is behind:
//   • Symmetric NAT / CGNAT (most mobile carriers, some ISPs, corporate WiFi)
//   • UDP-blocking firewalls
//   • Captive portals
// In those cases the srflx candidate STUN discovers is unreachable from the
// remote peer, and a TURN relay is required.
//
// By default we use STUN only (pure P2P).  To enable TURN fallback — which
// the browser only uses when direct P2P fails, so it doesn't change the
// architecture for working P2P calls — set this before tasky-voice.js loads:
//
//     window.VC_USE_TURN = true;
//
// or override the entire ICE server list:
//
//     window.VC_ICE_SERVERS = [ ...your own STUN+TURN servers... ];
//
// We use non-trickle ICE (see _vcWaitForIceGathering below): the offer /
// answer SDP is not sent until ICE gathering completes, so all candidates
// are embedded in the SDP itself.  This eliminates the candidate / SDP
// race condition that was causing cross-network calls to fail.
//
const VC_STUN_ONLY_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' }
];
// STUN + free OpenRelay TURN.  TURN is only used by the browser when P2P
// fails — having it in the list does NOT relay working P2P calls.
const VC_STUN_AND_TURN_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'turn:openrelay.mobi:443',     username: 'openrelay',         credential: 'openrelayproject' },
    { urls: 'turn:openrelay.mobi:443?transport=tcp', username: 'openrelay', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.mobi:3478',    username: 'openrelay',         credential: 'openrelayproject' },
    { urls: 'turn:openrelay.mobi:3478?transport=tcp', username: 'openrelay', credential: 'openrelayproject' }
];
function _vcResolveIceServers() {
    if (window.VC_ICE_SERVERS) return window.VC_ICE_SERVERS;
    if (window.VC_USE_TURN)    return VC_STUN_AND_TURN_SERVERS;
    return VC_STUN_ONLY_SERVERS;
}
const VC_ICE_SERVERS = _vcResolveIceServers();
const VC_SPEAKING_THRESHOLD = -50;
const VC_SPEAKING_INTERVAL  = 200;
const VC_RING_TIMEOUT_MS    = 30000;
const VC_RECONNECT_DELAY    = 3000;
const VC_ICE_GATHER_TIMEOUT = 5000;
const VC_RECONNECT_COOLDOWN_MS = 10000;
// P2P -> TURN auto-switch: if a call started in P2P mode and no peer has
// reached ICE 'connected' within this many ms, we auto-enable TURN and
// re-offer.  Per user: "if it fails within 8 seconds, auto switch to turn".
const VC_P2P_FAILURE_TIMEOUT_MS = 8000;

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
// Per-peer renegotiation bookkeeping.  Prevents two classes of bug:
//   1. PC leak — _vcOffer used to call _vcCreatePC which overwrote the old
//      PC reference without closing it, leaving zombie PCs gathering
//      candidates and holding audio elements open.
//   2. Renegotiation storm — mobile networks briefly drop ICE to
//      'disconnected' all the time.  Re-offering on every blip creates a
//      loop.  We track ongoingOffer to dedupe and lastOfferAt to cooldown.
let vcPeerBookkeeping = {};  // { uid: { ongoingOffer: bool, lastOfferAt: ms } }
// P2P -> TURN auto-switch state
let vcP2PWatchdogTimer   = null;   // 8s timer that flips on TURN if P2P stalls
let vcAutoTurnTried      = false;  // only auto-switch once per call
let vcCallStartedWithTurn = false; // snapshot of VC_USE_TURN at vcJoin time

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
function _vcEsc(s)       { return escHtml(s); }


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

// ─── Mic Permission Modal (one-shot — browser denies permanently after first block) ──
function _vcShowMicPermissionModal() {
    return new Promise(function(resolve) {
        if (document.getElementById('vc-mic-modal')) { resolve('cancel'); return; }
        var showHelp = false;
        var modal = document.createElement('div');
        modal.id = 'vc-mic-modal';
        modal.className = 'vc-mic-modal';
        modal.innerHTML = [
            '<div class="vc-mic-inner">',
            '<div class="vc-mic-icon">🎙️</div>',
            '<div class="vc-mic-title">Microphone Access Needed</div>',
            '<div class="vc-mic-desc" id="vc-mic-desc">Tasky needs your microphone to speak in voice calls. You can also join to listen only.</div>',
            '<div class="vc-mic-help" id="vc-mic-help" style="display:none;">',
                'Click the <strong>lock icon</strong> in your browser address bar → <strong>Site Settings</strong> → <strong>Microphone</strong> → <strong>Allow</strong>, then reload the page.',
            '</div>',
            '<div class="vc-mic-btns">',
            '<button class="vc-mic-btn vc-mic-btn--primary" id="vc-mic-listen">👂 Join to Listen</button>',
            '<button class="vc-mic-btn vc-mic-btn--secondary" id="vc-mic-help-btn">ℹ️ How to Enable</button>',
            '<button class="vc-mic-btn vc-mic-btn--secondary" id="vc-mic-cancel">Cancel</button>',
            '</div></div>'
        ].join('\n');
        document.body.appendChild(modal);
        requestAnimationFrame(function() { return modal.classList.add('vc-mic-modal--visible'); });
        function close(result) {
            modal.classList.remove('vc-mic-modal--visible');
            setTimeout(function() { return modal.remove(); }, 300);
            resolve(result);
        }
        modal.querySelector('#vc-mic-cancel').addEventListener('click', function() { return close('cancel'); });
        modal.querySelector('#vc-mic-listen').addEventListener('click', function() { return close('listen-only'); });
        modal.querySelector('#vc-mic-help-btn').addEventListener('click', function() {
            showHelp = !showHelp;
            var help = document.getElementById('vc-mic-help');
            var btn  = document.getElementById('vc-mic-help-btn');
            if (showHelp) {
                help.style.display = 'block';
                btn.textContent = '🙌 Got it';
            } else {
                help.style.display = 'none';
                btn.textContent = 'ℹ️ How to Enable';
            }
        });
        modal.addEventListener('click', function(e) {
            if (e.target === modal) close('cancel');
        });
    });
}

async function _vcRequestMicWithFallback() {
    try {
        return await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch(e) {
        if (e.name !== 'NotAllowedError') throw e;
    }
    var choice = await _vcShowMicPermissionModal();
    if (choice === 'cancel')      return null;
    if (choice === 'listen-only') return 'LISTEN_ONLY';
    return null;
}

// ─── Retry Mic Mid-Call ───────────────────────────────────────────────────
async function _vcRetryMic() {
    try {
        var stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        vcLocalStream = stream;
        Object.values(vcPeers).forEach(function(peer) {
            if (peer.pc && stream.getAudioTracks().length) {
                peer.pc.addTrack(stream.getAudioTracks()[0], stream);
            }
        });
        _vcTrackVAD('local', vcLocalStream);
        if (vcPresenceRef) {
            vcPresenceRef.update({ hardwareMuted: false }).catch(function() {});
        }
        if (vcParticipants[_vcMe()]) {
            vcParticipants[_vcMe()].hardwareMuted = false;
        }
        _vcRenderPanel();
        _vcUpdateControls();
        _vcToast('🎙️ Microphone connected');
    } catch(e) {
        _vcToast('🎙️ Unable to access microphone');
        console.warn('[VC] retry mic', e);
    }
}

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
// Close any existing PC for this peer and clear its bookkeeping entry.
// Called before creating a fresh PC to prevent the PC leak where the old
// RTCPeerConnection keeps gathering candidates and holding the audio element
// open after we've lost the reference to it.
function _vcCloseExistingPC(peerUid) {
    const existing = vcPeers[peerUid];
    if (existing && existing.pc) {
        try {
            // Remove listeners so onconnectionstatechange doesn't fire on close
            // and trigger a spurious reconnect attempt.
            existing.pc.onconnectionstatechange = null;
            existing.pc.oniceconnectionstatechange = null;
            existing.pc.onicegatheringstatechange = null;
            existing.pc.ontrack = null;
            existing.pc.onicecandidate = null;
            existing.pc.ondatachannel = null;
            existing.pc.close();
        } catch(_) {}
    }
    if (existing && existing.audioEl) {
        try { existing.audioEl.srcObject = null; existing.audioEl.remove(); } catch(_) {}
    }
    delete vcPeers[peerUid];
}

// Returns true if the existing PC for this peer is healthy enough to be
// reused for a renegotiation (rather than torn down and recreated).
function _vcCanReusePC(peerUid) {
    const peer = vcPeers[peerUid];
    if (!peer || !peer.pc) return false;
    const pc = peer.pc;
    const sigState = pc.signalingState;
    const iceState = pc.iceConnectionState;
    // 'closed' PCs can't be reused.  'have-local-offer' / 'have-remote-offer'
    // means a negotiation is already in flight — don't pile another on top.
    if (sigState === 'closed') return false;
    if (sigState !== 'stable') return false;
    if (iceState === 'failed') return false;
    return true;
}

function _vcCreatePC(peerUid) {
    // Always close any existing PC first — never leak.  _vcOffer decides
    // whether to call us (full rebuild) or reuse the existing PC (gentle
    // renegotiation); when it reaches us we always tear down.
    _vcCloseExistingPC(peerUid);

    // Resolve ICE servers fresh on every PC creation so the user can toggle
    // Mobile / Reliable Calls (window.VC_USE_TURN) in Settings and have it
    // take effect on the next call without reloading.
    const iceServers = _vcResolveIceServers();
    console.log('[VC] creating new PC for', peerUid,
                '— ICE config:', window.VC_ICE_SERVERS ? 'custom' :
                                   (window.VC_USE_TURN ? 'STUN+TURN' : 'STUN only'));

    const pc = new RTCPeerConnection({
        iceServers:           iceServers,
        // Use modern ICE transport policy — 'all' allows both STUN (host/srflx)
        // and TURN (relay) candidates so connectivity can fall back to relay
        // automatically when direct peer-to-peer fails across networks.
        iceTransportPolicy:   'all',
        // Bundle media on a single transport for efficiency
        bundlePolicy:         'max-bundle'
    });
    if (vcLocalStream) vcLocalStream.getTracks().forEach(t => pc.addTrack(t, vcLocalStream));

    pc.ontrack = (e) => {
        let el = document.getElementById('vc-audio-' + peerUid);
        if (!el) {
            el = document.createElement('audio');
            el.id = 'vc-audio-' + peerUid;
            el.autoplay = true;
            // playsInline helps on iOS Safari; muted=false is the default but
            // explicitly set so deafen toggling works predictably.
            el.setAttribute('playsinline', '');
            el.style.display = 'none';
            document.body.appendChild(el);
        }
        el.srcObject = e.streams[0];
        if (vcDeafened) el.muted = true;

        // Browsers can refuse to autoplay an <audio> element even after a user
        // gesture if the element was created and had srcObject assigned in a
        // microtask.  Explicitly calling play() resolves this race and surfaces
        // any rejection (often caused by the browser's autoplay policy) so we
        // can retry once the user interacts.
        const playPromise = el.play();
        if (playPromise && typeof playPromise.catch === 'function') {
            playPromise.catch(err => {
                console.warn('[VC] audio.play() rejected for peer', peerUid, err.name, err.message);
                // Retry on next user interaction
                const retry = () => {
                    el.play().catch(() => {});
                    document.removeEventListener('click', retry);
                    document.removeEventListener('keydown', retry);
                };
                document.addEventListener('click', retry, { once: true });
                document.addEventListener('keydown', retry, { once: true });
            });
        }

        _vcTrackVAD(peerUid, e.streams[0]);
        vcPeers[peerUid] = vcPeers[peerUid] || {};
        vcPeers[peerUid].audioEl = el;
    };

    pc.onicecandidate = (e) => {
        if (!e.candidate) return;
        // Non-trickle ICE: candidates are NOT sent separately.  We wait for
        // iceGatheringState === 'complete' in _vcOffer/_vcAnswer and then
        // send the full SDP with all candidates embedded.  This log is
        // kept for diagnostics so you can see which candidate types are
        // being gathered on your network.
        const cand = e.candidate.candidate || '';
        let ctype = 'unknown';
        if (/typ host/i.test(cand))      ctype = 'host';
        else if (/typ srflx/i.test(cand)) ctype = 'srflx (STUN)';
        else if (/typ relay/i.test(cand)) ctype = 'relay (TURN)';
        console.log('[VC] gathered ICE candidate for', peerUid, ':', ctype);
    };

    // ── ICE gathering / connection state diagnostics ───────────────────────
    // These events are the only way to know whether the media path actually
    // came up.  When users report "mic flashes but no audio", the root cause
    // is almost always that ICE never reaches 'connected' because the peer's
    // srflx candidates are unreachable and no relay candidate was available.
    pc.onicegatheringstatechange = () => {
        console.log('[VC] ICE gathering state for', peerUid, ':', pc.iceGatheringState);
    };
    pc.oniceconnectionstatechange = () => {
        const s = pc.iceConnectionState;
        console.log('[VC] ICE connection state for', peerUid, ':', s);
        // On any successful connection, cancel the P2P->TURN watchdog —
        // we don't need to fall back to TURN if P2P is working.
        if (s === 'connected' || s === 'completed') {
            if (vcP2PWatchdogTimer) {
                clearTimeout(vcP2PWatchdogTimer);
                vcP2PWatchdogTimer = null;
                console.log('[VC] P2P watchdog cancelled — ICE connected for', peerUid);
            }
        }
        // Mobile networks routinely blip to 'disconnected' for a second or
        // two when switching cell towers or when NAT bindings briefly time
        // out.  The browser auto-recovers from 'disconnected' on its own —
        // we should NOT treat it as a failure and trigger a renegotiation,
        // because doing so creates a renegotiation storm that ultimately
        // prevents the call from ever stabilising.
        //
        // 'failed' is the only state that requires explicit recovery.
        if (s === 'failed') {
            const now = Date.now();
            const bk = vcPeerBookkeeping[peerUid] || { lastOfferAt: 0 };
            if (now - bk.lastOfferAt < VC_RECONNECT_COOLDOWN_MS) {
                console.warn('[VC] ICE failed for', peerUid,
                             '— within cooldown, skipping restart (last offer was',
                             now - bk.lastOfferAt, 'ms ago)');
                return;
            }
            console.warn('[VC] ICE failed for', peerUid, '— restarting ICE');
            try { pc.restartIce(); } catch(_) {}
            // If we are the offerer, initiate a renegotiation to apply restart
            if (_vcMe() < peerUid) {
                bk.lastOfferAt = now;
                vcPeerBookkeeping[peerUid] = bk;
                setTimeout(() => _vcOffer(peerUid, /*isReconnect*/ true), 500);
            }
        }
    };

    pc.ondatachannel = (e) => {
        var dc = e.channel;
        window._wbDCs = window._wbDCs || {};
        dc.onopen = function() { window._wbDCs[peerUid] = dc; };
        dc.onclose = function() { delete window._wbDCs[peerUid]; };
        dc.onmessage = function(ev) {
            if (typeof window._wbDCReceive === 'function') window._wbDCReceive(peerUid, ev.data);
        };
    };

    pc.onconnectionstatechange = () => {
        console.log('[VC] PC connection state for', peerUid, ':', pc.connectionState);
        // Only trigger reconnect on 'failed', NOT on 'disconnected'.
        // Mobile networks briefly drop to 'disconnected' constantly and the
        // browser recovers automatically; reconnecting on every blip was
        // the cause of the renegotiation loop that broke mobile calls.
        if (pc.connectionState === 'failed') {
            const now = Date.now();
            const bk = vcPeerBookkeeping[peerUid] || { lastOfferAt: 0 };
            if (now - bk.lastOfferAt < VC_RECONNECT_COOLDOWN_MS) {
                console.warn('[VC] PC failed for', peerUid,
                             '— within cooldown, skipping reconnect');
                return;
            }
            bk.lastOfferAt = now;
            vcPeerBookkeeping[peerUid] = bk;
            setTimeout(() => {
                if (vcActive && vcParticipants[peerUid] && _vcMe() < peerUid) {
                    _vcOffer(peerUid, /*isReconnect*/ true);
                }
            }, VC_RECONNECT_DELAY);
        }
        _vcRenderParticipants();
    };

    vcPeers[peerUid] = vcPeers[peerUid] || {};
    vcPeers[peerUid].pc = pc;
    // Track whether this PC was created with TURN enabled — used by _vcAnswer
    // to detect when a TURN mismatch requires creating a fresh PC.
    vcPeers[peerUid].createdWithTurn = !!window.VC_USE_TURN;
    return pc;
}

// ─── ICE gathering helper (non-trickle ICE) ──────────────────────────────
// Waits for ICE gathering to reach 'complete', with a safety timeout so a
// slow STUN server can't block the call indefinitely.  Also waits until at
// least one candidate has been gathered — this fixes the "0 candidates"
// bug where the SDP was sent before the browser had gathered anything.
function _vcWaitForIceGathering(pc) {
    return new Promise(resolve => {
        let done = false;
        let candidateCount = 0;

        const finish = () => {
            if (done) return;
            done = true;
            pc.removeEventListener('icegatheringstatechange', onStateChange);
            pc.removeEventListener('icecandidate', onCandidate);
            clearTimeout(timer);
            if (candidateCount === 0) {
                console.warn('[VC] ICE gathering finished with ZERO candidates — ' +
                    'this usually means STUN is blocked or the browser hasn\'t started gathering yet');
            }
            resolve();
        };
        const onStateChange = () => {
            if (pc.iceGatheringState === 'complete') finish();
        };
        const onCandidate = (e) => {
            if (e.candidate) candidateCount++;
        };
        pc.addEventListener('icegatheringstatechange', onStateChange);
        pc.addEventListener('icecandidate', onCandidate);

        // If already complete, resolve immediately
        if (pc.iceGatheringState === 'complete') { finish(); return; }

        // Safety timeout — 5 seconds max
        const timer = setTimeout(finish, VC_ICE_GATHER_TIMEOUT);
    });
}

// Count candidates in an SDP string by type — used for diagnostic logging.
function _vcCountCandidates(sdp) {
    const lines = (sdp || '').split('\n').filter(l => l.startsWith('a=candidate'));
    const tally = { host: 0, srflx: 0, relay: 0, total: lines.length };
    for (const l of lines) {
        if (/typ host/i.test(l))       tally.host++;
        else if (/typ srflx/i.test(l)) tally.srflx++;
        else if (/typ relay/i.test(l)) tally.relay++;
    }
    return tally;
}

async function _vcOffer(peerUid, isReconnect) {
    // ─── Reconnect / dedupe bookkeeping ────────────────────────────────────
    // Prevents overlapping offers and renegotiation storms.  Mobile networks
    // blip ICE to 'disconnected' constantly; without dedupe, each blip would
    // trigger another _vcOffer and we'd end up with multiple in-flight
    // negotiations to the same peer, each leaking a PC.
    const bk = vcPeerBookkeeping[peerUid] || { ongoingOffer: false, lastOfferAt: 0 };
    if (bk.ongoingOffer) {
        console.warn('[VC] _vcOffer skipped — offer already in flight for', peerUid);
        return;
    }
    bk.ongoingOffer = true;
    bk.lastOfferAt  = Date.now();
    vcPeerBookkeeping[peerUid] = bk;
    const releaseBookkeeping = () => {
        if (vcPeerBookkeeping[peerUid]) vcPeerBookkeeping[peerUid].ongoingOffer = false;
    };

    // Log the caller so spurious offers (e.g. from video.js renegotiation)
    // are visible in the console and can be diagnosed.
    console.log('[VC] _vcOffer called for', peerUid,
                isReconnect ? '(reconnect)' : '(initial)',
                '— caller:', new Error().stack?.split('\n')[2]?.trim() || 'unknown');

    // ─── Reuse existing healthy PC for renegotiation (e.g. video track add) ─
    // Only tear down + recreate when this is an explicit reconnect or the
    // existing PC is in a bad state.  Reuse otherwise — creating a new PC
    // on every renegotiation was leaking the old one.
    let pc;
    if (!isReconnect && _vcCanReusePC(peerUid)) {
        pc = vcPeers[peerUid].pc;
        console.log('[VC] reusing existing PC for', peerUid, '(signalingState:', pc.signalingState + ')');
    } else {
        pc = _vcCreatePC(peerUid);  // closes any existing PC first
    }

    // Create DataChannel for whiteboard P2P sync — but only on first offer,
    // not on renegotiation (recreating the datachannel would break the wb).
    if (!isReconnect && !vcPeers[peerUid]?.wbDCCreated) {
        try {
            var wbDC = pc.createDataChannel('wb');
            window._wbDCs = window._wbDCs || {};
            wbDC.onopen = function() { window._wbDCs[peerUid] = wbDC; };
            wbDC.onclose = function() { delete window._wbDCs[peerUid]; };
            wbDC.onmessage = function(e) {
                if (typeof window._wbDCReceive === 'function') window._wbDCReceive(peerUid, e.data);
            };
            if (vcPeers[peerUid]) vcPeers[peerUid].wbDCCreated = true;
        } catch(e) { /* DataChannel not supported */ }
    }
    try {
        // iceRestart: true forces the browser to gather a fresh set of ICE
        // candidates instead of reusing the old ones.  Essential for
        // reconnects — without it, the same failed candidate pairs would
        // be tried again and fail again.
        const offer = await pc.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: true,
            iceRestart: !!isReconnect
        });
        await pc.setLocalDescription(offer);
        // Non-trickle ICE: wait for gathering to complete so all candidates
        // are embedded in pc.localDescription.sdp before we send it.
        await _vcWaitForIceGathering(pc);
        const sdp = pc.localDescription.sdp;
        const c = _vcCountCandidates(sdp);
        console.log('[VC] sending OFFER to', peerUid, '— candidates:',
                    c.total, '(host:', c.host, 'srflx:', c.srflx, 'relay:', c.relay + ')');
        const gRef = _vcGroupRef();
        if (!gRef) { releaseBookkeeping(); return; }
        await gRef.collection('signals').add({
            from: _vcMe(), to: peerUid, type: 'offer',
            sdp: sdp,
            ts: firebase.firestore.FieldValue.serverTimestamp()
        });
    } catch(e) {
        console.warn('[VC] offer error', e);
    } finally {
        releaseBookkeeping();
    }
}

async function _vcAnswer(peerUid, sdp) {
    let pc = vcPeers[peerUid]?.pc;

    // ─── Detect TURN mismatch: if the offer contains relay candidates but ──
    // our existing PC was created with STUN-only config, we MUST close it
    // and create a fresh TURN-enabled PC.  Otherwise our answer won't have
    // relay candidates and the call will fail for the same reason.
    const offerHasRelay = /typ relay/i.test(sdp || '');
    const ourPcHasTurn  = pc && vcPeers[peerUid]?.createdWithTurn;
    if (offerHasRelay && !ourPcHasTurn) {
        console.log('[VC] answer — offer has relay candidates but our PC is STUN-only, ' +
                    'creating fresh TURN-enabled PC for', peerUid);
        pc = _vcCreatePC(peerUid);  // closes old PC, creates new with current config
    } else if (pc && (pc.iceConnectionState === 'failed' || pc.connectionState === 'failed')) {
        console.log('[VC] answer — existing PC ICE state is', pc.iceConnectionState,
                    ', creating fresh PC for', peerUid);
        pc = _vcCreatePC(peerUid);
    } else if (!pc || pc.signalingState === 'closed') {
        pc = _vcCreatePC(peerUid);
    }

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
        const remoteC = _vcCountCandidates(sdp);
        console.log('[VC] received OFFER from', peerUid, '— remote candidates:',
                    remoteC.total, '(host:', remoteC.host, 'srflx:', remoteC.srflx, 'relay:', remoteC.relay + ')');
        await pc.setRemoteDescription({ type: 'offer', sdp });
        // Flush any trickle candidates that arrived before the offer did.
        const peer = vcPeers[peerUid];
        if (peer && peer.pendingCandidates && peer.pendingCandidates.length) {
            console.log('[VC] flushing', peer.pendingCandidates.length, 'buffered candidates for', peerUid);
            for (const c of peer.pendingCandidates) {
                try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch(e) {}
            }
            peer.pendingCandidates = [];
        }
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        // Non-trickle ICE: wait for our own gathering to complete too.
        await _vcWaitForIceGathering(pc);
        const outSdp = pc.localDescription.sdp;
        const c = _vcCountCandidates(outSdp);
        console.log('[VC] sending ANSWER to', peerUid, '— candidates:',
                    c.total, '(host:', c.host, 'srflx:', c.srflx, 'relay:', c.relay + ')');
        const gRef = _vcGroupRef(); if (!gRef) return;
        await gRef.collection('signals').add({
            from: _vcMe(), to: peerUid, type: 'answer',
            sdp: outSdp,
            ts: firebase.firestore.FieldValue.serverTimestamp()
        });
    } catch(e) { console.warn('[VC] answer error', e); }
}

async function _vcHandleAnswer(peerUid, sdp) {
    const pc = vcPeers[peerUid]?.pc;
    if (!pc || pc.signalingState !== 'have-local-offer') return;
    try {
        const c = _vcCountCandidates(sdp);
        console.log('[VC] received ANSWER from', peerUid, '— remote candidates:',
                    c.total, '(host:', c.host, 'srflx:', c.srflx, 'relay:', c.relay + ')');
        await pc.setRemoteDescription({ type: 'answer', sdp });
        // Flush any trickle candidates that arrived before the answer did.
        const peer = vcPeers[peerUid];
        if (peer && peer.pendingCandidates && peer.pendingCandidates.length) {
            console.log('[VC] flushing', peer.pendingCandidates.length, 'buffered candidates for', peerUid);
            for (const cand of peer.pendingCandidates) {
                try { await pc.addIceCandidate(new RTCIceCandidate(cand)); } catch(e) {}
            }
            peer.pendingCandidates = [];
        }
    } catch(e) {
        console.warn('[VC] setRemoteDescription(answer) failed', e);
    }
}

// Trickle-ICE candidates are no longer sent separately (non-trickle mode
// embeds them in the SDP).  This handler is kept for backwards compat
// with older clients that might still send candidates — it safely buffers
// them until remoteDescription is set, then flushes.
async function _vcHandleCandidate(peerUid, candidate) {
    const peer = vcPeers[peerUid];
    if (!peer || !peer.pc || peer.pc.signalingState === 'closed') return;
    if (!peer.pc.remoteDescription || !peer.pc.remoteDescription.sdp) {
        peer.pendingCandidates = peer.pendingCandidates || [];
        peer.pendingCandidates.push(candidate);
        return;
    }
    try {
        await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch(e) {
        console.warn('[VC] addIceCandidate failed for', peerUid, ':', e.message);
    }
}

// ─── Turn-required signal handler ─────────────────────────────────────────
// Called when the remote peer detects P2P failure and wants us to switch
// to TURN.  We enable TURN, close our existing PC, and wait for the remote
// peer's reconnect offer.  This ensures BOTH sides have TURN-enabled PCs
// when the reconnect offer arrives — without this, only the offerer would
// have TURN and the answerer's PC would still be STUN-only.
async function _vcHandleTurnRequired(peerUid) {
    console.log('%c[VC] ⟵ turn-required signal from ' + peerUid +
                ' — switching to TURN and closing old PC',
                'color: #3b82f6; font-weight: bold;');
    // Enable TURN on our side too
    window.VC_USE_TURN = true;
    vcCallStartedWithTurn = true;  // prevent our own watchdog from firing

    // Sync the Settings toggle UI
    try {
        var toggle = document.getElementById('st-turn-toggle');
        var sub    = document.getElementById('st-turn-sublabel');
        if (toggle) toggle.checked = true;
        if (sub) sub.textContent = 'TURN enabled — remote peer requested relay';
    } catch(_) {}

    // Close our existing PC so the next offer creates a fresh TURN-enabled one.
    // DO NOT re-offer — the remote peer (the one who sent turn-required) will
    // re-offer.  We just wait for their new offer and answer it.
    _vcCloseExistingPC(peerUid);

    _vcToast('📡 Remote peer switched to TURN relay');
}
function _vcRemovePeer(uid) {
    const peer = vcPeers[uid];
    if (peer) {
        if (peer.pc)      { try { peer.pc.close(); } catch(_) {} }
        if (peer.audioEl) { peer.audioEl.srcObject = null; peer.audioEl.remove(); }
    }
    delete vcPeers[uid]; delete vcParticipants[uid]; delete vcPeerBookkeeping[uid];
    _vcRemoveVAD(uid);
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
                if      (sig.type === 'offer')         { if (vcActive) await _vcAnswer(sig.from, sig.sdp); }
                else if (sig.type === 'answer')        { await _vcHandleAnswer(sig.from, sig.sdp); }
                else if (sig.type === 'candidate')     { await _vcHandleCandidate(sig.from, sig.candidate); }
                else if (sig.type === 'turn-required') { await _vcHandleTurnRequired(sig.from); }
                else if (sig.type === 'kick')          { await window.vcLeave(); _vcToast('🚫 Removed from call by supervisor'); }
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
                // Keep local participant entry in sync with Firestore (muted/speaking/hardwareMuted state)
                vcParticipants[me] = {
                    handle:        data.handle        || _vcHnd() || 'you',
                    muted:         data.muted         != null ? data.muted   : vcMuted,
                    speaking:      data.speaking       != null ? data.speaking : false,
                    hardwareMuted: data.hardwareMuted  != null ? data.hardwareMuted : !vcLocalStream
                };
            } else {
                const wasHere = !!vcParticipants[uid];
                vcParticipants[uid] = { handle: data.handle || uid.slice(0,6), muted: !!data.muted, speaking: !!data.speaking, hardwareMuted: !!data.hardwareMuted };
                // Offer WebRTC connection to new peer (lower uid initiates to avoid glare).
                // BUT only if we don't already have an active PC for this peer —
                // the presence doc can be deleted + re-added when the remote peer
                // goes through their own reconnect cycle, and re-offering in that
                // case creates a loop where both sides keep tearing down and
                // rebuilding their PCs.
                if (!wasHere && vcActive && me < uid) {
                    const existingPC = vcPeers[uid]?.pc;
                    const pcHealthy = existingPC &&
                                      existingPC.signalingState !== 'closed' &&
                                      existingPC.iceConnectionState !== 'failed' &&
                                      existingPC.connectionState !== 'failed';
                    if (pcHealthy) {
                        console.log('[VC] presence re-add for', uid,
                                    '— existing PC healthy (ICE:', existingPC.iceConnectionState +
                                    '), skipping re-offer');
                    } else {
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

    // Request microphone with reask modal + listen-only fallback
    var micResult;
    try {
        micResult = await _vcRequestMicWithFallback();
    } catch(e) {
        _vcToast('🎙️ Microphone error — no mic available');
        console.warn('[VC] getUserMedia error', e);
        return;
    }
    if (micResult === null) return;
    if (micResult === 'LISTEN_ONLY') {
        vcLocalStream = null;
    } else {
        vcLocalStream = micResult;
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
    const noMic = !vcLocalStream;
    vcParticipants[_vcMe()] = { handle: myHandle, muted: false, speaking: false, hardwareMuted: noMic };

    await vcPresenceRef.set({
        handle:   myHandle,
        uid:      _vcMe(),
        muted:    false,
        speaking: false,
        hardwareMuted: noMic,
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

    // ─── ICE config status + P2P watchdog ───────────────────────────────────
    vcCallStartedWithTurn = !!window.VC_USE_TURN;
    const iceLabel = window.VC_ICE_SERVERS ? 'custom' : (vcCallStartedWithTurn ? 'STUN+TURN' : 'STUN only (P2P)');
    console.log('%c[VC] ════════════════════════════════════════════════════════',
                'color: #8B5CF6; font-weight: bold;');
    console.log('%c[VC]  CALL STARTED — ICE config: ' + iceLabel,
                'color: ' + (vcCallStartedWithTurn ? '#22c55e' : '#f59e0b') + '; font-weight: bold; font-size: 13px;');
    console.log('%c[VC]  window.VC_USE_TURN = ' + window.VC_USE_TURN +
                '  |  localStorage tasky_use_turn = ' + localStorage.getItem('tasky_use_turn'),
                'color: #94a3b8;');
    if (!vcCallStartedWithTurn && !window.VC_DISABLE_AUTO_TURN) {
        console.log('%c[VC]  P2P watchdog ARMED — if no peer connects within ' +
                    VC_P2P_FAILURE_TIMEOUT_MS + 'ms, auto-switching to TURN',
                    'color: #f59e0b;');
        _vcArmP2PWatchdog();
    } else if (vcCallStartedWithTurn) {
        console.log('%c[VC]  TURN enabled — relay candidates will be gathered',
                    'color: #22c55e;');
    }
    console.log('%c[VC] ════════════════════════════════════════════════════════',
                'color: #8B5CF6; font-weight: bold;');

    _vcToast(vcCallStartedWithTurn
        ? '🎙️ Joined voice call (TURN relay ready)'
        : '🎙️ Joined voice call (P2P — auto-switches to TURN if needed)');
}

// ─── P2P -> TURN auto-switch watchdog ─────────────────────────────────────
// Starts an 8s timer when a call begins in P2P mode.  If no peer has
// reached ICE 'connected' by the time it fires, we flip VC_USE_TURN to
// true and re-offer all peers with TURN-enabled PCs.  The watchdog is
// cancelled early by oniceconnectionstatechange as soon as any peer
// reaches 'connected' or 'completed'.
function _vcArmP2PWatchdog() {
    if (vcP2PWatchdogTimer) clearTimeout(vcP2PWatchdogTimer);
    vcP2PWatchdogTimer = setTimeout(_vcP2PWatchdogFire, VC_P2P_FAILURE_TIMEOUT_MS);
}
async function _vcP2PWatchdogFire() {
    vcP2PWatchdogTimer = null;
    if (!vcActive) return;
    if (vcAutoTurnTried) return;            // only auto-switch once per call
    if (vcCallStartedWithTurn) return;      // call already started with TURN
    if (window.VC_DISABLE_AUTO_TURN) return;

    // Check if any peer is connected.  If even one is, P2P is working —
    // don't force TURN on (the failing peer will get its own reconnect).
    let anyConnected = false;
    let stuckPeers = [];
    for (const [uid, peer] of Object.entries(vcPeers)) {
        if (!peer.pc) continue;
        const s = peer.pc.iceConnectionState;
        if (s === 'connected' || s === 'completed') {
            anyConnected = true;
            break;
        }
        if (s !== 'closed') stuckPeers.push(uid);
    }
    if (anyConnected) {
        console.log('[VC] P2P watchdog: at least one peer connected, skipping TURN auto-switch');
        return;
    }
    if (stuckPeers.length === 0) {
        console.log('[VC] P2P watchdog: no peers yet, re-arming');
        _vcArmP2PWatchdog();
        return;
    }

    vcAutoTurnTried = true;
    console.log('%c[VC] ⚠ P2P failed within ' + VC_P2P_FAILURE_TIMEOUT_MS +
                'ms — auto-switching to TURN for peers: ' + stuckPeers.join(', '),
                'color: #ef4444; font-weight: bold; font-size: 13px;');
    window.VC_USE_TURN = true;

    // Sync the Settings toggle UI so the user can see what happened
    try {
        var toggle = document.getElementById('st-turn-toggle');
        var sub    = document.getElementById('st-turn-sublabel');
        if (toggle) toggle.checked = true;
        if (sub) sub.textContent = 'TURN enabled — auto-switched after P2P failed';
    } catch(_) {}

    _vcToast('⚠ P2P failed — switching to TURN relay');

    // ─── Send "turn-required" signal to all stuck peers BEFORE re-offering ──
    // This tells the remote peer to:
    //   1. Enable TURN on their side too
    //   2. Close their existing STUN-only PC
    //   3. Wait for our reconnect offer
    // Without this, only our side would have TURN and the remote's PC would
    // still be STUN-only — the reconnect offer would fail for the same reason.
    const gRef = _vcGroupRef();
    if (gRef) {
        for (const uid of stuckPeers) {
            try {
                await gRef.collection('signals').add({
                    from: _vcMe(), to: uid, type: 'turn-required',
                    ts: firebase.firestore.FieldValue.serverTimestamp()
                });
                console.log('[VC] ⟶ sent turn-required signal to', uid);
            } catch(e) {
                console.warn('[VC] failed to send turn-required to', uid, e);
            }
        }
        // Give the remote peer 1 second to close their old PC before we re-offer
        await new Promise(r => setTimeout(r, 1000));
    }

    // Re-offer all stuck peers with fresh PCs (TURN-enabled).  Only the
    // lower-uid side initiates to avoid glare.
    const me = _vcMe();
    for (const uid of stuckPeers) {
        if (me < uid) {
            _vcCloseExistingPC(uid);
            setTimeout(() => _vcOffer(uid, /*isReconnect*/ true), 200);
        }
    }
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

    window._wbDCs = {};
    for (const uid of Object.keys(vcPeers)) _vcRemovePeer(uid);
    vcPeers = {}; vcParticipants = {}; vcPeerBookkeeping = {};
    // Reset P2P->TURN watchdog state for next call
    if (vcP2PWatchdogTimer) { clearTimeout(vcP2PWatchdogTimer); vcP2PWatchdogTimer = null; }
    vcAutoTurnTried = false;
    vcCallStartedWithTurn = false;

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
            ${vcLocalStream
                ? '<button class="vc-ctrl-btn ' + (vcMuted ? 'vc-ctrl-btn--active' : '') + '" id="vc-mute-btn">' + (vcMuted ? '🔇' : '🎙️') + '<span>' + (vcMuted ? 'Unmute' : 'Mute') + '</span></button>'
                : '<button class="vc-ctrl-btn vc-ctrl-btn--no-mic" id="vc-retry-mic-btn" title="Retry microphone access">🔇<span>No Mic</span></button>'
            }
            <button class="vc-ctrl-btn ${vcDeafened ? 'vc-ctrl-btn--active' : ''}" id="vc-deafen-btn">
                ${vcDeafened ? '🔕' : '🔊'}<span>${vcDeafened ? 'Undeafen' : 'Deafen'}</span>
            </button>
            <button class="vc-ctrl-btn vc-ctrl-btn--leave" id="vc-leave-btn">
                📵<span>Leave</span>
            </button>
        </div>`;
    panel.querySelector('#vc-panel-close').addEventListener('click', function() {
        panel.classList.add('vc-panel--minimized');
        _vcShowMiniBar();
    });
    var muteBtn = panel.querySelector('#vc-mute-btn');
    var retryBtn = panel.querySelector('#vc-retry-mic-btn');
    if (muteBtn)  muteBtn.addEventListener('click',  vcToggleMute);
    if (retryBtn) retryBtn.addEventListener('click', _vcRetryMic);
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
        const noMic = p.hardwareMuted;
        const card = document.createElement('div');
        card.className = 'vc-p-card' + (p.speaking && !p.muted && !noMic ? ' vc-p-card--speaking' : '') + (noMic ? ' vc-p-card--no-mic' : '');
        var avatarCls = 'vc-p-avatar' + (p.speaking && !p.muted && !noMic ? ' vc-p-avatar--speaking' : '') + (isSup ? ' vc-p-avatar--sup' : '') + (noMic ? ' vc-p-avatar--no-mic' : '');
        var statusHtml = '';
        if (noMic)                          statusHtml += '<span class="vc-status-chip listen-only">👂 Listen-only</span>';
        if (p.muted && !noMic)              statusHtml += '<span class="vc-status-chip muted">🔇</span>';
        if (p.speaking && !p.muted && !noMic) statusHtml += '<span class="vc-status-chip speaking">🎙️</span>';
        if (!connected && !isMe)            statusHtml += '<span class="vc-status-chip connecting">⏳</span>';
        card.innerHTML = '' +
            '<div class="' + avatarCls + '">' + _vcAvatarHtml(uid, p.handle) + '</div>' +
            '<div class="vc-p-info">' +
                '<span class="vc-p-name">@' + _vcEsc(p.handle || uid.slice(0,6)) + (isMe ? ' (you)' : '') + (isSup ? ' 👑' : '') + '</span>' +
                '<span class="vc-p-status">' + statusHtml + '</span>' +
            '</div>' +
            '<div class="vc-p-actions">' +
                (_vcIsSup() && !isMe ? '<button class="vc-kick-btn" data-uid="' + uid + '" title="Remove">✕</button>' : '') +
            '</div>';
        card.querySelectorAll('.vc-kick-btn').forEach(b =>
            b.addEventListener('click', e => { e.stopPropagation(); vcKickFromCall(b.dataset.uid); }));
        container.appendChild(card);
    });

    // Show helpful hints when only self is present
    if (entries.length === 1 && entries[0][0] === me) {
        var noMicHint = !vcLocalStream;
        const hintWrap = document.createElement('div');
        hintWrap.innerHTML = '' +
            '<div class="vc-empty" style="margin-bottom:8px;">Waiting for others to join…</div>' +
            (noMicHint
                ? '<div class="vc-hint-row"><span class="vc-hint-icon">🔇</span><span class="vc-hint-text">Click <strong>No Mic</strong> below to retry microphone access</span></div>'
                : '<div class="vc-hint-row"><span class="vc-hint-icon">🔇</span><span class="vc-hint-text"><strong>Mute / Unmute</strong> with the button below, or press <strong>M</strong></span></div>'
            ) +
            '<div class="vc-hint-row"><span class="vc-hint-icon">📹</span><span class="vc-hint-text"><strong>Video &amp; screen share</strong> available once you click the Video button</span></div>' +
            '<div class="vc-hint-row"><span class="vc-hint-icon">─</span><span class="vc-hint-text">Click <strong>─</strong> to minimise this panel without leaving the call</span></div>';
        container.appendChild(hintWrap);
    }

    const mini = document.getElementById('vc-mini-count');
    if (mini) mini.textContent = `${entries.length} in call`;
}

function _vcUpdateControls() {
    var hasMic = !!vcLocalStream;
    var mb = document.getElementById('vc-mute-btn');
    var rb = document.getElementById('vc-retry-mic-btn');
    var db = document.getElementById('vc-deafen-btn');
    if (hasMic && mb) {
        mb.className = 'vc-ctrl-btn' + (vcMuted ? ' vc-ctrl-btn--active' : '');
        mb.innerHTML = (vcMuted ? '🔇' : '🎙️') + '<span>' + (vcMuted ? 'Unmute' : 'Mute') + '</span>';
    }
    if (!hasMic && rb) {
        rb.className = 'vc-ctrl-btn vc-ctrl-btn--no-mic';
        rb.innerHTML = '🔇<span>No Mic</span>';
    }
    if (db) {
        db.className = 'vc-ctrl-btn' + (vcDeafened ? ' vc-ctrl-btn--active' : '');
        db.innerHTML = (vcDeafened ? '🔕' : '🔊') + '<span>' + (vcDeafened ? 'Undeafen' : 'Deafen') + '</span>';
    }
    var mm = document.getElementById('vc-mini-mute');
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

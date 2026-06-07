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
let vvRecordMimeType  = null;
let vvRecordResolve   = null;
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

// ─── Accessors ───────────────────────────────────────────────────────────
function _vvUser()      { return window.currentUser || null; }
function _vvMe()        { const u = _vvUser(); return u ? u.uid : null; }
function _vvGroup()     { return window.currentGroup || null; }
function _vvEsc(s)      { return typeof escHtml === 'function' ? escHtml(s) : String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// ─── Avatar helper for video tiles ───────────────────────────────────────
function _vvAvatarContent(uid, handle) {
    const cache = window._vcAvatarCache || {};
    const url   = cache[uid];
    const init  = (handle || uid || 'U')[0].toUpperCase();
    if (url) return `<img src="${url.replace(/"/g,'&quot;')}" alt="${init}" style="width:100%;height:100%;object-fit:cover;display:block;">`;
    return init;
}

// Refresh a tile's avatar overlay when photo is loaded
function _vvRefreshTileAvatar(uid) {
    const ov = document.getElementById('vv-ov-' + uid);
    if (!ov) return;
    const avatarEl = ov.querySelector('.vv-tile-avatar');
    if (!avatarEl) return;
    const partic = _vvPartic();
    const p = partic[uid] || {};
    const handle = p.handle || uid.slice(0,6);
    avatarEl.innerHTML = _vvAvatarContent(uid, handle);
}


// vcActive, vcPeers, vcParticipants, vcLocalStream are plain `let` in
// tasky-voice.js — never exported to window.  Bridge via:
//   window._vvCallActive    set by our vcJoin / vcLeave wrappers
//   window._vvPeersRef      object reference injected by wrapper
//   window._vvParticRef     object reference injected by wrapper
//   window._vvLocalStreamRef track reference injected by wrapper
// Fallback: presence of #vc-panel in DOM = call is live.
function _vvIsActive() {
    if (window._vvCallActive != null) return !!window._vvCallActive;
    return !!document.getElementById('vc-panel');
}
function _vvPeers() {
    // Prefer the live getter from tasky-voice if available
    if (window._vcPeersRef && Object.keys(window._vcPeersRef).length > 0) return window._vcPeersRef;
    return window._vvPeersRef || {};
}
function _vvPartic() {
    // Prefer the live getter exported by tasky-voice.js (_vcParticipantsRef) —
    // this is the actual vcParticipants object, always current on all peers.
    if (window._vcParticipantsRef && Object.keys(window._vcParticipantsRef).length > 0) {
        return window._vcParticipantsRef;
    }

    // Fallback: build from DOM evidence when the live ref isn't available
    const base = Object.assign({}, window._vvParticRef || {});
    const me   = _vvMe();

    // Collect all remote uids from audio elements tasky-voice creates
    document.querySelectorAll('[id^="vc-audio-"]').forEach(el => {
        const uid = el.id.slice('vc-audio-'.length);
        if (uid && uid !== me && !base[uid]) {
            base[uid] = { handle: uid.slice(0, 8), muted: false, speaking: false };
        }
    });

    // Improve handles: read vc-p-name from supervisor kick buttons (all roles)
    // and from vc-p-card entries that have a data-uid attribute
    document.querySelectorAll('.vc-kick-btn[data-uid]').forEach(btn => {
        const uid = btn.dataset.uid;
        if (!uid || uid === me) return;
        const card   = btn.closest('.vc-p-card');
        const nameEl = card?.querySelector('.vc-p-name');
        if (nameEl) {
            const handle = nameEl.textContent
                .replace(/^@/, '').replace(/\s*\(you\).*$/, '').replace(/\s*👑\s*$/, '').trim();
            if (base[uid]) base[uid].handle = handle || base[uid].handle;
            else base[uid] = { handle, muted: false, speaking: false };
        }
    });

    // For non-supervisors: match vc-p-cards to audio elements by order
    // Each card that isn't "you" corresponds to a remote audio element in order
    const unresolved = Object.keys(base).filter(uid => base[uid].handle === uid.slice(0, 8));
    if (unresolved.length > 0) {
        const remoteCards = [...document.querySelectorAll('#vc-participants .vc-p-card')]
            .filter(c => !c.querySelector('.vc-p-name')?.textContent.includes('(you)'));
        unresolved.forEach((uid, i) => {
            const nameEl = remoteCards[i]?.querySelector('.vc-p-name');
            if (nameEl) {
                const handle = nameEl.textContent
                    .replace(/^@/, '').replace(/\s*\(you\).*$/, '').replace(/\s*👑\s*$/, '').trim();
                if (handle) base[uid].handle = handle;
            }
        });
    }

    return base;
}
function _vvLocalStream() {
    // Prefer the live getter exported by tasky-voice.js
    if (window._vcLocalStreamRef !== undefined) return window._vcLocalStreamRef;
    return window._vvLocalStreamRef || null;
}

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
        await _vvRemoveCameraTrack();
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
        await _vvAddVideoTrackToPeers(vvCameraStream.getVideoTracks()[0]);
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
        await _vvRemoveCameraTrack();
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
        await _vvAddVideoTrackToPeers(vvScreenStream.getVideoTracks()[0]);
        _vvToast('🖥️ Sharing screen');
    }
    _vvUpdateVideoControls();
    _vvRefreshLocalTile();
    _vvRenderVideoGrid();
}

// ─── Attach / replace video track in all existing peer connections ─────────
// Uses window._vvAllPCs (set by the RTCPeerConnection shim) as primary source
// so we reach every PC even if _vvPeersRef mapping is not yet complete.
function _vvLivePCs() {
    const pcs = [];
    if (window._vvAllPCs) {
        window._vvAllPCs.forEach(pc => {
            if (pc.signalingState !== 'closed') pcs.push(pc);
        });
    }
    // Also catch any from _vvPeersRef not yet in _vvAllPCs
    Object.values(_vvPeers()).forEach(peer => {
        if (peer.pc && peer.pc.signalingState !== 'closed' && !pcs.includes(peer.pc)) pcs.push(peer.pc);
    });
    // And from _vvPCMap
    if (window._vvPCMap) {
        window._vvPCMap.forEach((uid, pc) => {
            if (pc && pc.signalingState !== 'closed' && !pcs.includes(pc)) pcs.push(pc);
        });
    }
    return pcs;
}

async function _vvAddVideoTrackToPeers(track) {
    const stream = vvCameraOn ? vvCameraStream : vvScreenStream;
    const livePCs = _vvLivePCs();
    console.log('[VV:addTrack] livePCs=%d track.kind=%s track.id=%s', livePCs.length, track.kind, track.id);
    const promises = livePCs.map(async pc => {
        const senders = pc.getSenders();
        const liveVideoSender   = senders.find(s => s.track?.kind === 'video');
        const blankedVideoSender = !liveVideoSender
            ? senders.find(s => s.track === null && /^m=video/m.test(pc.localDescription?.sdp || ''))
            : null;
        const videoSender = liveVideoSender || blankedVideoSender;
        console.log('[VV:addTrack] pc sigState=%s senders=%d liveVideoSender=%s blankedSender=%s',
            pc.signalingState, senders.length, !!liveVideoSender, !!blankedVideoSender);

        if (videoSender) {
            console.log('[VV:addTrack] replaceTrack path, blanked=%s', !!blankedVideoSender);
            await videoSender.replaceTrack(track).catch(e => console.warn('[VV] replaceTrack', e));
            await _vvSetSenderBitrate(videoSender);
            // Log encoding state post-replaceTrack for diagnosis
            const p = videoSender.getParameters();
            console.log('[VV:addTrack] post-replaceTrack encoding active=%s maxBitrate=%s',
                p?.encodings?.[0]?.active, p?.encodings?.[0]?.maxBitrate);
            if (blankedVideoSender) {
                console.log('[VV:addTrack] blanked sender — forcing renegotiation');
                await _vvRenegotiate(pc);
            }
        } else {
            console.log('[VV:addTrack] addTrack + renegotiate path');
            try { pc.addTrack(track, stream); } catch(e) { console.error('[VV:addTrack] addTrack threw', e); return; }
            await _vvRenegotiate(pc);
        }
    });
    await Promise.all(promises);
}

// _vvRenegotiate: create a new offer on `pc` and send it through the same
// Firestore signals collection that tasky-voice uses.  The remote peer's
// existing signal listener (in tasky-voice.js) handles offer/answer already.
async function _vvRenegotiate(pc) {
    try {
        const uid = _vvUidForPC(pc);
        console.log('[VV:renegotiate] uid=%s signalingState=%s', uid, pc.signalingState);
        if (!uid) { console.error('[VV:renegotiate] ABORT — no uid for PC'); return; }
        const db    = (typeof _vcDb === 'function' ? _vcDb() : null) || window.db || null; if (!db) { console.error('[VV:renegotiate] ABORT — no db'); return; }
        const group = _vvGroup(); if (!group) { console.error('[VV:renegotiate] ABORT — no group'); return; }
        const me    = _vvMe();   if (!me) { console.error('[VV:renegotiate] ABORT — no me'); return; }
        const gRef  = db.collection('voice_sessions').doc(group.code);

        // Set all video transceivers to sendrecv before creating the offer.
        // offerToReceiveVideo:true is a legacy option and causes Chromium to
        // emit direction=recvonly when the sender's track is null after
        // replaceTrack(null). Explicitly setting the transceiver direction
        // overrides this — the browser will then emit sendrecv or sendonly.
        pc.getTransceivers().forEach(tc => {
            if (tc.stopped) return;
            if (tc.direction === 'inactive' || tc.direction === 'recvonly') {
                tc.direction = 'sendrecv';
                console.log('[VV:renegotiate] corrected transceiver to sendrecv, mid=%s', tc.mid);
            }
        });

        const offer = await pc.createOffer();
        const videoDir = offer.sdp.match(/m=video[\s\S]*?a=(sendrecv|sendonly|recvonly|inactive)/)?.[1] || 'not found';
        console.log('[VV:renegotiate] offer created, direction=%s', videoDir);
        await pc.setLocalDescription(offer);

        await gRef.collection('signals').add({
            from: me,
            to:   uid,
            type: 'offer',
            sdp:  offer.sdp,
            ts:   firebase.firestore.FieldValue.serverTimestamp()
        });
        console.log('[VV:renegotiate] offer sent to Firestore for uid=%s', uid);
    } catch(e) { console.error('[VV:renegotiate] ERROR', e); }
}

// Look up which remote uid is associated with a given RTCPeerConnection
function _vvUidForPC(pc) {
    const pcMap = window._vvPCMap;
    if (pcMap) {
        const uid = pcMap.get(pc);
        if (uid) return uid;
        // Try to resolve now
        _vvSyncAllUIDs(pcMap);
        return pcMap.get(pc) || null;
    }
    return null;
}

async function _vvRemoveCameraTrack() {
    const promises = _vvLivePCs().map(async pc => {
        const vs = pc.getSenders().find(s => s.track && s.track.kind === 'video');
        if (vs) {
            await vs.replaceTrack(null).catch(() => {});
            // No renegotiation needed for replaceTrack(null) — track goes silent
            // but sender stays in SDP so remote doesn't tear down the receiver
        }
    });
    await Promise.all(promises);
}

async function _vvSetSenderBitrate(sender) {
    if (!sender || !sender.getParameters) return;
    // setParameters must be called in a fresh task after replaceTrack completes.
    // Calling it in the same microtask chain as replaceTrack causes
    // InvalidModificationError in Chromium. Use setTimeout(0) to defer.
    await new Promise(resolve => setTimeout(resolve, 0));
    try {
        const params = sender.getParameters();
        console.log('[VV:setBitrate] encodings count=%d', params?.encodings?.length);
        if (!params.encodings || !params.encodings.length) params.encodings = [{}];
        params.encodings[0].maxBitrate = VV_QUALITY[vvQuality].bitrate;
        params.encodings[0].active = true;
        await sender.setParameters(params);
        console.log('[VV:setBitrate] OK active=true maxBitrate=%d', VV_QUALITY[vvQuality].bitrate);
    } catch(e) { console.warn('[VV] setParameters failed', e); }
}

// Remote stream registry: uid → MediaStream
// Avoids creating orphaned hidden <video> elements that Chromium won't decode.
const _vvRemoteStreams = new Map();

// ── Remote video liveness helpers ────────────────────────────────────────
// Returns true only when the stream has at least one live (non-ended, non-muted) video track.
function _vvRemoteHasLiveVideo(uid) {
    const stream = _vvRemoteStreams.get(uid);
    if (!stream) return false;
    return stream.getVideoTracks().some(t => t.readyState !== 'ended' && !t.muted);
}

// Called when a remote peer's video goes away — clears their tile and shows avatar overlay.
function _vvHandleRemoteVideoLost(uid) {
    const vid = document.getElementById('vv-video-' + uid);
    const ov  = document.getElementById('vv-ov-'    + uid);
    _vvClearVideoEl(vid);
    if (ov) ov.className = 'vv-tile-overlay';  // visible, no --hidden
    _vvRenderVideoGrid();
}



function _vvAttachRemoteVideo(peerUid, stream) {
    console.log('[VV:attach] uid=%s streamId=%s tracks=%d', peerUid, stream.id, stream.getTracks().length);
    stream.getTracks().forEach(t => console.log('[VV:attach]   track kind=%s readyState=%s muted=%s id=%s', t.kind, t.readyState, t.muted, t.id));

    _vvRemoteStreams.set(peerUid, stream);

    _vvPartic()[peerUid] = _vvPartic()[peerUid] || {};
    _vvPartic()[peerUid].hasVideo = true;

    // Wire listeners so avatar overlay shows immediately when remote camera/screen goes off
    stream.getVideoTracks().forEach(track => {
        track.addEventListener('ended', () => {
            console.log('[VV] remote video track ended uid=%s', peerUid);
            _vvHandleRemoteVideoLost(peerUid);
        });
        track.addEventListener('mute', () => {
            console.log('[VV] remote video track muted uid=%s', peerUid);
            // Small delay — mute fires for brief interruptions; only hide if still muted
            setTimeout(() => { if (!_vvRemoteHasLiveVideo(peerUid)) _vvHandleRemoteVideoLost(peerUid); }, 400);
        });
        track.addEventListener('unmute', () => {
            console.log('[VV] remote video track unmuted uid=%s', peerUid);
            _vvRenderVideoGrid();
        });
    });

    const existingEl = document.getElementById('vv-video-' + peerUid);
    console.log('[VV:attach] existingEl=%s isConnected=%s', !!existingEl, existingEl?.isConnected);
    if (existingEl && existingEl.isConnected) {
        console.log('[VV:attach] calling _vvApplyStreamToEl directly');
        _vvApplyStreamToEl(existingEl, stream);
    }

    _vvRefreshGridTile(peerUid);
    _vvUpdateActiveSpeaker();
}

// Apply a stream to an already-in-DOM video element and force play().
// Apply a stream to an already-in-DOM video element and force play().
function _vvApplyStreamToEl(el, stream) {
    const streamChanged = el.srcObject !== stream;
    console.log('[VV:apply] el.id=%s isConnected=%s streamChanged=%s paused=%s tracks=%d',
        el.id, el.isConnected, streamChanged, el.paused, stream.getTracks().length);
    if (streamChanged) {
        // Abort any in-flight play() before changing srcObject.
        // Assigning srcObject while a play() promise is pending causes AbortError.
        el.pause();
        el.srcObject = stream;
    }
    el.style.display = 'block';
    if (streamChanged || el.paused) {
        console.log('[VV:apply] calling play()');
        el.play().then(() => {
            console.log('[VV:apply] play() resolved OK for', el.id);
        }).catch(err => {
            console.warn('[VV:apply] play() rejected:', err.name, err.message, 'el.id=', el.id);
        });
    } else {
        console.log('[VV:apply] skipping play() — same stream, not paused');
    }
}

// ─── Intercept RTCPeerConnection creation to patch ontrack ────────────────
// tasky-voice.js creates PCs via `new RTCPeerConnection(...)` — we shim the
// constructor so every new PC is immediately patched to also handle video
// tracks, without needing access to vcPeers (which is not on window).
//
// We also maintain window._vvPeersRef ourselves as a {uid: {pc}} map by
// observing the Firestore presence collection via the vc-participants DOM
// updates — concretely: whenever a new vc-p-card appears in the panel we
// search all live RTCPeerConnections we have intercepted to match it.
function _vvWatchPeers() {
    // pcMap: plain Map (iterable) — RTCPeerConnection → peerUid string
    // We use a plain Map (not WeakMap) so we can call .values() / .entries()
    const pcMap = new Map();   // Map<RTCPeerConnection, uid>
    window._vvPCMap = pcMap;   // expose for _vvUidForPC() and _vvLivePCs()
    if (!window._vvPeersRef) window._vvPeersRef = {};

    // Shim RTCPeerConnection — must run before tasky-voice.js creates any PC.
    // All scripts are `defer` and run in order, so tasky-video.js runs after
    // tasky-voice.js is parsed but before any call is made — the shim is in
    // place before _vcCreatePC() is ever called.
    const OrigPC = window.RTCPeerConnection;
    window.RTCPeerConnection = function(...args) {
        const pc = new OrigPC(...args);
        console.log('[VV:shim] new RTCPeerConnection created, total tracked=%d', (window._vvAllPCs?.size || 0) + 1);

        // Use addEventListener('track') — more reliable than shimming the ontrack
        // IDL property setter. Browsers dispatch track events via EventTarget
        // regardless of how ontrack is assigned, and renegotiation-added tracks
        // always arrive here even when the property shim is bypassed internally.
        pc.addEventListener('track', function(e) {
            console.log('[VV:track] kind=%s readyState=%s muted=%s streams=%d pcInMap=%s',
                e.track?.kind, e.track?.readyState, e.track?.muted,
                e.streams?.length, pcMap.has(pc));
            if (e.streams?.[0]) {
                console.log('[VV:track] e.streams[0] id=%s tracks=%d',
                    e.streams[0].id, e.streams[0].getTracks().length);
            }
            if (!e.track || e.track.kind !== 'video') return;

            const stream = new MediaStream([e.track]);
            console.log('[VV:track] VIDEO track received, built stream id=%s', stream.id);

            const doAttach = (uid) => {
                console.log('[VV:doAttach] uid=%s track.readyState=%s track.muted=%s', uid, e.track.readyState, e.track.muted);
                _vvAttachRemoteVideo(uid, stream);
            };

            const attachWhenReady = (uid) => {
                if (!uid) return;
                console.log('[VV:attachWhenReady] uid=%s readyState=%s muted=%s', uid, e.track.readyState, e.track.muted);
                doAttach(uid);
                if (e.track.muted) {
                    console.log('[VV:attachWhenReady] track muted — waiting for unmute event');
                    e.track.addEventListener('unmute', () => {
                        console.log('[VV:unmute] fired for uid=%s', uid);
                        doAttach(uid);
                    }, { once: true });
                }
            };

            const uid = pcMap.get(pc) || _vvResolveUID(pc, pcMap);
            console.log('[VV:track] resolved uid=%s', uid);
            if (uid) {
                attachWhenReady(uid);
            } else {
                console.warn('[VV:track] uid not resolved yet, starting retry loop');
                let retries = 0;
                const retry = () => {
                    const u = pcMap.get(pc) || _vvResolveUID(pc, pcMap);
                    console.log('[VV:retry] attempt=%d uid=%s', retries, u);
                    if (u) { attachWhenReady(u); return; }
                    if (++retries < 20) setTimeout(retry, 250);
                    else console.error('[VV] ontrack: FAILED to resolve uid after 20 retries');
                };
                setTimeout(retry, 100);
            }
        });

        // Track every PC in the set so _vvLivePCs() can find them
        if (!window._vvAllPCs) window._vvAllPCs = new Set();
        window._vvAllPCs.add(pc);

        // Try to resolve uid as soon as ICE starts connecting
        pc.addEventListener('iceconnectionstatechange', () => {
            if (!pcMap.has(pc)) _vvResolveUID(pc, pcMap);
        });

        // On every renegotiation completing (signalingState → stable), scan all
        // receivers for video tracks that are now live but weren't wired up.
        // This is necessary because ontrack fires only ONCE per track — on first
        // negotiation. When a blanked sender is reactivated via replaceTrack +
        // renegotiate, the remote's receiver track already exists from the original
        // negotiation; it just goes from muted→unmuted. ontrack never re-fires.
        pc.addEventListener('signalingstatechange', () => {
            if (pc.signalingState !== 'stable') return;
            _vvSyncAllUIDs(pcMap);

            const uid = pcMap.get(pc);
            if (!uid) return;

            pc.getReceivers().forEach(receiver => {
                const track = receiver.track;
                if (!track || track.kind !== 'video') return;

                console.log('[VV:sigstate→stable] receiver video track readyState=%s muted=%s uid=%s', track.readyState, track.muted, uid);

                // Reuse existing stream if this track is already registered —
                // avoids creating a new MediaStream object on every renegotiation
                // (audio-only renegotiations also trigger stable) which would cause
                // repeated srcObject reassignments and AbortErrors.
                const existingStream = _vvRemoteStreams.get(uid);
                const trackAlreadyRegistered = existingStream?.getTracks().includes(track);
                if (trackAlreadyRegistered && !track.muted) {
                    console.log('[VV:sigstate→stable] track already registered and unmuted — skipping');
                    return;
                }

                const stream = existingStream && existingStream.getTracks().includes(track)
                    ? existingStream
                    : new MediaStream([track]);

                const doAttach = () => {
                    console.log('[VV:sigstate→stable] attaching uid=%s muted=%s', uid, track.muted);
                    _vvAttachRemoteVideo(uid, stream);
                };

                doAttach();
                if (track.muted) {
                    track.addEventListener('unmute', () => {
                        console.log('[VV:sigstate→stable:unmute] uid=%s', uid);
                        doAttach();
                    }, { once: true });
                }
            });
        });

        return pc;
    };
    window.RTCPeerConnection.prototype = OrigPC.prototype;
    Object.setPrototypeOf(window.RTCPeerConnection, OrigPC);

    // Periodic sync: match PCs to uids via audio element presence
    setInterval(() => _vvSyncAllUIDs(pcMap), 900);
}

// _vvResolveUID: try to map one PC to a uid right now; returns uid or null
function _vvResolveUID(pc, pcMap) {
    _vvSyncAllUIDs(pcMap || window._vvPCMap);
    return (pcMap || window._vvPCMap)?.get(pc) || null;
}

// _vvSyncAllUIDs: match every unresolved PC to a peer uid.
// Strategy: tasky-voice creates one <audio id="vc-audio-{uid}"> per peer
// and stores the remote stream on it.  We cross-reference receiver tracks
// to find which audio el's stream contains tracks from this PC.
function _vvSyncAllUIDs(pcMap) {
    if (!pcMap || !window._vvAllPCs) return;

    // Collect all known remote uids from audio elements
    const audioMap = new Map(); // uid → HTMLAudioElement
    document.querySelectorAll('[id^="vc-audio-"]').forEach(el => {
        const uid = el.id.slice('vc-audio-'.length);
        if (uid) audioMap.set(uid, el);
    });

    // Also pick up uids from kick buttons (rendered by tasky-voice for supervisor)
    document.querySelectorAll('.vc-kick-btn[data-uid]').forEach(el => {
        if (!audioMap.has(el.dataset.uid)) audioMap.set(el.dataset.uid, null);
    });

    // For each PC not yet in pcMap, try matching via receiver track → audio stream
    const livePCs = [...window._vvAllPCs].filter(pc => pc.signalingState !== 'closed');

    livePCs.forEach(pc => {
        if (pcMap.has(pc)) return;   // already resolved

        // Get all track ids this PC is receiving
        const receiverTrackIds = new Set(pc.getReceivers().map(r => r.track?.id).filter(Boolean));

        // Find audio element whose srcObject contains one of those tracks
        for (const [uid, el] of audioMap) {
            if (!el?.srcObject) continue;
            const streamTrackIds = new Set(el.srcObject.getTracks().map(t => t.id));
            const overlap = [...receiverTrackIds].some(id => streamTrackIds.has(id));
            if (overlap) {
                pcMap.set(pc, uid);
                if (!window._vvPeersRef) window._vvPeersRef = {};
                window._vvPeersRef[uid] = window._vvPeersRef[uid] || {};
                window._vvPeersRef[uid].pc = pc;
                break;
            }
        }

        // Fallback: if only one uid is unresolved and only one PC is unresolved, pair them
        if (!pcMap.has(pc)) {
            const mappedUids = new Set(pcMap.values());
            const freeUids   = [...audioMap.keys()].filter(u => !mappedUids.has(u));
            const freePCs    = livePCs.filter(p => !pcMap.has(p));
            if (freeUids.length === 1 && freePCs.length === 1) {
                pcMap.set(pc, freeUids[0]);
                if (!window._vvPeersRef) window._vvPeersRef = {};
                window._vvPeersRef[freeUids[0]] = window._vvPeersRef[freeUids[0]] || {};
                window._vvPeersRef[freeUids[0]].pc = pc;
            }
        }
    });

    // Remove closed PCs from the tracking set
    window._vvAllPCs.forEach(pc => {
        if (pc.signalingState === 'closed') {
            window._vvAllPCs.delete(pc);
            pcMap.delete(pc);
        }
    });
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

    // Local audio — clone so toggling mute/camera doesn't kill the recording track
    const ls = _vvLocalStream();
    if (ls) ls.getAudioTracks().forEach(t => tracks.push(t.clone()));

    // Local video — clone for the same reason
    const vid = vvCameraOn ? vvCameraStream : (vvScreenOn ? vvScreenStream : null);
    if (vid) vid.getVideoTracks().forEach(t => tracks.push(t.clone()));

    // Remote audio elements — capture via Web Audio + MediaStreamDestination
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    try { await ctx.resume(); } catch(e) {}
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
    const hasVideo = composite.getVideoTracks().length > 0;

    const mimeType = hasVideo
        ? MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
            ? 'video/webm;codecs=vp9,opus'
            : MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
            ? 'video/webm;codecs=vp8,opus'
            : 'video/webm'
        : MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
            ? 'audio/webm;codecs=opus'
            : 'audio/webm';

    try {
        vvMediaRecorder = new MediaRecorder(composite, { mimeType, videoBitsPerSecond: VV_QUALITY[vvQuality].bitrate });
    } catch(e) {
        try {
            vvMediaRecorder = new MediaRecorder(composite);
        } catch(e2) {
            ctx.close().catch(() => {});
            _vvToast('⚠️ Recording not supported in this browser'); return;
        }
    }

    vvRecordChunks    = [];
    vvRecordStartTime = Date.now();
    vvRecordMimeType  = vvMediaRecorder.mimeType || mimeType;
    vvRecording       = true;

    vvMediaRecorder.ondataavailable = e => { if (e.data.size > 0) vvRecordChunks.push(e.data); };
    vvMediaRecorder.onstop = () => {
        if (vvRecordResolve) vvRecordResolve();
        vvRecordResolve = null;
        _vvSaveRecording(ctx);
    };

    vvMediaRecorder.start(100); // 100ms timeslice so short recordings still produce data
    vvRecordInterval = setInterval(_vvUpdateRecordTimer, 1000);

    _vvUpdateVideoControls();
    _vvToast('⏺️ Recording started');
}

function _vvStopRecording() {
    if (!vvMediaRecorder || !vvRecording) return Promise.resolve();
    vvRecording = false;
    clearInterval(vvRecordInterval); vvRecordInterval = null;
    const done = new Promise(resolve => { vvRecordResolve = resolve; });
    vvMediaRecorder.stop();
    _vvUpdateVideoControls();
    _vvToast('⏹️ Processing recording…');
    return done;
}

async function _vvSaveRecording(ctx) {
    if (ctx) ctx.close().catch(() => {});
    const blob = new Blob(vvRecordChunks, { type: vvRecordMimeType || 'video/webm' });
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
        _vvClosePiP(); _vvToast('📺 PiP closed'); return;
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
                <button class="vv-ctrl" id="vv-btn-quality"title="HD/SD"><svg viewBox="0 0 24 24" width="17" height="17"><rect x="2.5" y="5" width="19" height="14" rx="3" fill="currentColor"/><text x="12" y="16.5" text-anchor="middle" font-size="9" font-weight="800" fill="#fff">HD</text></svg></button>
                <button class="vv-ctrl" id="vv-btn-layout" title="Layout"><svg viewBox="0 0 24 24" width="17" height="17"><rect x="3" y="3" width="8" height="8" rx="1.5" fill="currentColor"/><rect x="13" y="3" width="8" height="8" rx="1.5" fill="currentColor"/><rect x="3" y="13" width="8" height="8" rx="1.5" fill="currentColor"/><rect x="13" y="13" width="8" height="8" rx="1.5" fill="currentColor"/></svg></button>
                <button class="vv-ctrl vv-ctrl--close" id="vv-btn-close" title="Close video panel">✕</button>
            </div>
        </div>
        <div class="vv-tiles" id="vv-tiles"></div>
        <div class="vv-grid-hint" id="vv-grid-hint">
            <span class="vv-grid-hint-icon">💡</span>
            <span><strong>Turn on your camera</strong> with 📷, or share your screen with 🖥️. Double-click any tile to fullscreen. Pin a speaker with 📍.</span>
        </div>`;

    document.body.appendChild(grid);
    vvVideoGrid = grid;

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

    // Grid class
    const gridClass = count <= 1 ? 'vv-tiles--1'
                    : count <= 2 ? 'vv-tiles--2'
                    : count <= 4 ? 'vv-tiles--4'
                    : 'vv-tiles--9';

    const featured = vvSpeakerUid || vvActiveSpeaker || me;

    tiles.className = `vv-tiles ${gridClass} ${vvLayout === 'speaker' ? 'vv-tiles--speaker' : ''}`;

    // Build ordered list of desired tiles
    const allTiles = [{ uid: me, isLocal: true, p: { handle: window.currentHandle || 'You', muted: false } }];
    entries.forEach(([uid, p]) => { if (uid !== me) allTiles.push({ uid, isLocal: false, p }); });
    if (vvLayout === 'speaker') {
        allTiles.sort((a, b) => (a.uid === featured ? -1 : b.uid === featured ? 1 : 0));
    }

    // ── Reconcile: reuse existing tile nodes, only create/remove what changed ──
    // This is critical: never wipe tiles.innerHTML while video elements are
    // playing — Chromium aborts play() and goes black when srcObject is removed
    // from a connected element.

    const desiredUids = new Set(allTiles.map(t => t.uid));

    // Remove tiles whose uid is no longer in the participant list
    [...tiles.children].forEach(child => {
        if (!desiredUids.has(child.dataset.uid)) child.remove();
    });

    // Insert / update tiles in the correct order
    allTiles.forEach(({ uid, isLocal, p }, idx) => {
        const isFeatured = vvLayout === 'speaker' && uid === featured;
        let tileEl = document.getElementById('vv-tile-' + uid);

        if (tileEl) {
            // Tile already exists — update mutable parts without touching video
            _vvUpdateTile(tileEl, uid, isLocal, p, isFeatured);
        } else {
            // New participant — build the full tile
            tileEl = _vvMakeTile(uid, isLocal, p, isFeatured);
        }

        // Ensure correct DOM order by moving if needed
        const currentAtIdx = tiles.children[idx];
        if (currentAtIdx !== tileEl) {
            tiles.insertBefore(tileEl, currentAtIdx || null);
        }
    });

    // Hide hint once tiles are populated
    const hintEl = document.getElementById('vv-grid-hint');
    if (hintEl) hintEl.style.display = allTiles.length > 0 ? 'none' : 'flex';

    // Label
    const label = document.getElementById('vv-grid-label');
    if (label) label.textContent = `Video · ${allTiles.length} ${allTiles.length === 1 ? 'person' : 'people'}`;

    // Rec badge
    const badge = document.getElementById('vv-rec-badge');
    if (badge) badge.style.display = vvRecording ? 'flex' : 'none';
}

// Update the mutable parts of an existing tile without touching its video element.
function _vvUpdateTile(tileEl, uid, isLocal, p, isFeatured) {
    const isSpeaking = p.speaking && !p.muted;
    tileEl.className = `vv-tile ${isFeatured ? 'vv-tile--featured' : ''} ${isSpeaking ? 'vv-tile--speaking' : ''}`;

    const hasVideo = isLocal ? (vvCameraOn || vvScreenOn) : _vvRemoteHasLiveVideo(uid);
    const handle   = p.handle || (isLocal ? (window.currentHandle || 'You') : uid.slice(0, 6));

    const ov = document.getElementById('vv-ov-' + uid);
    if (ov) ov.className = `vv-tile-overlay ${hasVideo ? 'vv-tile-overlay--hidden' : ''}`;

    const bar = tileEl.querySelector('.vv-tile-bar');
    if (bar) {
        bar.innerHTML = `<span class="vv-tile-handle">@${_vvEsc(handle)}${isLocal ? ' (you)' : ''}</span>
            <div class="vv-tile-icons">
                ${p.muted ? '<span title="Muted">🔇</span>' : ''}
                ${isLocal && (vvCameraOn || vvScreenOn) ? (vvScreenOn ? '<span title="Sharing screen">🖥️</span>' : '<span title="Camera on">📷</span>') : ''}
                ${!isLocal && hasVideo ? '<span title="Camera on">📷</span>' : ''}
            </div>`;
    }

    const pinBtn = tileEl.querySelector('.vv-pin-btn');
    if (pinBtn) pinBtn.textContent = vvSpeakerUid === uid ? '📌' : '📍';

    // For local tile: keep local video srcObject current
    if (isLocal) {
        const vid = document.getElementById('vv-local-video');
        if (vid) {
            if (!hasVideo) {
                _vvClearVideoEl(vid);
            } else {
                const newSrc = vvCameraOn ? vvCameraStream : vvScreenStream;
                if (vid.srcObject !== newSrc) {
                    vid.srcObject = newSrc;
                    vid.style.display = 'block';
                    vid.play().catch(err => { if (err.name !== 'NotAllowedError') console.warn('[VV] local play()', err); });
                } else {
                    vid.style.display = 'block';
                }
            }
        }
    } else {
        // For remote: wire stream if it arrived after the tile was first created
        const vid = document.getElementById('vv-video-' + uid);
        const stream = _vvRemoteStreams.get(uid);
        console.log('[VV:updateTile] uid=%s vid=%s stream=%s srcObjectSame=%s', uid, !!vid, !!stream, vid?.srcObject === stream);
        if (vid && stream && vid.srcObject !== stream) {
            console.log('[VV:updateTile] applying stream to existing element');
            _vvApplyStreamToEl(vid, stream);
        }
    }
}

function _vvMakeTile(uid, isLocal, p, isFeatured) {
    const tile = document.createElement('div');
    tile.className = `vv-tile ${isFeatured ? 'vv-tile--featured' : ''} ${p.speaking && !p.muted ? 'vv-tile--speaking' : ''}`;
    tile.dataset.uid = uid;
    tile.id = 'vv-tile-' + uid;

    const hasVideo = isLocal
        ? (vvCameraOn || vvScreenOn)
        : _vvRemoteHasLiveVideo(uid);

    const videoEl = _vvGetOrCreateVideoEl(uid, isLocal);

    tile.appendChild(videoEl);

    // For remote participants: apply the stream and call play() AFTER the tile
    // is in the live DOM. _vvRenderVideoGrid appends it synchronously right after
    // _vvMakeTile returns, so a microtask is sufficient.
    // Guard: only fire if (a) element is still connected, and (b) the stream
    // hasn't already been applied by _vvUpdateTile on a subsequent render that
    // ran before this microtask drained.
    if (!isLocal) {
        const stream = _vvRemoteStreams.get(uid);
        console.log('[VV:makeTile] uid=%s hasStream=%s videoElConnected=%s', uid, !!stream, videoEl.isConnected);
        if (stream) {
            Promise.resolve().then(() => {
                console.log('[VV:makeTile:microtask] uid=%s isConnected=%s srcObjectSame=%s', uid, videoEl.isConnected, videoEl.srcObject === stream);
                if (videoEl.isConnected && videoEl.srcObject !== stream) {
                    _vvApplyStreamToEl(videoEl, stream);
                }
            });
        }
    }

    // Avatar overlay (shown when no video)
    const ov = document.createElement('div');
    ov.className = `vv-tile-overlay ${hasVideo ? 'vv-tile-overlay--hidden' : ''}`;
    ov.id = 'vv-ov-' + uid;
    const handle = p.handle || (isLocal ? (window.currentHandle || 'You') : uid.slice(0,6));
    ov.innerHTML = `<div class="vv-tile-avatar">${_vvAvatarContent(uid, handle)}</div>
                    <div class="vv-tile-name">@${_vvEsc(handle)}${isLocal ? ' (you)' : ''}</div>
                    <div class="vv-tile-cam-off">Camera off</div>`;
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
    } else {
        // For remote tiles: stream is applied after the element is appended
        // to the live DOM in _vvMakeTile, via the _vvApplyStreamToEl call below.
        // Hide until stream arrives so the tile shows the avatar overlay instead.
        const stream = _vvRemoteStreams.get(uid);
        if (!stream) {
            el.style.display = 'none';
        }
        // stream application happens in _vvMakeTile after appendChild
    }
    return el;
}


// Fully clear a video element so no stale frame remains visible.
function _vvClearVideoEl(vid) {
    if (!vid) return;
    vid.style.display = 'none';   // hide first — no flash
    try { vid.pause(); } catch(e) {}
    vid.srcObject = null;
    try { vid.load(); } catch(e) {} // resets decoded frame buffer
}

function _vvRefreshLocalTile() {
    const tile = document.getElementById('vv-tile-' + _vvMe());
    const ov   = document.getElementById('vv-ov-' + _vvMe());
    const vid  = document.getElementById('vv-local-video');
    const hasVideo = vvCameraOn || vvScreenOn;
    if (vid) {
        if (!hasVideo) {
            // Clear completely — prevents last decoded frame from staying visible
            _vvClearVideoEl(vid);
        } else {
            const newSrc = vvCameraOn ? vvCameraStream : vvScreenStream;
            if (vid.srcObject !== newSrc) {
                vid.srcObject = newSrc;
                vid.style.display = 'block';
                vid.play().catch(err => { if (err.name !== 'NotAllowedError') console.warn('[VV] local play()', err); });
            } else {
                vid.style.display = 'block';
            }
        }
    }
    // Show/hide overlay — show first so there's no gap between video hiding and overlay appearing
    if (ov) ov.className = `vv-tile-overlay${hasVideo ? ' vv-tile-overlay--hidden' : ''}`;
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
    var qBtn = document.getElementById('vv-btn-quality');
    if (qBtn) {
        qBtn.className = 'vv-ctrl';
        var isHd = vvQuality === 'hd';
        qBtn.innerHTML = '<svg viewBox="0 0 24 24" width="17" height="17"><rect x="2.5" y="5" width="19" height="14" rx="3" fill="currentColor" opacity="' + (isHd ? '1' : '0.5') + '"/><text x="12" y="16.5" text-anchor="middle" font-size="9" font-weight="800" fill="#fff">' + (isHd ? 'HD' : 'SD') + '</text></svg>';
    }
    var lBtn = document.getElementById('vv-btn-layout');
    if (lBtn) {
        lBtn.className = 'vv-ctrl';
        lBtn.innerHTML = vvLayout === 'grid'
            ? '<svg viewBox="0 0 24 24" width="17" height="17"><rect x="3" y="3" width="8" height="8" rx="1.5" fill="currentColor"/><rect x="13" y="3" width="8" height="8" rx="1.5" fill="currentColor"/><rect x="3" y="13" width="8" height="8" rx="1.5" fill="currentColor"/><rect x="13" y="13" width="8" height="8" rx="1.5" fill="currentColor"/></svg>'
            : '<svg viewBox="0 0 24 24" width="17" height="17"><rect x="2" y="3" width="20" height="11" rx="2" fill="currentColor"/><rect x="2" y="16" width="9" height="5" rx="1.5" fill="currentColor"/><rect x="13" y="16" width="9" height="5" rx="1.5" fill="currentColor"/></svg>';
    }

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
    if (window.innerWidth < 768) return;
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
    if (window.innerWidth < 768) return;
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
async function _vvCleanup() {
    if (vvRecording) await _vvStopRecording();

    _vvClosePiP();

    if (vvCameraStream)  { vvCameraStream.getTracks().forEach(t => t.stop());  vvCameraStream  = null; }
    if (vvScreenStream)  { vvScreenStream.getTracks().forEach(t => t.stop());  vvScreenStream  = null; }

    vvCameraOn = false; vvScreenOn = false;

    // Remove all vv video elements and clear the stream registry
    _vvRemoteStreams.clear();
    document.querySelectorAll('[id^="vv-video-"]').forEach(el => { el.srcObject = null; el.remove(); });
    const lv = document.getElementById('vv-local-video');
    if (lv) { lv.srcObject = null; lv.remove(); }

    _vvHideVideoGrid();
    _vvUpdateVideoControls();
}

// ─── Patch vcJoin + vcLeave to bridge closed-over state vars ─────────────
// tasky-voice.js uses plain `let` vars (vcActive, vcPeers, vcParticipants,
// vcLocalStream) that are never exported to window.  We wrap the exported
// vcJoin / vcLeave functions to copy those refs into window._vv* bridges
// immediately after they are set inside tasky-voice.js's own closures.
//
// The trick: the exported functions capture the same vars by reference, so
// we can't read them directly — but we CAN observe side-effects:
//   • vcJoin sets vcActive = true  → we set window._vvCallActive = true
//   • vcLeave sets vcActive = false → cleanup then window._vvCallActive = false
//
// For vcPeers / vcParticipants / vcLocalStream we poll in _vvWatchPeers
// and set window._vv*Ref by looking at RTCPeerConnection instances that
// tasky-voice creates (visible as audio element srcObjects + the PC objects
// we intercept via the peer-watcher).  A simpler heuristic: after vcJoin
// resolves, the vc-panel #vc-participants has child elements — we don't
// need the raw object refs for our correctness check, only for _vvPeers()
// used in track-sender logic.  That function falls back gracefully to {}.
function _vvPatchVcLeave() {
    const origLeave = window.vcLeave;
    if (!origLeave) { setTimeout(_vvPatchVcLeave, 300); return; }

    // Wrap vcLeave
    window.vcLeave = async function() {
        window._vvCallActive = false;
        await _vvCleanup();
        return origLeave.apply(this, arguments);
    };

    // Also wrap vcJoin to set the active flag
    const origJoin = window.vcJoin;
    if (origJoin) {
        window.vcJoin = async function() {
            const result = await origJoin.apply(this, arguments);
            // After join, poll briefly until the panel appears = call confirmed live
            let tries = 0;
            const check = () => {
                if (document.getElementById('vc-panel')) {
                    window._vvCallActive = true;
                    // Inject the panel video button now that panel exists
                    _vvInjectPanelButton();
                } else if (++tries < 20) {
                    setTimeout(check, 150);
                }
            };
            check();
            return result;
        };
    }

    // Patch _vcAnswer to log the SDP direction for the incoming renegotiation offer
    const origAnswer = window._vcAnswer;
    if (origAnswer) {
        window._vcAnswer = async function(peerUid, sdp) {
            const videoDir = sdp.match(/m=video[\s\S]*?a=(sendrecv|sendonly|recvonly|inactive)/)?.[1] || 'no-video-mline';
            console.log('[VV:_vcAnswer] from=%s videoDir=%s', peerUid, videoDir);
            return origAnswer.apply(this, arguments);
        };
    }
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

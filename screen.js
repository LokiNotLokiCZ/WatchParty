/* ============================================================
   SCREEN SHARE
   Host broadcasts their screen over WebRTC to every viewer.
   Firebase Realtime Database is used only for signaling
   (who is live, offers/answers, ICE candidates) — the video
   itself flows peer-to-peer from the host to each viewer.

   Depends on globals from app.js: db, firebaseReady, isHost.
   app.js fires a "hostchange" event whenever host mode toggles.
   ============================================================ */
(function(){
  const emptyMsg = document.getElementById('screen-empty-msg');

  if(typeof firebaseReady === 'undefined' || !firebaseReady){
    emptyMsg.innerHTML = 'Sync not configured<br><b>Firebase is required for screen sharing.</b>';
    return;
  }

  const rtcConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };
  const MAX_VIDEO_BITRATE = 2500000; // ~2.5 Mbps per viewer, protects the host's upload

  const screenRef  = db.ref('rooms/brasla/screen');
  const liveRef    = screenRef.child('live');
  const viewersRef = screenRef.child('viewers');
  const signalsRef = screenRef.child('signals');

  const video       = document.getElementById('screen-video');
  const pill        = document.getElementById('screen-pill');
  const controls    = document.getElementById('screen-controls');
  const startBtn    = document.getElementById('screen-start-btn');
  const stopBtn     = document.getElementById('screen-stop-btn');
  const statusEl    = document.getElementById('screen-status');
  const viewerNote  = document.getElementById('screen-viewer-note');
  const retryBtn    = document.getElementById('screen-retry-btn');

  const canShare = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  const viewerId = 'v_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

  // host state
  let localStream = null;
  const hostPeers = {}; // viewerId -> { pc, unsubs: [] }

  // viewer state
  let viewerPc = null;
  let viewerUnsubs = [];
  let joinedSessionId = null;
  let connectionFailed = false;

  /* ---------------- helpers ---------------- */
  function descToPlain(d){ return { type: d.type, sdp: d.sdp }; }

  function sdpSafe(fn){
    try { fn(); } catch(e) { /* ignore */ }
  }

  function connectedCount(){
    return Object.values(hostPeers).filter(p => p.pc.connectionState === 'connected').length;
  }

  /* ---------------- UI ---------------- */
  function renderUI(){
    const sharing  = !!localStream;
    const watching = !isHost && !!video.srcObject;

    controls.style.display = isHost ? 'flex' : 'none';
    startBtn.style.display = (isHost && !sharing) ? 'inline-block' : 'none';
    stopBtn.style.display  = (isHost && sharing)  ? 'inline-block' : 'none';

    if(isHost){
      statusEl.textContent = sharing
        ? 'Sharing — ' + connectedCount() + ' viewer(s) connected.'
        : (canShare ? 'Not sharing.' : 'This browser cannot share a screen (try desktop Chrome, Edge or Firefox).');
    }

    const showVideo = sharing || watching;
    video.style.display = showVideo ? 'block' : 'none';
    emptyMsg.style.display = showVideo ? 'none' : 'block';
    emptyMsg.textContent = isHost ? 'Press "Start sharing screen" to go live' : 'Nobody is sharing right now';
    video.controls = !isHost;

    if(sharing){
      pill.textContent = 'live';
      pill.className = 'sync-pill is-live';
    } else if(watching){
      pill.textContent = 'watching';
      pill.className = 'sync-pill is-watching';
    } else {
      pill.textContent = 'offline';
      pill.className = 'sync-pill';
    }

    if(!isHost){
      if(connectionFailed){
        viewerNote.style.display = 'block';
        viewerNote.textContent = 'Connection to the host failed. Press Reconnect to try again.';
      } else if(watching){
        viewerNote.style.display = 'block';
        viewerNote.textContent = 'Playing muted — use the video controls to unmute or go fullscreen.';
      } else {
        viewerNote.style.display = 'block';
        viewerNote.textContent = 'The picture appears here automatically as soon as the host starts sharing.';
      }
      retryBtn.style.display = connectionFailed ? 'inline-block' : 'none';
    } else {
      viewerNote.style.display = 'none';
      retryBtn.style.display = 'none';
    }
  }

  /* ---------------- HOST ---------------- */
  function closeHostPeer(id){
    const peer = hostPeers[id];
    if(!peer) return;
    peer.unsubs.forEach(f => sdpSafe(f));
    sdpSafe(() => peer.pc.close());
    delete hostPeers[id];
    signalsRef.child(id).remove();
    renderUI();
  }

  function onViewerAdded(snap){
    const id = snap.key;
    if(hostPeers[id] || !localStream) return;

    const pc = new RTCPeerConnection(rtcConfig);
    const unsubs = [];
    hostPeers[id] = { pc, unsubs };

    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

    // cap video bitrate so the host's upload survives several viewers
    pc.getSenders().forEach(sender => {
      if(sender.track && sender.track.kind === 'video'){
        const params = sender.getParameters();
        if(!params.encodings || !params.encodings.length) params.encodings = [{}];
        params.encodings[0].maxBitrate = MAX_VIDEO_BITRATE;
        sender.setParameters(params).catch(() => {});
      }
    });

    const sigRef = signalsRef.child(id);

    pc.onicecandidate = e => {
      if(e.candidate) sigRef.child('hostCandidates').push(e.candidate.toJSON());
    };
    pc.onconnectionstatechange = () => {
      if(pc.connectionState === 'failed' || pc.connectionState === 'closed'){
        closeHostPeer(id);
      } else {
        renderUI();
      }
    };

    // viewer's answer + candidates (buffer candidates until the answer is applied)
    const pending = [];
    const answerRef = sigRef.child('answer');
    const onAnswer = async s => {
      const answer = s.val();
      if(!answer || pc.currentRemoteDescription) return;
      try {
        await pc.setRemoteDescription(answer);
        pending.splice(0).forEach(c => pc.addIceCandidate(c).catch(() => {}));
      } catch(e) { console.error('setRemoteDescription failed', e); }
    };
    answerRef.on('value', onAnswer);
    unsubs.push(() => answerRef.off('value', onAnswer));

    const candRef = sigRef.child('viewerCandidates');
    const onCand = s => {
      const c = s.val();
      if(!c) return;
      if(pc.remoteDescription) pc.addIceCandidate(c).catch(() => {});
      else pending.push(c);
    };
    candRef.on('child_added', onCand);
    unsubs.push(() => candRef.off('child_added', onCand));

    pc.createOffer()
      .then(offer => pc.setLocalDescription(offer))
      .then(() => sigRef.child('offer').set(descToPlain(pc.localDescription)))
      .catch(err => console.error('createOffer failed', err));
  }

  function onViewerRemoved(snap){
    closeHostPeer(snap.key);
  }

  async function startSharing(){
    if(!isHost || localStream) return;
    if(!canShare){
      alert('This browser cannot share a screen. Use desktop Chrome, Edge or Firefox.');
      return;
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 30 } },
        audio: true
      });
    } catch(e) {
      return; // user cancelled the picker
    }

    localStream = stream;
    const vTrack = stream.getVideoTracks()[0];
    if(vTrack){
      try { vTrack.contentHint = 'motion'; } catch(e) {}
      vTrack.addEventListener('ended', stopSharing); // browser's own "Stop sharing" bar
    }

    video.srcObject = stream;
    video.muted = true; // never play your own audio back to yourself

    const sessionId = 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await signalsRef.remove();
    await viewersRef.remove();
    await liveRef.set({ active: true, sessionId, startedAt: firebase.database.ServerValue.TIMESTAMP });
    liveRef.onDisconnect().set({ active: false });

    viewersRef.on('child_added', onViewerAdded);
    viewersRef.on('child_removed', onViewerRemoved);
    renderUI();
  }

  function stopSharing(){
    if(!localStream) return;
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;

    viewersRef.off('child_added', onViewerAdded);
    viewersRef.off('child_removed', onViewerRemoved);
    Object.keys(hostPeers).forEach(closeHostPeer);

    liveRef.onDisconnect().cancel();
    liveRef.set({ active: false });
    signalsRef.remove();
    viewersRef.remove();

    video.srcObject = null;
    renderUI();
  }

  startBtn.addEventListener('click', startSharing);
  stopBtn.addEventListener('click', stopSharing);

  /* ---------------- VIEWER ---------------- */
  async function joinStream(sessionId){
    joinedSessionId = sessionId;
    connectionFailed = false;

    const sigRef = signalsRef.child(viewerId);
    await sigRef.remove();
    if(joinedSessionId !== sessionId) return; // left while we were cleaning up

    const pc = new RTCPeerConnection(rtcConfig);
    viewerPc = pc;
    const pending = [];

    pc.ontrack = e => {
      if(video.srcObject !== e.streams[0]) video.srcObject = e.streams[0];
      video.play().catch(() => {});
      connectionFailed = false;
      renderUI();
    };
    pc.onicecandidate = e => {
      if(e.candidate) sigRef.child('viewerCandidates').push(e.candidate.toJSON());
    };
    pc.onconnectionstatechange = () => {
      if(pc.connectionState === 'failed'){
        connectionFailed = true;
        renderUI();
      }
    };

    const offerRef = sigRef.child('offer');
    const onOffer = async s => {
      const offer = s.val();
      if(!offer || pc.remoteDescription) return;
      try {
        await pc.setRemoteDescription(offer);
        pending.splice(0).forEach(c => pc.addIceCandidate(c).catch(() => {}));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await sigRef.child('answer').set(descToPlain(pc.localDescription));
      } catch(err) {
        console.error('Answering offer failed', err);
        connectionFailed = true;
        renderUI();
      }
    };
    offerRef.on('value', onOffer);
    viewerUnsubs.push(() => offerRef.off('value', onOffer));

    const candRef = sigRef.child('hostCandidates');
    const onCand = s => {
      const c = s.val();
      if(!c) return;
      if(pc.remoteDescription) pc.addIceCandidate(c).catch(() => {});
      else pending.push(c);
    };
    candRef.on('child_added', onCand);
    viewerUnsubs.push(() => candRef.off('child_added', onCand));

    // announce ourselves — the host answers by creating an offer for us
    const me = viewersRef.child(viewerId);
    me.onDisconnect().remove();
    sigRef.onDisconnect().remove();
    me.set({ joinedAt: firebase.database.ServerValue.TIMESTAMP });
    renderUI();
  }

  function leaveStream(){
    viewerUnsubs.forEach(f => sdpSafe(f));
    viewerUnsubs = [];
    if(viewerPc){ sdpSafe(() => viewerPc.close()); viewerPc = null; }
    if(!localStream) video.srcObject = null;

    if(joinedSessionId){
      const me = viewersRef.child(viewerId);
      const sig = signalsRef.child(viewerId);
      me.onDisconnect().cancel();
      sig.onDisconnect().cancel();
      me.remove();
      sig.remove();
    }
    joinedSessionId = null;
    connectionFailed = false;
    renderUI();
  }

  function handleLive(live){
    if(isHost){ renderUI(); return; }
    if(live && live.active){
      if(joinedSessionId !== live.sessionId){
        leaveStream();
        joinStream(live.sessionId);
      }
    } else {
      leaveStream();
    }
  }

  retryBtn.addEventListener('click', () => {
    liveRef.once('value').then(s => {
      leaveStream();
      const live = s.val();
      if(live && live.active) joinStream(live.sessionId);
    });
  });

  /* ---------------- wiring ---------------- */
  document.addEventListener('hostchange', () => {
    if(isHost){
      leaveStream();
    } else {
      if(localStream) stopSharing();
      liveRef.once('value').then(s => handleLive(s.val()));
    }
    renderUI();
  });

  window.addEventListener('beforeunload', () => {
    if(localStream) liveRef.set({ active: false });
  });

  liveRef.on('value', snap => handleLive(snap.val()));
  renderUI();
})();

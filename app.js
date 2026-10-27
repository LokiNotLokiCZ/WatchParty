/* ============================================================
   CONFIG — edit these before deploying
   ============================================================ */
const CHANNEL = "brasla_";
const PARENT_DOMAINS = ["localhost", "127.0.0.1", window.location.hostname].filter(Boolean);
const UNIQUE_PARENTS = [...new Set(PARENT_DOMAINS)];

// NOTE: the host passcode is no longer in this file. It lives in the Vercel
// environment variable HOST_PASSCODE and is checked by /api/host-login.

// Fill this in with your Firebase project's web config (see setup steps).
// Get it from: Firebase Console -> Project settings -> General -> Your apps -> SDK setup and config
const firebaseConfig = {
  apiKey: "AIzaSyDOMImmROfhht_wJh5hpL92BL-i5TGs32Q",
  authDomain: "watchparty-d24f6.firebaseapp.com",
  databaseURL: "https://watchparty-d24f6-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "watchparty-d24f6",
  storageBucket: "watchparty-d24f6.firebasestorage.app",
  messagingSenderId: "725036907885",
  appId: "1:725036907885:web:4635194bd6dd4429b2ee64"
};

/* ============================================================
   FIREBASE INIT
   ============================================================ */
let db = null;
let stateRef = null;
let firebaseReady = false;
let auth = null;

try {
  firebase.initializeApp(firebaseConfig);
  auth = firebase.auth();
  db = firebase.database();
  stateRef = db.ref('rooms/brasla/state');
  firebaseReady = true;
} catch (err) {
  console.error('Firebase failed to init — sync disabled until firebaseConfig is filled in.', err);
}

/* ============================================================
   CLOCK
   ============================================================ */
function tickClock(){
  const d = new Date();
  document.getElementById('clock').textContent = d.toLocaleTimeString('cs-CZ', {hour12:false});
}
tickClock();
setInterval(tickClock, 1000);

/* ============================================================
   TWITCH STREAM + CHAT
   ============================================================ */
new Twitch.Embed("twitch-embed", {
  channel: CHANNEL,
  parent: UNIQUE_PARENTS,
  width: "100%",
  height: "100%",
  layout: "video",
  autoplay: false
});

const chatParents = UNIQUE_PARENTS.map(p => `parent=${encodeURIComponent(p)}`).join('&');
document.getElementById('twitch-chat').src =
  `https://www.twitch.tv/embed/${CHANNEL}/chat?darkpopout&${chatParents}`;

/* ============================================================
   HOST MODE
   ============================================================ */
let isHost = false;

function applyHostUI(){
  document.getElementById('host-btn').textContent = isHost ? 'HOST ✓' : 'HOST';
  document.getElementById('host-btn').classList.toggle('active', isHost);
  document.getElementById('film-controls').style.display = isHost ? 'flex' : 'none';
  document.getElementById('viewer-note').style.display = isHost ? 'none' : 'block';
  document.getElementById('sync-pill').textContent = isHost ? 'host' : 'viewer';
  document.getElementById('sync-pill').classList.toggle('is-host', isHost);
  document.dispatchEvent(new CustomEvent('hostchange'));
}

/* ------------------------------------------------------------
   Authentication
   Everyone signs in anonymously (so the database can require a login).
   The host additionally signs in with a custom token minted by
   /api/host-login after the passcode is verified ON THE SERVER.
   Host rights are a signed claim (token.host === true) that the Firebase
   security rules check — they cannot be faked from the browser.
   ------------------------------------------------------------ */
let authResolve;
const authReady = new Promise(res => { authResolve = res; });

async function refreshHostFlag(user){
  let host = false;
  try {
    const t = await user.getIdTokenResult();
    host = t.claims && t.claims.host === true;
  } catch(e) {}
  const changed = host !== isHost;
  isHost = host;
  if(isHost) playbackUnlocked = true;
  if(changed || !authReady.resolved){ applyHostUI(); }
}

if(firebaseReady){
  auth.onAuthStateChanged(async user => {
    if(!user){
      try { await auth.signInAnonymously(); } catch(e) { console.error('Anonymous sign-in failed — enable Anonymous in Firebase Authentication.', e); authResolve(); }
      return;
    }
    await refreshHostFlag(user);
    authReady.resolved = true;
    authResolve();
  });
} else {
  authResolve();
}

const hostModal = document.getElementById('host-modal');
const hostForm = document.getElementById('host-form');
const hostPass = document.getElementById('host-pass');
const hostError = document.getElementById('host-error');
const hostSubmit = document.getElementById('host-submit');

function openHostModal(){
  hostError.textContent = '';
  hostPass.value = '';
  hostModal.hidden = false;
  setTimeout(() => hostPass.focus(), 30);
}
function closeHostModal(){ hostModal.hidden = true; hostPass.value = ''; }

document.getElementById('host-btn').addEventListener('click', async function(){
  if(!firebaseReady) return;
  if(isHost){
    // Leave host mode: switch straight to a fresh anonymous user (no gap without auth).
    try { await auth.signInAnonymously(); } catch(e) { console.error(e); }
    return;
  }
  openHostModal();
});
document.getElementById('host-cancel').addEventListener('click', closeHostModal);
hostModal.addEventListener('click', e => { if(e.target === hostModal) closeHostModal(); });
document.addEventListener('keydown', e => { if(e.key === 'Escape' && !hostModal.hidden) closeHostModal(); });

hostForm.addEventListener('submit', async function(e){
  e.preventDefault();
  const entered = hostPass.value;
  if(!entered) return;
  hostSubmit.disabled = true;
  hostError.textContent = '';
  try {
    const res = await fetch('/api/host-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: entered })
    });
    if(res.status === 429){ hostError.textContent = 'Příliš mnoho pokusů. Zkus to za pár minut.'; }
    else if(res.status === 501){ hostError.textContent = 'Server ještě není nastavený (chybí proměnné ve Vercelu).'; }
    else if(!res.ok){ hostError.textContent = 'Špatné heslo.'; }
    else {
      const data = await res.json();
      await auth.signInWithCustomToken(data.token);
      closeHostModal();
    }
  } catch(err) {
    console.error(err);
    hostError.textContent = 'Přihlášení se nepovedlo. Zkontroluj připojení.';
  } finally {
    hostSubmit.disabled = false;
  }
});
applyHostUI();

/* ============================================================
   FILM PLAYER — local playback (both host and viewer use these
   elements; host also writes state, viewer only reacts to it)
   ============================================================ */
const filmVideo = document.getElementById('film-video');
const filmYtBox = document.getElementById('film-yt');
const filmEmpty = document.getElementById('film-empty-msg');
const filmTitleDisplay = document.getElementById('film-title-display');
const filmUrlInput = document.getElementById('film-url');

let ytPlayer = null;
let ytReady = false;
let currentSourceType = null; // 'mp4' | 'youtube' | null
let suppressLocalEvents = false; // true while we're programmatically applying remote state
let playbackUnlocked = isHost; // viewers need a click first; host always allowed (they trigger play directly)
const joinBtn = document.getElementById('join-playback-btn');

function showJoinButtonIfNeeded(){
  if(isHost || playbackUnlocked) { joinBtn.style.display = 'none'; return; }
  joinBtn.style.display = 'block';
}

joinBtn.addEventListener('click', function(){
  playbackUnlocked = true;
  joinBtn.style.display = 'none';
  // A real click on this button counts as a user gesture, which "unlocks" this
  // page to allow script-triggered play() for the rest of the session.
  if(currentSourceType === 'mp4'){
    filmVideo.play().then(() => {
      // Immediately re-apply the latest known state now that we're unlocked.
      if(firebaseReady) stateRef.once('value').then(snap => applyRemoteState(snap.val()));
    }).catch(() => {});
  } else if(currentSourceType === 'youtube' && ytPlayer){
    ytPlayer.playVideo();
    if(firebaseReady) stateRef.once('value').then(snap => applyRemoteState(snap.val()));
  }
});

function extractYouTubeId(url){
  const m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
  return m ? m[1] : null;
}

window.onYouTubeIframeAPIReady = function(){
  ytReady = true;
};

function resetFilmStage(writeToFirebase){
  filmVideo.pause();
  filmVideo.removeAttribute('src');
  filmVideo.load();
  filmVideo.style.display = 'none';
  if(ytPlayer){
    try { ytPlayer.stopVideo(); } catch(e){}
  }
  filmYtBox.style.display = 'none';
  filmEmpty.style.display = 'block';
  filmTitleDisplay.textContent = '';
  currentSourceType = null;
  if(writeToFirebase && isHost && firebaseReady){
    stateRef.set({ source: null, isPlaying: false, position: 0, updatedAt: firebase.database.ServerValue.TIMESTAMP });
  }
}

function ensureYtPlayer(videoId, cb){
  filmVideo.style.display = 'none';
  filmYtBox.style.display = 'block';
  if(!ytReady){
    setTimeout(() => ensureYtPlayer(videoId, cb), 200);
    return;
  }
  if(ytPlayer){
    ytPlayer.loadVideoById(videoId);
    if(cb) cb();
    return;
  }
  ytPlayer = new YT.Player('film-yt', {
    videoId: videoId,
    playerVars: { rel: 0, playsinline: 1, enablejsapi: 1 },
    events: {
      onReady: () => { if(cb) cb(); },
      onStateChange: onYtStateChange
    }
  });
}

function onYtStateChange(e){
  if(suppressLocalEvents || !isHost || !firebaseReady) return;
  // 1 = playing, 2 = paused
  if(e.data === 1){
    writePlaybackState(true, ytPlayer.getCurrentTime());
  } else if(e.data === 2){
    writePlaybackState(false, ytPlayer.getCurrentTime());
  }
}

function isSafeHttpsUrl(url){
  return typeof url === 'string' && url.length <= 2000 && /^https:\/\/[^\s]+$/i.test(url);
}

function loadFilmFromUrl(url, writeToFirebase){
  if(!url) return;
  const ytId = extractYouTubeId(url);
  if(!ytId && !isSafeHttpsUrl(url)){
    alert('Only secure links are allowed: use an https:// video URL or a YouTube link.');
    return;
  }
  filmEmpty.style.display = 'none';

  if(ytId){
    currentSourceType = 'youtube';
    ensureYtPlayer(ytId, () => { filmTitleDisplay.textContent = 'YouTube source loaded'; });
  } else {
    currentSourceType = 'mp4';
    filmYtBox.style.display = 'none';
    if(ytPlayer){ try { ytPlayer.stopVideo(); } catch(e){} }
    filmVideo.style.display = 'block';
    filmVideo.src = url;
    filmTitleDisplay.textContent = 'Direct video source loaded';
  }

  if(writeToFirebase && isHost && firebaseReady){
    stateRef.update({
      source: ytId ? { type: 'youtube', youtubeId: ytId } : { type: 'mp4', url: url },
      isPlaying: false,
      position: 0,
      updatedAt: firebase.database.ServerValue.TIMESTAMP
    });
  }
}

function writePlaybackState(isPlaying, position){
  if(!isHost || !firebaseReady) return;
  stateRef.update({ isPlaying, position, updatedAt: firebase.database.ServerValue.TIMESTAMP });
}

/* Host-side controls */
document.getElementById('film-load-url').addEventListener('click', function(){
  loadFilmFromUrl(filmUrlInput.value.trim(), true);
});
filmUrlInput.addEventListener('keydown', function(e){
  if(e.key === 'Enter') loadFilmFromUrl(filmUrlInput.value.trim(), true);
});

document.getElementById('film-file').addEventListener('change', function(e){
  const file = e.target.files[0];
  if(!file) return;
  const objectUrl = URL.createObjectURL(file);
  currentSourceType = 'mp4';
  filmEmpty.style.display = 'none';
  filmYtBox.style.display = 'none';
  if(ytPlayer){ try { ytPlayer.stopVideo(); } catch(e){} }
  filmVideo.style.display = 'block';
  filmVideo.src = objectUrl;
  filmTitleDisplay.textContent = file.name + ' (local only — not synced)';
  // Deliberately NOT written to Firebase: a blob URL only exists in this browser.
});

document.getElementById('film-clear').addEventListener('click', function(){
  filmUrlInput.value = '';
  resetFilmStage(true);
});

filmVideo.addEventListener('play', function(){
  if(suppressLocalEvents) return;
  writePlaybackState(true, filmVideo.currentTime);
});
filmVideo.addEventListener('pause', function(){
  if(suppressLocalEvents) return;
  writePlaybackState(false, filmVideo.currentTime);
});
filmVideo.addEventListener('seeked', function(){
  if(suppressLocalEvents) return;
  writePlaybackState(!filmVideo.paused, filmVideo.currentTime);
});

/* Host periodic drift-correction tick */
setInterval(function(){
  if(!isHost || !firebaseReady) return;
  if(currentSourceType === 'mp4' && !filmVideo.paused){
    writePlaybackState(true, filmVideo.currentTime);
  } else if(currentSourceType === 'youtube' && ytPlayer && ytPlayer.getPlayerState && ytPlayer.getPlayerState() === 1){
    writePlaybackState(true, ytPlayer.getCurrentTime());
  }
}, 5000);

/* ============================================================
   VIEWER SYNC — apply host's state to this browser's player
   ============================================================ */
function applyRemoteState(state){
  if(!state || isHost) return;
  suppressLocalEvents = true;

  if(!state.source){
    resetFilmStage(false);
    suppressLocalEvents = false;
    return;
  }

  const wantType = state.source.type;
  // Never trust remote data blindly: only accept https video URLs / plain YouTube ids.
  if(wantType === 'mp4' && !isSafeHttpsUrl(state.source.url)) { suppressLocalEvents = false; return; }
  if(wantType === 'youtube' && !/^[A-Za-z0-9_-]{6,20}$/.test(state.source.youtubeId || '')) { suppressLocalEvents = false; return; }
  if(wantType !== 'mp4' && wantType !== 'youtube') { suppressLocalEvents = false; return; }
  const needsLoad =
    (wantType === 'mp4' && (currentSourceType !== 'mp4' || filmVideo.src !== state.source.url)) ||
    (wantType === 'youtube' && currentSourceType !== 'youtube');

  const applyPlayback = () => {
    const elapsed = state.updatedAt ? (Date.now() - state.updatedAt) / 1000 : 0;
    const targetPos = state.position + (state.isPlaying ? Math.max(elapsed, 0) : 0);

    if(state.isPlaying && !playbackUnlocked){
      showJoinButtonIfNeeded();
      setTimeout(() => { suppressLocalEvents = false; }, 300);
      return;
    }
    joinBtn.style.display = 'none';

    if(wantType === 'mp4'){
      if(Math.abs(filmVideo.currentTime - targetPos) > 1.5){
        filmVideo.currentTime = targetPos;
      }
      if(state.isPlaying) filmVideo.play().catch(() => showJoinButtonIfNeeded());
      else filmVideo.pause();
    } else if(wantType === 'youtube' && ytPlayer){
      ytPlayer.getCurrentTime && Promise.resolve(ytPlayer.getCurrentTime()).then(cur => {
        if(Math.abs(cur - targetPos) > 1.5) ytPlayer.seekTo(targetPos, true);
      });
      if(state.isPlaying) ytPlayer.playVideo();
      else ytPlayer.pauseVideo();
    }
    setTimeout(() => { suppressLocalEvents = false; }, 300);
  };

  if(needsLoad){
    filmEmpty.style.display = 'none';
    if(wantType === 'mp4'){
      currentSourceType = 'mp4';
      filmYtBox.style.display = 'none';
      filmVideo.style.display = 'block';
      filmVideo.src = state.source.url;
      filmTitleDisplay.textContent = 'Direct video source loaded';
      filmVideo.addEventListener('loadedmetadata', applyPlayback, { once: true });
    } else if(wantType === 'youtube'){
      currentSourceType = 'youtube';
      ensureYtPlayer(state.source.youtubeId, () => {
        filmTitleDisplay.textContent = 'YouTube source loaded';
        applyPlayback();
      });
    }
  } else {
    applyPlayback();
  }
}

if(firebaseReady){
  authReady.then(() => stateRef.on('value', snap => applyRemoteState(snap.val())));
} else {
  filmEmpty.innerHTML = 'Sync not configured yet<br><b>Fill in firebaseConfig in app.js to enable syncing.</b>';
}

/* ============================================================
   DRAGGABLE / CLOSABLE PANELS
   ============================================================ */
const workspace = document.getElementById('workspace');
const tray = document.getElementById('panel-tray');
const panels = Array.from(document.querySelectorAll('.panel'));
const isSmallScreen = () => window.innerWidth < 900;

function loadPanelLayout(){
  try { return JSON.parse(localStorage.getItem('wp_panelLayout_v2') || '{}'); }
  catch(e){ return {}; }
}
function savePanelLayout(layout){
  localStorage.setItem('wp_panelLayout_v2', JSON.stringify(layout));
}

function initPanelPosition(panel, defaultX, defaultY){
  if(isSmallScreen()) return;
  const layout = loadPanelLayout();
  const id = panel.dataset.panel;
  const pos = layout[id];
  panel.style.left = (pos ? pos.x : defaultX) + 'px';
  panel.style.top = (pos ? pos.y : defaultY) + 'px';
  if(pos && pos.width) panel.style.width = pos.width + 'px';
  if(pos && pos.height) panel.style.height = pos.height + 'px';
}

initPanelPosition(document.getElementById('panel-twitch'), 20, 20);
initPanelPosition(document.getElementById('panel-film'), 860, 20);
initPanelPosition(document.getElementById('panel-screen'), 20, 560);

function makeDraggable(panel){
  const handle = panel.querySelector('[data-drag-handle]');
  let dragging = false, startX, startY, origX, origY;

  handle.addEventListener('pointerdown', function(e){
    if(isSmallScreen() || e.target.closest('.panel-close')) return;
    dragging = true;
    handle.setPointerCapture(e.pointerId);
    startX = e.clientX; startY = e.clientY;
    origX = panel.offsetLeft; origY = panel.offsetTop;
    panel.classList.add('dragging');
  });
  handle.addEventListener('pointermove', function(e){
    if(!dragging) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    let nx = origX + dx, ny = origY + dy;
    nx = Math.max(0, Math.min(nx, workspace.clientWidth - 80));
    ny = Math.max(0, Math.min(ny, workspace.clientHeight - 40));
    panel.style.left = nx + 'px';
    panel.style.top = ny + 'px';
  });
  handle.addEventListener('pointerup', function(e){
    if(!dragging) return;
    dragging = false;
    panel.classList.remove('dragging');
    const layout = loadPanelLayout();
    const id = panel.dataset.panel;
    layout[id] = { ...(layout[id] || {}), x: panel.offsetLeft, y: panel.offsetTop };
    savePanelLayout(layout);
  });
}
panels.forEach(makeDraggable);

/* Bring whichever panel was last interacted with to the front */
let topZ = 10;
function bringToFront(panel){
  topZ += 1;
  panel.style.zIndex = topZ;
}
panels.forEach(panel => {
  panel.style.zIndex = topZ;
  panel.addEventListener('pointerdown', () => bringToFront(panel));
});

document.getElementById('reset-layout-btn').addEventListener('click', function(){
  localStorage.removeItem('wp_panelLayout_v2');
  const twitch = document.getElementById('panel-twitch');
  const film = document.getElementById('panel-film');
  twitch.style.width = ''; twitch.style.height = '';
  const screen = document.getElementById('panel-screen');
  film.style.width = ''; film.style.height = '';
  screen.style.width = ''; screen.style.height = '';
  initPanelPosition(twitch, 20, 20);
  initPanelPosition(film, 860, 20);
  initPanelPosition(screen, 20, 560);
  bringToFront(twitch);
  bringToFront(film);
  bringToFront(screen);
});

function makeResizable(panel){
  const handles = panel.querySelectorAll('[data-resize-handle]');
  handles.forEach(handle => {
    const dir = handle.dataset.resizeHandle; // 'nw' | 'ne' | 'sw' | 'se'
    let resizing = false, startX, startY, startWidth, startHeight, startLeft, startTop;

    handle.addEventListener('pointerdown', function(e){
      if(isSmallScreen()) return;
      resizing = true;
      handle.setPointerCapture(e.pointerId);
      startX = e.clientX; startY = e.clientY;
      startWidth = panel.offsetWidth;
      startHeight = panel.offsetHeight;
      startLeft = panel.offsetLeft;
      startTop = panel.offsetTop;
      panel.classList.add('resizing');
      e.stopPropagation();
    });

    handle.addEventListener('pointermove', function(e){
      if(!resizing) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const isWest = dir === 'nw' || dir === 'sw';
      const isNorth = dir === 'nw' || dir === 'ne';

      let newWidth = isWest ? startWidth - dx : startWidth + dx;
      newWidth = Math.max(340, newWidth);

      let newLeft = startLeft;
      if(isWest){
        newLeft = startLeft + (startWidth - newWidth);
        newLeft = Math.max(0, newLeft);
      }
      newWidth = Math.min(newWidth, workspace.clientWidth - newLeft - 10);

      let newHeight = isNorth ? startHeight - dy : startHeight + dy;
      newHeight = Math.max(260, newHeight);

      let newTop = startTop;
      if(isNorth){
        newTop = startTop + (startHeight - newHeight);
        newTop = Math.max(0, newTop);
      }
      newHeight = Math.min(newHeight, workspace.clientHeight - newTop - 10);

      panel.style.width = newWidth + 'px';
      panel.style.height = newHeight + 'px';
      panel.style.left = newLeft + 'px';
      panel.style.top = newTop + 'px';
    });

    handle.addEventListener('pointerup', function(){
      if(!resizing) return;
      resizing = false;
      panel.classList.remove('resizing');
      const layout = loadPanelLayout();
      const id = panel.dataset.panel;
      layout[id] = {
        ...(layout[id] || {}),
        x: panel.offsetLeft,
        y: panel.offsetTop,
        width: panel.offsetWidth,
        height: panel.offsetHeight
      };
      savePanelLayout(layout);
    });
  });
}
panels.forEach(makeResizable);

function closePanel(id){
  const panel = document.getElementById('panel-' + id);
  panel.style.display = 'none';
  const chip = document.createElement('button');
  chip.className = 'tray-chip';
  const labels = { twitch: 'Stream', film: 'Film', chat: 'Chat', screen: 'Screen' };
  chip.textContent = (labels[id] || id) + ' — reopen';
  chip.dataset.reopen = id;
  chip.addEventListener('click', () => {
    panel.style.display = 'flex';
    chip.remove();
  });
  tray.appendChild(chip);
}

document.querySelectorAll('.panel-close').forEach(btn => {
  btn.addEventListener('click', () => closePanel(btn.dataset.close));
});

/* Chat sidebar toggle */
const chatSidebar = document.getElementById('chat-sidebar');
const chatTab = document.getElementById('chat-sidebar-tab');
const chatCloseBtn = document.getElementById('chat-sidebar-close');

function toggleChatSidebar(){
  chatSidebar.classList.toggle('closed');
}
// On phones the chat starts hidden (it is a bottom sheet there)
if(isSmallScreen()) chatSidebar.classList.add('closed');
chatTab.addEventListener('click', toggleChatSidebar);
chatCloseBtn.addEventListener('click', toggleChatSidebar);

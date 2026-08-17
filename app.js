/* ============================================================
   CONFIG — edit these before deploying
   ============================================================ */
const CHANNEL = "brasla_";
const PARENT_DOMAINS = ["localhost", "127.0.0.1", window.location.hostname].filter(Boolean);
const UNIQUE_PARENTS = [...new Set(PARENT_DOMAINS)];

// Change this passcode before deploying. Anyone with it can become host.
const HOST_PASSCODE = "brasla2026";

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

try {
  firebase.initializeApp(firebaseConfig);
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
let isHost = localStorage.getItem('wp_isHost') === '1';

function applyHostUI(){
  document.getElementById('host-btn').textContent = isHost ? 'HOST ✓' : 'HOST';
  document.getElementById('host-btn').classList.toggle('active', isHost);
  document.getElementById('film-controls').style.display = isHost ? 'flex' : 'none';
  document.getElementById('viewer-note').style.display = isHost ? 'none' : 'block';
  document.getElementById('sync-pill').textContent = isHost ? 'host' : 'viewer';
  document.getElementById('sync-pill').classList.toggle('is-host', isHost);
}

document.getElementById('host-btn').addEventListener('click', function(){
  if(isHost){
    isHost = false;
    localStorage.removeItem('wp_isHost');
    applyHostUI();
    return;
  }
  const entered = prompt('Host passcode:');
  if(entered === HOST_PASSCODE){
    isHost = true;
    localStorage.setItem('wp_isHost', '1');
    applyHostUI();
  } else if(entered !== null){
    alert('Wrong passcode.');
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

function loadFilmFromUrl(url, writeToFirebase){
  if(!url) return;
  const ytId = extractYouTubeId(url);
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
  stateRef.on('value', snap => applyRemoteState(snap.val()));
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
  try { return JSON.parse(localStorage.getItem('wp_panelLayout') || '{}'); }
  catch(e){ return {}; }
}
function savePanelLayout(layout){
  localStorage.setItem('wp_panelLayout', JSON.stringify(layout));
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
initPanelPosition(document.getElementById('panel-film'), 600, 20);

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
  localStorage.removeItem('wp_panelLayout');
  const twitch = document.getElementById('panel-twitch');
  const film = document.getElementById('panel-film');
  twitch.style.width = '560px';
  twitch.style.height = '460px';
  film.style.width = '560px';
  film.style.height = '560px';
  initPanelPosition(twitch, 20, 20);
  initPanelPosition(film, 600, 20);
  bringToFront(twitch);
  bringToFront(film);
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
  const labels = { twitch: 'Stream', film: 'Film', chat: 'Chat' };
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
chatTab.addEventListener('click', toggleChatSidebar);
chatCloseBtn.addEventListener('click', toggleChatSidebar);

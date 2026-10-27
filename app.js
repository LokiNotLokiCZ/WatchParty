/* ============================================================
   CONFIG
   ============================================================ */
const CHANNEL = "brasla_";
const PARENT_DOMAINS = ["localhost", "127.0.0.1", window.location.hostname].filter(Boolean);
const UNIQUE_PARENTS = [...new Set(PARENT_DOMAINS)];

// NOTE: the host passcode is not in this file. It lives in the Vercel
// environment variable HOST_PASSCODE and is checked by /api/host-login.

// Public Firebase web config (safe to be public — access is protected by the
// database security rules, see database.rules.json).
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
   FIREBASE INIT  (screen.js uses: db, auth, firebaseReady, isHost, authReady)
   ============================================================ */
let db = null;
let auth = null;
let firebaseReady = false;

try {
  firebase.initializeApp(firebaseConfig);
  auth = firebase.auth();
  db = firebase.database();
  firebaseReady = true;
} catch (err) {
  console.error('Firebase failed to init — screen sharing disabled.', err);
}

/* ============================================================
   TWITCH STREAM + CHAT
   ============================================================ */
function createPlayer(){
  const box = document.getElementById('twitch-embed');
  box.innerHTML = '';
  try {
    new Twitch.Embed("twitch-embed", {
      channel: CHANNEL,
      parent: UNIQUE_PARENTS,
      width: "100%",
      height: "100%",
      layout: "video",
      autoplay: false
    });
  } catch (e) { console.error('Twitch embed failed', e); }
}

const chatParents = UNIQUE_PARENTS.map(p => `parent=${encodeURIComponent(p)}`).join('&');
function loadChat(){
  document.getElementById('twitch-chat').src =
    `https://www.twitch.tv/embed/${CHANNEL}/chat?darkpopout&${chatParents}`;
}

createPlayer();
loadChat();

/* Reload BOTH the stream and the chat (they read the viewer's own twitch.tv session) */
function reloadTwitch(){
  createPlayer();
  const chat = document.getElementById('twitch-chat');
  chat.src = 'about:blank';
  setTimeout(loadChat, 80);
}

/* ============================================================
   HOST MODE  (verified by Firebase custom token claim, not by the browser)
   ============================================================ */
let isHost = false;

function applyHostUI(){
  const btn = document.getElementById('host-btn');
  btn.textContent = isHost ? 'HOST ✓' : 'HOST';
  btn.classList.toggle('active', isHost);
  document.dispatchEvent(new CustomEvent('hostchange'));
}

let authResolve;
const authReady = new Promise(res => { authResolve = res; });
let authFirstDone = false;

async function refreshHostFlag(user){
  let host = false;
  try {
    const t = await user.getIdTokenResult();
    host = !!(t.claims && t.claims.host === true);
  } catch(e) {}
  const changed = host !== isHost;
  isHost = host;
  if(changed || !authFirstDone){ applyHostUI(); }
}

if(firebaseReady){
  auth.onAuthStateChanged(async user => {
    if(!user){
      try { await auth.signInAnonymously(); }
      catch(e) { console.error('Anonymous sign-in failed — enable Anonymous in Firebase Authentication.', e); authResolve(); }
      return;
    }
    await refreshHostFlag(user);
    authFirstDone = true;
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
   VIEW SWITCHER  (Obrazovka / Obojí / Stream)
   ============================================================ */
const stage = document.getElementById('stage');
const viewBtns = Array.from(document.querySelectorAll('.view-btn'));

function setView(view){
  if(!['screen','both'].includes(view)) view = 'both';
  stage.dataset.view = view;
  viewBtns.forEach(b => b.classList.toggle('active', b.dataset.view === view));
  try { localStorage.setItem('wp_view', view); } catch(e) {}
}
viewBtns.forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
let savedView = 'both';
try { savedView = localStorage.getItem('wp_view') || 'both'; } catch(e) {}
setView(savedView);

// red dot on the "Obrazovka" tab while somebody is live
const screenPill = document.getElementById('screen-pill');
const screenDot = document.getElementById('screen-dot');
function syncScreenDot(){
  const live = screenPill.classList.contains('is-live') || screenPill.classList.contains('is-watching');
  screenDot.classList.toggle('live', live);
  const bd = document.getElementById('bubble-screen-dot');
  if(bd) bd.classList.toggle('live', live);
}
new MutationObserver(syncScreenDot).observe(screenPill, { attributes: true, attributeFilter: ['class'] });
syncScreenDot();

/* ============================================================
   FULLSCREEN buttons
   ============================================================ */
document.querySelectorAll('[data-fs]').forEach(btn => {
  btn.addEventListener('click', () => {
    const which = btn.dataset.fs;
    const tile = document.getElementById(which === 'screen' ? 'tile-screen' : 'tile-stream');
    const video = document.getElementById('screen-video');
    try {
      if(document.fullscreenElement){ document.exitFullscreen(); return; }
      if(tile.requestFullscreen) tile.requestFullscreen();
      else if(which === 'screen' && video.webkitEnterFullscreen) video.webkitEnterFullscreen(); // iPhone Safari
    } catch(e) { console.warn('Fullscreen failed', e); }
  });
});

/* ============================================================
   CHAT TOGGLE
   Desktop: docked column on the right.  Phone: bottom sheet.
   ============================================================ */
const app = document.getElementById('app');
const chatSidebar = document.getElementById('chat-sidebar');
const isSmallScreen = () => window.innerWidth < 900;

function setChatOpen(open){
  chatSidebar.classList.toggle('closed', !open);
  app.classList.toggle('chat-closed', !open);
  document.getElementById('chat-toggle').classList.toggle('active', open);
}
function toggleChat(){ setChatOpen(chatSidebar.classList.contains('closed')); }

setChatOpen(!isSmallScreen());   // phones start with the chat hidden
document.getElementById('chat-toggle').addEventListener('click', toggleChat);
document.getElementById('chat-sidebar-tab').addEventListener('click', toggleChat);
document.getElementById('chat-sidebar-close').addEventListener('click', toggleChat);


/* ============================================================
   RESIZABLE LAYOUT  (handle between the tiles + handle on the chat edge)
   ============================================================ */
const root = document.documentElement;
const splitTiles = document.getElementById('split-tiles');
const splitChat = document.getElementById('split-chat');
const stackedLayout = () => window.innerWidth <= 1200;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

let tileRatio = 0.5;
try { tileRatio = clamp(parseFloat(localStorage.getItem('wp_ratio')) || 0.5, 0.2, 0.8); } catch(e) {}
function applyRatio(){
  stage.style.setProperty('--sa', tileRatio + 'fr');
  stage.style.setProperty('--sb', (1 - tileRatio) + 'fr');
}
applyRatio();

let chatWidth = 380;
try { chatWidth = clamp(parseInt(localStorage.getItem('wp_chatW'), 10) || 380, 280, 680); } catch(e) {}
function applyChatWidth(){ root.style.setProperty('--chat-w', chatWidth + 'px'); }
applyChatWidth();

function makeSplitter(el, onMove, onDone, onReset, onKey){
  let active = false;
  el.addEventListener('pointerdown', e => {
    if(isSmallScreen() || !document.body.classList.contains('editing')) return;
    active = true;
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    document.body.classList.add('resizing');
    e.preventDefault();
  });
  el.addEventListener('pointermove', e => { if(active) onMove(e); });
  const end = () => {
    if(!active) return;
    active = false;
    el.classList.remove('dragging');
    document.body.classList.remove('resizing');
    onDone();
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('dblclick', () => { onReset(); onDone(); });
  el.addEventListener('keydown', e => { if(onKey && onKey(e)) { e.preventDefault(); onDone(); } });
}

// safety net: never leave the page stuck in "resizing" mode (that would block clicks inside the chat)
['pointerup','pointercancel','blur'].forEach(ev => window.addEventListener(ev, () => document.body.classList.remove('resizing')));

const tileSplitCfg = [
  e => {
    const a = document.getElementById('tile-screen').getBoundingClientRect();
    const b = document.getElementById('tile-stream').getBoundingClientRect();
    if(stackedLayout()){
      tileRatio = clamp((e.clientY - a.top) / (b.bottom - a.top), 0.2, 0.8);
    } else {
      tileRatio = clamp((e.clientX - a.left) / (b.right - a.left), 0.2, 0.8);
    }
    applyRatio();
  },
  () => { try { localStorage.setItem('wp_ratio', String(tileRatio)); } catch(e) {} },
  () => { tileRatio = 0.5; applyRatio(); },
  e => {
    const step = 0.03;
    if(e.key === 'ArrowLeft' || e.key === 'ArrowUp'){ tileRatio = clamp(tileRatio - step, 0.2, 0.8); applyRatio(); return true; }
    if(e.key === 'ArrowRight' || e.key === 'ArrowDown'){ tileRatio = clamp(tileRatio + step, 0.2, 0.8); applyRatio(); return true; }
    return false;
  }
];
makeSplitter(splitTiles, ...tileSplitCfg);
makeSplitter(document.getElementById('grip-screen'), ...tileSplitCfg);
makeSplitter(document.getElementById('grip-stream'), ...tileSplitCfg);

const chatSplitCfg = [
  e => { chatWidth = clamp(Math.round(window.innerWidth - e.clientX - 16), 280, 680); applyChatWidth(); },
  () => { try { localStorage.setItem('wp_chatW', String(chatWidth)); } catch(e) {} },
  () => { chatWidth = 380; applyChatWidth(); },
  e => {
    if(e.key === 'ArrowLeft'){ chatWidth = clamp(chatWidth + 20, 280, 680); applyChatWidth(); return true; }
    if(e.key === 'ArrowRight'){ chatWidth = clamp(chatWidth - 20, 280, 680); applyChatWidth(); return true; }
    return false;
  }
];
makeSplitter(splitChat, ...chatSplitCfg);
makeSplitter(document.getElementById('grip-chat'), ...chatSplitCfg);

/* ============================================================
   TWITCH MENU  (log in / log out / reload — affects stream AND chat)
   The embedded player and chat read the viewer's own twitch.tv session,
   so logging in once in a Twitch window logs in both; we then reload them.
   ============================================================ */
const twitchBtn = document.getElementById('twitch-btn');
const twitchMenu = document.getElementById('twitch-menu');
const appToast = document.getElementById('app-toast');
let toastTimer = null;

const appToastText = document.getElementById('app-toast-text');
const appToastBtn = document.getElementById('app-toast-btn');
let toastAction = null;
function showToast(text, ms, action){
  appToastText.textContent = text;
  toastAction = action ? action.fn : null;
  appToastBtn.hidden = !action;
  if(action) appToastBtn.textContent = action.label;
  appToast.hidden = false;
  clearTimeout(toastTimer);
  if(ms) toastTimer = setTimeout(() => { appToast.hidden = true; }, ms);
}
appToastBtn.addEventListener('click', () => { if(toastAction) toastAction(); });
function setMenu(open){
  twitchMenu.hidden = !open;
  twitchBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
}
twitchBtn.addEventListener('click', e => { e.stopPropagation(); setMenu(twitchMenu.hidden); });
document.addEventListener('click', e => { if(!twitchMenu.hidden && !twitchMenu.contains(e.target)) setMenu(false); });
document.addEventListener('keydown', e => { if(e.key === 'Escape') setMenu(false); });

function openTwitchWindow(url, message){
  setMenu(false);
  const w = 520, h = 760;
  const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - w) / 2));
  const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - h) / 2));
  const win = window.open(url, 'twitch-session', `width=${w},height=${h},left=${left},top=${top}`);
  if(!win){ showToast('Prohlížeč zablokoval vyskakovací okno. Povol ho a zkus to znovu.', 7000); return; }
  let finished = false;
  const finish = () => {
    if(finished) return;
    finished = true;
    clearInterval(timer);
    try { win.close(); } catch(e) {}
    appToast.hidden = true;
    reloadTwitch();
  };
  const timer = setInterval(() => { if(win.closed) finish(); }, 600);
  showToast(message, 0, { label: 'Hotovo – obnovit', fn: finish });
}

document.getElementById('twitch-login').addEventListener('click', () =>
  openTwitchWindow('https://www.twitch.tv/login', 'V okně Twitche se přihlas (pokud už přihlášený jsi, uvidíš svůj profil). Potom klikni na Hotovo.'));
document.getElementById('twitch-logout').addEventListener('click', () =>
  openTwitchWindow('https://www.twitch.tv/', 'V okně klikni vpravo nahoře na svůj profil → Odhlásit se. Potom klikni na Hotovo.'));
document.getElementById('twitch-reload').addEventListener('click', () => { setMenu(false); reloadTwitch(); });


/* ============================================================
   FLOATING WINDOWS  (pop a tile out, drag it anywhere, resize it,
   shrink it to a small floating icon, or dock it back)
   ============================================================ */
const tileEls = { screen: document.getElementById('tile-screen'), stream: document.getElementById('tile-stream'), chat: document.getElementById('chat-sidebar') };
const BUBBLE = 60;
let floatState = {};
try { floatState = JSON.parse(localStorage.getItem('wp_float') || '{}') || {}; } catch(e) { floatState = {}; }
const saveFloat = () => { try { localStorage.setItem('wp_float', JSON.stringify(floatState)); } catch(e) {} };
let floatZ = 60;

function floatRect(s){
  const min = !!s.min;
  const w = min ? BUBBLE : clamp(s.w || 480, 260, window.innerWidth - 16);
  const h = min ? BUBBLE : clamp(s.h || 300, 170, window.innerHeight - 16);
  const x = clamp(s.x || 40, 0, Math.max(0, window.innerWidth - w));
  const y = clamp(s.y || 90, 0, Math.max(0, window.innerHeight - h));
  return { x, y, w, h };
}

function applyFloat(name){
  const t = tileEls[name], s = floatState[name];
  const on = !!(s && s.on) && !isSmallScreen();
  t.classList.toggle('floating', on);
  t.classList.toggle('minimized', on && !!s.min);
  if(on){
    const r = floatRect(s);
    t.style.left = r.x + 'px'; t.style.top = r.y + 'px';
    t.style.width = r.w + 'px'; t.style.height = r.h + 'px';
  } else {
    ['left','top','width','height','zIndex'].forEach(k => { t.style[k] = ''; });
  }
  if(name === 'chat') app.classList.toggle('chat-floating', on);
  stage.classList.toggle('has-float', !isSmallScreen() && ['screen','stream'].some(n => floatState[n] && floatState[n].on));
}
function applyAllFloat(){ Object.keys(tileEls).forEach(applyFloat); }
function bringFloatToFront(name){ floatZ += 1; tileEls[name].style.zIndex = floatZ; }

function toggleFloat(name){
  const s = floatState[name] || (floatState[name] = {});
  if(s.on){ s.on = false; }
  else { floatOut(name); return; }
  saveFloat(); applyAllFloat();
}
function floatOut(name){
  const s = floatState[name] || (floatState[name] = {});
  {
    const r = tileEls[name].getBoundingClientRect();
    let w, h;
    if(name === 'chat'){
      w = Math.round(Math.min(420, Math.max(300, r.width))); h = Math.round(Math.min(620, window.innerHeight - 140));
      s.x = Math.max(8, Math.round(r.left)); s.y = Math.max(70, Math.round(r.top));
    } else {
      w = Math.round(Math.min(560, Math.max(320, r.width * 0.6))); h = Math.round(w * 9 / 16);
      s.x = Math.max(8, Math.round(r.right - w - 24)); s.y = Math.max(8, Math.round(r.bottom - h - 24));
    }
    s.w = w; s.h = h;
    s.on = true; s.min = false;
  }
  saveFloat(); applyAllFloat();
  bringFloatToFront(name);
}

document.querySelectorAll('[data-float]').forEach(b => b.addEventListener('click', () => toggleFloat(b.dataset.float)));
document.querySelectorAll('[data-min]').forEach(b => b.addEventListener('click', () => {
  const name = b.dataset.min, s = floatState[name];
  if(!s) return;
  s.min = true; saveFloat(); applyFloat(name);
}));

function endDragClasses(){ document.body.classList.remove('resizing', 'moving'); }

/* drag: by the top strip of the window, or by the whole icon when minimized */
function attachMove(handle, name, bubbleMode){
  const tile = tileEls[name];
  let drag = null;
  handle.addEventListener('pointerdown', e => {
    if(isSmallScreen()) return;
    if(e.target.closest('.tile-tools')) return;
    if(!bubbleMode && document.body.classList.contains('editing') && !(floatState[name] && floatState[name].on)) floatOut(name);
    const s = floatState[name];
    if(!s || !s.on) return;
    if(bubbleMode !== !!s.min) return;
    if(!bubbleMode && !document.body.classList.contains('editing')) return;
    handle.setPointerCapture(e.pointerId);
    drag = { px: e.clientX, py: e.clientY, x: floatRect(s).x, y: floatRect(s).y, moved: false };
    bringFloatToFront(name);
    tile.classList.add('dragging');
    document.body.classList.add('resizing', 'moving');
    e.preventDefault();
  });
  handle.addEventListener('pointermove', e => {
    if(!drag) return;
    const s = floatState[name];
    const dx = e.clientX - drag.px, dy = e.clientY - drag.py;
    if(Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    s.x = drag.x + dx; s.y = drag.y + dy;
    applyFloat(name);
  });
  const end = () => {
    if(!drag) return;
    const s = floatState[name];
    if(s.min && !drag.moved){ s.min = false; }   // a tap on the icon opens the window again
    drag = null;
    tile.classList.remove('dragging');
    endDragClasses();
    const r = floatRect(s); s.x = r.x; s.y = r.y;
    saveFloat(); applyFloat(name);
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}
Object.keys(tileEls).forEach(name => {
  attachMove(tileEls[name].querySelector('.tile-drag'), name, false);
  attachMove(tileEls[name], name, true);
  tileEls[name].querySelector('.tile-drag').addEventListener('dblclick', () => {
    if(document.body.classList.contains('editing') && floatState[name] && floatState[name].on){ floatState[name].on = false; saveFloat(); applyAllFloat(); }
  });
  tileEls[name].addEventListener('pointerdown', () => { if(floatState[name] && floatState[name].on) bringFloatToFront(name); });
});

/* resize: corner grip of a floating window */
Object.keys(tileEls).forEach(name => {
  const grip = tileEls[name].querySelector('.tile-resize');
  let rs = null;
  grip.addEventListener('pointerdown', e => {
    const s = floatState[name];
    if(!s || !s.on || !document.body.classList.contains('editing')) return;
    grip.setPointerCapture(e.pointerId);
    const r = floatRect(s);
    rs = { px: e.clientX, py: e.clientY, w: r.w, h: r.h, x: r.x, y: r.y };
    bringFloatToFront(name);
    document.body.classList.add('resizing');
    e.preventDefault(); e.stopPropagation();
  });
  grip.addEventListener('pointermove', e => {
    if(!rs) return;
    const s = floatState[name];
    s.w = clamp(rs.w + e.clientX - rs.px, 260, window.innerWidth - rs.x);
    s.h = clamp(rs.h + e.clientY - rs.py, 170, window.innerHeight - rs.y);
    applyFloat(name);
  });
  const end = () => { if(!rs) return; rs = null; endDragClasses(); saveFloat(); };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
});

window.addEventListener('resize', applyAllFloat);
applyAllFloat();


/* ============================================================
   EDIT-LAYOUT BUTTON
   ============================================================ */
const editBtn = document.getElementById('edit-layout');
const resetBtn = document.getElementById('reset-layout');
function setEditing(on){
  document.body.classList.toggle('editing', on);
  editBtn.classList.toggle('active', on);
  editBtn.textContent = on ? 'Hotovo' : 'Upravit rozložení';
  resetBtn.hidden = !on;
  if(!on) endDragClasses();
}
editBtn.addEventListener('click', () => setEditing(!document.body.classList.contains('editing')));
document.addEventListener('keydown', e => { if(e.key === 'Escape' && document.body.classList.contains('editing')) setEditing(false); });
resetBtn.addEventListener('click', () => {
  floatState = {}; saveFloat();
  tileRatio = 0.5; applyRatio(); try { localStorage.setItem('wp_ratio', '0.5'); } catch(e) {}
  chatWidth = 380; applyChatWidth(); try { localStorage.setItem('wp_chatW', '380'); } catch(e) {}
  applyAllFloat();
});

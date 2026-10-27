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

const chatParents = UNIQUE_PARENTS.map(p => `parent=${encodeURIComponent(p)}`).join('&');
document.getElementById('twitch-chat').src =
  `https://www.twitch.tv/embed/${CHANNEL}/chat?darkpopout&${chatParents}`;

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
  if(!['screen','both','stream'].includes(view)) view = 'both';
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
  screenDot.classList.toggle('live', screenPill.classList.contains('is-live') || screenPill.classList.contains('is-watching'));
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

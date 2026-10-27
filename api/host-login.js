// Vercel serverless function: verifies the host passcode SERVER-SIDE and returns a
// Firebase custom token carrying the claim { host: true }.
// Env vars (Vercel -> Settings -> Environment Variables):
//   HOST_PASSCODE            the host passcode (no longer stored in the website code)
//   FIREBASE_SERVICE_ACCOUNT the whole service-account JSON (Firebase -> Project settings -> Service accounts)
const crypto = require('crypto');

const attempts = new Map(); // ip -> { count, resetAt }  (best-effort, per server instance)
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 10 * 60 * 1000;

function b64url(input){
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function sameSecret(a, b){
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function makeCustomToken(sa){
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: sa.client_email,
    sub: sa.client_email,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat: now,
    exp: now + 3600,
    uid: 'host',
    claims: { host: true }
  };
  const data = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(payload));
  const sig = crypto.createSign('RSA-SHA256').update(data).sign(sa.private_key);
  return data + '.' + b64url(sig);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  // only our own site may call this
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite && fetchSite !== 'same-origin') { res.status(403).json({ error: 'forbidden' }); return; }
  const origin = req.headers.origin;
  if (origin) {
    try { if (new URL(origin).host !== req.headers.host) { res.status(403).json({ error: 'forbidden' }); return; } }
    catch (e) { res.status(403).json({ error: 'forbidden' }); return; }
  }

  // brute-force limit
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const now = Date.now();
  let rec = attempts.get(ip);
  if (!rec || rec.resetAt < now) { rec = { count: 0, resetAt: now + WINDOW_MS }; attempts.set(ip, rec); }
  if (rec.count >= MAX_ATTEMPTS) { res.status(429).json({ error: 'too many attempts' }); return; }

  const expected = process.env.HOST_PASSCODE;
  const saRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!expected || !saRaw) { res.status(501).json({ error: 'not configured' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const passcode = body && typeof body.passcode === 'string' ? body.passcode : '';

  if (!sameSecret(passcode, expected)) {
    rec.count++;
    res.status(401).json({ error: 'wrong passcode' });
    return;
  }

  try {
    const sa = JSON.parse(saRaw);
    rec.count = 0;
    res.status(200).json({ token: makeCustomToken(sa) });
  } catch (e) {
    res.status(500).json({ error: 'token error' });
  }
};

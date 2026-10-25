// Vercel serverless function: mints short-lived Cloudflare TURN credentials.
// Needs env vars in Vercel: CF_TURN_KEY_ID and CF_TURN_API_TOKEN.
module.exports = async (req, res) => {
  const keyId = process.env.CF_TURN_KEY_ID;
  const token = process.env.CF_TURN_API_TOKEN;
  res.setHeader('Cache-Control', 'no-store');
  if (!keyId || !token) {
    res.status(501).json({ error: 'TURN not configured' });
    return;
  }
  try {
    const r = await fetch(
      'https://rtc.live.cloudflare.com/v1/turn/keys/' + keyId + '/credentials/generate-ice-servers',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: 86400 })
      }
    );
    if (!r.ok) {
      res.status(502).json({ error: 'Cloudflare HTTP ' + r.status });
      return;
    }
    const data = await r.json();
    res.status(200).json({ iceServers: data.iceServers || [] });
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
};

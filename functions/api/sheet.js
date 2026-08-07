// Cloudflare Pages Function: POST /api/sheet
//
// Writes the current rankings live to a Google Sheet, authenticated as a
// Google service account (a "bot" identity you share the sheet with as an
// Editor — see README.md for full setup steps). No user OAuth flow needed.

function checkAuth(request, env) {
  const expected = env.AUTH_TOKEN;
  if (!expected) return true;
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return token === expected;
}

function b64url(bytes) {
  let str;
  if (typeof bytes === 'string') str = btoa(bytes);
  else str = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };
  const enc = (obj) => b64url(JSON.stringify(obj));
  const unsigned = `${enc(header)}.${enc(claim)}`;

  // The private key comes from the downloaded service-account JSON's
  // "private_key" field. Cloudflare env vars are single-line, so paste it
  // with literal \n sequences (as the JSON file already has them) — this
  // code converts those back into real newlines before parsing.
  const pemKey = env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
  const pemBody = pemKey
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');
  const binaryDer = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    'pkcs8',
    binaryDer.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const sigBuf = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsigned)
  );
  const jwt = `${unsigned}.${b64url(sigBuf)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Google token exchange failed: ' + JSON.stringify(data));
  return data.access_token;
}

export async function onRequestPost({ request, env }) {
  if (!checkAuth(request, env)) {
    return new Response('Unauthorized', { status: 401 });
  }
  if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !env.GOOGLE_PRIVATE_KEY || !env.GOOGLE_SHEET_ID) {
    return new Response('Google Sheets not configured', { status: 404 });
  }

  let body;
  try { body = await request.json(); } catch (e) { return new Response('Invalid JSON body', { status: 400 }); }
  const rows = body.rows;
  if (!Array.isArray(rows)) return new Response('Missing rows array', { status: 400 });

  let accessToken;
  try {
    accessToken = await getAccessToken(env);
  } catch (e) {
    return new Response('Auth error: ' + e.message, { status: 502 });
  }

  const sheetName = env.GOOGLE_SHEET_NAME || 'Sheet1';
  const lastRow = rows.length + 1; // +1 for header row
  const range = `${sheetName}!A2:H${lastRow}`;
  const values = rows.map(r => [
    r.rank, r.id, r.title, r.url, r.elo, r.rd, r.matchesPlayed, r.eliminated ? 'y' : 'n'
  ]);

  const sheetsRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ values })
    }
  );

  if (!sheetsRes.ok) {
    const errText = await sheetsRes.text();
    return new Response('Sheets API error: ' + errText, { status: 502 });
  }

  return new Response(JSON.stringify({ ok: true, rows: rows.length }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

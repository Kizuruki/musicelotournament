// Cloudflare Pages Function: GET/POST /api/state
//
// Persists the tournament's state (songs, elo, rd, race log, etc.) in a
// Cloudflare KV namespace instead of only the browser's localStorage, so it
// survives across devices/browsers/reinstalls.
//
// Setup (see README.md for full steps):
//   1. Create a KV namespace and bind it to this Pages project as `STATE_KV`.
//   2. Set an environment variable `AUTH_TOKEN` to a secret string of your
//      choosing (Pages project settings -> Environment variables).
//   3. In the app's "Cloud sync" section, paste that same token once. It's
//      stored in your browser and sent as a Bearer token on every request.
//
// This is intentionally simple (a single shared token, single KV key) since
// it's meant for one person's personal tournament data, not multi-tenant use.

const KV_KEY = 'yt-elo-state-v1';

function checkAuth(request, env) {
  const expected = env.AUTH_TOKEN;
  if (!expected) return true; // no token configured -> auth disabled (not recommended)
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return token === expected;
}

export async function onRequestGet({ request, env }) {
  if (!env.STATE_KV) {
    return new Response('KV namespace not bound', { status: 404 });
  }
  if (!checkAuth(request, env)) {
    return new Response('Unauthorized', { status: 401 });
  }
  const raw = await env.STATE_KV.get(KV_KEY);
  if (!raw) {
    return new Response(JSON.stringify(null), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  return new Response(raw, { headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPost({ request, env }) {
  if (!env.STATE_KV) {
    return new Response('KV namespace not bound', { status: 404 });
  }
  if (!checkAuth(request, env)) {
    return new Response('Unauthorized', { status: 401 });
  }
  let body;
  try {
    body = await request.text();
    JSON.parse(body); // validate it's real JSON before storing
  } catch (e) {
    return new Response('Invalid JSON body', { status: 400 });
  }
  await env.STATE_KV.put(KV_KEY, body);
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

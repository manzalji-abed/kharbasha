import { LobbyObject } from './lobby-object.js';
import { RoomObject } from './room-object.js';
import { handleAdmin } from './analytics/admin.js';
import { clientInfo } from './analytics/client.js';
import { recordRoomOpened, recordVisit } from './analytics/record.js';
import { arabicHome } from './seo.js';

export { LobbyObject, RoomObject };

const ROOM_CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{5}$/;
const OPEN_ATTEMPTS = 5;

// Static files in /public (the game, and /admin) are served by Cloudflare before this
// handler runs; only the API and room connections reach the code below.
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/ws/')) return connectToRoom(request, env, url);
    if (request.method === 'GET' && (url.pathname === '/ar' || url.pathname === '/ar/')) return arabicHome(request, env);

    const lobby = env.LOBBY.get(env.LOBBY.idFromName('lobby'));
    if (url.pathname.startsWith('/api/admin/')) return handleAdmin(request, env, url, lobby);

    const client = clientInfo(request);
    const ip = request.headers.get('CF-Connecting-IP') ?? '';
    const route = `${request.method} ${url.pathname}`;

    if (route === 'POST /api/track') {
      ctx.waitUntil(recordVisit(env.DB, client, await readJson(request)));
      return new Response(null, { status: 204 });
    }
    if (route === 'GET /api/rooms') return json(await lobby.list(url.searchParams.get('lang')));
    if (route === 'POST /api/rooms') {
      const { lang, isPublic, visitor } = await readJson(request);
      return json(await openRoom({ env, ctx, lobby, ip, client, visitor }, { lang, isPublic: isPublic === true }));
    }
    if (route === 'POST /api/quick') {
      const { lang, visitor } = await readJson(request);
      const code = await lobby.pickQuick(lang);
      return json(code ? { code } : await openRoom({ env, ctx, lobby, ip, client, visitor }, { lang, isPublic: true }));
    }
    if (route === 'GET /api/ice') return json({ iceServers: await iceServers(env) });
    const info = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{5})$/);
    if (request.method === 'GET' && info) {
      const room = await lobby.info(info[1].toUpperCase());
      return room ? json(room) : json({ error: 'notFound' }, 404);
    }
    return new Response('Not found', { status: 404 });
  },
};

// The room object is created from here (close to the player) rather than from the lobby,
// so Cloudflare places each room near the people who play in it.
async function openRoom({ env, ctx, lobby, ip, client, visitor }, options) {
  for (let attempt = 0; attempt < OPEN_ATTEMPTS; attempt++) {
    const { code, error } = await lobby.allocate(ip);
    if (error) return { error };
    if (await env.ROOMS.get(env.ROOMS.idFromName(code)).init({ code, ...options })) {
      ctx.waitUntil(recordRoomOpened(env.DB, client, { code, visitor, ...options }));
      return { code };
    }
  }
  return { error: 'generic' };
}

const STUN_ONLY = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];

// Network helpers for voice chat. STUN lets most players connect directly; with a Cloudflare
// TURN key configured (secrets TURN_KEY_ID + TURN_KEY_API_TOKEN), players on strict networks
// are relayed too.
async function iceServers(env) {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return STUN_ONLY;
  try {
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: 6 * 3600 }),
    });
    if (!res.ok) throw new Error(`TURN credentials: HTTP ${res.status}`);
    const { iceServers: servers } = await res.json();
    // Port 53 is blocked by browsers and would only slow down connecting.
    return servers.map(s => ({ ...s, urls: [].concat(s.urls).filter(u => !/:53\b/.test(u)) }));
  } catch (err) {
    console.error(err);
    return STUN_ONLY;
  }
}

function connectToRoom(request, env, url) {
  if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
  const code = url.pathname.slice('/ws/'.length).toUpperCase();
  if (!ROOM_CODE.test(code)) return new Response('Not found', { status: 404 });
  if (!sameOrigin(request, url)) return new Response('Forbidden', { status: 403 });
  // The room records who joins (country, device) for statistics; it can't see the request's details itself.
  const headers = new Headers(request.headers);
  headers.set('X-Client', JSON.stringify(clientInfo(request)));
  return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(new Request(request, { headers }));
}

function sameOrigin(request, url) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === url.host;
  } catch {
    return false;
  }
}

async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? body : {};
  } catch {
    return {};
  }
}

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
}

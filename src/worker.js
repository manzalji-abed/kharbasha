import { LobbyObject } from './lobby-object.js';
import { RoomObject } from './room-object.js';

export { LobbyObject, RoomObject };

const ROOM_CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{5}$/;
const OPEN_ATTEMPTS = 5;

// Static files in /public are served by Cloudflare before this handler runs;
// only the API and room connections reach the code below.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/ws/')) return connectToRoom(request, env, url);

    const lobby = env.LOBBY.get(env.LOBBY.idFromName('lobby'));
    const ip = request.headers.get('CF-Connecting-IP') ?? '';
    const route = `${request.method} ${url.pathname}`;

    if (route === 'GET /api/rooms') return json(await lobby.list(url.searchParams.get('lang')));
    if (route === 'POST /api/rooms') {
      const { lang, isPublic } = await readJson(request);
      return json(await openRoom(env, lobby, ip, { lang, isPublic: isPublic === true }));
    }
    if (route === 'POST /api/quick') {
      const { lang } = await readJson(request);
      const code = await lobby.pickQuick(lang);
      return json(code ? { code } : await openRoom(env, lobby, ip, { lang, isPublic: true }));
    }
    return new Response('Not found', { status: 404 });
  },
};

// The room object is created from here (close to the player) rather than from the lobby,
// so Cloudflare places each room near the people who play in it.
async function openRoom(env, lobby, ip, options) {
  for (let attempt = 0; attempt < OPEN_ATTEMPTS; attempt++) {
    const { code, error } = await lobby.allocate(ip);
    if (error) return { error };
    if (await env.ROOMS.get(env.ROOMS.idFromName(code)).init({ code, ...options })) return { code };
  }
  return { error: 'generic' };
}

function connectToRoom(request, env, url) {
  if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
  const code = url.pathname.slice('/ws/'.length).toUpperCase();
  if (!ROOM_CODE.test(code)) return new Response('Not found', { status: 404 });
  if (!sameOrigin(request, url)) return new Response('Forbidden', { status: 403 });
  return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(request);
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

function json(data) {
  return Response.json(data, { headers: { 'cache-control': 'no-store' } });
}

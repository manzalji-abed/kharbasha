import { buildReport } from './report.js';

const DAY_MS = 86_400_000;
const RANGES = [1, 7, 30, 90, 0]; // days; 0 = all time

// /api/admin/* — the owner's dashboard data, behind the ADMIN_PASSWORD secret.
export async function handleAdmin(request, env, url, lobby) {
  if (!env.ADMIN_PASSWORD) return json({ error: 'The admin password is not set up yet.' }, 503);
  if (!(await authorized(request, env.ADMIN_PASSWORD))) {
    await new Promise(r => setTimeout(r, 400)); // slow down password guessing
    return json({ error: 'Wrong password.' }, 401);
  }
  if (url.pathname !== '/api/admin/report') return json({ error: 'Not found' }, 404);

  const requested = Number(url.searchParams.get('days'));
  const days = RANGES.includes(requested) ? requested : 7;
  const since = days ? Date.now() - days * DAY_MS : 0;
  const [report, live] = await Promise.all([buildReport(env.DB, since), lobby.live()]);
  return json({ days, since, generatedAt: Date.now(), live, ...report });
}

// Compares digests so the check takes the same time whatever was typed. Surrounding whitespace
// is ignored on both sides (a secret set from a shell pipe can pick up a trailing newline).
async function authorized(request, secret) {
  const given = (request.headers.get('Authorization') ?? '').replace(/^Bearer /, '').trim();
  const password = secret.trim();
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([given, password].map(s => crypto.subtle.digest('SHA-256', encoder.encode(s))));
  return crypto.subtle.timingSafeEqual(a, b);
}

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
}

// Owner dashboard: fetches /api/admin/report with the admin password and renders it.

const DAY_MS = 86_400_000;
const REFRESH_MS = 60_000;
const SERIES = {
  visitors: { key: 'visitors', label: 'Visitors', color: 'var(--series-1)' },
  players: { key: 'players', label: 'Players', color: 'var(--series-2)' },
  games: { key: 'games', label: 'Games', color: 'var(--series-1)' },
};
const LANG_NAMES = { en: 'English', ar: 'Arabic', both: 'English + Arabic' };
const STATUS = {
  finished: { label: 'Finished', color: 'var(--good)' },
  abandoned: { label: 'Abandoned', color: 'var(--serious)' },
  playing: { label: 'Playing', color: 'var(--accent)' },
};

const $ = sel => document.querySelector(sel);
const regionNames = (() => {
  try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return null; }
})();

function store(kind, key, value) {
  try {
    if (value === undefined) return window[kind].getItem(key);
    if (value === null) window[kind].removeItem(key);
    else window[kind].setItem(key, value);
  } catch { /* storage unavailable */ }
  return null;
}

// Strings become text nodes, so names from players can never inject markup.
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  el.append(...children.filter(c => c != null && c !== false));
  return el;
}

function s(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

// ---------------------------------------------------------------- formatting

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const fmt = n => (n == null || Number.isNaN(n) ? '–' : Math.abs(n) >= 10_000 ? compact.format(n) : Math.round(n).toLocaleString('en'));
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '–');

function duration(ms) {
  if (!ms) return '–';
  const sec = Math.round(ms / 1000);
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`;
}

function ago(ts) {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < DAY_MS) return `${Math.floor(diff / 3_600_000)} h ago`;
  return new Date(ts).toLocaleString('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const dayLabel = (day, long) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en', {
  timeZone: 'UTC', month: 'short', day: 'numeric', ...(long ? { weekday: 'short' } : {}),
});

// Country names rather than flag emoji: Windows can't draw flags and shows bare letters instead.
function country(code) {
  if (code === 'T1') return 'Tor network';
  if (!code || !/^[A-Z]{2}$/.test(code) || code === 'XX') return 'Unknown';
  try {
    return regionNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

const cap = text => (text ? text[0].toUpperCase() + text.slice(1) : text);
const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------- state & loading

const state = {
  password: store('sessionStorage', 'adminPassword'),
  days: Number(store('localStorage', 'adminDays') ?? 7),
  data: null,
  views: {}, // chart name → 'table' when the table view is shown
};
if (![1, 7, 30, 90, 0].includes(state.days)) state.days = 7;

async function load() {
  $('#dash').classList.add('loading');
  try {
    const res = await fetch(`/api/admin/report?days=${state.days}`, { headers: { Authorization: `Bearer ${state.password}` } });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) return signOut(body.error ?? 'Wrong password.');
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    state.data = body;
    showDashboard();
    render();
  } catch (err) {
    if (!state.data) return signOut(`Couldn't load the dashboard: ${err.message}`);
    $('#updated').textContent = `Refresh failed: ${err.message}`;
  } finally {
    $('#dash').classList.remove('loading');
  }
}

function showDashboard() {
  $('#login').hidden = true;
  $('#dash').hidden = false;
}

function signOut(message = '') {
  state.password = null;
  state.data = null;
  store('sessionStorage', 'adminPassword', null);
  $('#dash').hidden = true;
  $('#login').hidden = false;
  $('#loginError').textContent = message;
  $('#password').focus();
}

// ---------------------------------------------------------------- rendering

function render() {
  const d = state.data;
  for (const btn of $('#range').children) btn.setAttribute('aria-pressed', String(Number(btn.dataset.days) === state.days));
  $('#updated').textContent = `Updated ${new Date(d.generatedAt).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })}`;
  renderLive(d.live);
  renderKpis(d.totals);

  const days = fillDays(d.daily, d.since);
  renderChart('people', $('#peopleChart'), days, [SERIES.visitors, SERIES.players], lineChart);
  renderChart('games', $('#gamesChart'), days, [SERIES.games], columnChart);

  barList($('#countries'), d.countries.map(r => ({ label: country(r.country), value: r.visitors, text: `${fmt(r.visitors)} · ${fmt(r.players)}` })));
  barList($('#cities'), d.cities.map(r => ({ label: r.label, value: r.n })));
  barList($('#devices'), d.devices.map(r => ({ label: cap(r.label), value: r.n })));
  barList($('#os'), d.os.map(r => ({ label: r.label, value: r.n })));
  barList($('#browsers'), d.browsers.map(r => ({ label: r.label, value: r.n })));
  barList($('#uiLangs'), d.uiLangs.map(r => ({ label: LANG_NAMES[r.label] ?? r.label, value: r.n })));
  barList($('#roomLangs'), d.roomLangs.map(r => ({ label: LANG_NAMES[r.label] ?? r.label, value: r.n })));
  barList($('#referrers'), d.referrers.map(r => ({ label: r.label, value: r.n })));

  wordTable($('#topWords'), d.topWords);
  wordTable($('#hardWords'), d.hardWords);
  gamesTable($('#recentGames'), d.recentGames);
  playersTable($('#recentPlayers'), d.recentPlayers);
}

function renderLive(live) {
  $('#live').replaceChildren(
    h('span', { class: 'live-dot', 'aria-hidden': 'true' }),
    h('strong', {}, 'Live now'),
    ...[
      [live.players, 'player online', 'players online'],
      [live.rooms, 'room open', 'rooms open'],
      [live.playing, 'game in progress', 'games in progress'],
      [live.publicRooms, 'public room', 'public rooms'],
    ].map(([n, one, many]) => {
      const [count, ...words] = plural(n, one, many).split(' ');
      return h('span', {}, h('b', {}, count), ` ${words.join(' ')}`);
    }),
  );
}

function renderKpis(t) {
  const tile = (label, value, sub) => h('div', { class: 'tile' },
    h('div', { class: 'tile-label' }, label),
    h('div', { class: 'tile-value' }, value),
    h('div', { class: 'tile-sub' }, sub));
  $('#kpis').replaceChildren(
    tile('Unique visitors', fmt(t.visitors), `${fmt(t.newVisitors)} new · ${fmt(t.visits)} visits`),
    tile('Players', fmt(t.players), `${fmt(t.joins)} room joins`),
    tile('Rooms opened', fmt(t.rooms), `${fmt(t.public)} public`),
    tile('Games', fmt(t.games.started), `${fmt(t.games.completed)} played to the end`),
    tile('Turns drawn', fmt(t.turns.turns), `about ${duration(t.turns.avgMs)} each`),
    tile('Guess success', pct(t.turns.correct, t.turns.guessers), `${fmt(t.turns.correct)} of ${fmt(t.turns.guessers)} guessers got it`),
    tile('Game length', duration(t.games.avgMs), `${t.games.avgPlayers ? t.games.avgPlayers.toFixed(1) : '–'} players on average`),
    tile('From invite links', pct(t.invited, t.visits), `${fmt(t.invited)} visits opened an invite`),
  );
}

// One entry per UTC day from the start of the range to today, zeros where nothing happened.
function fillDays(daily, since) {
  const byDay = new Map(daily.map(r => [r.day, r]));
  const startDay = since ? new Date(since).toISOString().slice(0, 10) : daily[0]?.day ?? new Date().toISOString().slice(0, 10);
  const out = [];
  for (let t = Date.parse(`${startDay}T00:00:00Z`); t <= Date.now(); t += DAY_MS) {
    const day = new Date(t).toISOString().slice(0, 10);
    out.push({ day, visitors: 0, visits: 0, players: 0, games: 0, ...byDay.get(day) });
  }
  return out;
}

function renderChart(name, el, rows, series, draw) {
  const card = el.closest('.card');
  const toggle = card.querySelector('.view-toggle');
  const asTable = state.views[name] === 'table';
  toggle.textContent = asTable ? 'Chart' : 'Table';
  toggle.onclick = () => {
    state.views[name] = asTable ? 'chart' : 'table';
    renderChart(name, el, rows, series, draw);
  };
  el.replaceChildren();
  if (asTable) return el.append(dataTable(rows, series));
  if (series.length > 1) {
    el.append(h('div', { class: 'legend' }, ...series.map(sr => h('span', {}, h('i', { class: 'key-line', style: `--c:${sr.color}` }), sr.label))));
  }
  draw(el, rows, series);
}

function dataTable(rows, series) {
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Day'), ...series.map(sr => h('th', { class: 'num' }, sr.label)))),
    h('tbody', {}, ...[...rows].reverse().map(r => h('tr', {},
      h('td', {}, dayLabel(r.day, true)),
      ...series.map(sr => h('td', { class: 'num' }, fmt(r[sr.key]))))))));
}

// ---------------------------------------------------------------- charts

// Whole-number axis steps of 1, 2 or 5 × 10ⁿ, at most five intervals: 0 2 4 6 8 10, never 0 3 5 8 10.
function niceScale(maxValue) {
  const max = Math.max(1, maxValue);
  const magnitude = 10 ** Math.floor(Math.log10(max));
  const step = [0.1, 0.2, 0.5, 1, 2, 5, 10].map(m => Math.max(1, m * magnitude)).find(st => Math.ceil(max / st) <= 5);
  const top = Math.ceil(max / step) * step;
  return { max: top, ticks: Array.from({ length: top / step + 1 }, (_, i) => i * step) };
}

function frame(el, rows, scale, ariaLabel) {
  const width = Math.max(280, el.clientWidth);
  const height = 220;
  const m = { top: 14, right: 40, bottom: 26, left: 36 };
  const pw = width - m.left - m.right;
  const ph = height - m.top - m.bottom;
  const root = s('svg', { viewBox: `0 0 ${width} ${height}`, height, role: 'img', 'aria-label': ariaLabel, tabindex: 0 });
  const y = v => m.top + ph - (v / scale.max) * ph;
  for (const v of scale.ticks) {
    root.append(
      s('line', { x1: m.left, x2: width - m.right, y1: y(v), y2: y(v), style: `stroke: var(${v ? '--grid' : '--axis'}); stroke-width: 1` }),
      Object.assign(s('text', { x: m.left - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'axis-text' }), { textContent: fmt(v) }),
    );
  }
  return { root, width, height, m, pw, ph, y };
}

function xLabels(f, rows, x) {
  const picks = rows.length === 1 ? [0] : [...new Set([0, Math.floor((rows.length - 1) / 2), rows.length - 1])];
  for (const i of picks) {
    const anchor = rows.length === 1 ? 'middle' : i === 0 ? 'start' : i === rows.length - 1 ? 'end' : 'middle';
    f.root.append(Object.assign(s('text', { x: x(i), y: f.height - 6, 'text-anchor': anchor, class: 'axis-text' }), { textContent: dayLabel(rows[i].day) }));
  }
}

// Shared hover + keyboard readout: `show(i)` highlights day i and returns the tooltip anchor point.
function interactive(f, rows, series, indexAt, show, hide) {
  let current = rows.length - 1;
  const move = (i, point) => {
    current = Math.max(0, Math.min(rows.length - 1, i));
    const anchor = show(current);
    tooltip(rows[current], series, point ?? toScreen(f.root, f.width, anchor));
  };
  f.root.addEventListener('pointermove', e => {
    const r = f.root.getBoundingClientRect();
    move(indexAt(((e.clientX - r.left) * f.width) / r.width), { x: e.clientX, y: e.clientY });
  });
  f.root.addEventListener('pointerleave', () => { hide(); hideTooltip(); });
  f.root.addEventListener('focus', () => move(current));
  f.root.addEventListener('blur', () => { hide(); hideTooltip(); });
  f.root.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      move(current + (e.key === 'ArrowRight' ? 1 : -1));
    }
  });
}

function toScreen(svgEl, width, { x, y }) {
  const r = svgEl.getBoundingClientRect();
  const k = r.width / width;
  return { x: r.left + x * k, y: r.top + y * k };
}

function lineChart(el, rows, series) {
  const f = frame(el, rows, niceScale(Math.max(...rows.flatMap(r => series.map(sr => r[sr.key])))), `${series.map(sr => sr.label).join(' and ')} per day`);
  const x = i => f.m.left + (rows.length === 1 ? f.pw / 2 : (i * f.pw) / (rows.length - 1));
  xLabels(f, rows, x);

  for (const sr of series) {
    const d = rows.map((r, i) => `${i ? 'L' : 'M'}${x(i)},${f.y(r[sr.key])}`).join('');
    f.root.append(s('path', { d, style: `fill: none; stroke: ${sr.color}; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round` }));
  }
  // End dots, and end labels unless the two values would collide.
  const last = rows.length - 1;
  const ends = series.map(sr => ({ sr, y: f.y(rows[last][sr.key]), v: rows[last][sr.key] }));
  const collide = ends.length > 1 && Math.abs(ends[0].y - ends[1].y) < 14;
  for (const { sr, y, v } of ends) {
    f.root.append(s('circle', { cx: x(last), cy: y, r: 4, style: `fill: ${sr.color}; stroke: var(--surface); stroke-width: 2` }));
    if (!collide) f.root.append(Object.assign(s('text', { x: x(last) + 8, y: y + 4, class: 'end-text' }), { textContent: fmt(v) }));
  }

  const cross = s('line', { y1: f.m.top, y2: f.m.top + f.ph, style: 'stroke: var(--axis); stroke-width: 1', visibility: 'hidden' });
  const dots = series.map(sr => s('circle', { r: 4, style: `fill: ${sr.color}; stroke: var(--surface); stroke-width: 2`, visibility: 'hidden' }));
  f.root.append(cross, ...dots);
  interactive(
    f, rows, series,
    px => (rows.length === 1 ? 0 : Math.round(((px - f.m.left) / f.pw) * (rows.length - 1))),
    i => {
      cross.setAttribute('x1', x(i));
      cross.setAttribute('x2', x(i));
      cross.setAttribute('visibility', 'visible');
      series.forEach((sr, k) => {
        dots[k].setAttribute('cx', x(i));
        dots[k].setAttribute('cy', f.y(rows[i][sr.key]));
        dots[k].setAttribute('visibility', 'visible');
      });
      return { x: x(i), y: Math.min(...series.map(sr => f.y(rows[i][sr.key]))) };
    },
    () => [cross, ...dots].forEach(n => n.setAttribute('visibility', 'hidden')),
  );
  el.append(f.root);
}

function columnChart(el, rows, [sr]) {
  const f = frame(el, rows, niceScale(Math.max(...rows.map(r => r[sr.key]))), `${sr.label} per day`);
  const band = f.pw / rows.length;
  const w = Math.max(2, Math.min(24, band - 2)); // 2px surface gap between neighbours
  const x = i => f.m.left + band * (i + 0.5);
  xLabels(f, rows, x);
  const base = f.m.top + f.ph;
  const peak = rows.reduce((best, r, i) => (r[sr.key] > rows[best][sr.key] ? i : best), 0);

  const cols = rows.map((r, i) => {
    const top = f.y(r[sr.key]);
    const rad = Math.min(4, w / 2, base - top);
    const x0 = x(i) - w / 2;
    const x1 = x(i) + w / 2;
    const d = base - top < 0.5 ? '' : `M${x0},${base}V${top + rad}Q${x0},${top} ${x0 + rad},${top}H${x1 - rad}Q${x1},${top} ${x1},${top + rad}V${base}Z`;
    const col = s('path', { d, style: `fill: ${sr.color}` });
    f.root.append(col);
    return col;
  });
  if (rows[peak][sr.key] > 0) {
    f.root.append(Object.assign(s('text', { x: x(peak), y: f.y(rows[peak][sr.key]) - 6, 'text-anchor': 'middle', class: 'end-text' }), { textContent: fmt(rows[peak][sr.key]) }));
  }
  interactive(
    f, rows, [sr],
    px => Math.floor((px - f.m.left) / band),
    i => {
      cols.forEach((c, k) => (c.style.opacity = k === i ? '1' : '0.55'));
      return { x: x(i), y: f.y(rows[i][sr.key]) };
    },
    () => cols.forEach(c => (c.style.opacity = '1')),
  );
  el.append(f.root);
}

function tooltip(row, series, point) {
  const tip = $('#tooltip');
  tip.replaceChildren(
    h('div', { class: 'tt-head' }, dayLabel(row.day, true)),
    ...series.map(sr => h('div', { class: 'tt-row' },
      h('i', { class: 'key-line', style: `--c:${sr.color}` }),
      h('b', {}, fmt(row[sr.key])),
      h('span', {}, sr.label))),
  );
  tip.hidden = false;
  const { width, height } = tip.getBoundingClientRect();
  tip.style.left = `${Math.min(window.innerWidth - width - 8, point.x + 14)}px`;
  tip.style.top = `${Math.max(8, point.y - height - 12)}px`;
}

function hideTooltip() {
  $('#tooltip').hidden = true;
}

// ---------------------------------------------------------------- lists & tables

function barList(el, items) {
  if (!items.length) return el.replaceChildren(h('p', { class: 'empty' }, 'No data yet'));
  const max = Math.max(...items.map(i => i.value), 1);
  el.replaceChildren(h('ul', { class: 'bars' }, ...items.map(item => h('li', {},
    h('span', { class: 'bar-label', title: item.label }, item.label),
    h('span', { class: 'bar-track' }, h('span', { class: 'bar-fill', style: `display:block;width:${(100 * item.value) / max}%` })),
    h('span', { class: 'bar-value' }, item.text ?? fmt(item.value))))));
}

function table(el, head, rows) {
  if (!rows.length) return el.replaceChildren(h('p', { class: 'empty' }, 'No data yet'));
  el.replaceChildren(h('table', {},
    h('thead', {}, h('tr', {}, ...head.map(([label, num]) => h('th', { class: num ? 'num' : null }, label)))),
    h('tbody', {}, ...rows.map(cells => h('tr', {}, ...cells.map((cell, i) => h('td', { class: head[i][1] ? 'num' : null }, cell)))))));
}

function wordTable(el, words) {
  table(el, [['Word'], ['Plays', true], ['Guessed', true]], words.map(w => [
    h('span', {}, w.en ?? '', w.en && w.ar ? ' · ' : '', w.ar ? h('span', { class: 'ar', lang: 'ar', dir: 'rtl' }, w.ar) : ''),
    fmt(w.plays),
    pct(w.correct, w.guessers),
  ]));
}

function gameStatus(g) {
  if (g.completed) return STATUS.finished;
  if (!g.endedAt && Date.now() - g.startedAt < 2 * 3_600_000) return STATUS.playing;
  return STATUS.abandoned;
}

function gamesTable(el, games) {
  table(el, [['Started'], ['Room'], ['Words'], ['Players', true], ['Turns', true], ['Winner'], ['Length', true], ['Status']], games.map(g => {
    const status = gameStatus(g);
    return [
      ago(g.startedAt),
      h('span', {}, h('bdi', {}, g.roomName || g.room), g.roomName ? h('span', { class: 'muted' }, ` ${g.room}`) : '', g.isPublic ? h('span', { class: 'muted' }, ' · public') : ''),
      LANG_NAMES[g.lang] ?? g.lang,
      fmt(g.players),
      fmt(g.turns),
      g.winner ? h('bdi', {}, g.winner) : '–',
      g.endedAt ? duration(g.endedAt - g.startedAt) : '–',
      h('span', { class: 'status', style: `--c:${status.color}` }, status.label),
    ];
  }));
}

function playersTable(el, players) {
  table(el, [['Nickname'], ['Country'], ['Device'], ['Rooms joined', true], ['Last seen']], players.map(p => [
    h('bdi', {}, p.name ?? '–'),
    country(p.country),
    cap(p.device ?? '–'),
    fmt(p.rooms),
    ago(p.lastSeen),
  ]));
}

// ---------------------------------------------------------------- controls

$('#loginForm').addEventListener('submit', e => {
  e.preventDefault();
  state.password = $('#password').value;
  store('sessionStorage', 'adminPassword', state.password);
  $('#loginError').textContent = '';
  load();
});
$('#range').addEventListener('click', e => {
  const days = e.target.closest('button')?.dataset.days;
  if (days === undefined) return;
  state.days = Number(days);
  store('localStorage', 'adminDays', String(state.days));
  load();
});
$('#refreshBtn').onclick = load;
$('#logoutBtn').onclick = () => signOut();
$('#themeBtn').onclick = () => {
  const dark = getComputedStyle(document.documentElement).colorScheme === 'dark';
  document.documentElement.dataset.theme = dark ? 'light' : 'dark';
  store('localStorage', 'adminTheme', document.documentElement.dataset.theme);
  if (state.data) render();
};
const savedTheme = store('localStorage', 'adminTheme');
if (savedTheme === 'light' || savedTheme === 'dark') document.documentElement.dataset.theme = savedTheme;

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => state.data && render(), 150);
});
setInterval(() => state.password && !document.hidden && load(), REFRESH_MS);

if (state.password) load();
else $('#password').focus();

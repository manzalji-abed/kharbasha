// End-to-end test: real Chrome sessions (desktop, tablet, phone) play Kharbasha through the UI
// and then check the analytics dashboard.
//
//   npm run e2e -- [base-url]          default http://127.0.0.1:8787 (npm run dev)
//   ADMIN_PASSWORD=...                 checks /admin too
//   HEADFUL=1                          watch the browsers
//   CHROME_PATH=...                    Chrome/Edge executable
//
// Test players use visitor ids starting with "e2e-" so their statistics can be removed
// afterwards with e2e/purge-test-data.sql.

import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const OUT = fileURLToPath(new URL('./screenshots/', import.meta.url));
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const RUN = Math.random().toString(36).slice(2, 8);

const UA = {
  desktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  tablet: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  phone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
};
const VIEWPORT = {
  desktop: { width: 1366, height: 768 },
  tablet: { width: 820, height: 1180, isMobile: true, hasTouch: true },
  phone: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
};

mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const pages = [];

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function step(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✔ ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (err) {
    results.push({ name, ok: false, error: err.message });
    console.log(`  ✘ ${name}\n      ${err.message}`);
    for (const p of pages) await shot(p, `FAIL-${name.slice(0, 30).replace(/\W+/g, '-')}-${p.label}`).catch(() => {});
  }
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: !process.env.HEADFUL, args: ['--no-first-run', '--window-size=1400,900'] });

async function open(label, kind, uiLang) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.label = label;
  page.errors = [];
  await page.setViewport(VIEWPORT[kind]);
  await page.setUserAgent(UA[kind]);
  await page.evaluateOnNewDocument((visitor, lang) => {
    localStorage.setItem('visitor', JSON.stringify(visitor));
    if (lang && !localStorage.getItem('uiLang')) localStorage.setItem('uiLang', JSON.stringify(lang));
  }, `e2e-${RUN}-${label}`, uiLang);
  page.on('pageerror', e => page.errors.push(e.message));
  page.on('console', m => m.type() === 'error' && !/favicon|404/.test(m.text()) && page.errors.push(m.text()));
  page.on('dialog', d => d.accept());
  pages.push(page);
  return page;
}

const shot = (page, name) => page.screenshot({ path: `${OUT}${name}.png`, fullPage: page.viewport().isMobile });
// The app wraps names and numbers in invisible bidi isolates (U+2066–2069); compare without them.
const text = (page, sel) => page.$eval(sel, el => el.textContent.replace(/[⁦-⁩]/g, '').trim());
const state = page => page.$eval('#room', el => (el.hidden ? 'home' : el.dataset.state));
const waitState = (page, wanted, timeout = 15_000) =>
  page.waitForFunction(s => document.querySelector('#room').dataset.state === s && !document.querySelector('#room').hidden, { timeout }, wanted);
const waitText = (page, sel, wanted, timeout = 8_000) =>
  page.waitForFunction((s, w) => document.querySelector(s)?.textContent.replace(/[⁦-⁩]/g, '').trim() === w, { timeout }, sel, wanted);

async function say(page, message) {
  await page.click('#chatInput');
  await page.type('#chatInput', message);
  await page.keyboard.press('Enter');
}

async function findDrawer(players) {
  for (let i = 0; i < 50; i++) {
    for (const p of players) if (await p.$('#choosePanel:not([hidden]) .choice')) return p;
    await sleep(200);
  }
  throw new Error('nobody was offered words to draw');
}

async function drawerWords(drawer) {
  return drawer.$$eval('.word-full', els => Object.fromEntries(els.map(e => [e.lang, e.textContent])));
}

// A house with a yellow fill and an orange sun, drawn with the mouse.
async function drawPicture(page) {
  const box = () => page.$eval('#board', el => {
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const stroke = async pts => {
    const b = await box();
    const at = ([fx, fy]) => [b.x + fx * b.w, b.y + fy * b.h];
    await page.mouse.move(...at(pts[0]));
    await page.mouse.down();
    for (const p of pts.slice(1)) await page.mouse.move(...at(p), { steps: 8 });
    await page.mouse.up();
  };
  await page.click('.size[data-size="6"]');
  await stroke([[0.3, 0.5], [0.3, 0.85], [0.7, 0.85], [0.7, 0.5], [0.3, 0.5]]);
  await stroke([[0.27, 0.52], [0.5, 0.25], [0.73, 0.52]]);
  await page.click('.swatch[data-color="#facc15"]');
  await page.click('[data-tool="fill"]');
  const b = await box();
  await page.mouse.click(b.x + 0.5 * b.w, b.y + 0.7 * b.h);
  await page.click('[data-tool="pen"]');
  await page.click('.swatch[data-color="#f97316"]');
  await page.click('.size[data-size="12"]');
  await stroke(Array.from({ length: 13 }, (_, i) => [0.85 + 0.06 * Math.cos(i / 2), 0.18 + 0.08 * Math.sin(i / 2)]));
}

const pixelAt = (page, fx, fy) => page.$eval('#board', (c, x, y) => [...c.getContext('2d').getImageData(Math.round(x * c.width), Math.round(y * c.height), 1, 1).data], fx, fy);
const arabicVariant = word => (word.startsWith('ال') ? word : `ال${word}`).replace(/ة/g, 'ه');

async function noOverflow(page, where) {
  const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  check(sw <= iw, `${page.label}: page scrolls sideways at ${where} (${sw} > ${iw})`);
}

// One turn: drawer picks, everyone guesses right, everyone presses Continue.
async function playQuickTurn(players, next) {
  const drawer = await findDrawer(players);
  await drawer.click('.choice');
  await Promise.all(players.map(p => waitState(p, 'drawing')));
  const words = await drawerWords(drawer);
  for (const p of players.filter(p => p !== drawer)) await say(p, words.en ?? words.ar);
  await Promise.all(players.map(p => waitState(p, 'reveal')));
  for (const p of players) await p.click('#continueBtn');
  await Promise.all(players.map(p => waitState(p, next)));
}

console.log(`Kharbasha end-to-end test · ${BASE} · run ${RUN}\n`);

const host = await open('host', 'desktop', 'en');
const guest = await open('guest', 'tablet', 'en');
const phone = await open('phone', 'phone', 'ar');
const players = [host, guest, phone];
let code;

await step('home page loads in English (desktop) and Arabic (phone)', async () => {
  await host.goto(BASE, { waitUntil: 'networkidle0' });
  await phone.goto(BASE, { waitUntil: 'networkidle0' });
  check((await text(host, '#playBtn')) === 'Play now', 'English Play button');
  check((await phone.$eval('html', el => el.dir)) === 'rtl', 'Arabic page is right-to-left');
  check((await text(phone, '#playBtn')) === 'العب الآن', 'Arabic Play button');
  await shot(host, '01-home-desktop');
  await shot(phone, '02-home-phone-ar');
});

await step('a nickname is required before creating a room', async () => {
  await host.click('#createBtn');
  await sleep(300);
  check(await host.$eval('#nameInput', el => el.classList.contains('needs-name')), 'name field is highlighted');
  check((await text(host, '#homeError')).includes('nickname'), 'error asks for a nickname');
  check((await state(host)) === 'home', 'no room was opened');
});

await step('host creates a private room and names it', async () => {
  await host.type('#nameInput', 'Sara');
  await host.click('#createBtn');
  await waitState(host, 'lobby');
  code = new URL(host.url()).searchParams.get('r');
  check(/^[A-Z0-9]{5}$/.test(code), `room code in the address (${code})`);
  await host.type('#setName', 'Family night');
  await host.select('#setLang', 'both');
  await host.select('#setRounds', '1');
  await host.type('#setCustom', 'magnifying glass|عدسة مكبرة, hot air balloon|منطاد هوائي, traffic light|إشارة مرور');
  await host.click('#setCustomOnly');
  await waitText(host, '#roomTitle', 'Family night');
});

await step('invite link shows the room name and asks for a nickname', async () => {
  await guest.goto(`${BASE}/?r=${code}`, { waitUntil: 'networkidle0' });
  await waitText(guest, '#inviteRoom', 'Family night');
  check(await guest.$eval('#mainActions', el => el.hidden), 'the general menu is hidden on an invite');
  check((await text(guest, '#inviteMeta')).includes('1/10'), 'invite shows the player count');
  await shot(guest, '03-invite-tablet');
  await guest.click('#inviteJoinBtn');
  await sleep(300);
  check((await state(guest)) === 'home', 'cannot join without a name');
  await guest.type('#nameInput', 'Lina');
  await guest.click('#inviteJoinBtn');
  await waitState(guest, 'lobby');
  await waitText(guest, '#roomTitle', 'Family night');
});

await step('third player joins with the room code on an Arabic phone', async () => {
  await phone.type('#nameInput', 'عمر');
  await phone.type('#codeInput', code);
  await phone.click('#joinForm button');
  await waitState(phone, 'lobby');
  await waitText(phone, '#roomTitle', 'Family night');
  await sleep(300);
  check((await host.$$('#playerList .player')).length === 3, 'host sees three players');
  await shot(host, '04-lobby-host-desktop');
  await shot(phone, '05-lobby-phone-ar');
});

let drawer;
await step('game starts and the drawer chooses a word', async () => {
  await host.click('#startBtn');
  drawer = await findDrawer(players);
  check((await drawer.$$('.choice')).length === 3, 'three word options');
  await shot(drawer, `06-choose-${drawer.label}`);
  await drawer.click('.choice');
  await Promise.all(players.map(p => waitState(p, 'drawing')));
});

await step('the drawing shows up on every screen', async () => {
  await drawPicture(drawer);
  await sleep(700);
  for (const p of players.filter(p => p !== drawer)) {
    const [r, g, b] = await pixelAt(p, 0.5, 0.7);
    check(r > 200 && g > 150 && b < 100, `${p.label} sees the yellow fill (got ${r},${g},${b})`);
  }
  for (const p of players) await shot(p, `07-drawing-${p.label}`);
});

await step('guesses: wrong, close, then correct in Arabic and English', async () => {
  const [g1, g2] = players.filter(p => p !== drawer);
  const words = await drawerWords(drawer);
  await say(g1, 'banana');
  await say(g1, words.en.slice(0, -1));
  await g1.waitForSelector('.msg.close', { timeout: 5000 });
  await say(g1, arabicVariant(words.ar));
  await g1.waitForSelector('.word-full', { timeout: 5000 });
  await shot(g1, `08-guessed-${g1.label}`);
  await say(g2, words.en);
  await Promise.all(players.map(p => waitState(p, 'reveal')));
  for (const p of players) await shot(p, `09-reveal-${p.label}`);
});

await step('Continue starts the next turn as soon as everyone is ready', async () => {
  check(!(await host.$eval('#continueBtn', el => el.hidden)), 'Continue button is shown');
  await host.click('#continueBtn');
  await waitText(host, '#continueBtn', 'Waiting for the others… (1/3)');
  const t0 = Date.now();
  await guest.click('#continueBtn');
  await phone.click('#continueBtn');
  await Promise.all(players.map(p => waitState(p, 'choosing')));
  const ms = Date.now() - t0;
  check(ms < 2500, `next turn took ${ms} ms`);
  console.log(`      next turn started ${ms} ms after the last Continue`);
});

await step('a refresh mid-turn keeps the seat and score', async () => {
  const before = await phone.$eval('#playerList .me .pscore', el => el.textContent);
  await phone.reload({ waitUntil: 'networkidle0' });
  await phone.waitForFunction(() => !document.querySelector('#room').hidden, { timeout: 10_000 });
  const after = await phone.$eval('#playerList .me .pscore', el => el.textContent);
  check(before === after, `score kept (${before} → ${after})`);
});

await step('the remaining turns play through to the final scores', async () => {
  await playQuickTurn(players, 'choosing');
  await playQuickTurn(players, 'gameover');
  for (const p of players) await shot(p, `10-gameover-${p.label}`);
  const podium = await host.$$eval('#podium li', els => els.length);
  check(podium === 3, 'three players on the final ranking');
});

const q1 = await open('quick1', 'desktop', 'en');
const q2 = await open('quick2', 'phone', 'ar');
await step('quick play: two strangers meet in the same public room', async () => {
  await q1.goto(BASE, { waitUntil: 'networkidle0' });
  await q1.type('#nameInput', 'Quick One');
  await q1.click('#langSeg [data-lang="ar"]');
  await q1.click('#playBtn');
  await waitState(q1, 'lobby');
  const quickCode = new URL(q1.url()).searchParams.get('r');
  await q2.goto(BASE, { waitUntil: 'networkidle0' });
  await q2.waitForFunction(c => [...document.querySelectorAll('#roomList .room-host')].some(el => el.textContent.includes('Quick One')), { timeout: 12_000 }, quickCode);
  await shot(q2, '11-public-rooms-phone');
  await q2.type('#nameInput', 'سريع');
  await q2.click('#langSeg [data-lang="ar"]');
  await q2.click('#playBtn');
  await waitState(q2, 'lobby');
  check(new URL(q2.url()).searchParams.get('r') === quickCode, 'joined the existing public room');
  await q1.waitForFunction(() => /Game starts in/.test(document.querySelector('#lobbyStatus').textContent), { timeout: 5000 });
});

await step('the host can kick a player', async () => {
  const target = await q1.$('#playerList .kick');
  check(target, 'kick button for the other player');
  await target.click();
  await q2.waitForFunction(() => document.querySelector('#room').hidden, { timeout: 5000 });
  check((await text(q2, '#homeError')).length > 0, 'kicked player sees why');
  await q1.click('#leaveBtn');
  check((await state(q1)) === 'home', 'leave returns home');
});

await step('no sideways scrolling and no script errors on any screen', async () => {
  for (const p of pages) await noOverflow(p, 'the end');
  const errors = pages.flatMap(p => p.errors.map(e => `${p.label}: ${e}`));
  check(!errors.length, errors.join(' | '));
});

if (ADMIN_PASSWORD) {
  const admin = await open('admin', 'desktop');
  const adminPhone = await open('admin-phone', 'phone');
  await sleep(2500); // statistics are written in the background
  await step('dashboard rejects a wrong password', async () => {
    await admin.goto(`${BASE}/admin`, { waitUntil: 'networkidle0' });
    await admin.type('#password', 'not-the-password');
    await admin.click('#loginForm button');
    await admin.waitForFunction(() => document.querySelector('#loginError').textContent.length > 0, { timeout: 5000 });
    check(await admin.$eval('#dash', el => el.hidden), 'dashboard stays hidden');
  });
  await step('dashboard shows the games, players and rooms just played', async () => {
    await admin.click('#password', { clickCount: 3 });
    await admin.type('#password', ADMIN_PASSWORD);
    await admin.click('#loginForm button');
    await admin.waitForSelector('#dash:not([hidden]) #kpis .tile');
    const games = await admin.$eval('#recentGames', el => el.textContent);
    check(games.includes('Family night'), 'recent games list the named room');
    check(games.includes('Finished'), 'the game is marked finished');
    const people = await admin.$eval('#recentPlayers', el => el.textContent);
    for (const name of ['Sara', 'Lina', 'عمر']) check(people.includes(name), `recent players include ${name}`);
    check((await admin.$$('#peopleChart svg path')).length >= 2, 'daily chart drawn');
    check((await admin.$eval('#topWords', el => el.textContent)).includes('magnifying glass') ||
      (await admin.$eval('#topWords', el => el.textContent)).includes('hot air balloon') ||
      (await admin.$eval('#topWords', el => el.textContent)).includes('traffic light'), 'words played are listed');
    await shot(admin, '12-dashboard-desktop');
    await admin.click('#themeBtn');
    await shot(admin, '13-dashboard-dark');
    await adminPhone.goto(`${BASE}/admin`, { waitUntil: 'networkidle0' });
    await adminPhone.type('#password', ADMIN_PASSWORD);
    await adminPhone.click('#loginForm button');
    await adminPhone.waitForSelector('#dash:not([hidden]) #kpis .tile');
    await shot(adminPhone, '14-dashboard-phone');
    await noOverflow(adminPhone, 'dashboard');
  });
}

await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed · screenshots in e2e/screenshots`);
process.exit(failed.length ? 1 : 0);

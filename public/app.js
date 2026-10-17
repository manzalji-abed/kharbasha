import { Board } from './board.js';
import { getLang, setLang, t } from './i18n.js';
import { RoomConnection, api } from './net.js';
import { VoiceChat } from './voice.js';

const AVATARS = ['🐱', '🐶', '🦊', '🐼', '🐨', '🐯', '🦁', '🐸', '🐵', '🐰', '🐻', '🐷', '🐮', '🐔', '🐧', '🦉', '🐙', '🦄', '🐲', '🐢', '🐝', '🦋', '🐳', '🐪'];
const COLORS = [
  '#000000', '#4b5563', '#9ca3af', '#ffffff', '#7f1d1d', '#dc2626', '#f97316', '#facc15', '#16a34a',
  '#86efac', '#0ea5e9', '#1d4ed8', '#7c3aed', '#ec4899', '#fbcfe8', '#92400e', '#d6a77a', '#fde68a',
];
const SIZES = [3, 6, 12, 22, 40];
const LANG_BADGE = { en: 'EN', ar: 'ع', both: 'EN+ع' };
const ROOM_CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{5}$/;
const JOIN_TIMEOUT_MS = 10_000;
const TOKEN_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const TUNES = {
  correct: [[660, 0], [880, 0.09]],
  start: [[523, 0], [659, 0.1], [784, 0.2]],
  turn: [[784, 0], [988, 0.12]],
  win: [[523, 0], [659, 0.12], [784, 0.24], [1047, 0.36]],
  tick: [[1100, 0]],
};

const $ = sel => document.querySelector(sel);

// Tiny DOM builder. Strings become text nodes, so player names and chat can never inject HTML.
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  el.append(...children.filter(c => c != null && c !== false));
  return el;
}

// ---------------------------------------------------------------- storage (may be blocked)

function storageArea(kind) {
  try { return window[kind]; } catch { return null; }
}

const store = {
  get(key, fallback, kind = 'localStorage') {
    try {
      const raw = storageArea(kind)?.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, value, kind = 'localStorage') {
    try { storageArea(kind)?.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
  remove(key, kind = 'localStorage') {
    try { storageArea(kind)?.removeItem(key); } catch { /* storage unavailable */ }
  },
};

// ---------------------------------------------------------------- state

const randomToken = length => Array.from(crypto.getRandomValues(new Uint8Array(length)), b => TOKEN_CHARS[b & 63]).join('');
const validId = (value, min) => typeof value === 'string' && new RegExp(`^[\\w-]{${min},64}$`).test(value);

const savedAvatar = store.get('avatar', null);
const savedToken = store.get('token', null, 'sessionStorage');
const savedVisitor = store.get('visitor', null);
const profile = {
  name: String(store.get('name', '') ?? ''),
  avatar: Number.isInteger(savedAvatar) && savedAvatar >= 0 && savedAvatar < AVATARS.length
    ? savedAvatar
    : Math.floor(Math.random() * AVATARS.length),
  // Per-tab secret that lets the server hand your seat back after a refresh or a dropped connection.
  token: validId(savedToken, 16) ? savedToken : randomToken(24),
  // Anonymous per-browser id, only used to count unique and returning players.
  visitor: validId(savedVisitor, 8) ? savedVisitor : randomToken(20),
};
store.set('token', profile.token, 'sessionStorage');
store.set('visitor', profile.visitor);

const initialUiLang = store.get('uiLang', null) ?? (navigator.language?.toLowerCase().startsWith('ar') ? 'ar' : 'en');
let wordLang = ['en', 'ar', 'both'].includes(store.get('wordLang', null)) ? store.get('wordLang', null) : initialUiLang;
let muted = store.get('muted', false) === true;
let inviteCode = (new URLSearchParams(location.search).get('r') ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);

let room = null; // latest room:state from the server
let conn = null; // RoomConnection while in (or joining) a room
let joinTimer = null;
let deadline = 0;
let prevState = null;
let lastTick = 0;
let lastRooms = [];
let roomPoll = null;
let toastTimer = null;
let inviteInfo = null; // room shown on the invite card
let audio = null;
const pendingText = new Map(); // lobby text field → timer for its not-yet-sent edit

const send = (type, data) => conn?.send(type, data);
const board = new Board($('#board'), op => send('draw', op));
const voice = new VoiceChat({ send, onChange: () => room && renderVoice() });

const secondsLeft = () => (deadline ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) : 0);
const me = () => room.players.find(p => p.id === room.me.id);
const isHost = () => room.me.id === room.hostId;
const dirOf = lang => (lang === 'ar' ? 'rtl' : 'ltr');

// ---------------------------------------------------------------- messages from the room

const handlers = {
  'room:state': onState,
  'room:closed': ({ reason } = {}) => closeRoom(`err_${reason}`),
  chat: m => addChat(m),
  draw: op => board.apply(op),
  'draw:history': ops => Array.isArray(ops) && board.load(ops),
  rtc: ({ from, signal } = {}) => voice.handleSignal(from, signal),
};

// ---------------------------------------------------------------- home screen

function initHome() {
  const name = $('#nameInput');
  name.value = profile.name;
  name.addEventListener('input', () => {
    profile.name = name.value;
    store.set('name', profile.name);
    name.classList.remove('needs-name');
    if (name.value.trim() && $('#homeError').textContent === t('needName')) showError('');
  });
  $('#avPrev').onclick = () => cycleAvatar(-1);
  $('#avNext').onclick = () => cycleAvatar(1);
  $('#avatar').onclick = () => cycleAvatar(1);
  for (const btn of $('#langSeg').children) {
    btn.onclick = () => {
      wordLang = btn.dataset.lang;
      store.set('wordLang', wordLang);
      renderLangSeg();
    };
  }
  $('#playBtn').onclick = () => openNewRoom('/api/quick', { lang: wordLang, visitor: profile.visitor });
  $('#createBtn').onclick = () => openNewRoom('/api/rooms', { lang: wordLang, isPublic: false, visitor: profile.visitor });
  $('#inviteJoinBtn').onclick = () => joinRoom(inviteCode);
  $('#skipInviteBtn').onclick = () => forgetRoom();
  $('#joinForm').onsubmit = e => {
    e.preventDefault();
    const code = $('#codeInput').value.trim().toUpperCase();
    if (code) joinRoom(code);
  };
  $('#logo').onclick = e => {
    if (!room) return;
    e.preventDefault();
    closeRoom();
  };
  if (inviteCode) $('#codeInput').value = inviteCode;
  renderAvatar();
  renderLangSeg();
}

function cycleAvatar(step) {
  profile.avatar = (profile.avatar + step + AVATARS.length) % AVATARS.length;
  store.set('avatar', profile.avatar);
  renderAvatar();
}

function renderAvatar() {
  $('#avatar').textContent = AVATARS[profile.avatar];
}

function renderLangSeg() {
  for (const btn of $('#langSeg').children) btn.setAttribute('aria-pressed', String(btn.dataset.lang === wordLang));
}

// The room's own name, or "<host>'s room" until the host gives it one.
const roomDisplayName = (name, host) => name || (host ? t('defaultRoomName', { name: host }) : '');

// Invite link mode: a focused card for that one room (name + avatar + Join) instead of the full menu.
function renderInvite() {
  const show = Boolean(inviteCode) && !room;
  $('#inviteBanner').hidden = !show;
  $('#inviteActions').hidden = !show;
  $('#mainActions').hidden = show;
  if (!show) return;
  const langName = { en: t('langEn'), ar: t('langAr'), both: t('langBoth') };
  $('#inviteRoom').textContent = inviteInfo ? roomDisplayName(inviteInfo.name, inviteInfo.host) || inviteCode : inviteCode;
  $('#inviteMeta').textContent = inviteInfo
    ? `${t('inviteMeta', { lang: langName[inviteInfo.lang] ?? '', n: inviteInfo.players, max: inviteInfo.maxPlayers })} · ${inviteCode}`
    : '';
}

async function loadInvite() {
  renderInvite();
  try {
    inviteInfo = await api(`/api/rooms/${inviteCode}`);
  } catch (err) {
    if (err.status === 404) {
      forgetRoom();
      showError(t('err_notFound'));
    }
  }
  renderInvite();
  if (!profile.name.trim()) $('#nameInput').focus();
}

function showError(message) {
  $('#homeError').textContent = message;
}

function setBusy(busy) {
  for (const id of ['#playBtn', '#createBtn', '#inviteJoinBtn']) $(id).disabled = busy;
}

// Everyone picks a nickname before taking a seat.
function requireName() {
  const input = $('#nameInput');
  if (input.value.trim()) return true;
  showError(t('needName'));
  input.classList.remove('needs-name');
  void input.offsetWidth; // restart the shake animation
  input.classList.add('needs-name');
  input.focus();
  return false;
}

// Quick play or a new private room: the server picks/creates the room and returns its code.
async function openNewRoom(path, body) {
  if (!requireName()) return;
  showError('');
  setBusy(true);
  try {
    const { code, error } = await api(path, body);
    if (error) throw Object.assign(new Error(error), { key: error });
    joinRoom(code);
  } catch (err) {
    setBusy(false);
    showError(t(`err_${err.key ?? 'generic'}`));
  }
}

function joinRoom(code) {
  if (!requireName()) return;
  if (!ROOM_CODE.test(code)) return showError(t('err_notFound'));
  showError('');
  setBusy(true);
  conn?.close();
  $('#messages').replaceChildren();
  conn = new RoomConnection(code, {
    // Sent on every (re)connect; the token lets the server give back this player's seat.
    onOpen: () => send('join', { name: profile.name.trim(), avatar: profile.avatar, token: profile.token, visitor: profile.visitor }),
    onMessage: (type, data) => handlers[type]?.(data),
    onDrop: () => room && toast(t('err_offline')),
  });
  clearTimeout(joinTimer);
  joinTimer = setTimeout(() => !room && closeRoom('err_generic'), JOIN_TIMEOUT_MS);
}

function forgetRoom() {
  store.remove('room', 'sessionStorage');
  history.replaceState(null, '', location.pathname);
  inviteCode = '';
  inviteInfo = null;
  renderInvite();
}

function startRoomPolling() {
  clearInterval(roomPoll);
  refreshRooms();
  roomPoll = setInterval(refreshRooms, 5000);
}

function refreshRooms() {
  if (room || document.hidden) return;
  api('/api/rooms')
    .then(rooms => {
      lastRooms = Array.isArray(rooms) ? rooms : [];
      renderRooms();
    })
    .catch(() => { /* keep showing the last list */ });
}

function renderRooms() {
  const list = $('#roomList');
  if (!lastRooms.length) return list.replaceChildren(h('li', { class: 'empty' }, t('noRooms')));
  list.replaceChildren(...lastRooms.map(r => {
    const status = r.state === 'lobby' || r.state === 'gameover' ? t('inLobby') : t('inRound', { r: r.round, t: r.rounds });
    return h('li', { class: 'room-item' },
      h('span', { class: `lang-badge ${r.lang}` }, LANG_BADGE[r.lang] ?? r.lang),
      h('span', { class: 'room-meta' },
        h('bdi', { class: 'room-host' }, roomDisplayName(r.name, r.host) || r.code),
        h('small', {}, `${t('playersCount', { n: r.players, max: r.maxPlayers })} · ${status}`)),
      h('button', {
        class: 'btn small green',
        disabled: r.players >= r.maxPlayers,
        onclick: () => joinRoom(r.code),
      }, t('join')));
  }));
}

// ---------------------------------------------------------------- entering / leaving a room

function onState(state) {
  if (!conn) return;
  const opening = !room;
  room = state;
  deadline = state.timeLeft ? Date.now() + state.timeLeft : 0;
  if (opening) openRoom();
  voice.sync(state.players, state.me.id, state.voiceAllowed);
  render();
}

function openRoom() {
  clearInterval(roomPoll);
  clearTimeout(joinTimer);
  setBusy(false);
  $('#home').hidden = true;
  $('#room').hidden = false;
  store.set('room', room.code, 'sessionStorage');
  history.replaceState(null, '', `?r=${room.code}`);
  inviteCode = room.code;
  window.scrollTo(0, 0);
}

function closeRoom(errorKey) {
  voice.leave({ notify: false });
  if (room) send('leave');
  conn?.close();
  conn = null;
  clearTimeout(joinTimer);
  setBusy(false);
  room = null;
  deadline = 0;
  prevState = null;
  board.setEnabled(false);
  board.apply({ k: 'x' });
  $('#messages').replaceChildren();
  $('#room').hidden = true;
  $('#home').hidden = false;
  forgetRoom();
  document.title = 'Kharbasha · خربشة';
  showError(errorKey ? t(errorKey) : '');
  startRoomPolling();
}

function shareInvite() {
  const url = `${location.origin}/?r=${room.code}`;
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    navigator.share({ title: 'Kharbasha · خربشة', text: t('tagline'), url }).catch(err => {
      if (err.name !== 'AbortError') copyInvite(url);
    });
    return;
  }
  copyInvite(url);
}

function copyInvite(url) {
  const fallback = () => {
    const area = h('textarea', { readonly: true, style: 'position:fixed;opacity:0' });
    area.value = url;
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  };
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(url).catch(fallback);
  else fallback();
  toast(t('copied'));
}

// ---------------------------------------------------------------- room rendering

function render() {
  const drawer = room.players.find(p => p.id === room.drawerId);
  const amDrawer = room.me.id === room.drawerId;
  $('#room').dataset.state = room.state;
  board.setEnabled(room.state === 'drawing' && amDrawer);
  renderBar(drawer, amDrawer);
  renderPlayers();
  renderToolbar(drawer, amDrawer);
  renderOverlay(drawer, amDrawer);
  fitBoard();
  renderVoice();
  const guessing = room.state === 'drawing' && !amDrawer && !me()?.guessed;
  setPlaceholder($('#chatInput'), guessing ? t('guessPh') : t('chatPh'));
  onTransition(amDrawer);
  prevState = room.state;
  tick();
}

function onTransition(amDrawer) {
  if (room.state === prevState) return;
  lastTick = 0;
  if (room.state === 'choosing' && amDrawer) sound('turn');
  if (room.state === 'drawing') {
    sound('start');
    if (amDrawer) toast(t('yourTurn'));
    else if (matchMedia('(pointer: fine)').matches) $('#chatInput').focus();
  }
  if (room.state === 'gameover') sound('win');
}

// On desktop and tablet landscape the board takes whatever height the toolbar leaves,
// keeping its 4:3 shape. Other layouts (phones, portrait tablets) size it in CSS.
function fitBoard() {
  const stage = $('#stage');
  const wrap = $('#boardWrap');
  const fit = getComputedStyle(stage).getPropertyValue('--fit').trim() === '1';
  if (!fit || wrap.classList.contains('expanded') || !stage.clientHeight) {
    wrap.style.width = '';
    return;
  }
  const toolbar = $('#toolbar');
  const gap = parseFloat(getComputedStyle(stage).rowGap) || 0;
  const free = stage.clientHeight - (toolbar.hidden ? 0 : toolbar.offsetHeight + gap);
  wrap.style.width = `${Math.max(240, Math.min(stage.clientWidth, (free * 4) / 3))}px`;
}

function wordSpans(label) {
  return Object.entries(label).map(([lang, word]) => h('span', { lang, dir: dirOf(lang) }, word));
}

function renderBar(drawer, amDrawer) {
  const st = room.state;
  const playing = st === 'choosing' || st === 'drawing' || st === 'reveal';
  const title = roomDisplayName(room.settings.name, room.players.find(p => p.id === room.hostId)?.name);
  $('#roomTitle').textContent = title;
  $('#roundInfo').textContent = playing ? t('round', { r: room.round, t: room.settings.rounds }) : t('roomCode', { code: room.code });
  document.title = `${title} · Kharbasha`;

  const area = $('#wordArea');
  area.replaceChildren();
  if (st === 'drawing' && room.me.word) {
    area.append(h('span', { class: 'word-label' }, amDrawer ? t('youDraw') : '✅'));
    for (const [lang, word] of Object.entries(room.me.word)) area.append(h('span', { class: 'word-full', lang, dir: dirOf(lang) }, word));
  } else if (st === 'drawing') {
    for (const mask of room.masks ?? []) area.append(maskEl(mask));
  } else if (st === 'choosing') {
    area.append(h('span', { class: 'word-status' }, amDrawer ? t('chooseWord') : t('isChoosing', { name: drawer?.name ?? '' })));
  }
}

function maskEl(mask) {
  const letters = mask.chars.filter(c => c === null || /[\p{L}\p{N}]/u.test(c)).length;
  const size = mask.chars.length > 12 ? ' long' : mask.chars.length > 8 ? ' mid' : '';
  return h('div', { class: `mask${size}`, lang: mask.lang, dir: dirOf(mask.lang), 'aria-label': t('letters', { n: letters }) },
    ...mask.chars.map(c => (c === ' ' ? h('span', { class: 'gap' }) : h('span', { class: c === null ? 'slot' : 'slot shown' }, c ?? ''))),
    h('sup', { class: 'count' }, String(letters)));
}

function renderPlayers() {
  const host = isHost();
  const playing = room.state === 'choosing' || room.state === 'drawing' || room.state === 'reveal';
  const ranked = [...room.players].sort((a, b) => b.score - a.score);
  $('#playerList').replaceChildren(...ranked.map((p, i) => {
    const classes = ['player'];
    if (!p.connected) classes.push('offline');
    if (p.guessed) classes.push('guessed');
    if (playing && p.id === room.drawerId) classes.push('drawing');
    if (p.id === room.me.id) classes.push('me');
    return h('li', { class: classes.join(' '), 'data-id': p.id },
      h('span', { class: 'rank' }, `#${i + 1}`),
      h('span', { class: 'avatar' }, AVATARS[p.avatar] ?? '🙂'),
      h('span', { class: 'pinfo' },
        h('bdi', { class: 'pname' }, p.name),
        h('span', { class: 'pscore' }, `${p.score} ${t('pts')}`, p.id === room.me.id ? ` · ${t('you')}` : '')),
      h('span', { class: 'badges' },
        p.voice ? voiceBadge(p) : null,
        p.id === room.hostId ? h('span', { title: t('host') }, '👑') : null,
        playing && p.id === room.drawerId ? h('span', {}, '✏️') : null,
        host && p.id !== room.me.id
          ? h('button', {
            class: 'kick',
            title: t('kick'),
            'aria-label': t('kick'),
            onclick: () => confirm(t('kickConfirm', { name: p.name })) && send('kick', p.id),
          }, '✕')
          : null));
  }));
}

// 🎙️ in voice · 🔇 muted their own mic · 🔕 muted on this device. Other players' badges toggle "mute for me".
function voiceBadge(p) {
  const badge = p.id === room.me.id
    ? h('span', { class: 'voice-badge' })
    : h('button', { class: 'voice-badge', onclick: () => voice.toggleBlocked(p.id) });
  paintVoiceBadge(badge, p);
  return badge;
}

function paintVoiceBadge(badge, p) {
  const blocked = voice.blocked.has(p.id);
  const label = blocked ? t('voiceUnmuteForMe') : p.muted ? t('voiceMutedSelf') : t('voiceOn');
  badge.textContent = blocked ? '🔕' : p.muted ? '🔇' : '🎙️';
  badge.title = blocked || p.id === room.me.id ? label : `${label} · ${t('voiceMuteForMe')}`;
  badge.setAttribute('aria-label', p.id === room.me.id ? label : blocked ? t('voiceUnmuteForMe') : t('voiceMuteForMe'));
  if (badge.tagName === 'BUTTON') badge.setAttribute('aria-pressed', String(blocked));
}

// Voice buttons and the speaking glow; runs on every room update and whenever someone starts/stops talking.
function renderVoice() {
  const allowed = room.voiceAllowed;
  $('#voiceBtn').hidden = !allowed || voice.active;
  $('#micBtn').hidden = !voice.active;
  $('#hangupBtn').hidden = !voice.active;
  if (voice.active) {
    $('#micBtn').replaceChildren(voice.muted ? '🔇 ' : '🎙️ ', h('span', {}, voice.muted ? t('unmute') : t('mute')));
    $('#micBtn').setAttribute('aria-pressed', String(voice.muted));
    $('#micBtn').classList.toggle('muted', voice.muted);
  }
  for (const li of $('#playerList').children) {
    const p = room.players.find(x => x.id === li.dataset.id);
    li.classList.toggle('speaking', voice.speaking.has(li.dataset.id));
    li.dataset.voice = voice.connectionOf(li.dataset.id) ?? '';
    const badge = li.querySelector('.voice-badge');
    if (badge && p) paintVoiceBadge(badge, p);
  }
}

async function joinVoice() {
  $('#voiceBtn').disabled = true;
  try {
    await voice.join(room.me.id);
  } catch (err) {
    toast(t(err?.name === 'NotAllowedError' ? 'micDenied' : 'micError'));
  } finally {
    $('#voiceBtn').disabled = false;
  }
}

function renderToolbar(drawer, amDrawer) {
  const st = room.state;
  const canDraw = st === 'drawing' && amDrawer;
  $('#toolbar').hidden = st === 'lobby' || st === 'gameover';
  $('#tools').hidden = !canDraw;
  const watching = $('#watching');
  watching.hidden = canDraw;
  if (st === 'drawing') watching.textContent = t('nowDrawing', { name: drawer?.name ?? '' });
  else if (st === 'choosing') watching.textContent = amDrawer ? t('chooseWord') : t('isChoosing', { name: drawer?.name ?? '' });
  else watching.textContent = '';
}

function renderOverlay(drawer, amDrawer) {
  const st = room.state;
  $('#overlay').hidden = st === 'drawing';
  $('#boardWrap').classList.toggle('expanded', st === 'lobby' || st === 'gameover');
  $('#lobbyPanel').hidden = st !== 'lobby';
  $('#choosePanel').hidden = st !== 'choosing';
  $('#revealPanel').hidden = st !== 'reveal';
  $('#overPanel').hidden = st !== 'gameover';
  if (st === 'lobby') renderLobby();
  else if (st === 'choosing') renderChoose(drawer, amDrawer);
  else if (st === 'reveal') renderReveal();
  else if (st === 'gameover') renderGameOver();
}

function renderLobby() {
  const host = isHost();
  const s = room.settings;
  const sync = (sel, value) => {
    const el = $(sel);
    if (document.activeElement !== el && el.value !== String(value)) el.value = String(value);
    if (el.disabled === host) el.disabled = !host;
  };
  if (!pendingText.has('#setName')) sync('#setName', s.name);
  setPlaceholder($('#setName'), roomDisplayName('', room.players.find(p => p.id === room.hostId)?.name));
  sync('#setLang', s.lang);
  sync('#setRounds', s.rounds);
  sync('#setTime', s.drawTime);
  sync('#setMax', s.maxPlayers);
  sync('#setHints', s.hints);
  $('#setPublic').checked = room.isPublic;
  $('#setPublic').disabled = !host;
  $('#setCustomOnly').checked = s.customOnly;
  $('#customWrap').hidden = !host;
  $('#customOnlyWrap').hidden = !host;
  const custom = $('#setCustom');
  // Never overwrite text the host is typing or hasn't sent yet.
  if (host && document.activeElement !== custom && !pendingText.has('#setCustom') && typeof room.me.customText === 'string') custom.value = room.me.customText;
  $('#customInfo').hidden = host || !room.customCount;
  $('#customInfo').textContent = t('customCount', { n: room.customCount });
  $('#startBtn').hidden = !host;
  $('#startBtn').disabled = room.players.filter(p => p.connected).length < 2;
  renderLobbyStatus();
}

function renderLobbyStatus() {
  const enough = room.players.filter(p => p.connected).length >= 2;
  let text = '';
  if (!enough) text = t('needPlayers');
  else if (deadline) text = t('autoStart', { s: secondsLeft() });
  else if (!isHost()) text = t('waitingHost');
  $('#lobbyStatus').textContent = text;
}

function renderChoose(drawer, amDrawer) {
  $('#chooseTitle').textContent = amDrawer ? t('chooseWord') : t('isChoosing', { name: drawer?.name ?? '' });
  const box = $('#choices');
  if (!amDrawer || !room.me.options) {
    box.replaceChildren(h('div', { class: 'big-avatar' }, AVATARS[drawer?.avatar] ?? '🙂'));
    return;
  }
  box.replaceChildren(...room.me.options.map((label, i) =>
    h('button', { class: 'btn choice', onclick: () => send('choose', i) }, ...wordSpans(label))));
}

function renderReveal() {
  const reveal = room.reveal ?? {};
  $('#revealReason').textContent = t(reveal.reason ?? 'timeUp');
  $('#revealLabel').hidden = !reveal.word;
  $('#revealWord').replaceChildren(...(reveal.word ? wordSpans(reveal.word) : []));
  const rows = [...room.players].sort((a, b) => b.gain - a.gain);
  $('#gains').replaceChildren(...rows.map(p => h('li', { class: p.gain ? 'plus' : '' },
    h('span', {}, AVATARS[p.avatar] ?? '🙂'),
    h('bdi', {}, p.name),
    h('b', { dir: 'ltr' }, p.gain ? `+${p.gain}` : '0'))));

  // Continue: the next turn starts as soon as everyone still here has pressed it.
  const btn = $('#continueBtn');
  const ready = room.ready ?? [];
  const waiting = ready.includes(room.me.id);
  btn.hidden = !reveal.word;
  btn.disabled = waiting;
  btn.textContent = waiting
    ? t('waitingOthers', { n: ready.length, total: room.players.filter(p => p.connected).length })
    : t('continue');
  renderRevealStatus();
}

function renderRevealStatus() {
  $('#revealStatus').textContent = deadline ? t('nextTurnIn', { s: secondsLeft() }) : '';
}

function renderGameOver() {
  const medals = ['🥇', '🥈', '🥉'];
  const ranked = [...room.players].sort((a, b) => b.score - a.score);
  $('#podium').replaceChildren(...ranked.map((p, i) => h('li', { class: i < 3 ? `top${i + 1}` : '' },
    h('span', { class: 'medal' }, medals[i] ?? `#${i + 1}`),
    h('span', {}, AVATARS[p.avatar] ?? '🙂'),
    h('bdi', {}, p.name),
    h('b', {}, String(p.score)))));
  $('#againBtn').hidden = !isHost();
}

// Runs four times a second: countdowns are computed locally from the server's deadline.
function tick() {
  if (!room) return;
  const left = secondsLeft();
  const counting = deadline && (room.state === 'choosing' || room.state === 'drawing');
  const timer = $('#timer');
  timer.textContent = counting ? String(left) : '⏱';
  timer.classList.toggle('urgent', room.state === 'drawing' && left <= 10);
  if (room.state === 'drawing' && left > 0 && left <= 10 && left !== lastTick) {
    lastTick = left;
    sound('tick');
  }
  if (room.state === 'lobby') renderLobbyStatus();
  if (room.state === 'reveal') renderRevealStatus();
  if (room.state === 'gameover') $('#overStatus').textContent = deadline ? t('backSoon', { s: left }) : '';
}

// ---------------------------------------------------------------- lobby settings & toolbar

function initLobby() {
  const fill = (sel, values) => $(sel).replaceChildren(...values.map(v => h('option', { value: v }, String(v))));
  fill('#setRounds', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  fill('#setTime', [30, 45, 60, 80, 100, 120, 150, 180, 240]);
  fill('#setMax', Array.from({ length: 15 }, (_, i) => i + 2));
  fill('#setHints', [0, 1, 2, 3]);

  const update = patch => send('settings', patch);
  $('#setLang').onchange = e => update({ lang: e.target.value });
  $('#setRounds').onchange = e => update({ rounds: Number(e.target.value) });
  $('#setTime').onchange = e => update({ drawTime: Number(e.target.value) });
  $('#setMax').onchange = e => update({ maxPlayers: Number(e.target.value) });
  $('#setHints').onchange = e => update({ hints: Number(e.target.value) });
  $('#setPublic').onchange = e => update({ isPublic: e.target.checked });
  $('#setCustomOnly').onchange = e => update({ customOnly: e.target.checked });
  // Text fields are sent shortly after typing stops, or at once when they lose focus.
  const bindText = (sel, key) => {
    const el = $(sel);
    const flush = () => {
      if (!pendingText.has(sel)) return;
      clearTimeout(pendingText.get(sel));
      pendingText.delete(sel);
      update({ [key]: el.value });
    };
    el.addEventListener('input', () => {
      clearTimeout(pendingText.get(sel));
      pendingText.set(sel, setTimeout(flush, 500));
    });
    el.addEventListener('blur', flush);
  };
  bindText('#setName', 'name');
  bindText('#setCustom', 'customText');
  $('#startBtn').onclick = () => send('start');
  $('#againBtn').onclick = () => send('start');
  $('#continueBtn').onclick = () => send('ready');
}

function initToolbar() {
  $('#palette').replaceChildren(...COLORS.map(color => h('button', {
    class: 'swatch',
    style: `--c:${color}`,
    'data-color': color,
    'aria-label': color,
    onclick: () => {
      board.color = color;
      if (board.tool === 'eraser') board.tool = 'pen';
      syncTools();
    },
  })));
  $('#sizes').replaceChildren(...SIZES.map(size => h('button', {
    class: 'size',
    'data-size': size,
    'aria-label': `${size}px`,
    onclick: () => {
      board.size = size;
      if (board.tool === 'fill') board.tool = 'pen';
      syncTools();
    },
  }, h('span', { style: `--s:${Math.min(Math.max(size, 4), 28)}px` }))));
  for (const btn of document.querySelectorAll('[data-tool]')) {
    btn.onclick = () => {
      board.tool = btn.dataset.tool;
      syncTools();
    };
  }
  $('#undoBtn').onclick = () => board.undo();
  $('#clearBtn').onclick = () => board.clear();
  document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z' || !board.enabled) return;
    if (e.target.closest?.('input, textarea')) return;
    e.preventDefault();
    board.undo();
  });
  syncTools();
}

function syncTools() {
  for (const btn of $('#palette').children) btn.classList.toggle('active', btn.dataset.color === board.color && board.tool !== 'eraser');
  for (const btn of $('#sizes').children) btn.classList.toggle('active', Number(btn.dataset.size) === board.size);
  for (const btn of document.querySelectorAll('[data-tool]')) btn.classList.toggle('active', btn.dataset.tool === board.tool);
  $('#board').dataset.tool = board.tool;
}

// ---------------------------------------------------------------- chat

function initChat() {
  const input = $('#chatInput');
  // Phone keyboards build each word in a "composition"; touching the field before the word is
  // finished makes letters vanish or reappear. So Enter waits for the composition to end.
  let composing = false;
  let sendWhenDone = false;
  const submit = () => {
    const text = input.value.trim();
    if (text) send('chat', text);
    input.value = '';
  };
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => {
    composing = false;
    if (sendWhenDone) {
      sendWhenDone = false;
      setTimeout(submit);
    }
  });
  $('#chatForm').onsubmit = e => {
    e.preventDefault();
    if (composing) sendWhenDone = true;
    else submit();
  };
}

// Only touch a text field's attributes when they really change: rewriting them while someone is
// typing can reset the phone keyboard mid-word.
function setPlaceholder(el, text) {
  if (el.placeholder !== text) el.placeholder = text;
}

// System lines remember their message so they can be re-translated when the UI language changes.
const systemLines = new WeakMap();

function retranslateChat() {
  for (const line of $('#messages').children) {
    const m = systemLines.get(line);
    if (m) line.textContent = t(`sys_${m.key}`, m.params);
  }
}

function addChat(m) {
  const box = $('#messages');
  // On phones the newest message sits at the top, right under the guess box (column-reverse),
  // and the browser keeps it in view by itself.
  const newestFirst = getComputedStyle(box).flexDirection === 'column-reverse';
  const atBottom = !newestFirst && box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  let line;
  if (m.type === 'msg' || m.type === 'secret') {
    line = h('div', { class: `msg ${m.type}` }, h('bdi', { class: 'who' }, m.name), ': ', h('bdi', {}, m.text));
  } else {
    line = h('div', { class: `msg ${m.type}` }, t(`sys_${m.key}`, m.params));
    systemLines.set(line, m);
  }
  box.append(line);
  while (box.childElementCount > 150) box.firstElementChild.remove();
  if (atBottom) box.scrollTop = box.scrollHeight;
  if (m.type === 'correct') sound('correct');
}

// ---------------------------------------------------------------- sound, toast, language

function sound(kind) {
  if (muted) return;
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') audio.resume();
    const now = audio.currentTime;
    const tickSound = kind === 'tick';
    for (const [freq, at] of TUNES[kind]) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = tickSound ? 'square' : 'triangle';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + at);
      gain.gain.exponentialRampToValueAtTime(tickSound ? 0.03 : 0.2, now + at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + (tickSound ? 0.06 : 0.22));
      osc.connect(gain).connect(audio.destination);
      osc.start(now + at);
      osc.stop(now + at + 0.25);
    }
  } catch { /* audio unavailable */ }
}

// Browsers only allow audio after a user gesture, so unlock it on the first tap.
document.addEventListener('pointerdown', () => {
  try {
    audio ??= new AudioContext();
    audio.resume();
  } catch { /* audio unavailable */ }
}, { once: true });

function renderMute() {
  $('#muteBtn').textContent = muted ? '🔇' : '🔊';
}

function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

function applyUiLang(lang) {
  setLang(lang);
  store.set('uiLang', lang);
  const btn = $('#uiLangBtn');
  btn.textContent = lang === 'ar' ? 'English' : 'عربي';
  btn.lang = lang === 'ar' ? 'en' : 'ar';
  renderInvite();
  renderRooms();
  retranslateChat();
  if (room) render();
}

// ---------------------------------------------------------------- start

initHome();
initLobby();
initToolbar();
initChat();
$('#leaveBtn').onclick = () => closeRoom();
$('#inviteBtn').onclick = shareInvite;
$('#voiceBtn').onclick = joinVoice;
$('#micBtn').onclick = () => voice.setMuted(!voice.muted);
$('#hangupBtn').onclick = () => voice.leave();
$('#muteBtn').onclick = () => {
  muted = !muted;
  store.set('muted', muted);
  renderMute();
};
$('#uiLangBtn').onclick = () => applyUiLang(getLang() === 'ar' ? 'en' : 'ar');
renderMute();
applyUiLang(initialUiLang);
startRoomPolling();
setInterval(tick, 250);
new ResizeObserver(fitBoard).observe($('#stage'));
new ResizeObserver(fitBoard).observe($('#toolbar'));

// Coming back to a room this tab was already in (e.g. after a refresh) rejoins straight away;
// a fresh invite link shows the invite card first so the player can pick a name.
if (inviteCode && store.get('room', null, 'sessionStorage') === inviteCode && profile.name.trim()) joinRoom(inviteCode);
else if (inviteCode) loadInvite();

api('/api/track', { visitor: profile.visitor, uiLang: getLang(), referrer: document.referrer, invited: Boolean(inviteCode) })
  .catch(() => { /* statistics are best-effort */ });

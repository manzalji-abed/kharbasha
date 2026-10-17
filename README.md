# Kharbasha · خربشة

A live multiplayer draw-and-guess game (in the style of Gartic / Skribbl) for English and Arabic players.
One player draws, everyone else races to guess the word in the chat.

Runs on **Cloudflare Workers + Durable Objects** at <https://kharbasha.abedmanzalji.com>.

## Develop

```bash
npm install
npm run dev        # local Cloudflare runtime at http://localhost:8787
npm test           # game rules, Arabic/English matching, room directory, analytics
npm run e2e        # real Chrome plays a full game on desktop, tablet and phone (see below)
npm run deploy     # publish to Cloudflare (first time: npx wrangler login)
```

Node 20 or newer. Open the local URL in two browser tabs to play against yourself.

For local development, create `.dev.vars` (not committed) with `ADMIN_PASSWORD=...` and apply the analytics schema once
with `npx wrangler d1 migrations apply kharbasha-analytics --local`.

### End-to-end test

`npm run e2e -- https://kharbasha.abedmanzalji.com` drives real Chrome sessions through the whole game: nickname
check, named private room, invite link, joining by code on an Arabic phone, drawing (pixels are checked on the other
screens), wrong / close / correct guesses, Continue, a mid-turn refresh, a full game, quick play, kicking, and — with
`ADMIN_PASSWORD` set — the analytics dashboard. Screenshots land in `e2e/screenshots/`. `HEADFUL=1` shows the browsers.
Test players use visitor ids starting with `e2e-`; remove their statistics afterwards with
`npx wrangler d1 execute kharbasha-analytics --remote --file e2e/purge-test-data.sql`.

## Voice chat

Audio goes directly between browsers over WebRTC (`public/voice.js`): each player in voice has one connection to every
other one. The room's WebSocket only carries the set-up messages (`voice` and `rtc`), which the server passes on
between players who are both in voice.

To connect, browsers use the servers from `GET /api/ice`. By default that is STUN only, which works for most home
and mobile networks. Some strict networks (some offices, some mobile carriers) need a **TURN relay**. To switch on
Cloudflare's relay ($0.05 per GB actually relayed; voice is roughly 20–30 MB per relayed person per hour):

1. Cloudflare dashboard → **Realtime** (formerly "Calls") → **TURN** → create a TURN key → copy its **key ID** and
   **API token**.
2. In this folder:
   ```bash
   npx wrangler secret put TURN_KEY_ID          # paste the Token ID
   npx wrangler secret put TURN_KEY_API_TOKEN   # paste the API token
   ```

No redeploy is needed: the Worker picks the relay up as soon as the secrets exist.

## Analytics

<https://kharbasha.abedmanzalji.com/admin> (password: the `ADMIN_PASSWORD` secret, change it with
`npx wrangler secret put ADMIN_PASSWORD`). Everything stays on Cloudflare:

- **D1 database `kharbasha-analytics`** stores visits (country, region, city, device, OS, browser, app language,
  referrer), rooms opened, players joining (nickname, country, device), games (room name, language, players, winner,
  length, finished or abandoned) and turns (word, guessers, correct guesses, duration). Schema: `migrations/`.
- Visitors are identified by a random id in their browser (to count unique and returning players); no IP addresses are
  stored. Bots and headless browsers are skipped. Writes never block or break the game.
- The dashboard shows who's online now, totals, daily visitors/players/games, countries and cities, devices, operating
  systems, browsers, languages, where visitors came from, the most drawn and hardest words, and recent games and players.

## Features

- **Live rooms** — public rooms ("Play now" fills the busiest one) and private rooms shared by link or 5-letter code.
  Public rooms start by themselves 20 s after two players are in. Hosts can name their room; invite links open a
  card showing the room before you join, and everyone picks a nickname first.
- **No waiting between turns** — after each word is revealed, the next turn starts as soon as everyone presses
  Continue (or after 6 s).
- **Voice chat in private rooms** — players opt in with 🎤 (mic off until then), mute themselves, or mute someone just
  for themselves; whoever is talking gets a green glow. Up to 8 people. Not offered in public rooms.
- **Word language per room** — English, Arabic, or **Both** (drawer sees both words, guesses accepted in either).
- **Arabic-aware guessing** — أ/إ/آ → ا, ة → ه, ى → ي, tashkeel and tatweel ignored, "ال" optional, Arabic-Indic digits.
  Near misses get a private "very close!" hint. ~680 built-in word pairs with common dialect alternatives.
- **Custom words** — the host can add their own (`cat|قطة|قط`, comma or new-line separated) or use only those.
- **Full RTL Arabic UI** with an English/عربي toggle; names and messages in either script display correctly.
- **Drawing** — 18 colours, 5 brush sizes, fill bucket, eraser, undo (Ctrl+Z), clear; mouse, pen or touch.
- **Fair play** — the server holds the word; guessers only ever receive blanks. Players who already guessed
  (and the drawer) chat on a private channel so they can't spoil it. The host can kick.
- **Resilient** — refresh or lose signal and you get your seat and score back within 20 s; late joiners see the drawing so far.
- **Responsive** — desktop, tablet (portrait and landscape) and phone layouts; installable to the home screen.

## How it works

```
browser ──HTTP──▶ Worker ──▶ LobbyObject (one, global): room codes + public room list
   │
   └──WebSocket /ws/CODE──▶ Worker ──▶ RoomObject (one per room code) ──▶ Room (game rules)
```

- **Worker** (`src/worker.js`) serves the static site from `public/` and routes `/api/*` and `/ws/:code`.
- **RoomObject** (`src/room-object.js`) is a Durable Object per room. It holds the players' WebSockets using the
  Hibernation API: an idle room is unloaded from memory without dropping anyone, and restored from storage
  when the next message arrives. Rooms are created close to the player who opens them.
- **LobbyObject** (`src/lobby-object.js`) hands out unique codes and keeps the public room list; rooms report
  changes and check in every 5 minutes.
- **Room** (`src/core/room.js`) is the game itself — turns, timer, hints, scoring, drawing history — and knows
  nothing about Cloudflare. It talks to players through a small transport (`send`, `close`, `changed`), which is
  what makes it easy to test (`test/room.test.js`) and to move to another platform if ever needed.

The server is the referee: it owns the secret word and the clock. The drawer's browser paints locally at once and
sends point batches every 50 ms; the room relays them to the others and keeps them for late joiners. All clients
share an 800×600 coordinate space, so drawings look the same on any screen.

## Project layout

```
src/
  worker.js          request routing
  room-object.js     Durable Object: room connections, persistence, lobby reporting
  lobby-object.js    Durable Object: room codes, public room directory, live counts
  analytics/         usage statistics in D1: request context, writes, dashboard queries, /api/admin
  core/              platform-independent game logic
    room.js          one room: players, turns, timer, hints, scoring, drawing
    directory.js     public room listing and quick-play choice
    normalize.js     guess normalisation (Arabic + English), "close guess" detection
    words.js         word picking, custom-word parsing
    wordlist.js      built-in English/Arabic word pairs  ← add words here
    random.js        crypto-random helpers
public/
  index.html         page shell (home + room screens)
  app.js             UI logic and rendering
  net.js             API calls and the reconnecting room WebSocket
  voice.js           voice chat: microphone, WebRTC connections, "who's talking"
  board.js           canvas drawing, flood fill, stroke batching
  i18n.js            English & Arabic UI strings
  style.css          styles and responsive layouts
  admin.html/js/css  the analytics dashboard (/admin)
  icon*.svg/png      app icon, manifest.webmanifest
migrations/          D1 analytics schema
e2e/                 end-to-end browser test and test-data cleanup
test/                node:test suites
wrangler.jsonc       Cloudflare configuration (bindings, custom domain)
```

## Costs

Durable Objects work on the **Workers Free plan** (daily limits, including 100,000 requests/day). Drawing traffic
counts toward that, so a busy day of play could reach the limit; the **Workers Paid plan ($5/month)** lifts it
with plenty of headroom. Idle rooms hibernate and cost nothing while players sit in the lobby.

## Ideas for next steps

- Accounts / persistent profiles and leaderboards
- Profanity filter for chat and names; vote-kick for public rooms
- More word packs (themes, kids mode, Gulf / Levantine / Egyptian dialect packs)
- Spectator mode, reactions (👍/👎 on drawings), saving drawings as images

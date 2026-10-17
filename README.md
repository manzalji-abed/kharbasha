# Kharbasha · خربشة

A live multiplayer draw-and-guess game (in the style of Gartic / Skribbl) for English and Arabic players.
One player draws, everyone else races to guess the word in the chat.

## Run it

```bash
npm install
npm start          # http://localhost:3000
npm run dev        # same, restarts when server files change
npm test           # word-matching tests + real multiplayer games against the server
```

Node 20 or newer. Set `PORT` to change the port.

**Try it with friends on the same Wi-Fi:** find your PC's local IP (`ipconfig` → IPv4 address, e.g. `192.168.1.20`)
and open `http://192.168.1.20:3000` on their phones. Allow Node through the Windows firewall when asked.

## Features

- **Live rooms** — public rooms ("Play now" fills the busiest one) and private rooms shared by link or 5-letter code.
  Public rooms start by themselves 20 s after two players are in.
- **Word language per room** — English, Arabic, or **Both** (drawer sees both words, guesses accepted in either).
- **Arabic-aware guessing** — أ/إ/آ → ا, ة → ه, ى → ي, tashkeel and tatweel ignored, "ال" optional, Arabic-Indic digits.
  Near misses get a private "very close!" hint. ~250 built-in word pairs with common dialect alternatives.
- **Custom words** — host can add their own (`cat|قطة|قط`, comma or new-line separated) or use only those.
- **Full RTL Arabic UI** with an English/عربي toggle; names and messages in either script display correctly.
- **Drawing** — 18 colours, 5 brush sizes, fill bucket, eraser, undo (Ctrl+Z), clear; mouse, pen or touch.
- **Fair play** — the server holds the word; guessers only ever receive blanks. Players who already guessed
  (and the drawer) chat on a private channel so they can't spoil it. Host can kick.
- **Resilient** — refresh or lose signal and you get your seat and score back within 20 s; late joiners see the drawing so far.
- **Responsive** — desktop, tablet (portrait and landscape) and phone layouts; installable to the home screen.

## How the real-time part works

Every browser keeps a WebSocket (Socket.IO) connection open to the server. The server is the referee:
it owns rooms, turn order, the timer, the secret word and the scores.

- **Drawing:** the drawer's browser paints locally at once and sends point batches every 40 ms. The server checks
  it's really their turn, stores the stroke (for late joiners) and relays it to everyone else.
  All clients share an 800×600 coordinate space, so drawings look the same on any screen.
- **Guessing:** chat goes to the server, which normalises and compares it to the answer. A correct guess is
  announced without revealing the word; only that player is sent the word.
- **State:** whenever something changes, each player gets a personal snapshot (the drawer's includes the word,
  guessers' include blanks). Timers are sent as "time left" and counted down locally.

## Project layout

```
server/
  index.js       Express + Socket.IO bootstrap
  lobby.js       room directory, quick play, socket event wiring, rate limits
  room.js        one room: players, turns, timer, hints, scoring, drawing history, state sync
  normalize.js   guess normalisation (Arabic + English), "close guess" detection
  words.js       word picking, custom-word parsing
  wordlist.js    built-in English/Arabic word pairs  ← add words here
public/
  index.html     page shell (home + room screens)
  app.js         UI logic, socket events, rendering
  board.js       canvas drawing, flood fill, stroke batching
  i18n.js        English & Arabic UI strings
  style.css      styles and responsive layouts
  icon*.svg/png  app icon, manifest.webmanifest
test/            node:test suites
```

## Deploying

The game needs a **long-running Node server** with WebSocket support — e.g. Render, Railway, Fly.io,
or any VPS. Serverless hosts (Vercel/Netlify functions) won't work. Start command: `npm start`.

All rooms live in memory on one process, which comfortably handles thousands of concurrent players.
To run several instances later, add the Socket.IO Redis adapter and sticky sessions.

## Ideas for next steps

- Accounts / persistent profiles and leaderboards
- Profanity filter for chat and names; vote-kick for public rooms
- More word packs (themes, kids mode, Gulf / Levantine / Egyptian dialect packs)
- Spectator mode, reactions (👍/👎 on drawings), saving drawings as images

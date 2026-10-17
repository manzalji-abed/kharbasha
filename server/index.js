import express from 'express';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Server } from 'socket.io';
import { Lobby } from './lobby.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function startServer(port = Number(process.env.PORT) || 3000) {
  const app = express();
  app.use(express.static(publicDir));
  app.get('/health', (_req, res) => res.json({ ok: true }));

  const httpServer = createServer(app);
  const io = new Server(httpServer, { maxHttpBufferSize: 64 * 1024, pingInterval: 10_000, pingTimeout: 8_000 });
  const lobby = new Lobby(io);
  io.on('connection', socket => lobby.attach(socket));

  return new Promise(resolve => {
    httpServer.listen(port, () => resolve({ httpServer, io, lobby, port: httpServer.address().port }));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { port } = await startServer();
  console.log(`Kharbasha is live on http://localhost:${port}`);
}

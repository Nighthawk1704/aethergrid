// AetherGrid server entrypoint: HTTP (static web client + status) and WebSocket game endpoint.
import express from 'express';
import { createServer } from 'node:http';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { DEFAULT_PORT } from '../shared/constants';
import { GameDb } from './db';
import { Game } from './game';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.PORT ?? DEFAULT_PORT);
const DB_PATH = process.env.AETHER_DB ?? resolve(ROOT, 'data/aethergrid.db');
const DEFAULT_SEED = 1337;

/** True when the bundle is missing or any web/shared source file is newer than it. */
function webIsStale(bundle: string): boolean {
  if (!existsSync(bundle)) return true;
  const built = statSync(bundle).mtimeMs;
  const newer = (dir: string): boolean => readdirSync(dir, { withFileTypes: true }).some((e) => {
    const p = resolve(dir, e.name);
    return e.isDirectory() ? newer(p) : statSync(p).mtimeMs > built;
  });
  return newer(resolve(ROOT, 'src/client-web')) || newer(resolve(ROOT, 'src/shared'));
}

export async function startServer(opts: { port?: number; dbPath?: string; seed?: number; quiet?: boolean; autoStart?: boolean } = {}): Promise<{ game: Game; close: () => Promise<void>; port: number }> {
  const db = new GameDb(opts.dbPath ?? DB_PATH);
  // The world seed is fixed on first run and stored, so restarts regenerate the identical world.
  const stored = db.getMeta('seed');
  const seed = stored !== null ? Number(stored) : Number(process.env.AETHER_SEED ?? opts.seed ?? DEFAULT_SEED);
  if (stored === null) db.setMeta('seed', String(seed));

  const game = new Game(db, seed);

  const app = express();
  app.disable('x-powered-by');
  app.get('/api/status', (_req, res) => {
    res.json({
      name: 'AetherGrid',
      tick: game.tick,
      players: [...game.players.values()].map((p) => ({ name: p.name, level: p.level, cls: p.cls, zone: p.zone.def.id })),
      tickMsAvg: Math.round(game.stats.tickMsAvg * 100) / 100,
      tickMsMax: Math.round(game.stats.tickMsMax * 100) / 100,
      seed,
    });
  });
  const webDir = resolve(ROOT, 'dist/web');
  // Build the browser client on demand (and whenever its sources changed) so `npm run server` just works.
  if (existsSync(resolve(ROOT, 'src/client-web/main.ts')) && webIsStale(resolve(webDir, 'app.js'))) {
    const { buildWeb } = await import('../../scripts/build-web.mjs');
    await buildWeb();
  }
  app.use(express.static(webDir, { extensions: ['html'] }));

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8192 });
  wss.on('connection', (ws) => game.attach(ws));
  const heartbeat = setInterval(() => game.heartbeat(), 15000);

  await new Promise<void>((res, rej) => {
    server.once('error', rej);
    server.listen(opts.port ?? PORT, res);
  });
  const port = (server.address() as { port: number }).port;
  if (opts.autoStart !== false) game.start();
  if (!opts.quiet) {
    console.log(`[server] AetherGrid listening on http://localhost:${port}  (ws path /ws, world seed ${seed})`);
    console.log(`[server] database: ${opts.dbPath ?? DB_PATH}`);
  }

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    game.stop();
    await new Promise<void>((r) => wss.close(() => r()));
    await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections?.(); });
    db.close();
  };
  return { game, close, port };
}

// Run directly (npm run server).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const srv = await startServer();
  const shutdown = (sig: string): void => {
    console.log(`\n[server] ${sig} received, saving and shutting down...`);
    void srv.close().then(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  setInterval(() => {
    const g = srv.game;
    console.log(`[server] tick ${g.tick}  players ${g.players.size}  tick avg ${g.stats.tickMsAvg.toFixed(2)}ms max ${g.stats.tickMsMax.toFixed(2)}ms`);
  }, 60000).unref();
}

// One-command demo: game server + web client + N bots in a single process.
//   npm run demo
import { startBots } from './bots';
import { startServer } from './main';

const count = Number(process.env.BOTS ?? 10);
const srv = await startServer();
const { stop } = startBots(`ws://localhost:${srv.port}/ws`, count);
console.log(`[demo] ${count} bots are joining. Open http://localhost:${srv.port} or run: npm run client`);
const shutdown = (): void => { stop(); void srv.close().then(() => process.exit(0)); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

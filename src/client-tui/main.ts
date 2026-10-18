// AetherGrid terminal client. Usage:  npm run client -- [--url ws://host:port/ws] [--user NAME --pass PW [--register --class vanguard|arcanist|shadowblade]]
import { DEFAULT_PORT, SCREEN_H, SCREEN_W } from '../shared/constants';
import { CLASS_IDS } from '../shared/gamedata';
import type { ClassId } from '../shared/types';
import { GameApp, type Credentials } from '../shared/ui/app';
import { AnsiRenderer } from './ansi';
import { parseKeys } from './keys';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const url = arg('url') ?? process.env.AETHER_URL ?? `ws://localhost:${DEFAULT_PORT}/ws`;
const user = arg('user') ?? process.env.AETHER_USER;
const pass = arg('pass') ?? process.env.AETHER_PASS;
const cls = (arg('class') ?? process.env.AETHER_CLASS ?? 'vanguard') as ClassId;

if (!process.stdout.isTTY || !process.stdin.isTTY) {
  console.error('The AetherGrid terminal client needs an interactive terminal (TTY).');
  process.exit(1);
}
if (!CLASS_IDS.includes(cls)) {
  console.error(`Unknown class "${cls}". Choose one of: ${CLASS_IDS.join(', ')}`);
  process.exit(1);
}
if (typeof WebSocket === 'undefined') {
  console.error('This client needs Node.js 22+ (global WebSocket).');
  process.exit(1);
}

const credentials: Credentials | undefined = user && pass ? { name: user, password: pass, register: flag('register'), cls } : undefined;
const trueColor = /truecolor|24bit/i.test(process.env.COLORTERM ?? '') || process.env.TERM_PROGRAM === 'iTerm.app' || process.env.TERM_PROGRAM === 'vscode';
const app = new GameApp({ url, credentials, initialName: user });
const renderer = new AnsiRenderer(trueColor);
const out = process.stdout;

let restored = false;
function restore(): void {
  if (restored) return;
  restored = true;
  try { process.stdin.setRawMode(false); } catch { /* ignore */ }
  out.write('\x1b[0m\x1b[?25h\x1b[?1049l');
}
function quit(code = 0): never {
  clearInterval(timer);
  app.net.close();
  restore();
  process.exit(code);
}

out.write('\x1b[?1049h\x1b[?25l\x1b]0;AetherGrid\x07\x1b[2J');
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.resume();
process.stdin.on('data', (chunk: string) => {
  for (const k of parseKeys(chunk)) app.handleKey(k);
  if (app.quit) quit(0);
});
out.on('resize', () => { renderer.invalidate(); out.write('\x1b[0m\x1b[2J'); });
process.on('SIGINT', () => quit(0));
process.on('SIGTERM', () => quit(0));
process.on('exit', restore);
process.on('uncaughtException', (err) => { restore(); console.error(err); process.exit(1); });

let frameNo = 0;
const timer = setInterval(() => {
  frameNo++;
  if (frameNo % 2 === 0) app.update(); // the world runs at 10 Hz; draw at 20 Hz for smooth animation
  const cols = out.columns ?? 0, rows = out.rows ?? 0;
  if (cols < SCREEN_W || rows < SCREEN_H) {
    renderer.invalidate();
    out.write(`\x1b[0m\x1b[2J\x1b[1;1HTerminal too small: AetherGrid needs ${SCREEN_W}x${SCREEN_H}, this one is ${cols}x${rows}.\x1b[2;1HResize the window (or reduce the font size).`);
    return;
  }
  const frame = renderer.frame(app.render(), Math.floor((cols - SCREEN_W) / 2), Math.floor((rows - SCREEN_H) / 2));
  if (frame) out.write(frame);
}, 50);

app.connect();

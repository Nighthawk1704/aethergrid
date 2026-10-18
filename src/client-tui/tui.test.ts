// Verifies the terminal client without a real terminal: key parsing, and that the diffing ANSI
// renderer reproduces arbitrary frames exactly when replayed through a minimal terminal emulator.
// Run with: npm run test:tui
import { SCREEN_H, SCREEN_W } from '../shared/constants';
import { unpack } from '../shared/colors';
import { ATTR, Screen } from '../shared/ui/screen';
import { AnsiRenderer, rgbTo256 } from './ansi';
import { Emu } from './emu';
import { parseKeys } from './keys';

let checks = 0, failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  checks++;
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? `  -> ${detail}` : ''}`);
}

// ---- Key parsing --------------------------------------------------------------------------------
const keys = (s: string): string => parseKeys(s).map((k) => `${k.ctrl ? 'C-' : ''}${k.alt ? 'M-' : ''}${k.key}`).join(',');
check('printable characters', keys('wasd') === 'w,a,s,d');
check('arrow keys (CSI)', keys('\x1b[A\x1b[B\x1b[C\x1b[D') === 'ArrowUp,ArrowDown,ArrowRight,ArrowLeft');
check('arrow keys (SS3 application mode)', keys('\x1bOA\x1bOD') === 'ArrowUp,ArrowLeft');
check('modified arrows keep their direction', keys('\x1b[1;2A\x1b[1;5C') === 'ArrowUp,C-ArrowRight');
check('lone ESC is Escape', keys('\x1b') === 'Escape');
check('enter / backspace / tab', keys('\r') === 'Enter' && keys('\x7f') === 'Backspace' && keys('\t') === 'Tab');
check('Ctrl+C', keys('\x03') === 'C-c');
check('Home/End/PageUp/PageDown/Delete', keys('\x1b[H\x1b[F\x1b[5~\x1b[6~\x1b[3~') === 'Home,End,PageUp,PageDown,Delete');
check('shift-tab', keys('\x1b[Z') === 'Tab');
check('Alt+key', keys('\x1bx') === 'M-x');
check('uppercase and symbols pass through (Shift+E, >, /)', keys('E>/') === 'E,>,/');
check('mixed burst (key repeat)', keys('ddd\x1b[A') === 'd,d,d,ArrowUp');
check('truncated escape sequence is dropped, not misparsed', keys('\x1b[') === '');

function sameColour(trueColor: boolean, expected: number, got: number): boolean {
  return trueColor ? expected === got : got === 1_000_000_000 + rgbTo256(expected);
}

function randomFrame(s: Screen, seed: number, density: number): void {
  let x = seed >>> 0;
  const rnd = (): number => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
  const glyphs = '#.~"@gsoDN$!/[+\'<>T*=:^%-';
  for (let i = 0; i < s.w * s.h; i++) {
    if (rnd() > density) continue;
    s.ch[i] = rnd() < 0.2 ? ' ' : glyphs[Math.floor(rnd() * glyphs.length)]!;
    s.fg[i] = Math.floor(rnd() * 0xffffff);
    s.bg[i] = rnd() < 0.7 ? 0 : Math.floor(rnd() * 0x303030);
    s.at[i] = rnd() < 0.2 ? ATTR.BOLD : rnd() < 0.05 ? ATTR.UNDERLINE : 0;
  }
}

function verify(trueColor: boolean): void {
  const tag = trueColor ? 'truecolor' : '256-color';
  const emu = new Emu(SCREEN_W + 6, SCREEN_H + 2, trueColor);
  const r = new AnsiRenderer(trueColor);
  const s = new Screen(SCREEN_W, SCREEN_H);
  const OX = 3, OY = 1;
  let bad = '';
  let lastBytes = 0;
  const compare = (label: string): void => {
    for (let y = 0; y < SCREEN_H && !bad; y++) {
      for (let x = 0; x < SCREEN_W && !bad; x++) {
        const i = y * SCREEN_W + x;
        const c = emu.cells[(y + OY) * emu.w + x + OX]!;
        const blank = s.ch[i] === ' ';
        if (c.ch !== s.ch[i]) bad = `${label} (${x},${y}) char ${JSON.stringify(c.ch)} != ${JSON.stringify(s.ch[i])}`;
        else if (!sameColour(trueColor, s.bg[i]!, c.bg)) bad = `${label} (${x},${y}) bg`;
        else if (!blank && !sameColour(trueColor, s.fg[i]!, c.fg)) bad = `${label} (${x},${y}) fg ${c.fg} vs ${s.fg[i]}`;
        else if (!blank && (c.at & ~ATTR.UNDERLINE) !== (s.at[i]! & ~ATTR.UNDERLINE)) bad = `${label} (${x},${y}) attr`;
      }
    }
  };

  randomFrame(s, 1, 0.9);
  emu.write(r.frame(s, OX, OY));
  compare('full frame');
  check(`${tag}: first frame paints the whole screen exactly`, !bad, bad);

  // A sequence of sparse changes, as in real play: only a few cells move each frame.
  let fullBytes = emu.bytes - lastBytes;
  for (let n = 0; n < 40 && !bad; n++) {
    lastBytes = emu.bytes;
    randomFrame(s, 100 + n, 0.02);
    emu.write(r.frame(s, OX, OY));
    compare(`delta ${n}`);
  }
  check(`${tag}: 40 sparse delta frames replay to the exact screen`, !bad, bad);
  const deltaBytes = emu.bytes - lastBytes;
  check(`${tag}: a sparse delta is far smaller than a full repaint`, deltaBytes < fullBytes / 5, `${deltaBytes} vs ${fullBytes}`);

  emu.write(r.frame(s, OX, OY));
  check(`${tag}: an unchanged frame emits nothing (no flicker)`, r.frame(s, OX, OY) === '');

  r.invalidate();
  emu.write(r.frame(s, OX, OY));
  compare('after invalidate');
  check(`${tag}: invalidate() forces a correct full repaint`, !bad, bad);
}
verify(true);
verify(false);

check('rgbTo256: pure colours', rgbTo256(0xff0000) === 196 && rgbTo256(0x0000ff) === 21 && rgbTo256(0xffffff) === 231 && rgbTo256(0x000000) === 16);
check('rgbTo256: greys use the grey ramp', rgbTo256(0x808080) >= 232 && rgbTo256(0x808080) <= 255);
check('unpack sanity', unpack(0x102030).join() === '16,32,48');

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);

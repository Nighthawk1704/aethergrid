import { C, mix } from '../colors';
import { CLASSES, CLASS_IDS, SKILLS } from '../gamedata';
import { SCREEN_W } from '../constants';
import type { ClassId } from '../types';
import { ATTR, Screen } from './screen';

export interface LoginForm {
  register: boolean;
  /** 0 mode, 1 name, 2 password, 3 class */
  field: number;
  name: string;
  pass: string;
  cls: number;
}

export const newLoginForm = (): LoginForm => ({ register: false, field: 1, name: '', pass: '', cls: 0 });

export const formClass = (f: LoginForm): ClassId => CLASS_IDS[f.cls]!;

const FONT: Record<string, string[]> = {
  A: [' ### ', '#   #', '#####', '#   #', '#   #'],
  E: ['#####', '#    ', '#### ', '#    ', '#####'],
  T: ['#####', '  #  ', '  #  ', '  #  ', '  #  '],
  H: ['#   #', '#   #', '#####', '#   #', '#   #'],
  R: ['#### ', '#   #', '#### ', '#  # ', '#   #'],
  G: [' ####', '#    ', '#  ##', '#   #', ' ### '],
  I: ['#####', '  #  ', '  #  ', '  #  ', '#####'],
  D: ['#### ', '#   #', '#   #', '#   #', '#### '],
};

export function drawLogin(s: Screen, f: LoginForm, now: number, status: string, error: string): void {
  const title = 'AETHERGRID';
  const width = title.length * 6 - 1;
  const x0 = Math.floor((SCREEN_W - width) / 2);
  for (let row = 0; row < 5; row++) {
    for (let li = 0; li < title.length; li++) {
      const glyph = FONT[title[li]!]![row]!;
      for (let c = 0; c < 5; c++) {
        if (glyph[c] !== '#') continue;
        const shimmer = 0.5 + 0.5 * Math.sin(now / 500 - li * 0.7 + row * 0.5);
        s.set(x0 + li * 6 + c, 3 + row, '█', mix(0x2a6cff, 0x5ae8ff, (row / 4) * 0.6 + shimmer * 0.4), -1, ATTR.BOLD);
      }
    }
  }
  s.center(0, SCREEN_W, 9, 'a real-time multiplayer ASCII adventure', C.dim);

  const bx = 25, by = 12, bw = 50;
  s.box(bx, by, bw, 14, C.border, f.register ? 'Create your hero' : 'Enter the world');
  const label = (row: number, text: string, active: boolean): void => s.text(bx + 3, by + row, text.padEnd(10), active ? C.yellow : C.dim, -1, active ? ATTR.BOLD : 0);

  label(2, 'Mode', f.field === 0);
  s.text(bx + 14, by + 2, f.register ? '  Login    < Register >' : '< Login >    Register  ', f.field === 0 ? C.brightWhite : C.text);

  label(4, 'Username', f.field === 1);
  const field = (row: number, value: string, active: boolean, mask: boolean): void => {
    const shown = mask ? '*'.repeat(value.length) : value;
    s.fill(bx + 14, by + row, 24, 1, active ? 0x1a2040 : 0x101018);
    s.text(bx + 14, by + row, shown.slice(-22), C.brightWhite);
    if (active && Math.floor(now / 500) % 2 === 0) s.set(bx + 14 + Math.min(22, shown.length), by + row, '█', C.brightWhite);
  };
  field(4, f.name, f.field === 1, false);
  label(6, 'Password', f.field === 2);
  field(6, f.pass, f.field === 2, true);

  if (f.register) {
    const cls = CLASSES[formClass(f)];
    label(8, 'Class', f.field === 3);
    s.text(bx + 14, by + 8, `< ${cls.name} >`, f.field === 3 ? C.brightWhite : C.text, -1, ATTR.BOLD);
    s.text(bx + 3, by + 9, cls.blurb.slice(0, bw - 6), C.dim);
    s.text(bx + 3, by + 10, `Skills: ${cls.skills.map((id) => SKILLS[id].name).join(', ')}`, C.cyan);
    s.text(bx + 3, by + 11, `HP ${cls.base.maxHp}  MP ${cls.base.maxMp}  ATK ${cls.base.atk}  MAG ${cls.base.mag}  DEF ${cls.base.def}  CRT ${cls.base.crit}%`, C.dimmer);
  } else {
    s.text(bx + 3, by + 9, 'New here? Select Mode and press → to register.', C.dimmer);
  }
  s.center(bx, bw, by + 12, 'Enter connect   Tab next field   Ctrl+C quit', C.dim);

  if (error) s.center(0, SCREEN_W, by + 17, error, C.brightRed, -1, ATTR.BOLD);
  else s.center(0, SCREEN_W, by + 17, status, C.dim);
}

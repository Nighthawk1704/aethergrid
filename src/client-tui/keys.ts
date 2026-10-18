// Terminal byte stream -> normalized key events.
import type { KeyEvent } from '../shared/ui/keys';

const CSI_FINAL: Record<string, string> = { A: 'ArrowUp', B: 'ArrowDown', C: 'ArrowRight', D: 'ArrowLeft', H: 'Home', F: 'End', Z: 'Tab' };
const CSI_TILDE: Record<string, string> = { '1': 'Home', '2': 'Insert', '3': 'Delete', '4': 'End', '5': 'PageUp', '6': 'PageDown', '7': 'Home', '8': 'End' };

/** Parse one chunk of stdin into key events. A lone ESC byte is the Escape key. */
export function parseKeys(chunk: string): KeyEvent[] {
  const out: KeyEvent[] = [];
  let i = 0;
  while (i < chunk.length) {
    const c = chunk[i]!;
    if (c === '\x1b') {
      if (i + 1 >= chunk.length) { out.push({ key: 'Escape' }); i++; continue; }
      const n = chunk[i + 1]!;
      if (n === '[' || n === 'O') {
        // CSI / SS3: params then a final byte.
        let j = i + 2;
        let params = '';
        while (j < chunk.length && /[0-9;?]/.test(chunk[j]!)) params += chunk[j++];
        const fin = chunk[j];
        if (fin === undefined) { i = chunk.length; continue; }
        const shift = /;2$/.test(params);
        const ctrl = /;5$/.test(params);
        if (fin === '~') {
          const name = CSI_TILDE[params.split(';')[0]!];
          if (name) out.push({ key: name, shift, ctrl });
        } else if (CSI_FINAL[fin]) {
          out.push({ key: CSI_FINAL[fin]!, shift: shift || fin === 'Z', ctrl });
        }
        i = j + 1;
        continue;
      }
      // Alt + key.
      out.push({ key: n, alt: true });
      i += 2;
      continue;
    }
    const code = c.codePointAt(0)!;
    const step = code > 0xffff ? 2 : 1;
    if (c === '\r' || c === '\n') out.push({ key: 'Enter' });
    else if (c === '\x7f' || c === '\b') out.push({ key: 'Backspace' });
    else if (c === '\t') out.push({ key: 'Tab' });
    else if (code < 32) out.push({ key: String.fromCharCode(code + 96), ctrl: true });
    else out.push({ key: chunk.slice(i, i + step) });
    i += step;
  }
  return out;
}

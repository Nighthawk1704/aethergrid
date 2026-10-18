/** Normalized key event shared by the TUI and the browser. `key` follows the DOM `KeyboardEvent.key` names. */
export interface KeyEvent {
  key: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}

export const isPrintable = (k: KeyEvent): boolean => k.key.length === 1 && !k.ctrl && !k.alt && k.key >= ' ' && k.key !== '\u007f';

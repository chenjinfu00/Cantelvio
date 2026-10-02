/**
 * Keyboard shortcuts, following MuseScore conventions where they exist:
 * N input mode · 1–8 durations · . dot · A–G notes · Shift+A–G add to chord · 0 rest ·
 * ↑/↓ semitone · Ctrl+↑/↓ octave · ←/→ move · Delete · + tie · Ctrl+3 triplet ·
 * Ctrl+Alt+1–4 voice · Ctrl+B add measure · Space play · Ctrl+Z / Ctrl+Y undo/redo · Esc.
 */
import type { NoteValue, Step } from '@ailegro-score/core';
import * as actions from '../state/actions';
import { getStore } from '../state/store';
import { togglePlayback } from '../playback/player';

const DURATION_KEYS: Record<string, NoteValue> = {
  '1': '64th',
  '2': '32nd',
  '3': '16th',
  '4': 'eighth',
  '5': 'quarter',
  '6': 'half',
  '7': 'whole',
  '8': 'breve',
};

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export function handleKeyDown(e: KeyboardEvent): void {
  if (isTyping(e.target)) return;
  const store = getStore();
  const s = store.getState();
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key;

  // history
  if (mod && !e.shiftKey && key.toLowerCase() === 'z') {
    e.preventDefault();
    s.undo();
    return;
  }
  if (mod && (key.toLowerCase() === 'y' || (e.shiftKey && key.toLowerCase() === 'z'))) {
    e.preventDefault();
    s.redo();
    return;
  }
  if (mod && key.toLowerCase() === 's') {
    e.preventDefault();
    window.dispatchEvent(new CustomEvent('ailegro:save'));
    return;
  }
  if (mod && key.toLowerCase() === 'b') {
    e.preventDefault();
    actions.appendMeasures(e.shiftKey ? 4 : 1);
    return;
  }
  // e.code, not e.key: Option/Alt changes the character on macOS ("¡" for Option+1).
  if (mod && e.altKey && /^Digit[1-4]$/.test(e.code)) {
    e.preventDefault();
    const voice = Number(e.code.slice(5)) - 1;
    s.setInput({ voice });
    if (s.cursor) store.setState({ cursor: { ...s.cursor, voice } });
    return;
  }
  // Ctrl+3 (Control on macOS: the browser keeps ⌘3 for switching tabs)
  if (mod && !e.altKey && (key === '3' || e.code === 'Digit3')) {
    e.preventDefault();
    actions.createTriplet();
    return;
  }
  if (key === ' ') {
    e.preventDefault();
    void togglePlayback();
    return;
  }
  if (key === 'Escape') {
    if (s.input.active) actions.toggleNoteInput();
    else s.select({ kind: 'none' });
    return;
  }
  if (!mod && (key === 'n' || key === 'N') && !e.shiftKey) {
    e.preventDefault();
    actions.toggleNoteInput();
    return;
  }
  if (!mod && !e.altKey && DURATION_KEYS[key]) {
    e.preventDefault();
    s.setInput({ value: DURATION_KEYS[key]!, dots: 0 });
    actions.setSelectedDuration();
    return;
  }
  if (key === '.') {
    e.preventDefault();
    s.setInput({ dots: s.input.dots ? 0 : 1 });
    actions.setSelectedDuration();
    return;
  }
  if (key === '0' && !mod) {
    e.preventDefault();
    if (s.input.active) actions.enterRest();
    return;
  }
  if (!mod && /^[a-gA-G]$/.test(key)) {
    if (!s.input.active && !(e.shiftKey && s.lastEntered)) {
      // like MuseScore, typing a letter outside input mode starts input at the selection
      actions.toggleNoteInput();
    }
    e.preventDefault();
    actions.enterLetter(key.toUpperCase() as Step, e.shiftKey);
    return;
  }
  if (key === '+' || (key === 't' && !mod)) {
    e.preventDefault();
    actions.tie();
    return;
  }
  if (key === 'ArrowUp' || key === 'ArrowDown') {
    e.preventDefault();
    const dir = key === 'ArrowUp' ? 1 : -1;
    actions.transposeSelection(mod ? dir * 12 : dir);
    return;
  }
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    e.preventDefault();
    actions.moveSelection(key === 'ArrowRight' ? 1 : -1);
    return;
  }
  if (key === 'Delete' || key === 'Backspace') {
    e.preventDefault();
    actions.deleteSelection();
    return;
  }
  if (e.shiftKey && !mod) {
    const art = ({ S: 'staccato', V: 'accent', N: 'tenuto', O: 'marcato', H: 'fermata' } as const)[
      key.toUpperCase() as 'S'
    ];
    if (art) {
      e.preventDefault();
      actions.toggleArticulation(art);
    }
  }
}

/**
 * Keyboard shortcuts, following MuseScore conventions where they exist:
 * N input mode · 1–8 durations · . dot · A–G notes · Shift+A–G add to chord · 0 rest ·
 * ↑/↓ semitone · Ctrl+↑/↓ octave · ←/→ move · Delete · + tie · Ctrl+2–9 tuplets ·
 * Ctrl+Alt+1–4 voice · S slur · < > hairpins · / acciaccatura · X flip stem ·
 * Ctrl+Alt+O 8va (Shift: 8vb) · K keypad (Alt+1–6 its tabs) · Ctrl+B add measure · Space play ·
 * Ctrl+Z / Ctrl+Y undo/redo · Ctrl+S save (Shift: save as) · Ctrl+O open · Esc.
 */
import type { NoteValue, Step } from '@cantelvio-score/core';
import * as actions from '../state/actions';
import * as marks from '../state/marks';
import { type KeypadTab, getStore } from '../state/store';
import { togglePlayback } from '../playback/player';

const KEYPAD_TABS: readonly KeypadTab[] = [
  'notes',
  'more',
  'articulations',
  'ornaments',
  'lines',
  'dynamics',
];

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
    window.dispatchEvent(new CustomEvent(e.shiftKey ? 'ailegro:save-as' : 'ailegro:save'));
    return;
  }
  if (mod && !e.shiftKey && !e.altKey && key.toLowerCase() === 'o') {
    e.preventDefault();
    window.dispatchEvent(new CustomEvent('ailegro:open'));
    return;
  }
  // Ctrl+Alt+O 8va, Ctrl+Alt+Shift+O 8vb (MuseScore)
  if (mod && e.altKey && e.code === 'KeyO') {
    e.preventDefault();
    marks.addLine(e.shiftKey ? '8vb' : '8va');
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
  // Ctrl+2–9 tuplets (Control on macOS: the browser keeps ⌘ + digit for switching tabs)
  if (mod && !e.altKey && /^Digit[2-9]$/.test(e.code)) {
    e.preventDefault();
    actions.createTuplet(Number(e.code.slice(5)));
    return;
  }
  // Alt+1–6: keypad tabs (e.code: Option changes the character on macOS)
  if (e.altKey && !mod && /^Digit[1-6]$/.test(e.code)) {
    e.preventDefault();
    s.setKeypad({ open: true, collapsed: false, tab: KEYPAD_TABS[Number(e.code.slice(5)) - 1]! });
    return;
  }
  if (key === ' ') {
    e.preventDefault();
    void togglePlayback();
    return;
  }
  if (key === 'Escape') {
    if (s.input.pendingLine) marks.endPendingLine();
    else if (s.input.active) actions.toggleNoteInput();
    else s.select({ kind: 'none' });
    return;
  }
  if (!mod && !e.altKey && (key === 'k' || key === 'K') && !e.shiftKey) {
    e.preventDefault();
    s.setKeypad({ open: !s.keypad.open, collapsed: false });
    return;
  }
  if (!mod && !e.altKey && (key === 's' || key === 'S') && !e.shiftKey) {
    e.preventDefault();
    marks.addLine('slur');
    return;
  }
  if (!mod && (key === '<' || key === '>')) {
    e.preventDefault();
    marks.addLine(key === '<' ? 'crescendo' : 'diminuendo');
    return;
  }
  // e.code for Alt+/: Option turns "/" into "÷" on macOS
  if (!mod && (key === '/' || (e.altKey && e.code === 'Slash'))) {
    e.preventDefault();
    marks.addGrace(e.altKey ? 'appoggiatura' : 'acciaccatura');
    return;
  }
  if (!mod && !e.altKey && (key === 'x' || key === 'X') && !e.shiftKey) {
    e.preventDefault();
    marks.flipStem();
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
    // grace notes selected: the letter re-pitches them
    if (!s.input.active && !e.shiftKey && actions.repitchSelection(key.toUpperCase() as Step)) {
      e.preventDefault();
      return;
    }
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

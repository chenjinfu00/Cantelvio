/**
 * Editor state (zustand). The document lives in a core `Session` (doc + undo history); every
 * change goes through `apply()` with core commands, never by mutating the document.
 */
import {
  type Command,
  CommandError,
  type HistoryEntry,
  type IdGenerator,
  type NoteValue,
  type ScoreDoc,
  type ScorePosition,
  Session,
  type Spanner,
  ZERO,
  allStaves,
  hasMeasure,
  hasStaff,
  randomIds,
} from '@ailegro-score/core';
import { create } from 'zustand';
import type { Lang } from '../i18n';

export type Selection =
  | { readonly kind: 'none' }
  | { readonly kind: 'notes'; readonly noteIds: readonly string[] }
  | { readonly kind: 'rest'; readonly at: ScorePosition }
  | {
      readonly kind: 'range';
      readonly staffFrom: number;
      readonly staffTo: number;
      readonly measureFrom: number;
      readonly measureTo: number;
    }
  /** Lines (spanners) and dynamics picked on the page. */
  | {
      readonly kind: 'marks';
      readonly spanners: readonly string[];
      readonly dynamics: readonly string[];
    };

/**
 * A line started during note input: it grows with every note entered until it is ended
 * (the same key again, Esc, or leaving note input).
 */
export interface PendingLine {
  /** The spanner as it is (or will be) in the document. */
  readonly spanner: Spanner;
  /** False until the document holds it (a slur needs a second note first). */
  readonly created: boolean;
  readonly voice: number;
}

export interface InputState {
  readonly active: boolean;
  readonly value: NoteValue;
  readonly dots: number;
  readonly voice: number;
  readonly pendingLine: PendingLine | null;
}

export type KeypadTab = 'notes' | 'more' | 'articulations' | 'ornaments' | 'lines' | 'dynamics';

export interface KeypadState {
  readonly open: boolean;
  readonly collapsed: boolean;
  readonly tab: KeypadTab;
  /** Position of the floating window (px from the top-left of the viewport). */
  readonly x: number;
  readonly y: number;
}

export interface ConfirmRequest {
  readonly message: string;
  readonly actions: readonly {
    readonly id: string;
    readonly label: string;
    readonly primary?: boolean;
  }[];
  readonly resolve: (id: string) => void;
}

export interface ViewState {
  readonly zoom: number;
  readonly concertPitch: boolean;
  readonly mode: 'page' | 'continuous';
  readonly lang: Lang;
}

export type PanelId = 'instruments' | 'ailegro' | 'text' | 'properties';

interface EditorUiState {
  readonly selection: Selection;
  readonly cursor: ScorePosition | null;
  /** Event entered last (Shift+letter adds to it, arrows transpose it). */
  readonly lastEntered: string | null;
}

export interface EditorState extends EditorUiState {
  readonly session: Session;
  readonly doc: ScoreDoc;
  readonly input: InputState;
  readonly view: ViewState;
  readonly playing: boolean;
  /** Score time (whole notes, approximate) of the playhead while playing. */
  readonly playhead: number | null;
  readonly panel: PanelId | null;
  readonly dialog: 'new' | null;
  readonly toast: {
    readonly text: string;
    readonly kind: 'info' | 'error';
    readonly at: number;
  } | null;
  readonly fileName: string | null;
  /** Newest history entry when the document was last saved or opened (dirty = it differs). */
  readonly cleanEntry: HistoryEntry | null;
  readonly keypad: KeypadState;
  readonly confirm: ConfirmRequest | null;
  readonly changedAt: number;
  /** Incremented whenever another document is loaded (panels reset their local state). */
  readonly generation: number;
  readonly ids: IdGenerator;

  apply(
    commands: Command | readonly Command[],
    label?: string,
    after?: Partial<EditorUiState>,
  ): boolean;
  undo(): void;
  redo(): void;
  load(doc: ScoreDoc, fileName?: string | null): void;
  select(selection: Selection): void;
  setCursor(cursor: ScorePosition | null): void;
  setInput(patch: Partial<InputState>): void;
  setView(patch: Partial<ViewState>): void;
  setPanel(panel: PanelId | null): void;
  setDialog(dialog: 'new' | null): void;
  setPlaying(playing: boolean, playhead?: number | null): void;
  setPlayhead(playhead: number | null): void;
  notify(text: string, kind?: 'info' | 'error'): void;
  setKeypad(patch: Partial<KeypadState>): void;
  /**
   * The document now matches the file (after saving). `entry` is the history entry the saved
   * document was taken at (default: the newest), so edits made while saving stay unsaved.
   */
  markSaved(fileName?: string | null, entry?: HistoryEntry | null): void;
  /** Ask the user to pick one of the actions; resolves with its id. */
  ask(message: string, actions: ConfirmRequest['actions']): Promise<string>;
}

/** The newest history entry (null at the start of the history): identifies the document. */
export function currentEntry(s: Pick<EditorState, 'session'>): HistoryEntry | null {
  const past = s.session.history.past;
  return past[past.length - 1] ?? null;
}

/** True when the document has changes that are not in its file. */
export function isDirty(s: Pick<EditorState, 'session' | 'cleanEntry'>): boolean {
  return currentEntry(s) !== s.cleanEntry;
}

const KEYPAD_KEY = 'ailegro-score:keypad';
const KEYPAD_TABS: readonly KeypadTab[] = [
  'notes',
  'more',
  'articulations',
  'ornaments',
  'lines',
  'dynamics',
];

/** The keypad as the user left it; open on wide screens on a first visit. */
function initialKeypad(): KeypadState {
  const wide = typeof window === 'undefined' || window.innerWidth >= 760;
  const fallback: KeypadState = {
    open: wide,
    collapsed: false,
    tab: 'notes',
    x: 16,
    y: typeof window === 'undefined' ? 200 : Math.max(120, window.innerHeight - 440),
  };
  try {
    const saved = JSON.parse(
      localStorage.getItem(KEYPAD_KEY) ?? 'null',
    ) as Partial<KeypadState> | null;
    if (!saved) return fallback;
    return {
      open: typeof saved.open === 'boolean' ? saved.open : fallback.open,
      collapsed: !!saved.collapsed,
      tab: KEYPAD_TABS.includes(saved.tab as KeypadTab) ? (saved.tab as KeypadTab) : 'notes',
      x: Number.isFinite(saved.x) ? saved.x! : fallback.x,
      y: Number.isFinite(saved.y) ? saved.y! : fallback.y,
    };
  } catch {
    return fallback;
  }
}

/** UI language: the saved choice, else Chinese (the owner's language; English is one click away). */
export function initialLang(): Lang {
  try {
    const saved = localStorage.getItem('ailegro-score:lang');
    if (saved === 'zh' || saved === 'en') return saved;
  } catch {
    /* storage unavailable */
  }
  return 'zh';
}

/** Fit an A4 page to narrow screens (phones); 100% elsewhere. */
function initialZoom(): number {
  if (typeof window === 'undefined' || window.innerWidth >= 760) return 1;
  return Math.max(0.4, Math.round(((window.innerWidth - 110) / 794) * 20) / 20);
}

/**
 * UI state that still points into `doc`: the last change may have removed bars or staves (the
 * cursor then moves to the bar now in that place).
 */
function keepValid(doc: ScoreDoc, prev: ScoreDoc, ui: EditorUiState): EditorUiState {
  let { cursor, selection } = ui;
  const exists = (at: ScorePosition) => hasStaff(doc, at.staffId) && hasMeasure(doc, at.measureId);
  if (cursor && !exists(cursor)) {
    const index = prev.measures.findIndex((m) => m.id === cursor!.measureId);
    const bar = doc.measures[Math.max(0, Math.min(index, doc.measures.length - 1))];
    cursor =
      bar && hasStaff(doc, cursor.staffId) ? { ...cursor, measureId: bar.id, offset: ZERO } : null;
  }
  if (selection.kind === 'rest' && !exists(selection.at)) selection = { kind: 'none' };
  if (
    selection.kind === 'range' &&
    (selection.measureTo >= doc.measures.length || selection.staffTo >= allStaves(doc).length)
  )
    selection = { kind: 'none' };
  return cursor === ui.cursor && selection === ui.selection ? ui : { ...ui, cursor, selection };
}

/**
 * Undo and redo end a line being drawn in note input: what it covered may have changed, and a line
 * the user took back should not come back with the next note.
 */
function endLine(s: EditorState): Partial<EditorState> {
  return s.input.pendingLine ? { input: { ...s.input, pendingLine: null } } : {};
}

export function createEditorStore(doc: ScoreDoc) {
  return create<EditorState>()((set, get) => ({
    session: Session.start(doc),
    doc,
    selection: { kind: 'none' },
    cursor: null,
    lastEntered: null,
    input: { active: false, value: 'quarter', dots: 0, voice: 0, pendingLine: null },
    view: {
      zoom: initialZoom(),
      concertPitch: doc.settings.concertPitch,
      mode: 'page',
      lang: initialLang(),
    },
    playing: false,
    playhead: null,
    // narrow screens start with the score; the panels are one tap away
    panel: typeof window !== 'undefined' && window.innerWidth < 760 ? null : 'ailegro',
    dialog: null,
    toast: null,
    fileName: null,
    cleanEntry: null,
    keypad: initialKeypad(),
    confirm: null,
    changedAt: 0,
    generation: 0,
    ids: randomIds(),

    apply(commands, label, after) {
      const state = get();
      const before: EditorUiState = {
        selection: state.selection,
        cursor: state.cursor,
        lastEntered: state.lastEntered,
      };
      try {
        const ui: EditorUiState = { ...before, ...after };
        const next = state.session.dispatch(commands, label, { before, after: ui });
        set({
          session: next,
          doc: next.doc,
          changedAt: Date.now(),
          ...keepValid(next.doc, state.doc, ui),
        });
        return true;
      } catch (e) {
        const message = e instanceof CommandError ? e.message : String(e);
        set({ toast: { text: message, kind: 'error', at: Date.now() } });
        console.warn('[editor] command rejected', e);
        return false;
      }
    },
    undo() {
      const { session, entry } = get().session.undo();
      if (!entry) return;
      const ui = (entry.before as EditorUiState | undefined) ?? {
        selection: { kind: 'none' },
        cursor: null,
        lastEntered: null,
      };
      set({
        session,
        doc: session.doc,
        changedAt: Date.now(),
        ...keepValid(session.doc, get().doc, ui),
        ...endLine(get()),
      });
    },
    redo() {
      const { session, entry } = get().session.redo();
      if (!entry) return;
      const ui = (entry.after as EditorUiState | undefined) ?? {
        selection: { kind: 'none' },
        cursor: null,
        lastEntered: null,
      };
      set({
        session,
        doc: session.doc,
        changedAt: Date.now(),
        ...keepValid(session.doc, get().doc, ui),
        ...endLine(get()),
      });
    },
    load(next, fileName = null) {
      const session = Session.start(next);
      set({
        session,
        doc: next,
        selection: { kind: 'none' },
        cursor: null,
        lastEntered: null,
        input: { ...get().input, active: false, pendingLine: null },
        fileName,
        cleanEntry: null,
        changedAt: Date.now(),
        generation: get().generation + 1,
        view: { ...get().view, concertPitch: next.settings.concertPitch },
      });
    },
    select(selection) {
      set({ selection });
    },
    setCursor(cursor) {
      set({ cursor });
    },
    setInput(patch) {
      set({ input: { ...get().input, ...patch } });
    },
    setView(patch) {
      const view = { ...get().view, ...patch };
      if (patch.lang) {
        try {
          localStorage.setItem('ailegro-score:lang', patch.lang);
        } catch {
          /* ignore */
        }
      }
      set({ view });
    },
    setPanel(panel) {
      set({ panel });
    },
    setDialog(dialog) {
      set({ dialog });
    },
    setPlaying(playing, playhead = null) {
      set({ playing, playhead });
    },
    setPlayhead(playhead) {
      set({ playhead });
    },
    notify(text, kind = 'info') {
      set({ toast: { text, kind, at: Date.now() } });
    },
    setKeypad(patch) {
      const keypad = { ...get().keypad, ...patch };
      try {
        localStorage.setItem(KEYPAD_KEY, JSON.stringify(keypad));
      } catch {
        /* ignore */
      }
      set({ keypad });
    },
    markSaved(fileName, entry) {
      set({
        cleanEntry: entry !== undefined ? entry : currentEntry(get()),
        ...(fileName !== undefined ? { fileName } : {}),
      });
    },
    ask(message, actions) {
      return new Promise<string>((resolve) => {
        set({
          confirm: {
            message,
            actions,
            resolve: (id) => {
              set({ confirm: null });
              resolve(id);
            },
          },
        });
      });
    },
  }));
}

export type EditorStore = ReturnType<typeof createEditorStore>;

// The app has exactly one store; it is created in main.tsx before rendering.
let store: EditorStore | null = null;

export function initStore(doc: ScoreDoc): EditorStore {
  store = createEditorStore(doc);
  return store;
}

export function getStore(): EditorStore {
  if (!store) throw new Error('editor store not initialised');
  return store;
}

/** Selector hook bound to the app store. */
export function useEditor<T>(selector: (s: EditorState) => T): T {
  return getStore()(selector);
}

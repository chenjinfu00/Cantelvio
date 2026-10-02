/**
 * Editor state (zustand). The document lives in a core `Session` (doc + undo history); every
 * change goes through `apply()` with core commands, never by mutating the document.
 */
import {
  type Command,
  CommandError,
  type IdGenerator,
  type NoteValue,
  type ScoreDoc,
  type ScorePosition,
  Session,
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
    };

export interface InputState {
  readonly active: boolean;
  readonly value: NoteValue;
  readonly dots: number;
  readonly voice: number;
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

export function createEditorStore(doc: ScoreDoc) {
  return create<EditorState>()((set, get) => ({
    session: Session.start(doc),
    doc,
    selection: { kind: 'none' },
    cursor: null,
    lastEntered: null,
    input: { active: false, value: 'quarter', dots: 0, voice: 0 },
    view: { zoom: 1, concertPitch: doc.settings.concertPitch, mode: 'page', lang: initialLang() },
    playing: false,
    playhead: null,
    panel: 'ailegro',
    dialog: null,
    toast: null,
    fileName: null,
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
        const next = state.session.dispatch(commands, label, {
          before,
          after: { ...before, ...after },
        });
        set({ session: next, doc: next.doc, changedAt: Date.now(), ...(after ?? {}) });
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
      set({ session, doc: session.doc, changedAt: Date.now(), ...ui });
    },
    redo() {
      const { session, entry } = get().session.redo();
      if (!entry) return;
      const ui = (entry.after as EditorUiState | undefined) ?? {
        selection: { kind: 'none' },
        cursor: null,
        lastEntered: null,
      };
      set({ session, doc: session.doc, changedAt: Date.now(), ...ui });
    },
    load(next, fileName = null) {
      const session = Session.start(next);
      set({
        session,
        doc: next,
        selection: { kind: 'none' },
        cursor: null,
        lastEntered: null,
        input: { ...get().input, active: false },
        fileName,
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

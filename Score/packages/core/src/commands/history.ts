import type { ScoreDoc } from '../model/types';
import { type Patch, applyCommand, applyPatchList } from './apply';
import type { Command } from './types';

export interface HistoryEntry {
  readonly label: string;
  readonly commands: readonly Command[];
  readonly patches: readonly Patch[];
  readonly inverse: readonly Patch[];
  /** Opaque editor state (selection, cursor) to restore on undo/redo. */
  readonly before?: unknown;
  readonly after?: unknown;
}

export interface History {
  readonly past: readonly HistoryEntry[];
  readonly future: readonly HistoryEntry[];
  readonly limit: number;
}

export const emptyHistory = (limit = 500): History => ({ past: [], future: [], limit });

/**
 * An editing session: a document plus undo/redo. Immutable; every method returns a new session.
 * The web editor's store and headless scripts both build on this.
 */
export class Session {
  private constructor(
    readonly doc: ScoreDoc,
    readonly history: History,
  ) {}

  static start(doc: ScoreDoc, limit = 500): Session {
    return new Session(doc, emptyHistory(limit));
  }

  get canUndo(): boolean {
    return this.history.past.length > 0;
  }

  get canRedo(): boolean {
    return this.history.future.length > 0;
  }

  /** Apply one command (or several as one undo step). Throws CommandError if invalid. */
  dispatch(
    commands: Command | readonly Command[],
    label?: string,
    editorState?: { before?: unknown; after?: unknown },
  ): Session {
    const list = Array.isArray(commands) ? (commands as readonly Command[]) : [commands as Command];
    if (list.length === 0) return this;
    const cmd: Command = list.length === 1 ? list[0]! : { type: 'batch', commands: list };
    const r = applyCommand(this.doc, cmd);
    if (r.patches.length === 0) return new Session(r.doc, this.history);
    const entry: HistoryEntry = {
      label: label ?? (list.length === 1 ? list[0]!.type : 'batch'),
      commands: list,
      patches: r.patches,
      inverse: r.inverse,
      ...(editorState?.before !== undefined ? { before: editorState.before } : {}),
      ...(editorState?.after !== undefined ? { after: editorState.after } : {}),
    };
    const past = [...this.history.past, entry].slice(-this.history.limit);
    return new Session(r.doc, { ...this.history, past, future: [] });
  }

  undo(): { session: Session; entry: HistoryEntry | null } {
    const entry = this.history.past[this.history.past.length - 1];
    if (!entry) return { session: this, entry: null };
    const doc = applyPatchList(this.doc, entry.inverse);
    return {
      session: new Session(doc, {
        ...this.history,
        past: this.history.past.slice(0, -1),
        future: [entry, ...this.history.future],
      }),
      entry,
    };
  }

  redo(): { session: Session; entry: HistoryEntry | null } {
    const entry = this.history.future[0];
    if (!entry) return { session: this, entry: null };
    const doc = applyPatchList(this.doc, entry.patches);
    return {
      session: new Session(doc, {
        ...this.history,
        past: [...this.history.past, entry],
        future: this.history.future.slice(1),
      }),
      entry,
    };
  }

  /** Replace the document without history (e.g. after loading a file). */
  reset(doc: ScoreDoc): Session {
    return new Session(doc, emptyHistory(this.history.limit));
  }
}

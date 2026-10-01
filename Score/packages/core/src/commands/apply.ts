import { type Patch, applyPatches, enablePatches, produceWithPatches } from 'immer';
import type { ScoreDoc } from '../model/types';
import * as content from './content';
import type { DraftDoc } from './draft';
import * as structure from './structure';
import { type Command, CommandError } from './types';

enablePatches();

type Handler<C extends Command = Command> = (draft: DraftDoc, base: ScoreDoc, cmd: C) => void;

type HandlerMap = {
  [K in Exclude<Command['type'], 'batch'>]: Handler<Extract<Command, { type: K }>>;
};

const HANDLERS: HandlerMap = {
  'meta.set': (draft, _base, cmd) => {
    Object.assign(draft.meta, cmd.patch);
  },
  'settings.set': (draft, _base, cmd) => {
    Object.assign(draft.settings, cmd.patch);
  },
  'measures.insert': structure.measuresInsert,
  'measures.delete': structure.measuresDelete,
  'measure.setTimeSig': structure.measureSetTimeSig,
  'measure.setKeySig': structure.measureSetKeySig,
  'measure.setBarline': structure.measureSetBarline,
  'measure.setRepeat': structure.measureSetRepeat,
  'measure.setTempo': structure.measureSetTempo,
  'measure.setBreak': structure.measureSetBreak,
  'measure.setRehearsalMark': structure.measureSetRehearsalMark,
  'note.enter': content.noteEnter,
  'rest.enter': content.restEnter,
  'events.insert': content.eventsInsert,
  'provenance.accept': content.provenanceAccept,
  'provenance.reject': content.provenanceReject,
  'note.addToChord': content.noteAddToChord,
  'note.setPitch': content.noteSetPitch,
  'notes.delete': content.notesDelete,
  'events.delete': content.eventsDelete,
  'event.setDuration': content.eventSetDuration,
  'notes.setTie': content.notesSetTie,
  'events.setArticulation': content.eventsSetArticulation,
  'events.setStem': content.eventsSetStem,
  'range.clear': content.rangeClear,
  'tuplet.create': content.tupletCreate,
  'clef.set': structure.clefSet,
  'dynamic.set': structure.dynamicSet,
  'dynamic.delete': structure.dynamicDelete,
  'harmony.set': structure.harmonySet,
  'harmony.delete': structure.harmonyDelete,
  'part.add': structure.partAdd,
  'part.remove': structure.partRemove,
  'part.rename': structure.partRename,
};

export interface ApplyResult {
  readonly doc: ScoreDoc;
  /** Forward patches (JSON-patch-like, immer format). */
  readonly patches: readonly Patch[];
  /** Patches that undo this change when applied to `doc`. */
  readonly inverse: readonly Patch[];
}

/**
 * Apply a command. Pure: returns a new document (structurally shared with the old one) and the
 * patches describing the change. Throws CommandError if the command is invalid; `doc` is then
 * unchanged.
 */
export function applyCommand(doc: ScoreDoc, cmd: Command): ApplyResult {
  if (cmd.type === 'batch') {
    let current = doc;
    const patches: Patch[] = [];
    const inverse: Patch[] = [];
    for (const sub of cmd.commands) {
      const r = applyCommand(current, sub);
      current = r.doc;
      patches.push(...r.patches);
      inverse.unshift(...r.inverse);
    }
    return { doc: current, patches, inverse };
  }
  const handler = HANDLERS[cmd.type] as Handler | undefined;
  if (!handler) throw new CommandError(cmd, 'unknown command type');
  const [next, patches, inverse] = produceWithPatches(doc, (draft) => {
    handler(draft as DraftDoc, doc, cmd);
  });
  return { doc: next, patches, inverse };
}

/** Apply many commands in order (convenience for scripts and tests). */
export function applyCommands(doc: ScoreDoc, cmds: readonly Command[]): ScoreDoc {
  return cmds.reduce((d, c) => applyCommand(d, c).doc, doc);
}

export function applyPatchList(doc: ScoreDoc, patches: readonly Patch[]): ScoreDoc {
  return applyPatches(doc, patches as Patch[]);
}

export type { Patch };

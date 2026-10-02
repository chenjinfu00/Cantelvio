import {
  type ScoreDoc,
  type ScorePosition,
  findEventOfNote,
  measureInfo,
} from '@ailegro-score/core';
import { useState } from 'react';
import { type MessageKey, useT } from '../i18n';
import { type Selection, isDirty, useEditor } from '../state/store';

function describePosition(doc: ScoreDoc, at: ScorePosition): { bar: number; beat: string } {
  const info = measureInfo(doc, at.measureId);
  const beat = (at.offset.n / at.offset.d) * info.timeSig.beatType + 1;
  return { bar: info.index + 1, beat: Number.isInteger(beat) ? String(beat) : beat.toFixed(2) };
}

function positionOf(
  doc: ScoreDoc,
  selection: Selection,
  cursor: ScorePosition | null,
): ScorePosition | null {
  if (cursor) return cursor;
  if (selection.kind === 'rest') return selection.at;
  if (selection.kind === 'notes' && selection.noteIds.length) {
    const loc = findEventOfNote(doc, selection.noteIds[0]!);
    if (loc)
      return {
        staffId: loc.staffId,
        voice: loc.voice,
        measureId: loc.measureId,
        offset: loc.event.offset,
      };
  }
  return null;
}

export function StatusBar({ savedAt }: { savedAt: number | null }) {
  const t = useT();
  const doc = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  const cursor = useEditor((s) => s.cursor);
  const input = useEditor((s) => s.input);
  const changedAt = useEditor((s) => s.changedAt);
  const [help, setHelp] = useState(false);

  const at = positionOf(doc, selection, cursor);
  let where = t('status.noSelection');
  if (selection.kind === 'range') {
    where = `${t('status.measure')} ${selection.measureFrom + 1}${selection.measureTo > selection.measureFrom ? `–${selection.measureTo + 1}` : ''}`;
  } else if (at) {
    const p = describePosition(doc, at);
    where = `${t('status.measure')} ${p.bar} · ${t('status.beat')} ${p.beat} · ${t('status.voice')} ${at.voice + 1}`;
  }
  if (selection.kind === 'notes' && selection.noteIds.length > 1)
    where += ` · ${t('status.notes', { n: selection.noteIds.length })}`;
  const duration = `${input.dots ? t('status.dotted') : ''}${t(`dur.${input.value}` as MessageKey)}`;
  const autosaved = savedAt !== null && savedAt >= changedAt;
  const dirty = useEditor((s) => isDirty(s));
  const fileName = useEditor((s) => s.fileName);

  return (
    <footer className="statusbar">
      <span className={`mode ${input.active ? 'input' : ''}`}>
        {input.active ? t('status.inputMode') : t('status.normalMode')}
      </span>
      <span>{where}</span>
      <span>
        {t('status.duration')}: {duration}
      </span>
      <span className="grow" />
      <span className="parts">
        {t('status.summary', { p: doc.parts.length, m: doc.measures.length })}
      </span>
      <span
        className={`file-state ${dirty ? 'unsaved' : 'saved'}`}
        title={autosaved ? t('status.autosaved') : undefined}
      >
        {fileName ? `${fileName} · ` : ''}
        {dirty ? t('status.dirty') : fileName ? t('status.clean') : t('status.newFile')}
      </span>
      <button className="link" onClick={() => setHelp(!help)} aria-expanded={help}>
        {t('status.shortcuts')}
      </button>
      {help && (
        <div className="help-pop" role="dialog" onClick={() => setHelp(false)}>
          {t('help.shortcuts')
            .split(' · ')
            .map((line) => (
              <div key={line}>{line}</div>
            ))}
        </div>
      )}
    </footer>
  );
}

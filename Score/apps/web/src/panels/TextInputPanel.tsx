import { TextNotationError, findEvent, textToCommands } from '@cantelvio-score/core';
import { useState } from 'react';
import { useT } from '../i18n';
import { cursorFromSelection } from '../state/actions';
import { getStore, useEditor } from '../state/store';

const EXAMPLE = 'c4 d e f | g2 g | a4 a a a | g1 |\n<c e g>2 r4 3{e8 f g} | c1';

export function TextInputPanel() {
  const t = useT();
  const [text, setText] = useState('');
  const [message, setMessage] = useState<{ kind: 'error' | 'warn' | 'ok'; text: string } | null>(
    null,
  );
  const hasTarget = useEditor((s) => !!s.cursor || s.selection.kind !== 'none');

  const apply = () => {
    const s = getStore().getState();
    if (!s.cursor && s.selection.kind === 'none') {
      setMessage({ kind: 'error', text: t('text.noCursor') });
      return;
    }
    const at = s.cursor ?? cursorFromSelection(s.doc, s.selection, s.input.voice);
    try {
      const r = textToCommands(s.doc, at, text, { ids: s.ids });
      if (!r.commands.length) return;
      const last = r.eventIds[r.eventIds.length - 1] ?? null;
      if (
        !s.apply(r.commands, 'text input', {
          cursor: s.input.active ? r.end : null,
          lastEntered: last,
        })
      )
        return;
      const loc = last ? findEvent(getStore().getState().doc, last) : null;
      if (loc)
        getStore().setState({
          selection: { kind: 'notes', noteIds: loc.event.notes.map((n) => n.id) },
        });
      setMessage(
        r.warnings.length
          ? { kind: 'warn', text: r.warnings.join('\n') }
          : { kind: 'ok', text: t('text.done', { n: r.eventIds.length }) },
      );
    } catch (e) {
      setMessage({
        kind: 'error',
        text: e instanceof TextNotationError ? e.message : String((e as Error).message ?? e),
      });
    }
  };

  return (
    <div className="panel-body">
      <h3>{t('text.title')}</h3>
      <textarea
        className="code"
        rows={8}
        value={text}
        placeholder={t('text.placeholder')}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            apply();
          }
        }}
      />
      <div className="row tight">
        <button className="primary" onClick={apply} disabled={!text.trim()} title="Ctrl+Enter">
          {t('text.apply')}
        </button>
        <button onClick={() => setText(EXAMPLE)}>{t('text.example')}</button>
      </div>
      {!hasTarget && <p className="hint">{t('text.noCursor')}</p>}
      {message && <pre className={`message ${message.kind}`}>{message.text}</pre>}
      <p className="hint">{t('text.help')}</p>
      <p className="hint">{t('text.concert')}</p>
    </div>
  );
}

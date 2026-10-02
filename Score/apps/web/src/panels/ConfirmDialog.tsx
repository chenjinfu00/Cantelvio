import { useEffect, useRef } from 'react';
import { useEditor } from '../state/store';

/** In-app question dialog (window.confirm is unavailable inside the artifact viewer). */
export function ConfirmDialog() {
  const confirm = useEditor((s) => s.confirm);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!confirm) return;
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      const cancel = confirm.actions.find((a) => a.id === 'cancel') ?? confirm.actions.at(-1);
      if (cancel) confirm.resolve(cancel.id);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [confirm]);
  if (!confirm) return null;
  return (
    <div className="modal-backdrop">
      <div
        className="modal confirm"
        role="alertdialog"
        aria-modal="true"
        aria-label={confirm.message}
      >
        <p>{confirm.message}</p>
        <div className="modal-actions">
          {confirm.actions.map((a, i) => (
            <button
              key={a.id}
              ref={i === 0 ? first : undefined}
              className={a.primary ? 'primary' : ''}
              onClick={() => confirm.resolve(a.id)}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

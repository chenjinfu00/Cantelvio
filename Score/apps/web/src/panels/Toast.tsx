import { useEffect, useState } from 'react';
import { useEditor } from '../state/store';

export function Toast() {
  const toast = useEditor((s) => s.toast);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!toast) return;
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), toast.kind === 'error' ? 6000 : 3500);
    return () => clearTimeout(timer);
  }, [toast]);
  if (!toast || !visible) return null;
  return (
    <div
      className={`toast ${toast.kind}`}
      role={toast.kind === 'error' ? 'alert' : 'status'}
      onClick={() => setVisible(false)}
    >
      {toast.text}
    </div>
  );
}

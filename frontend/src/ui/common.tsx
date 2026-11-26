import { useEffect, useRef, useState, type ReactNode } from 'react';
import { errorMessage } from '../domain/errors';

export function useNotice() {
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const show = (kind: 'ok' | 'error', text: string) => {
    setNotice({ kind, text });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setNotice(null), 5000);
  };
  const node = notice ? (
    <div className={`toast ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
      {notice.text}
    </div>
  ) : null;
  /** Runs an async action, surfacing failures as an error toast. */
  const run = async <T,>(fn: () => Promise<T>, okText?: string): Promise<T | undefined> => {
    try {
      const r = await fn();
      if (okText) show('ok', okText);
      return r;
    } catch (e) {
      show('error', errorMessage(e));
      return undefined;
    }
  };
  return { show, node, run };
}

export function Modal({ title, onClose, children, danger }: { title: string; onClose: () => void; children: ReactNode; danger?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${danger ? 'danger' : ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" aria-label="Close dialog" onClick={onClose}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Confirm({ title, body, confirmLabel, onConfirm, onCancel }: {
  title: string; body: ReactNode; confirmLabel: string; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <Modal title={title} onClose={onCancel} danger>
      <p>{body}</p>
      <div className="row end">
        <button onClick={onCancel}>Cancel</button>
        <button className="btn-danger" onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </Modal>
  );
}

/** Uncontrolled text field that commits on blur / Enter (avoids one op per keystroke). */
export function CommitInput({ value, onCommit, multiline, label, ...rest }: {
  value: string; onCommit: (v: string) => void; multiline?: boolean; label: string; disabled?: boolean; maxLength?: number;
}) {
  const key = `${label}:${value}`;
  const commit = (v: string) => { if (v !== value) onCommit(v); };
  return (
    <label className="field">
      <span>{label}</span>
      {multiline ? (
        <textarea key={key} defaultValue={value} rows={3} onBlur={(e) => commit(e.target.value)} {...rest} />
      ) : (
        <input
          key={key}
          defaultValue={value}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          {...rest}
        />
      )}
    </label>
  );
}

export function StateBadge({ state }: { state: string }) {
  return <span className={`badge state-${state}`}>{state}</span>;
}

export function fmtDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—';
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function downloadText(filename: string, text: string, mime = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

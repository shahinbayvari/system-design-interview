import { useEffect, useState } from 'react';
import { errorMessage } from '../domain/errors';
import { useServices, type JoinPreview } from '../services';
import { loadGuest, saveGuest } from './guestStore';
import { navigate } from './router';

function browserWarning(): string | null {
  const ok = typeof BroadcastChannel !== 'undefined' && typeof crypto?.subtle !== 'undefined' && typeof structuredClone === 'function';
  return ok ? null : 'Your browser may not support everything needed here. Please use the latest Chrome, Edge, Firefox or Safari on a desktop.';
}

export function Lobby({ token }: { token: string }) {
  const { join, collab } = useServices();
  const [preview, setPreview] = useState<JoinPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const p = await join.preview(token);
        if (!live) return;
        // Already joined in this tab? Resume instead of creating a new participant.
        const stored = loadGuest(p.sessionId);
        if (stored) {
          try {
            saveGuest(await collab.refreshCredential(stored));
            navigate(`/room/${p.sessionId}`);
            return;
          } catch {
            /* fall through to the normal join form */
          }
        }
        setPreview(p);
      } catch (e) {
        if (live) setError(errorMessage(e));
      }
    })();
    return () => { live = false; };
  }, [join, collab, token]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await join.join(token, name);
      saveGuest(r.credential);
      navigate(`/room/${r.session.id}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const warn = browserWarning();

  return (
    <main className="card narrow lobby">
      <p className="brand">SD Interview</p>
      {!preview && !error && <p className="muted">Checking your link…</p>}
      {!preview && error && (
        <>
          <h1>Can't join this interview</h1>
          <p className="error" role="alert">{error}</p>
        </>
      )}
      {preview && (
        <>
          <h1>{preview.sessionTitle}</h1>
          {warn && <p className="warn" role="note">{warn}</p>}
          <form className="stack" onSubmit={submit}>
            <label className="field">
              <span>Your display name</span>
              <input required maxLength={40} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </label>
            <p className="muted small">
              Everything drawn on the canvas during this interview is saved automatically, and may be reviewed
              by the interviewer afterwards.
            </p>
            <label className="check">
              <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} required />
              <span>I understand that canvas activity is saved.</span>
            </label>
            {error && <p className="error" role="alert">{error}</p>}
            <button className="btn-primary" disabled={busy || !accepted || !name.trim()}>Join interview</button>
          </form>
        </>
      )}
    </main>
  );
}

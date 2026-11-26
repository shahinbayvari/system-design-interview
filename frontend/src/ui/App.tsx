import { useCallback, useEffect, useState } from 'react';
import type { User } from '../domain/types';
import { errorMessage } from '../domain/errors';
import { useServices } from '../services';
import { Dashboard } from './Dashboard';
import { Lobby } from './Lobby';
import { NewSession } from './NewSession';
import { Review } from './Review';
import { Room } from './Room';
import { navigate, useRoute } from './router';

function SignIn({ onSignedIn }: { onSignedIn: (u: User) => void }) {
  const { auth } = useServices();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await auth.signInWithMagicLink(email, name));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="card narrow">
      <h1>Interviewer sign in</h1>
      <p className="muted">
        Demo mode: there is no real backend. Entering an email signs you in instantly, as if you had clicked a
        magic link. Candidates do not sign in; they use the link you send them.
      </p>
      <form onSubmit={submit} className="stack">
        <label className="field">
          <span>Email</span>
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
        </label>
        <label className="field">
          <span>Display name (optional)</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn-primary" disabled={busy}>Send magic link &amp; sign in</button>
      </form>
    </main>
  );
}

export function App() {
  const { auth } = useServices();
  const route = useRoute();
  const [user, setUser] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    auth.getCurrentUser().then((u) => live && setUser(u));
    return () => { live = false; };
  }, [auth]);

  const signOut = useCallback(async () => {
    await auth.signOut();
    setUser(null);
    navigate('/');
  }, [auth]);

  if (route.name === 'join') return <Lobby token={route.token} />;
  if (user === undefined) return <p className="center muted">Loading…</p>;

  // Rooms can be entered by guests (stored identity) or signed-in users.
  if (route.name === 'room') return <Room sessionId={route.id} user={user} />;

  if (!user) return <SignIn onSignedIn={setUser} />;

  return (
    <div className="shell">
      <header className="appbar">
        <a href="#/" className="brand">SD Interview</a>
        <span className="grow" />
        <span className="muted">{user.displayName}</span>
        <button onClick={signOut}>Sign out</button>
      </header>
      {route.name === 'dashboard' && <Dashboard />}
      {route.name === 'new' && <NewSession />}
      {route.name === 'review' && <Review sessionId={route.id} />}
      {route.name === 'notfound' && <p className="center">Page not found. <a href="#/">Go to dashboard</a></p>}
    </div>
  );
}

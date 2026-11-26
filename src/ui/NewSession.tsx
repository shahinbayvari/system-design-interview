import { useState } from 'react';
import { errorMessage } from '../domain/errors';
import { useServices } from '../services';
import { navigate } from './router';

export function NewSession() {
  const { sessions } = useServices();
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [duration, setDuration] = useState(45);
  const [reveal, setReveal] = useState<'join' | 'start'>('join');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const s = await sessions.create({ title, prompt, durationMinutes: duration, promptReveal: reveal });
      navigate(`/room/${s.id}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <main className="card narrow">
      <h1>New interview</h1>
      <form className="stack" onSubmit={submit}>
        <label className="field">
          <span>Title</span>
          <input required value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Design a URL shortener" />
        </label>
        <label className="field">
          <span>Problem statement (optional)</span>
          <textarea rows={6} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </label>
        <div className="row">
          <label className="field">
            <span>Duration (minutes)</span>
            <input type="number" min={1} max={480} value={duration} onChange={(e) => setDuration(Number(e.target.value))} />
          </label>
          <label className="field grow">
            <span>Candidates can read the prompt</span>
            <select value={reveal} onChange={(e) => setReveal(e.target.value as 'join' | 'start')}>
              <option value="join">As soon as they join</option>
              <option value="start">Only after I start the interview</option>
            </select>
          </label>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="row end">
          <button type="button" onClick={() => navigate('/')}>Cancel</button>
          <button className="btn-primary" disabled={busy}>Create draft</button>
        </div>
      </form>
    </main>
  );
}

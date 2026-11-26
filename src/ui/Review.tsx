import { useEffect, useMemo, useState } from 'react';
import { CanvasDoc } from '../domain/canvasDoc';
import { boundsOf, unionBounds } from '../domain/geometry';
import type { AuditEvent, InterviewSession, Participant } from '../domain/types';
import { errorMessage } from '../domain/errors';
import { useServices } from '../services';
import { downloadText, fmtDate, StateBadge, useNotice } from './common';
import { ElementsLayer } from './ElementsLayer';
import { navigate } from './router';

export function Review({ sessionId }: { sessionId: string }) {
  const { sessions } = useServices();
  const [session, setSession] = useState<InterviewSession | null>(null);
  const [doc, setDoc] = useState<CanvasDoc | null>(null);
  const [people, setPeople] = useState<Participant[]>([]);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { node, run } = useNotice();

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const s = await sessions.get(sessionId);
        const snap = await sessions.getCanvasSnapshot(sessionId);
        if (!live) return;
        setSession(s);
        setDoc(CanvasDoc.fromState('review', snap));
        sessions.listParticipants(sessionId).then((p) => live && setPeople(p)).catch(() => {});
        sessions.listAuditEvents(sessionId).then((a) => live && setAudit(a)).catch(() => {});
      } catch (e) {
        if (live) setError(errorMessage(e));
      }
    })();
    return () => { live = false; };
  }, [sessions, sessionId]);

  const elements = useMemo(() => doc?.visible() ?? [], [doc]);
  const viewBox = useMemo(() => {
    const b = unionBounds(elements.map(boundsOf));
    if (!b) return '0 0 800 500';
    const pad = 40;
    return `${b.x - pad} ${b.y - pad} ${Math.max(b.w, 100) + pad * 2} ${Math.max(b.h, 100) + pad * 2}`;
  }, [elements]);

  if (error) return <main className="card narrow"><p className="error" role="alert">{error}</p><a href="#/">Back</a></main>;
  if (!session) return <p className="center muted">Loading…</p>;

  return (
    <main className="page review">
      <div className="row">
        <h1>{session.title}</h1> <StateBadge state={session.state} />
        <span className="grow" />
        <button onClick={async () => { const j = await run(() => sessions.exportCanvasJson(sessionId)); if (j) downloadText(`${session.title.replace(/\W+/g, '-')}.json`, j); }}>Export JSON</button>
        {session.state === 'ended' && <button onClick={async () => { if (await run(() => sessions.reopen(sessionId), 'Reopened.')) navigate(`/room/${sessionId}`); }}>Reopen</button>}
        {session.state !== 'archived' && session.state !== 'ended' && <button onClick={() => navigate(`/room/${sessionId}`)}>Open live room</button>}
      </div>
      {node}
      <p className="muted">
        Started {fmtDate(session.startedAt)} · Ended {fmtDate(session.endedAt)} · {elements.length} elements
      </p>
      <div className="review-canvas" aria-label="Final canvas (read-only)">
        <svg viewBox={viewBox} role="img" aria-label={`Final canvas for ${session.title}`}>
          <ElementsLayer elements={elements} />
        </svg>
        {elements.length === 0 && <p className="empty">The canvas is empty.</p>}
      </div>
      <div className="cols">
        <section>
          <h2>Prompt</h2>
          <p className="prompt">{session.prompt || '—'}</p>
          <h2>Participants</h2>
          <ul className="list">
            {people.map((p) => <li key={p.id}>{p.displayName} · {p.role}{p.removed ? ' · removed' : ''}</li>)}
            {people.length === 0 && <li className="muted">—</li>}
          </ul>
        </section>
        <section>
          <h2>Audit log</h2>
          <ul className="list">
            {audit.map((a) => <li key={a.id}>{fmtDate(a.at)} · {a.action.replace(/_/g, ' ')}</li>)}
            {audit.length === 0 && <li className="muted">Only the owner can see the audit log.</li>}
          </ul>
        </section>
      </div>
    </main>
  );
}

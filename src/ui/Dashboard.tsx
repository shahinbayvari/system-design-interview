import { useCallback, useEffect, useState } from 'react';
import type { SessionSummary } from '../domain/types';
import { useServices } from '../services';
import { Confirm, copyText, fmtDate, StateBadge, useNotice } from './common';
import { joinUrl, navigate } from './router';

export function Dashboard() {
  const { sessions, guestLinks } = useServices();
  const [rows, setRows] = useState<SessionSummary[] | null>(null);
  const [archiving, setArchiving] = useState<SessionSummary | null>(null);
  const { node, run, show } = useNotice();

  const refresh = useCallback(async () => {
    const r = await run(() => sessions.list());
    if (r) setRows(r);
  }, [sessions]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { void refresh(); }, [refresh]);

  const copyLink = async (s: SessionSummary) => {
    const created = await run(() => guestLinks.create(s.id));
    if (!created) return;
    const url = joinUrl(created.token);
    show('ok', (await copyText(url)) ? 'New candidate link copied to clipboard.' : `Candidate link: ${url}`);
  };

  return (
    <main className="page">
      <div className="row">
        <h1>Interviews</h1>
        <span className="grow" />
        <button className="btn-primary" onClick={() => navigate('/new')}>New interview</button>
      </div>
      {node}
      {rows === null ? <p className="muted">Loading…</p> : rows.length === 0 ? (
        <p className="empty">No interviews yet. Create one to get a candidate link.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Title</th><th>State</th><th>Created</th><th>Session time</th><th>Participants</th><th>Last modified</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const owner = s.myRole === 'owner';
              const ended = s.state === 'ended' || s.state === 'archived';
              return (
                <tr key={s.id}>
                  <td><strong>{s.title}</strong>{!owner && <span className="muted"> ({s.myRole})</span>}</td>
                  <td><StateBadge state={s.state} /></td>
                  <td>{fmtDate(s.createdAt)}</td>
                  <td>{fmtDate(s.startedAt ?? s.scheduledAt)}</td>
                  <td>{s.participantNames.join(', ') || '—'}</td>
                  <td>{fmtDate(s.updatedAt)}</td>
                  <td className="actions">
                    <button onClick={() => navigate(ended ? `/review/${s.id}` : `/room/${s.id}`)}>{ended ? 'Review' : 'Open'}</button>
                    {owner && s.state !== 'archived' && <button onClick={() => copyLink(s)}>Copy link</button>}
                    {owner && <button onClick={async () => { if (await run(() => sessions.duplicate(s.id), 'Duplicated as a new draft.')) void refresh(); }}>Duplicate</button>}
                    {owner && s.state !== 'archived' && s.state !== 'live' && <button onClick={() => setArchiving(s)}>Archive</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {archiving && (
        <Confirm
          title="Archive interview?"
          body={`"${archiving.title}" will no longer be joinable. Its canvas stays available for review.`}
          confirmLabel="Archive"
          onCancel={() => setArchiving(null)}
          onConfirm={async () => {
            const s = archiving;
            setArchiving(null);
            if (await run(() => sessions.archive(s.id), 'Archived.')) void refresh();
          }}
        />
      )}
    </main>
  );
}

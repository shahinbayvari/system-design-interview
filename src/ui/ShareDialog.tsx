import { useCallback, useEffect, useState } from 'react';
import type { GuestLink, Participant } from '../domain/types';
import { useServices } from '../services';
import { copyText, fmtDate, Modal, useNotice } from './common';
import { joinUrl } from './router';

export function ShareDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const { guestLinks, sessions } = useServices();
  const [links, setLinks] = useState<GuestLink[]>([]);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [fresh, setFresh] = useState<string | null>(null);
  const [role, setRole] = useState<'candidate' | 'observer'>('candidate');
  const [maxUses, setMaxUses] = useState('');
  const [expiresHours, setExpiresHours] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'interviewer' | 'observer'>('interviewer');
  const { node, run, show } = useNotice();

  const refresh = useCallback(async () => {
    const [l, p] = await Promise.all([run(() => guestLinks.list(sessionId)), run(() => sessions.listParticipants(sessionId))]);
    if (l) setLinks(l);
    if (p) setParticipants(p);
  }, [guestLinks, sessions, sessionId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void refresh(); }, [refresh]);

  const show_ = async (token: string) => {
    const url = joinUrl(token);
    setFresh(url);
    show('ok', (await copyText(url)) ? 'Link copied to clipboard.' : 'Link created. Copy it below.');
    void refresh();
  };

  const create = async () => {
    const created = await run(() => guestLinks.create(sessionId, {
      role,
      maxUses: maxUses ? Number(maxUses) : null,
      expiresAt: expiresHours ? new Date(Date.now() + Number(expiresHours) * 3600_000).toISOString() : null,
    }));
    if (created) await show_(created.token);
  };

  return (
    <Modal title="Share interview" onClose={onClose}>
      {node}
      <section className="stack">
        <h3>Candidate links</h3>
        <p className="muted small">
          Links can only be copied when they are created (the server keeps just a hash). Revoking a link stops new
          joins but does not disconnect anyone already in the room.
        </p>
        {fresh && (
          <div className="linkbox">
            <input readOnly value={fresh} aria-label="New link" onFocus={(e) => e.target.select()} />
            <button onClick={async () => show('ok', (await copyText(fresh)) ? 'Copied.' : 'Select and copy the link manually.')}>Copy</button>
          </div>
        )}
        <div className="row wrap">
          <label className="field">
            <span>Role granted</span>
            <select value={role} onChange={(e) => setRole(e.target.value as 'candidate' | 'observer')}>
              <option value="candidate">Candidate</option>
              <option value="observer">Observer (view only)</option>
            </select>
          </label>
          <label className="field">
            <span>Max uses</span>
            <input type="number" min={1} value={maxUses} onChange={(e) => setMaxUses(e.target.value)} placeholder="∞" />
          </label>
          <label className="field">
            <span>Expires in (hours)</span>
            <input type="number" min={1} value={expiresHours} onChange={(e) => setExpiresHours(e.target.value)} placeholder="never" />
          </label>
        </div>
        <div className="row">
          <button className="btn-primary" onClick={create}>Create link</button>
          <button
            onClick={async () => {
              const c = await run(() => guestLinks.rotate(sessionId));
              if (c) await show_(c.token);
            }}
          >
            Rotate (revoke all &amp; create new)
          </button>
        </div>
        <ul className="list">
          {links.map((l) => (
            <li key={l.id}>
              <span>
                {l.roleGranted} link · created {fmtDate(l.createdAt)} · used {l.uses}{l.maxUses ? `/${l.maxUses}` : ''}
                {l.expiresAt ? ` · expires ${fmtDate(l.expiresAt)}` : ''}
                {' · '}<strong>{l.revokedAt ? 'revoked' : 'active'}</strong>
              </span>
              {!l.revokedAt && <button onClick={async () => { await run(() => guestLinks.revoke(sessionId, l.id), 'Link revoked.'); void refresh(); }}>Revoke</button>}
            </li>
          ))}
          {links.length === 0 && <li className="muted">No links yet.</li>}
        </ul>
      </section>

      <section className="stack">
        <h3>Invite an interviewer or observer</h3>
        <div className="row wrap">
          <label className="field grow">
            <span>Email</span>
            <input type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} />
          </label>
          <label className="field">
            <span>Role</span>
            <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as 'interviewer' | 'observer')}>
              <option value="interviewer">Interviewer (can edit)</option>
              <option value="observer">Observer (view only)</option>
            </select>
          </label>
          <button
            onClick={async () => {
              if (await run(() => sessions.invite(sessionId, inviteEmail, inviteRole), 'Invitation saved. They will see this interview on their dashboard.')) setInviteEmail('');
            }}
          >
            Invite
          </button>
        </div>
      </section>

      <section className="stack">
        <h3>People in this interview</h3>
        <ul className="list">
          {participants.map((p) => (
            <li key={p.id}>
              <span>{p.displayName} · {p.role} · {p.removed ? 'removed' : p.leftAt ? 'left' : 'present'}</span>
              {p.role !== 'owner' && !p.removed && (
                <button className="btn-danger" onClick={async () => { await run(() => sessions.removeParticipant(sessionId, p.id), `${p.displayName} removed.`); void refresh(); }}>Remove</button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </Modal>
  );
}

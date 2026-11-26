import { describe, expect, it } from 'vitest';
import { CanvasDoc, LIMITS, type CanvasOp } from '../src/domain/canvasDoc';
import type { ServerEvent } from '../src/services/types';
import { sha256Hex } from '../src/services/mock';
import { guestJoin, makeWorld, ownerWithSession, until } from './helpers';

const op = (doc: CanvasDoc, id: string, fields: Record<string, string | number | boolean> = {}) =>
  doc.local(id, { kind: 'node', x: 0, y: 0, w: 100, h: 60, z: 1, label: id, ...fields });

describe('auth', () => {
  it('signs in, persists per tab, and signs out', async () => {
    const w = makeWorld();
    const { s } = w.tab();
    expect(await s.auth.getCurrentUser()).toBeNull();
    const u = await s.auth.signInWithMagicLink('Ann@Example.com', 'Ann');
    expect(u.email).toBe('ann@example.com');
    expect((await s.auth.getCurrentUser())?.id).toBe(u.id);
    // another tab (separate auth store) is still signed out
    expect(await w.tab().s.auth.getCurrentUser()).toBeNull();
    await s.auth.signOut();
    expect(await s.auth.getCurrentUser()).toBeNull();
  });
  it('rejects bad emails and unauthenticated calls', async () => {
    const { s } = makeWorld().tab();
    await expect(s.auth.signInWithMagicLink('nope')).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(s.sessions.list()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(s.sessions.create({ title: 'x' })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});

describe('sessions', () => {
  it('creates a draft with a blank canvas and lists it', async () => {
    const w = makeWorld();
    const { s, session } = await ownerWithSession(w, 'Chat app');
    expect(session).toMatchObject({ title: 'Chat app', state: 'draft', candidateEditingEnabled: true, maxParticipants: 10 });
    const rows = await s.sessions.list();
    expect(rows).toHaveLength(1);
    expect(rows[0].myRole).toBe('owner');
    expect(await s.sessions.getCanvasSnapshot(session.id)).toMatchObject({ elements: {} });
  });

  it('validates titles and settings', async () => {
    const w = makeWorld();
    const { s, session } = await ownerWithSession(w);
    await expect(s.sessions.create({ title: '   ' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(s.sessions.update(session.id, { durationMinutes: 0 })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(s.sessions.update(session.id, { maxParticipants: 999 })).rejects.toMatchObject({ code: 'VALIDATION' });
    const u = await s.sessions.update(session.id, { title: 'New', prompt: 'P', cursorsVisible: false });
    expect(u).toMatchObject({ title: 'New', prompt: 'P', cursorsVisible: false });
  });

  it('runs the lifecycle draft → live → ended → reopened → ended → archived', async () => {
    const w = makeWorld();
    const { s, session } = await ownerWithSession(w);
    await expect(s.sessions.end(session.id)).rejects.toMatchObject({ code: 'VALIDATION' });
    const live = await s.sessions.start(session.id);
    expect(live.state).toBe('live');
    expect(live.startedAt).toBeTruthy();
    await expect(s.sessions.start(session.id)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(s.sessions.archive(session.id)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect((await s.sessions.end(session.id)).state).toBe('ended');
    expect((await s.sessions.reopen(session.id)).state).toBe('live');
    await s.sessions.end(session.id);
    expect((await s.sessions.archive(session.id)).state).toBe('archived');
  });

  it('duplicates a session as a new draft including the canvas', async () => {
    const w = makeWorld();
    const { s, session, client } = await ownerWithSession(w);
    client.mutate([{ id: 'n1', fields: { kind: 'node', x: 0, y: 0, w: 10, h: 10, z: 1, label: 'Keep me' } }]);
    await until(() => client.pendingCount === 0);
    const copy = await s.sessions.duplicate(session.id);
    expect(copy.id).not.toBe(session.id);
    expect(copy.state).toBe('draft');
    expect(copy.title).toBe('Copy of Design a URL shortener');
    const snap = await s.sessions.getCanvasSnapshot(copy.id);
    expect(CanvasDoc.fromState('t', snap).get('n1')?.label).toBe('Keep me');
  });

  it("other users can't see or touch a session; invited users can, by role", async () => {
    const w = makeWorld();
    const { s, session } = await ownerWithSession(w);
    const stranger = w.tab().s;
    await stranger.auth.signInWithMagicLink('stranger@example.com');
    await expect(stranger.sessions.get(session.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(stranger.collab.getAccess(session.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await stranger.sessions.list()).toHaveLength(0);

    await s.sessions.invite(session.id, 'stranger@example.com', 'observer');
    expect((await stranger.sessions.list())[0].myRole).toBe('observer');
    await expect(stranger.sessions.update(session.id, { title: 'hax' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(stranger.sessions.end(session.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(stranger.guestLinks.create(session.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(stranger.sessions.listParticipants(session.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('records audit events for the actions the spec lists', async () => {
    const w = makeWorld();
    const { s, session } = await ownerWithSession(w);
    const { link } = await s.guestLinks.create(session.id);
    await s.guestLinks.rotate(session.id);
    await s.guestLinks.revoke(session.id, link.id);
    await s.sessions.setCandidateEditing(session.id, false);
    await s.sessions.start(session.id);
    await s.sessions.end(session.id);
    const actions = (await s.sessions.listAuditEvents(session.id)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining([
      'session_created', 'link_created', 'link_rotated', 'link_revoked', 'editing_locked', 'session_started', 'session_ended',
    ]));
  });

  it('exports the canvas as JSON', async () => {
    const w = makeWorld();
    const { s, session, client } = await ownerWithSession(w);
    client.mutate([{ id: 'n1', fields: { kind: 'node', x: 1, y: 2, w: 10, h: 10, z: 1, label: 'DB' } }]);
    await until(() => client.pendingCount === 0);
    const json = JSON.parse(await s.sessions.exportCanvasJson(session.id));
    expect(json.elements).toHaveLength(1);
    expect(json.session.title).toBe(session.title);
  });
});

describe('guest links & joining', () => {
  it('stores only a hash of a high-entropy token', async () => {
    const w = makeWorld();
    const { s, session } = await ownerWithSession(w);
    const { token, link } = await s.guestLinks.create(session.id);
    expect(token.length).toBeGreaterThanOrEqual(43); // 256 bits, base64url
    expect(w.store.get('sdi.db')).not.toContain(token);
    expect(w.store.get('sdi.db')).toContain(await sha256Hex(token));
    expect(JSON.stringify(await s.guestLinks.list(session.id))).not.toContain('tokenHash');
    const other = (await s.guestLinks.create(session.id)).token;
    expect(other).not.toBe(token);
    expect(link.revokedAt).toBeNull();
  });

  it('previews and joins as a candidate', async () => {
    const w = makeWorld();
    const { s, session } = await ownerWithSession(w);
    const { token } = await s.guestLinks.create(session.id);
    const guest = w.tab().s;
    expect(await guest.join.preview(token)).toMatchObject({ sessionId: session.id, sessionTitle: session.title });
    const j = await guest.join.join(token, '  Alice ');
    expect(j.participant).toMatchObject({ displayName: 'Alice', role: 'candidate', userId: null });
    expect(j.credential.sessionId).toBe(session.id);
    await expect(guest.join.join(token, '')).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(guest.join.join(token, 'x'.repeat(41))).rejects.toMatchObject({ code: 'VALIDATION' });
    expect((await s.sessions.list())[0].participantNames).toContain('Alice');
  });

  it('rejects unknown, revoked, expired, exhausted, archived and ended links with clear codes', async () => {
    const w = makeWorld();
    const { s, session } = await ownerWithSession(w);
    const g = w.tab().s;
    await expect(g.join.preview('totally-wrong')).rejects.toMatchObject({ code: 'LINK_INVALID' });

    const revoked = await s.guestLinks.create(session.id);
    await s.guestLinks.revoke(session.id, revoked.link.id);
    await expect(g.join.join(revoked.token, 'A')).rejects.toMatchObject({ code: 'LINK_REVOKED' });

    const expiring = await s.guestLinks.create(session.id, { expiresAt: new Date(w.clock.t + 1000).toISOString() });
    await g.join.join(expiring.token, 'A');
    w.clock.t += 5000;
    await expect(g.join.join(expiring.token, 'B')).rejects.toMatchObject({ code: 'LINK_EXPIRED' });

    const once = await s.guestLinks.create(session.id, { maxUses: 1 });
    await g.join.join(once.token, 'A');
    await expect(g.join.join(once.token, 'B')).rejects.toMatchObject({ code: 'LINK_EXHAUSTED' });

    const live = await s.guestLinks.create(session.id);
    await s.sessions.start(session.id);
    await s.sessions.end(session.id);
    await expect(g.join.join(live.token, 'A')).rejects.toMatchObject({ code: 'SESSION_ENDED' });
    await s.sessions.archive(session.id);
    await expect(g.join.join(live.token, 'A')).rejects.toMatchObject({ code: 'SESSION_ARCHIVED' });
  });

  it('enforces the participant limit (default 10)', async () => {
    const w = makeWorld();
    const { s, session } = await ownerWithSession(w);
    expect((await s.sessions.get(session.id)).maxParticipants).toBe(10);
    await s.sessions.update(session.id, { maxParticipants: 3 }); // owner already counts as 1
    const { token } = await s.guestLinks.create(session.id);
    const g = w.tab().s;
    await g.join.join(token, 'A');
    await g.join.join(token, 'B');
    await expect(g.join.join(token, 'C')).rejects.toMatchObject({ code: 'SESSION_FULL' });
  });

  it('rotating revokes the old link and revoking does not disconnect current participants', async () => {
    const w = makeWorld();
    const { s, session } = await ownerWithSession(w);
    const first = await s.guestLinks.create(session.id);
    const alice = await guestJoin(w, first.token, 'Alice');
    const second = await s.guestLinks.rotate(session.id);
    await expect(w.tab().s.join.join(first.token, 'Bob')).rejects.toMatchObject({ code: 'LINK_REVOKED' });
    await w.tab().s.join.join(second.token, 'Bob');
    // Alice is still connected and can refresh her credential after the link was revoked.
    expect(alice.client.removed).toBe(false);
    expect((await alice.s.collab.refreshCredential(alice.credential)).participantId).toBe(alice.participant.id);
    const active = (await s.guestLinks.list(session.id)).filter((l) => !l.revokedAt);
    expect(active).toHaveLength(1);
  });

  it('lets a credential be refreshed concurrently (e.g. two effects or tabs) and prunes long-expired ones', async () => {
    const w = makeWorld();
    const { s, session } = await ownerWithSession(w);
    const { token } = await s.guestLinks.create(session.id);
    const g = w.tab().s;
    const j = await g.join.join(token, 'Alice');
    const [a, b] = await Promise.all([g.collab.refreshCredential(j.credential), g.collab.refreshCredential(j.credential)]);
    expect(a.id).not.toBe(b.id);
    await g.collab.connect(a);
    await g.collab.connect(b);
    w.clock.t += 3 * 24 * 3600_000; // far past expiry + grace
    await expect(g.collab.refreshCredential(j.credential)).rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' });
  });

  it('rate-limits join attempts', async () => {
    const w = makeWorld({ joinRateLimit: { max: 3, windowMs: 60_000 } });
    const { s } = w.tab();
    for (let i = 0; i < 3; i++) await expect(s.join.preview('guess' + i)).rejects.toMatchObject({ code: 'LINK_INVALID' });
    await expect(s.join.preview('guess4')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    w.clock.t += 61_000;
    await expect(s.join.preview('guess5')).rejects.toMatchObject({ code: 'LINK_INVALID' });
  });

  it('hides the prompt from candidates until the interview starts when configured', async () => {
    const w = makeWorld();
    const { s, session } = await ownerWithSession(w, 'T', { prompt: 'Secret prompt', promptReveal: 'start' });
    const { token } = await s.guestLinks.create(session.id);
    const g = await guestJoin(w, token, 'Alice');
    expect(g.session.prompt).toBeNull();
    expect(g.client.session.prompt).toBeNull();
    await s.sessions.start(session.id);
    await until(() => g.client.session.prompt === 'Secret prompt');
  });
});

describe('collaboration gateway authorization', () => {
  async function room() {
    const w = makeWorld();
    const o = await ownerWithSession(w);
    const { token } = await o.s.guestLinks.create(o.session.id);
    const g = await w.tab().s.join.join(token, 'Alice');
    const gs = w.tab().s;
    const conn = await gs.collab.connect(g.credential);
    return { w, o, token, g, gs, conn };
  }

  it("rejects candidate edits while the session is a draft, accepts them once live, rejects them when locked", async () => {
    const { o, conn } = await room();
    const d = new CanvasDoc('alice');
    await expect(conn.sendUpdate([op(d, 'n1')])).rejects.toMatchObject({ code: 'EDITING_LOCKED' });
    await o.s.sessions.start(o.session.id);
    await conn.sendUpdate([op(d, 'n1')]);
    await o.s.sessions.setCandidateEditing(o.session.id, false);
    await expect(conn.sendUpdate([op(d, 'n2')])).rejects.toMatchObject({ code: 'EDITING_LOCKED' });
    // the rejected element never reached the server
    expect(CanvasDoc.fromState('x', await o.s.sessions.getCanvasSnapshot(o.session.id)).get('n2')).toBeUndefined();
    await o.s.sessions.setCandidateEditing(o.session.id, true);
    await conn.sendUpdate([op(d, 'n3')]);
  });

  it('observers can view but never edit', async () => {
    const w = makeWorld();
    const o = await ownerWithSession(w);
    await o.s.sessions.start(o.session.id);
    const { token } = await o.s.guestLinks.create(o.session.id, { role: 'observer' });
    const g = await guestJoin(w, token, 'Watcher');
    expect(g.participant.role).toBe('observer');
    await expect(g.client['conn'].sendUpdate([op(new CanvasDoc('w'), 'n1')])).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(g.client.canEdit).toBe(false);
  });

  it('cannot reach another session by swapping identifiers in a credential', async () => {
    const { w, o, g } = await room();
    const other = await o.s.sessions.create({ title: 'Other interview' });
    const attacker = w.tab().s;
    await expect(attacker.collab.connect({ ...g.credential, sessionId: other.id })).rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' });
    await expect(attacker.collab.connect({ ...g.credential, participantId: 'someone-else' })).rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' });
    await expect(attacker.collab.connect({ ...g.credential, id: 'forged' })).rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' });
    await expect(attacker.collab.refreshCredential({ ...g.credential, sessionId: other.id })).rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' });
    // and guests have no API access at all
    await expect(attacker.sessions.get(other.id)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(attacker.sessions.getCanvasSnapshot(other.id)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('removing a participant disconnects them and invalidates their credential', async () => {
    const { o, g, conn } = await room();
    await o.s.sessions.start(o.session.id);
    const events: ServerEvent[] = [];
    conn.on((e) => events.push(e));
    await o.s.sessions.removeParticipant(o.session.id, g.participant.id);
    await until(() => events.some((e) => e.type === 'removed'));
    await expect(conn.sendUpdate([op(new CanvasDoc('a'), 'n1')])).rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' });
    await expect(o.s.sessions.removeParticipant(o.session.id, o.cred.participantId)).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('ending makes the room read-only, saves a final snapshot, and blocks candidate re-entry', async () => {
    const { w, o, g, conn } = await room();
    await o.s.sessions.start(o.session.id);
    const d = new CanvasDoc('alice');
    await conn.sendUpdate([op(d, 'n1', { label: 'Final answer' })]);
    await o.s.sessions.end(o.session.id);
    await expect(conn.sendUpdate([op(d, 'n2')])).rejects.toMatchObject({ code: 'EDITING_LOCKED' });
    const owner = o.client;
    owner.mutate([{ id: 'late', fields: { kind: 'node', x: 0, y: 0, w: 1, h: 1, z: 1, label: 'late' } }]);
    expect(owner.canEdit).toBe(false); // even the owner is read-only until reopening
    const final = CanvasDoc.fromState('x', await o.s.sessions.getCanvasSnapshot(o.session.id));
    expect(final.get('n1')?.label).toBe('Final answer');
    await expect(w.tab().s.collab.refreshCredential(g.credential)).rejects.toMatchObject({ code: 'SESSION_ENDED' });
    await o.s.sessions.reopen(o.session.id);
    await conn.sendUpdate([op(d, 'n3')]);
  });

  it('validates operations server-side', async () => {
    const { o, conn } = await room();
    await o.s.sessions.start(o.session.id);
    const d = new CanvasDoc('alice');
    const bad = { ...op(d, 'n1'), fields: { evil: 'x' } } as unknown as CanvasOp;
    await expect(conn.sendUpdate([bad])).rejects.toMatchObject({ code: 'INVALID_OP' });
    const many = Array.from({ length: LIMITS.maxOpsPerMessage + 1 }, (_, i) => op(d, `e${i}`));
    await expect(conn.sendUpdate(many)).rejects.toMatchObject({ code: 'INVALID_OP' });
    const huge = { ...op(d, 'n2'), fields: { label: 'x'.repeat(LIMITS.maxTextLength + 1) } };
    await expect(conn.sendUpdate([huge])).rejects.toMatchObject({ code: 'INVALID_OP' });
  });

  it('ignores duplicate deliveries and out-of-order ops', async () => {
    const { o, conn } = await room();
    await o.s.sessions.start(o.session.id);
    const d = new CanvasDoc('alice');
    const create = op(d, 'n1');
    const move = d.local('n1', { x: 50 });
    await conn.sendUpdate([move, create]);
    await conn.sendUpdate([create, move, move]);
    const snap = CanvasDoc.fromState('x', await o.s.sessions.getCanvasSnapshot(o.session.id));
    expect(snap.get('n1')).toMatchObject({ x: 50, label: 'n1' });
    const stored = JSON.parse(o.be.store.get(`sdi.canvas.${o.session.id}`)!);
    expect(stored.ops.filter((x: CanvasOp) => x.id === create.id)).toHaveLength(1); // never logged twice
  });

  it('presence is ephemeral and the participant list follows connections', async () => {
    const { o, conn } = await room();
    const seen: ServerEvent[] = [];
    o.client['conn'].on((e) => seen.push(e));
    conn.sendPresence({ cursor: { x: 5, y: 6 }, selection: ['n1'] });
    await until(() => seen.some((e) => e.type === 'presence_update' && e.entry.displayName === 'Alice' && e.entry.cursor?.x === 5));
    await until(() => [...o.client.presence.values()].some((p) => p.displayName === 'Alice'));
    conn.disconnect();
    await until(() => ![...o.client.presence.values()].some((p) => p.displayName === 'Alice'));
    // nothing about cursors is persisted
    expect(o.be.store.get('sdi.db')).not.toContain('"cursor"');
  });
});

describe('persistence', () => {
  it('compacts the operation log into snapshots and restores after a reload', async () => {
    const w = makeWorld({ compactEvery: 5 });
    const o = await ownerWithSession(w);
    for (let i = 0; i < 12; i++) {
      o.client.mutate([{ id: `n${i}`, fields: { kind: 'node', x: i, y: 0, w: 10, h: 10, z: i, label: `L${i}` } }]);
    }
    await until(() => o.client.pendingCount === 0);
    const rec = JSON.parse(w.store.get(`sdi.canvas.${o.session.id}`)!);
    expect(rec.ops.length).toBeLessThan(5);
    expect(Object.keys(rec.snapshot.elements).length).toBeGreaterThanOrEqual(5);
    expect(rec.cursor).toBe(12);

    // "refresh the browser": a brand-new backend instance reading the same durable store
    const fresh = w.tab().s;
    await fresh.auth.signInWithMagicLink('owner@example.com');
    const conn = await fresh.collab.connect(await fresh.collab.getAccess(o.session.id));
    expect(CanvasDoc.fromState('x', conn.joined.snapshot).count()).toBe(12);
  });

  it('clearing keeps a recoverable snapshot', async () => {
    const w = makeWorld();
    const o = await ownerWithSession(w);
    o.client.mutate([
      { id: 'a', fields: { kind: 'node', x: 0, y: 0, w: 10, h: 10, z: 1, label: 'A' } },
      { id: 'b', fields: { kind: 'node', x: 0, y: 0, w: 10, h: 10, z: 2, label: 'B' } },
    ]);
    await until(() => o.client.pendingCount === 0);
    await o.s.sessions.clearCanvas(o.session.id);
    await until(() => o.client.elements.length === 0);
    await o.s.sessions.restoreClearedCanvas(o.session.id);
    await until(() => o.client.elements.length === 2);
    await expect(o.s.sessions.restoreClearedCanvas(o.session.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

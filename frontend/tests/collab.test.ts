import { describe, expect, it } from 'vitest';
import {
  addConnector, addNode, addStroke, addSticky, addText, bringToFront, copyElements, deleteElements, duplicate,
  expandGroups, group, moveBy, paste, sendToBack, setProps, ungroup,
} from '../src/collab/actions';
import { findComponent } from '../src/domain/palette';
import { guestJoin, invitedClient, makeWorld, ownerWithSession, same, until } from './helpers';

const DB = findComponent('relational-db')!;
const SVC = findComponent('service')!;
const nodeFields = (label: string, z = 1) => ({ kind: 'node', x: 0, y: 0, w: 100, h: 60, z, label });

/** Owner + invited interviewer + two guests, like acceptance criterion 2. */
async function fourPeople() {
  const w = makeWorld();
  const o = await ownerWithSession(w);
  await o.s.sessions.start(o.session.id);
  const { token } = await o.s.guestLinks.create(o.session.id);
  const iv = await invitedClient(w, o.session.id, o.s, 'second@example.com', 'interviewer');
  const g1 = await guestJoin(w, token, 'Alice');
  const g2 = await guestJoin(w, token, 'Bob');
  const all = [o.client, iv.client, g1.client, g2.client];
  await until(() => all.every((c) => c.canEdit), 2000, 'everyone can edit');
  const settled = () => all.every((c) => c.pendingCount === 0);
  return { w, o, iv, g1, g2, all, settled, token };
}

describe('four participants converge (acceptance criteria 2-4)', () => {
  it('sees the same participants, components, moves, resizes, text, connectors, strokes and deletions', async () => {
    const { o, iv, g1, g2, all, settled } = await fourPeople();
    await until(() => o.client.presence.size === 3, 2000, 'presence of 3 others');

    const a = addNode(o.client, DB, 100, 100)!;
    const b = addNode(g1.client, SVC, 400, 100)!;
    await until(() => all.every((c) => c.elements.length === 2));
    addConnector(iv.client, a, b, 'elbow');
    moveBy(g2.client, [a], 40, 20);
    setProps(g1.client, [b], { label: 'API' });
    setProps(o.client, [b], { w: 200, h: 90 });
    addStroke(g2.client, [[0, 0], [10, 10], [20, 5]], '#dc2626', 3);
    addText(iv.client, 10, 10, 'Notes');
    addSticky(g1.client, 10, 300);
    await until(() => settled() && all.every((c) => c.elements.length === 6 && c.pendingCount === 0));
    await until(() => same(...all));
    const view = o.client.doc.get(b)!;
    expect(view).toMatchObject({ label: 'API', w: 200, h: 90 });
    expect(o.client.doc.get(a)).toMatchObject({ x: 140, y: 120 });

    deleteElements(g2.client, [b]); // also removes the attached connector
    await until(() => all.every((c) => c.elements.length === 4));
    await until(() => same(...all));
  });

  it('simultaneous edits to different objects do not overwrite each other', async () => {
    const { o, iv, g1, g2, all, settled } = await fourPeople();
    const ids = ['a', 'b', 'c', 'd'].map((id) => {
      o.client.mutate([{ id, fields: nodeFields(id) }]);
      return id;
    });
    await until(() => all.every((c) => c.elements.length === 4));
    // everyone edits a different object "at the same time" (no awaiting in between)
    setProps(o.client, ['a'], { label: 'A!' });
    setProps(iv.client, ['b'], { label: 'B!' });
    setProps(g1.client, ['c'], { label: 'C!' });
    setProps(g2.client, ['d'], { label: 'D!' });
    await until(() => settled());
    await until(() => same(...all));
    expect(o.client.elements.map((e) => e.label)).toEqual(['A!', 'B!', 'C!', 'D!']);
    expect(ids).toHaveLength(4);
  });

  it('simultaneous edits to the same object but different properties merge', async () => {
    const { o, g1, all, settled } = await fourPeople();
    o.client.mutate([{ id: 'n', fields: nodeFields('n') }]);
    await until(() => all.every((c) => c.elements.length === 1));
    moveBy(o.client, ['n'], 100, 0);
    setProps(g1.client, ['n'], { label: 'renamed' });
    await until(() => settled());
    await until(() => same(...all));
    expect(o.client.doc.get('n')).toMatchObject({ x: 100, label: 'renamed' });
  });

  it('a concurrent conflict on one property resolves identically for everyone', async () => {
    const { o, g1, g2, all, settled } = await fourPeople();
    o.client.mutate([{ id: 'n', fields: nodeFields('n') }]);
    await until(() => all.every((c) => c.elements.length === 1));
    setProps(o.client, ['n'], { label: 'from owner' });
    setProps(g1.client, ['n'], { label: 'from alice' });
    setProps(g2.client, ['n'], { label: 'from bob' });
    await until(() => settled());
    await until(() => same(...all));
  });
});

describe('connectivity', () => {
  it('a participant offline for a while reconnects and converges without reloading (criterion 5)', async () => {
    const { o, g1, all, settled } = await fourPeople();
    const statuses: string[] = [];
    g1.client.subscribe(() => { if (statuses[statuses.length - 1] !== g1.client.status) statuses.push(g1.client.status); });
    g1.s.dev!.setOnline(false);
    await until(() => g1.client.status === 'offline');

    // while offline: Alice keeps editing locally (queued); the others keep working.
    const mine = addNode(g1.client, DB, 0, 0)!;
    setProps(g1.client, [mine], { label: 'offline work' });
    expect(g1.client.pendingCount).toBeGreaterThan(0);
    expect(g1.client.elements).toHaveLength(1);
    const theirs = addNode(o.client, SVC, 500, 500)!;
    await until(() => o.client.pendingCount === 0);
    expect(g1.client.doc.get(theirs)).toBeUndefined(); // she has not seen it
    expect(o.client.doc.get(mine)).toBeUndefined(); // and they have not seen hers

    g1.s.dev!.setOnline(true);
    await until(() => g1.client.status === 'connected', 2000, 'reconnect');
    await until(() => settled() && all.every((c) => c.elements.length === 2));
    await until(() => same(...all));
    expect(statuses).toEqual(expect.arrayContaining(['offline', 'reconnecting', 'connected']));
    expect(o.client.doc.get(mine)?.label).toBe('offline work');
    expect(g1.client.notice).toBeNull();
  });

  it('offline edits that the server can no longer accept are dropped with a message, never overwriting server data', async () => {
    const { o, g1, all } = await fourPeople();
    addNode(o.client, SVC, 0, 0);
    await until(() => all.every((c) => c.elements.length === 1));

    g1.s.dev!.setOnline(false);
    await until(() => g1.client.status === 'offline');
    addNode(g1.client, DB, 50, 50); // queued
    await o.s.sessions.setCandidateEditing(o.session.id, false); // owner locks meanwhile
    g1.s.dev!.setOnline(true);

    await until(() => g1.client.notice !== null, 2000, 'rejection notice');
    expect(g1.client.notice).toMatch(/not saved/i);
    await until(() => g1.client.pendingCount === 0);
    expect(g1.client.elements).toHaveLength(1); // authoritative canvas shown
    expect(o.client.elements).toHaveLength(1); // server data intact
    expect(g1.client.canEdit).toBe(false);
  });

  it('lock/unlock is reflected in every candidate UI model, and local edits are refused while locked (criterion 7)', async () => {
    const { o, iv, g1, g2 } = await fourPeople();
    await o.s.sessions.setCandidateEditing(o.session.id, false);
    await until(() => !g1.client.canEdit && !g2.client.canEdit);
    expect(o.client.canEdit && iv.client.canEdit).toBe(true);
    expect(addNode(g1.client, DB, 0, 0)).toBeNull();
    expect(g1.client.elements).toHaveLength(0);
    await o.s.sessions.setCandidateEditing(o.session.id, true);
    await until(() => g1.client.canEdit);
    expect(addNode(g1.client, DB, 0, 0)).not.toBeNull();
  });

  it('refreshing restores the latest confirmed canvas (criterion 6)', async () => {
    const { o, w } = await fourPeople();
    addNode(o.client, DB, 10, 10);
    addNode(o.client, SVC, 200, 10);
    await until(() => o.client.pendingCount === 0);
    o.client.close();
    const reload = w.tab().s; // new tab, same browser session cookie-equivalent
    await reload.auth.signInWithMagicLink('owner@example.com');
    const { SyncClient } = await import('../src/collab/syncClient');
    const again = new SyncClient(await reload.collab.connect(await reload.collab.getAccess(o.session.id)));
    expect(again.elements.map((e) => e.componentType).sort()).toEqual(['relational-db', 'service']);
  });

  it('a removed participant learns they were removed', async () => {
    const { o, g1 } = await fourPeople();
    await o.s.sessions.removeParticipant(o.session.id, g1.participant.id);
    await until(() => g1.client.removed);
    expect(g1.client.canEdit).toBe(false);
  });

  it('shows the interview ending to everyone and keeps it read-only (criterion 9)', async () => {
    const { o, iv, g1, g2 } = await fourPeople();
    addNode(g1.client, DB, 0, 0);
    await until(() => g1.client.pendingCount === 0);
    await o.s.sessions.end(o.session.id);
    await until(() => [o, iv, g1, g2].every((p) => p.client.session.state === 'ended'));
    expect([o, iv, g1, g2].some((p) => p.client.canEdit)).toBe(false);
  });
});

describe('presence', () => {
  it('shares cursors and selections with names and colors, and clears them on leave', async () => {
    const { o, g1 } = await fourPeople();
    g1.client.sendPresence({ cursor: { x: 12, y: 34 }, selection: ['x'] });
    await until(() => [...o.client.presence.values()].some((p) => p.displayName === 'Alice' && p.cursor?.x === 12));
    const alice = [...o.client.presence.values()].find((p) => p.displayName === 'Alice')!;
    expect(alice.selection).toEqual(['x']);
    expect(alice.color).toMatch(/^#/);
    expect(alice.role).toBe('candidate');
    g1.client.close();
    await until(() => ![...o.client.presence.values()].some((p) => p.displayName === 'Alice'));
  });
  it('lets the owner hide cursors for everyone', async () => {
    const { o, g1 } = await fourPeople();
    await o.s.sessions.update(o.session.id, { cursorsVisible: false });
    await until(() => g1.client.session.cursorsVisible === false);
  });
});

describe('undo / redo scoped to the current participant', () => {
  it("only reverts my own actions, never a peer's", async () => {
    const { o, g1, all } = await fourPeople();
    const mine = addNode(o.client, DB, 0, 0)!;
    const theirs = addNode(g1.client, SVC, 300, 0)!;
    await until(() => all.every((c) => c.elements.length === 2));

    expect(o.client.undo()).toBe(true); // hides my node, not Alice's
    await until(() => all.every((c) => c.elements.length === 1));
    expect(g1.client.doc.get(theirs)).toBeDefined();
    expect(g1.client.doc.get(mine)).toBeUndefined();

    expect(o.client.redo()).toBe(true);
    await until(() => all.every((c) => c.elements.length === 2));
    expect(g1.client.undo()).toBe(true);
    await until(() => o.client.elements.length === 1);
    expect(o.client.doc.get(mine)).toBeDefined();
    expect(o.client.undo()).toBe(true);
    expect(o.client.undo()).toBe(false); // nothing left of mine
  });

  it('undoes a deletion and restores attached connectors', async () => {
    const { o } = await fourPeople();
    const a = addNode(o.client, DB, 0, 0)!;
    const b = addNode(o.client, SVC, 300, 0)!;
    addConnector(o.client, a, b);
    expect(o.client.elements).toHaveLength(3);
    deleteElements(o.client, [a]);
    expect(o.client.elements).toHaveLength(1);
    o.client.undo();
    expect(o.client.elements).toHaveLength(3);
  });

  it('records a whole drag as one undo step', async () => {
    const { o } = await fourPeople();
    const a = addNode(o.client, DB, 0, 0)!;
    const g = o.client.beginGesture([a]);
    g.update([{ id: a, fields: { x: 10, y: 0 } }]);
    g.update([{ id: a, fields: { x: 50, y: 20 } }]);
    g.update([{ id: a, fields: { x: 90, y: 40 } }]);
    g.end();
    expect(o.client.doc.get(a)).toMatchObject({ x: 90, y: 40 });
    o.client.undo();
    expect(o.client.doc.get(a)).toMatchObject({ x: 0, y: 0 });
    o.client.redo();
    expect(o.client.doc.get(a)).toMatchObject({ x: 90, y: 40 });
  });
});

describe('canvas actions', () => {
  it('refuses to connect an element to itself or to strokes/missing elements', async () => {
    const { o } = await fourPeople();
    const a = addNode(o.client, DB, 0, 0)!;
    const s = addStroke(o.client, [[0, 0]], '#000', 2)!;
    expect(addConnector(o.client, a, a)).toBeNull();
    expect(addConnector(o.client, a, s)).toBeNull();
    expect(addConnector(o.client, a, 'missing')).toBeNull();
  });

  it('creates connectors with sane defaults and lets them be restyled and re-pointed', async () => {
    const { o } = await fourPeople();
    const a = addNode(o.client, DB, 0, 0)!;
    const b = addNode(o.client, SVC, 300, 0)!;
    const c = addConnector(o.client, a, b, 'curved')!;
    expect(o.client.doc.get(c)).toMatchObject({ connectorStyle: 'curved', arrowEnd: true, arrowStart: false, from: a, to: b });
    setProps(o.client, [c], { label: 'HTTPS', dashed: true, lineWidth: 4, arrowStart: true, connectorStyle: 'elbow' });
    expect(o.client.doc.get(c)).toMatchObject({ label: 'HTTPS', dashed: true, lineWidth: 4, arrowStart: true, connectorStyle: 'elbow' });
    setProps(o.client, [c], { from: b, to: a });
    expect(o.client.doc.get(c)).toMatchObject({ from: b, to: a });
  });

  it('copies, pastes and duplicates elements, remapping connectors and groups', async () => {
    const { o } = await fourPeople();
    const a = addNode(o.client, DB, 0, 0)!;
    const b = addNode(o.client, SVC, 300, 0)!;
    const c = addConnector(o.client, a, b)!;
    group(o.client, [a, b]);
    const copies = duplicate(o.client, [a, b]);
    expect(copies).toHaveLength(3); // two nodes + the connector between them
    const els = o.client.elements;
    expect(els).toHaveLength(6);
    const newConn = els.find((e) => copies.includes(e.id) && e.kind === 'connector')!;
    expect(copies).toContain(newConn.from);
    expect(copies).toContain(newConn.to);
    expect(newConn.from).not.toBe(a);
    const newNodes = els.filter((e) => copies.includes(e.id) && e.kind === 'node');
    expect(newNodes[0].groupId).toBeTruthy();
    expect(newNodes[0].groupId).not.toBe(o.client.doc.get(a)!.groupId);
    expect(newNodes[0].groupId).toBe(newNodes[1].groupId);
    expect(o.client.doc.get(a)).toMatchObject({ x: 0 }); // originals untouched
    copyElements(o.client, [c]);
    expect(paste(o.client)).toHaveLength(1);
  });

  it('groups, expands selections by group, and ungroups', async () => {
    const { o } = await fourPeople();
    const a = addNode(o.client, DB, 0, 0)!;
    const b = addNode(o.client, SVC, 300, 0)!;
    const c = addNode(o.client, SVC, 600, 0)!;
    expect(group(o.client, [a])).toBeNull(); // needs two
    expect(group(o.client, [a, b])).toBeTruthy();
    expect(expandGroups(o.client, [a]).sort()).toEqual([a, b].sort());
    expect(expandGroups(o.client, [c])).toEqual([c]);
    ungroup(o.client, [a, b]);
    expect(expandGroups(o.client, [a])).toEqual([a]);
  });

  it('orders layers and keeps boundaries behind other elements', async () => {
    const { o } = await fourPeople();
    const a = addNode(o.client, DB, 0, 0)!;
    const b = addNode(o.client, SVC, 0, 0)!;
    const boundary = addNode(o.client, findComponent('boundary')!, 0, 0)!;
    expect(o.client.elements.map((e) => e.id)).toEqual([boundary, a, b]);
    bringToFront(o.client, [a]);
    expect(o.client.elements.at(-1)!.id).toBe(a);
    sendToBack(o.client, [b]);
    expect(o.client.elements[0].id).toBe(b);
  });

  it('moves strokes by translating their vector points', async () => {
    const { o } = await fourPeople();
    const s = addStroke(o.client, [[0, 0], [10, 10]], '#000', 3, true)!;
    moveBy(o.client, [s], 5, -5);
    expect(o.client.doc.get(s)).toMatchObject({ points: [[5, -5], [15, 5]], highlighter: true });
  });
});

describe('typical-canvas size (criterion 11, logic level)', () => {
  it('handles 2,000 elements with 10,000 freehand points through the server and still converges', async () => {
    const { o, g1 } = await fourPeople();
    const t0 = Date.now();
    const changes = [];
    for (let i = 0; i < 1900; i++) changes.push({ id: `n${i}`, fields: { kind: 'node', x: i, y: i, w: 10, h: 10, z: i, label: `N${i}` } });
    for (let i = 0; i < 100; i++) {
      const pts = Array.from({ length: 100 }, (_, j) => [j, Math.sin(j / 5) * 20 + i]);
      changes.push({ id: `s${i}`, fields: { kind: 'stroke', points: pts, x: 0, y: 0, w: 0, h: 0, z: 2000 + i, label: '', color: '#000', lineWidth: 3 } });
    }
    o.client.mutate(changes);
    await until(() => o.client.pendingCount === 0, 20000, 'bulk flush');
    await until(() => g1.client.elements.length === 2000, 20000, 'bulk delivery');
    await until(() => same(o.client, g1.client), 20000);
    expect(Date.now() - t0).toBeLessThan(15000);
  }, 30000);
});

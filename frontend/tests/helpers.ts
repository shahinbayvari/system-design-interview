import { SyncClient } from '../src/collab/syncClient';
import { snapshotOf } from '../src/domain/canvasDoc';
import type { CollabCredential } from '../src/domain/types';
import type { Services } from '../src/services/types';
import { createMemoryBusHub, MemoryStore, MockBackend, type MockOptions } from '../src/services/mock';

/** A shared "server" (store + bus) with any number of independent "browser tabs". */
export function makeWorld(opts: MockOptions = {}) {
  const store = new MemoryStore();
  const hub = createMemoryBusHub();
  const clock = { t: Date.parse('2026-08-03T12:00:00Z') };
  const tab = (extra: MockOptions = {}) => {
    const be = new MockBackend({
      store,
      authStore: new MemoryStore(),
      bus: hub.connect(),
      now: () => clock.t,
      reconnectDelayMs: 5,
      ...opts,
      ...extra,
    });
    return { be, s: be.services };
  };
  return { store, hub, clock, tab };
}

export type World = ReturnType<typeof makeWorld>;

export async function until(cond: () => boolean, ms = 2000, label = 'condition'): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 3));
  }
}

export async function settle(ms = 20) {
  await new Promise((r) => setTimeout(r, ms));
}

/** Owner tab with a created session and an opened SyncClient. */
export async function ownerWithSession(world: World, title = 'Design a URL shortener', input: { prompt?: string; promptReveal?: 'join' | 'start' } = {}) {
  const { s, be } = world.tab();
  await s.auth.signInWithMagicLink('owner@example.com', 'Olivia');
  const session = await s.sessions.create({ title, ...input });
  const cred = await s.collab.getAccess(session.id);
  const client = new SyncClient(await s.collab.connect(cred));
  return { s, be, session, cred, client };
}

export async function guestJoin(world: World, token: string, name: string) {
  const { s, be } = world.tab();
  const j = await s.join.join(token, name);
  const client = new SyncClient(await s.collab.connect(j.credential));
  return { s, be, ...j, client };
}

export async function invitedClient(world: World, sessionId: string, ownerS: Services, email: string, role: 'interviewer' | 'observer') {
  await ownerS.sessions.invite(sessionId, email, role);
  const { s, be } = world.tab();
  await s.auth.signInWithMagicLink(email, email.split('@')[0]);
  const cred: CollabCredential = await s.collab.getAccess(sessionId);
  const client = new SyncClient(await s.collab.connect(cred));
  return { s, be, cred, client };
}

export const same = (...cs: SyncClient[]) => cs.every((c) => snapshotOf(c.doc) === snapshotOf(cs[0].doc));

/**
 * In-browser mock of the whole backend (API + collaboration gateway + persistence).
 *
 * It deliberately behaves like a real server: every call re-checks authorization, ops are
 * validated, guest tokens are stored only as SHA-256 hashes, and the canvas is persisted as
 * operation log + periodic compact snapshots. Several instances sharing a `store` and a `bus`
 * behave like several browser tabs talking to one server.
 */
import { CanvasDoc, LIMITS, validateOp, type CanvasOp, type DocState } from '../../domain/canvasDoc';
import { ServiceError } from '../../domain/errors';
import { canEdit } from '../../domain/permissions';
import type {
  AuditEvent,
  CollabCredential,
  GuestLink,
  InterviewSession,
  Participant,
  PresenceEntry,
  PresenceState,
  Role,
  RoomSession,
  SessionSummary,
  User,
} from '../../domain/types';
import type {
  CollabConnection,
  CreatedGuestLink,
  CreateSessionInput,
  JoinPreview,
  JoinResult,
  RoomJoined,
  ServerEvent,
  Services,
  UpdateSessionInput,
} from '../types';
import {
  colorFor,
  MemoryStore,
  noopBus,
  randomId,
  randomToken,
  sha256Hex,
  type Bus,
  type BusMessage,
  type KeyValueStore,
} from './infra';

export interface MockOptions {
  /** The shared "server" database. */
  store?: KeyValueStore;
  /** Per-browser-tab sign-in state (sessionStorage in the app). */
  authStore?: KeyValueStore;
  bus?: Bus;
  now?: () => number;
  latencyMs?: number;
  reconnectDelayMs?: number;
  /** Compact the op log into a snapshot after this many ops. */
  compactEvery?: number;
  credentialTtlMs?: number;
  joinRateLimit?: { max: number; windowMs: number };
}

interface StoredLink extends GuestLink {
  tokenHash: string;
}
interface Membership {
  sessionId: string;
  userId: string;
  role: 'interviewer' | 'observer';
}
interface Db {
  users: User[];
  sessions: InterviewSession[];
  memberships: Membership[];
  links: StoredLink[];
  participants: Participant[];
  audit: AuditEvent[];
  credentials: Record<string, CollabCredential>;
}
interface CanvasRecord {
  snapshot: DocState;
  cursor: number;
  ops: CanvasOp[];
  recovery: DocState | null;
  final: DocState | null;
}

interface ConnRecord {
  participantId: string;
  sessionId: string;
  presence: PresenceState;
  emit(e: ServerEvent): void;
  entry(): PresenceEntry;
  close(): void;
}

const DB_KEY = 'sdi.db';
const AUTH_KEY = 'sdi.auth.userId';
const canvasKey = (id: string) => `sdi.canvas.${id}`;
const blankState = (): DocState => ({ schemaVersion: 1, elements: {} });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class MockBackend {
  readonly store: KeyValueStore;
  readonly authStore: KeyValueStore;
  private bus: Bus;
  private now: () => number;
  private latencyMs: number;
  private reconnectDelayMs: number;
  private compactEvery: number;
  private credTtl: number;
  private rate: { max: number; windowMs: number };
  private rateHits: number[] = [];
  private online = true;
  private docs = new Map<string, CanvasDoc>();
  private conns = new Map<string, Set<ConnRecord>>();
  private serverActor = `server-${randomId(4)}`;

  constructor(opts: MockOptions = {}) {
    this.store = opts.store ?? new MemoryStore();
    this.authStore = opts.authStore ?? new MemoryStore();
    this.bus = opts.bus ?? noopBus();
    this.now = opts.now ?? (() => Date.now());
    this.latencyMs = opts.latencyMs ?? 0;
    this.reconnectDelayMs = opts.reconnectDelayMs ?? 400;
    this.compactEvery = opts.compactEvery ?? 50;
    this.credTtl = opts.credentialTtlMs ?? 15 * 60_000;
    this.rate = opts.joinRateLimit ?? { max: 30, windowMs: 60_000 };
    this.bus.subscribe((m) => this.onBus(m));
  }

  // ------------------------------------------------------------------ plumbing

  private iso(): string {
    return new Date(this.now()).toISOString();
  }
  private async delay(): Promise<void> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
  }
  private load(): Db {
    const raw = this.store.get(DB_KEY);
    if (raw) return JSON.parse(raw) as Db;
    return { users: [], sessions: [], memberships: [], links: [], participants: [], audit: [], credentials: {} };
  }
  private save(db: Db): void {
    this.store.set(DB_KEY, JSON.stringify(db));
  }
  private mutate<T>(fn: (db: Db) => T): T {
    const db = this.load();
    const out = fn(db);
    this.save(db);
    return out;
  }
  private audit(db: Db, sessionId: string, actor: string, action: string, meta?: AuditEvent['meta']) {
    db.audit.push({ id: randomId(8), sessionId, actor, action, at: this.iso(), meta });
  }

  private currentUser(db: Db): User {
    const id = this.authStore.get(AUTH_KEY);
    const u = id ? db.users.find((x) => x.id === id) : undefined;
    if (!u) throw new ServiceError('UNAUTHENTICATED');
    return u;
  }

  /** The caller's relationship to a session, or FORBIDDEN / NOT_FOUND. */
  private access(db: Db, user: User, sessionId: string): { session: InterviewSession; role: Role } {
    const session = db.sessions.find((s) => s.id === sessionId);
    if (!session) throw new ServiceError('NOT_FOUND');
    if (session.ownerUserId === user.id) return { session, role: 'owner' };
    const m = db.memberships.find((x) => x.sessionId === sessionId && x.userId === user.id);
    if (!m) throw new ServiceError('FORBIDDEN');
    return { session, role: m.role };
  }
  private ownerAccess(db: Db, sessionId: string): { user: User; session: InterviewSession } {
    const user = this.currentUser(db);
    const a = this.access(db, user, sessionId);
    if (a.role !== 'owner') throw new ServiceError('FORBIDDEN');
    return { user, session: a.session };
  }

  private roomSession(s: InterviewSession, role: Role): RoomSession {
    const hidden = (role === 'candidate') && s.promptReveal === 'start' && s.state === 'draft';
    return {
      id: s.id,
      title: s.title,
      prompt: hidden ? null : s.prompt,
      state: s.state,
      candidateEditingEnabled: s.candidateEditingEnabled,
      cursorsVisible: s.cursorsVisible,
      durationMinutes: s.durationMinutes,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
    };
  }

  // ------------------------------------------------------------------ canvas storage

  private readRecord(sessionId: string): CanvasRecord {
    const raw = this.store.get(canvasKey(sessionId));
    if (raw) return JSON.parse(raw) as CanvasRecord;
    return { snapshot: blankState(), cursor: 0, ops: [], recovery: null, final: null };
  }
  private writeRecord(sessionId: string, rec: CanvasRecord) {
    this.store.set(canvasKey(sessionId), JSON.stringify(rec));
  }

  /** In-memory authoritative doc; `refresh` re-merges what other instances persisted. */
  private loadDoc(sessionId: string, refresh = false): CanvasDoc {
    let doc = this.docs.get(sessionId);
    if (!doc) {
      doc = new CanvasDoc(this.serverActor);
      this.docs.set(sessionId, doc);
      refresh = true;
    }
    if (refresh) {
      const rec = this.readRecord(sessionId);
      doc.mergeState(rec.snapshot);
      doc.applyMany(rec.ops);
    }
    return doc;
  }

  /** Durably append ops to the log, compacting into a snapshot when the log grows. */
  private persistOps(sessionId: string, ops: CanvasOp[]) {
    const rec = this.readRecord(sessionId);
    const have = new Set(rec.ops.map((o) => o.id));
    for (const op of ops) {
      if (have.has(op.id)) continue;
      rec.ops.push(op);
      rec.cursor += 1;
    }
    if (rec.ops.length >= this.compactEvery) {
      const d = new CanvasDoc(this.serverActor, rec.snapshot);
      d.applyMany(rec.ops);
      rec.snapshot = d.serialize();
      rec.ops = [];
    }
    this.writeRecord(sessionId, rec);
  }

  // ------------------------------------------------------------------ realtime

  private connsOf(sessionId: string): ConnRecord[] {
    return [...(this.conns.get(sessionId) ?? [])];
  }

  private fanOut(sessionId: string, ev: ServerEvent, exceptParticipantId?: string) {
    if (!this.online) return;
    for (const c of this.connsOf(sessionId)) {
      if (c.participantId !== exceptParticipantId) c.emit(ev);
    }
  }

  private emitSessionLocal(sessionId: string) {
    if (!this.online) return;
    const db = this.load();
    const s = db.sessions.find((x) => x.id === sessionId);
    if (!s) return;
    for (const c of this.connsOf(sessionId)) {
      const p = db.participants.find((x) => x.id === c.participantId);
      if (p) c.emit({ type: 'session_updated', session: this.roomSession(s, p.role) });
    }
  }

  private broadcastSession(sessionId: string) {
    this.emitSessionLocal(sessionId);
    this.bus.publish({ k: 'session', sessionId });
  }

  private onBus(m: BusMessage) {
    switch (m.k) {
      case 'ops': {
        const doc = this.docs.get(m.sessionId);
        doc?.applyMany(m.ops);
        this.fanOut(m.sessionId, { type: 'document_update', ops: m.ops }, m.fromParticipantId ?? undefined);
        break;
      }
      case 'session':
        this.emitSessionLocal(m.sessionId);
        break;
      case 'presence':
        this.fanOut(m.sessionId, { type: 'presence_update', entry: m.entry });
        break;
      case 'presence_gone':
        this.fanOut(m.sessionId, { type: 'presence_gone', participantId: m.participantId });
        break;
      case 'presence_request':
        if (this.online) {
          for (const c of this.connsOf(m.sessionId)) {
            this.bus.publish({ k: 'presence', sessionId: m.sessionId, entry: c.entry() });
          }
        }
        break;
      case 'removed':
        for (const c of this.connsOf(m.sessionId)) {
          if (c.participantId === m.participantId) { c.emit({ type: 'removed' }); c.close(); }
        }
        break;
    }
  }

  setOnline(online: boolean) {
    if (this.online === online) return;
    if (!online) {
      for (const set of this.conns.values()) for (const c of set) c.emit({ type: 'status', status: 'offline' });
      this.online = false;
      return;
    }
    this.online = true;
    const all = [...this.conns.values()].flatMap((s) => [...s]);
    for (const c of all) c.emit({ type: 'status', status: 'reconnecting' });
    setTimeout(() => {
      if (!this.online) return;
      for (const c of all) {
        this.bus.publish({ k: 'presence', sessionId: c.sessionId, entry: c.entry() });
        this.bus.publish({ k: 'presence_request', sessionId: c.sessionId });
        c.emit({ type: 'status', status: 'connected' });
      }
    }, this.reconnectDelayMs);
  }
  isOnline() {
    return this.online;
  }

  // ------------------------------------------------------------------ credentials & participants

  private issueCredential(db: Db, p: Participant): CollabCredential {
    const cred: CollabCredential = {
      id: randomToken(24),
      sessionId: p.sessionId,
      participantId: p.id,
      role: p.role,
      expiresAt: new Date(this.now() + this.credTtl).toISOString(),
    };
    const day = 24 * 3600_000;
    for (const [id, c] of Object.entries(db.credentials)) {
      if (Date.parse(c.expiresAt) + day < this.now()) delete db.credentials[id];
    }
    db.credentials[cred.id] = cred;
    return cred;
  }

  private checkRate() {
    const t = this.now();
    this.rateHits = this.rateHits.filter((h) => t - h < this.rate.windowMs);
    if (this.rateHits.length >= this.rate.max) throw new ServiceError('RATE_LIMITED');
    this.rateHits.push(t);
  }

  /** Validates a stored credential on *every* use. */
  private validateCredential(db: Db, c: CollabCredential, allowExpired = false) {
    const stored = db.credentials[c.id];
    if (!stored || stored.sessionId !== c.sessionId || stored.participantId !== c.participantId) {
      throw new ServiceError('CREDENTIAL_INVALID');
    }
    if (!allowExpired && Date.parse(stored.expiresAt) <= this.now()) throw new ServiceError('CREDENTIAL_INVALID');
    const participant = db.participants.find((p) => p.id === stored.participantId);
    if (!participant || participant.removed || participant.sessionId !== stored.sessionId) {
      throw new ServiceError('CREDENTIAL_INVALID');
    }
    const session = db.sessions.find((s) => s.id === stored.sessionId);
    if (!session) throw new ServiceError('NOT_FOUND');
    return { participant, session };
  }

  // ------------------------------------------------------------------ guest link resolution

  private async resolveLink(token: string): Promise<{ db: Db; link: StoredLink; session: InterviewSession }> {
    this.checkRate();
    const hash = await sha256Hex(token);
    const db = this.load();
    const link = db.links.find((l) => l.tokenHash === hash);
    if (!link) throw new ServiceError('LINK_INVALID');
    if (link.revokedAt) throw new ServiceError('LINK_REVOKED');
    if (link.expiresAt && Date.parse(link.expiresAt) <= this.now()) throw new ServiceError('LINK_EXPIRED');
    const session = db.sessions.find((s) => s.id === link.sessionId);
    if (!session) throw new ServiceError('LINK_INVALID');
    if (session.state === 'archived') throw new ServiceError('SESSION_ARCHIVED');
    if (session.state === 'ended') throw new ServiceError('SESSION_ENDED');
    return { db, link, session };
  }

  private activeCount(db: Db, sessionId: string) {
    return db.participants.filter((p) => p.sessionId === sessionId && !p.leftAt && !p.removed).length;
  }

  // ------------------------------------------------------------------ the public Services facade

  readonly services: Services = this.buildServices();

  private buildServices(): Services {
    const be = this;

    const sessions: Services['sessions'] = {
      async create(input: CreateSessionInput) {
        await be.delay();
        return be.mutate((db) => {
          const user = be.currentUser(db);
          const title = input.title?.trim();
          if (!title || title.length > 120) throw new ServiceError('VALIDATION', 'Title is required (max 120 characters).');
          const ts = be.iso();
          const s: InterviewSession = {
            id: randomId(8),
            ownerUserId: user.id,
            title,
            prompt: input.prompt?.trim() ?? '',
            state: 'draft',
            candidateEditingEnabled: true,
            cursorsVisible: true,
            promptReveal: input.promptReveal ?? 'join',
            durationMinutes: input.durationMinutes ?? 45,
            maxParticipants: 10,
            scheduledAt: null,
            startedAt: null,
            endedAt: null,
            createdAt: ts,
            updatedAt: ts,
          };
          db.sessions.push(s);
          be.writeRecord(s.id, { snapshot: blankState(), cursor: 0, ops: [], recovery: null, final: null });
          be.audit(db, s.id, user.id, 'session_created');
          return s;
        });
      },

      async list() {
        await be.delay();
        const db = be.load();
        const user = be.currentUser(db);
        const out: SessionSummary[] = [];
        for (const s of db.sessions) {
          let role: Role | null = null;
          if (s.ownerUserId === user.id) role = 'owner';
          else role = db.memberships.find((m) => m.sessionId === s.id && m.userId === user.id)?.role ?? null;
          if (!role) continue;
          const names = [...new Set(db.participants.filter((p) => p.sessionId === s.id && p.role !== 'owner').map((p) => p.displayName))];
          out.push({ ...s, myRole: role, participantNames: names });
        }
        return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      },

      async get(id) {
        await be.delay();
        const db = be.load();
        return be.access(db, be.currentUser(db), id).session;
      },

      async update(id, patch: UpdateSessionInput) {
        await be.delay();
        const s = be.mutate((db) => {
          const { session } = be.ownerAccess(db, id);
          if (patch.title !== undefined) {
            const t = patch.title.trim();
            if (!t || t.length > 120) throw new ServiceError('VALIDATION', 'Title is required (max 120 characters).');
            session.title = t;
          }
          if (patch.prompt !== undefined) {
            if (patch.prompt.length > 10_000) throw new ServiceError('VALIDATION', 'Prompt is too long.');
            session.prompt = patch.prompt;
          }
          if (patch.durationMinutes !== undefined) {
            if (!(patch.durationMinutes >= 1 && patch.durationMinutes <= 480)) throw new ServiceError('VALIDATION', 'Duration must be 1-480 minutes.');
            session.durationMinutes = Math.round(patch.durationMinutes);
          }
          if (patch.maxParticipants !== undefined) {
            if (!(patch.maxParticipants >= 1 && patch.maxParticipants <= 50)) throw new ServiceError('VALIDATION', 'Participants must be 1-50.');
            session.maxParticipants = Math.round(patch.maxParticipants);
          }
          if (patch.cursorsVisible !== undefined) session.cursorsVisible = patch.cursorsVisible;
          if (patch.promptReveal !== undefined) session.promptReveal = patch.promptReveal;
          if (patch.scheduledAt !== undefined) session.scheduledAt = patch.scheduledAt;
          session.updatedAt = be.iso();
          return { ...session };
        });
        be.broadcastSession(id);
        return s;
      },

      async start(id) {
        return be.transition(id, 'start', (s) => {
          if (s.state !== 'draft') throw new ServiceError('VALIDATION', 'Only a draft interview can be started.');
          s.state = 'live';
          s.startedAt = be.iso();
        });
      },

      async end(id) {
        const s = await be.transition(id, 'end', (session) => {
          if (session.state !== 'live') throw new ServiceError('VALIDATION', 'Only a live interview can be ended.');
          session.state = 'ended';
          session.endedAt = be.iso();
        });
        // Final snapshot.
        const doc = be.loadDoc(id, true);
        const rec = be.readRecord(id);
        const state = doc.serialize();
        rec.snapshot = state;
        rec.ops = [];
        rec.final = state;
        be.writeRecord(id, rec);
        return s;
      },

      async reopen(id) {
        const s = await be.transition(id, 'reopen', (session) => {
          if (session.state !== 'ended') throw new ServiceError('VALIDATION', 'Only an ended interview can be reopened.');
          session.state = 'live';
          session.endedAt = null;
        });
        const rec = be.readRecord(id);
        rec.final = null;
        be.writeRecord(id, rec);
        return s;
      },

      async archive(id) {
        return be.transition(id, 'archive', (s) => {
          if (s.state === 'live') throw new ServiceError('VALIDATION', 'End the interview before archiving it.');
          s.state = 'archived';
        });
      },

      async duplicate(id) {
        await be.delay();
        return be.mutate((db) => {
          const { user, session } = be.ownerAccess(db, id);
          const ts = be.iso();
          const copy: InterviewSession = {
            ...session,
            id: randomId(8),
            title: `Copy of ${session.title}`.slice(0, 120),
            state: 'draft',
            candidateEditingEnabled: true,
            scheduledAt: null,
            startedAt: null,
            endedAt: null,
            createdAt: ts,
            updatedAt: ts,
            ownerUserId: user.id,
          };
          db.sessions.push(copy);
          const doc = be.loadDoc(id, true);
          be.writeRecord(copy.id, { snapshot: doc.serialize(), cursor: 0, ops: [], recovery: null, final: null });
          be.audit(db, copy.id, user.id, 'session_created', { duplicatedFrom: id });
          return copy;
        });
      },

      async setCandidateEditing(id, enabled) {
        await be.delay();
        const s = be.mutate((db) => {
          const { user, session } = be.ownerAccess(db, id);
          session.candidateEditingEnabled = enabled;
          session.updatedAt = be.iso();
          be.audit(db, id, user.id, enabled ? 'editing_unlocked' : 'editing_locked');
          return { ...session };
        });
        be.broadcastSession(id);
        return s;
      },

      async clearCanvas(id) {
        await be.delay();
        be.mutate((db) => {
          const o = be.ownerAccess(db, id);
          if (o.session.state === 'archived' || o.session.state === 'ended') {
            throw new ServiceError('VALIDATION', 'Reopen the interview before clearing the canvas.');
          }
          be.audit(db, id, o.user.id, 'canvas_cleared');
        });
        const doc = be.loadDoc(id, true);
        const rec = be.readRecord(id);
        rec.recovery = doc.serialize();
        be.writeRecord(id, rec);
        const ops = doc.visible().map((e) => doc.local(e.id, { deleted: true }));
        be.persistOps(id, ops);
        be.fanOut(id, { type: 'document_update', ops });
        be.bus.publish({ k: 'ops', sessionId: id, ops, fromParticipantId: null });
      },

      async restoreClearedCanvas(id) {
        await be.delay();
        be.mutate((db) => {
          const o = be.ownerAccess(db, id);
          if (o.session.state === 'archived' || o.session.state === 'ended') throw new ServiceError('VALIDATION', 'Reopen the interview first.');
          be.audit(db, id, o.user.id, 'canvas_restored');
        });
        const rec = be.readRecord(id);
        if (!rec.recovery) throw new ServiceError('NOT_FOUND', 'There is no cleared canvas to restore.');
        const old = new CanvasDoc('recovery', rec.recovery);
        const doc = be.loadDoc(id, true);
        const ops = old.visible().map((e) => doc.local(e.id, { ...(old.rawFields(e.id) as Record<string, never>), deleted: false }));
        rec.recovery = null;
        be.writeRecord(id, rec);
        be.persistOps(id, ops);
        be.fanOut(id, { type: 'document_update', ops });
        be.bus.publish({ k: 'ops', sessionId: id, ops, fromParticipantId: null });
      },

      async listParticipants(id) {
        await be.delay();
        const db = be.load();
        const user = be.currentUser(db);
        const { role } = be.access(db, user, id);
        if (role === 'observer') throw new ServiceError('FORBIDDEN');
        return db.participants.filter((p) => p.sessionId === id);
      },

      async removeParticipant(id, participantId) {
        await be.delay();
        be.mutate((db) => {
          const { user } = be.ownerAccess(db, id);
          const p = db.participants.find((x) => x.id === participantId && x.sessionId === id);
          if (!p) throw new ServiceError('NOT_FOUND');
          if (p.role === 'owner') throw new ServiceError('VALIDATION', 'The owner cannot be removed.');
          p.removed = true;
          p.leftAt = p.leftAt ?? be.iso();
          for (const [cid, c] of Object.entries(db.credentials)) if (c.participantId === p.id) delete db.credentials[cid];
          be.audit(db, id, user.id, 'participant_removed', { participantId: p.id });
        });
        be.onBus({ k: 'removed', sessionId: id, participantId });
        be.bus.publish({ k: 'removed', sessionId: id, participantId });
      },

      async invite(id, email, role) {
        await be.delay();
        be.mutate((db) => {
          const { user } = be.ownerAccess(db, id);
          const e = email.trim().toLowerCase();
          if (!EMAIL_RE.test(e)) throw new ServiceError('VALIDATION', 'Enter a valid email address.');
          let invitee = db.users.find((u) => u.email === e);
          if (!invitee) {
            invitee = { id: randomId(8), email: e, displayName: e.split('@')[0], organizationId: null, createdAt: be.iso() };
            db.users.push(invitee);
          }
          if (invitee.id === user.id) throw new ServiceError('VALIDATION', 'You already own this interview.');
          const existing = db.memberships.find((m) => m.sessionId === id && m.userId === invitee!.id);
          if (existing) existing.role = role;
          else db.memberships.push({ sessionId: id, userId: invitee.id, role });
          be.audit(db, id, user.id, 'participant_invited', { role });
        });
      },

      async listAuditEvents(id) {
        await be.delay();
        const db = be.load();
        be.ownerAccess(db, id);
        return db.audit.filter((a) => a.sessionId === id);
      },

      async getCanvasSnapshot(id) {
        await be.delay();
        const db = be.load();
        be.access(db, be.currentUser(db), id);
        const rec = be.readRecord(id);
        return rec.final ?? be.loadDoc(id, true).serialize();
      },

      async exportCanvasJson(id) {
        await be.delay();
        const db = be.load();
        const { session } = be.access(db, be.currentUser(db), id);
        const doc = be.loadDoc(id, true);
        return JSON.stringify(
          {
            schemaVersion: 1,
            exportedAt: be.iso(),
            session: { title: session.title, prompt: session.prompt, state: session.state },
            elements: doc.visible(),
          },
          null,
          2,
        );
      },
    };

    const guestLinks: Services['guestLinks'] = {
      async list(id) {
        await be.delay();
        const db = be.load();
        be.ownerAccess(db, id);
        return db.links.filter((l) => l.sessionId === id).map(({ tokenHash: _t, ...l }) => l);
      },

      async create(id, opts = {}) {
        await be.delay();
        const { token, tokenHash } = await be.newToken();
        return be.mutate((db) => {
          const { user, session } = be.ownerAccess(db, id);
          if (session.state === 'archived') throw new ServiceError('SESSION_ARCHIVED');
          return be.createLink(db, user, id, opts, 'link_created', token, tokenHash);
        });
      },

      async rotate(id) {
        await be.delay();
        const { token, tokenHash } = await be.newToken();
        return be.mutate((db) => {
          const { user, session } = be.ownerAccess(db, id);
          if (session.state === 'archived') throw new ServiceError('SESSION_ARCHIVED');
          for (const l of db.links) if (l.sessionId === id && !l.revokedAt) l.revokedAt = be.iso();
          return be.createLink(db, user, id, {}, 'link_rotated', token, tokenHash);
        });
      },

      async revoke(id, linkId) {
        await be.delay();
        be.mutate((db) => {
          const { user } = be.ownerAccess(db, id);
          const l = db.links.find((x) => x.id === linkId && x.sessionId === id);
          if (!l) throw new ServiceError('NOT_FOUND');
          if (!l.revokedAt) l.revokedAt = be.iso();
          be.audit(db, id, user.id, 'link_revoked', { linkId });
        });
      },
    };

    const join: Services['join'] = {
      async preview(token): Promise<JoinPreview> {
        await be.delay();
        const { session } = await be.resolveLink(token);
        return { sessionId: session.id, sessionTitle: session.title, state: session.state };
      },

      async join(token, displayName): Promise<JoinResult> {
        await be.delay();
        const name = displayName?.trim();
        if (!name || name.length > 40) throw new ServiceError('VALIDATION', 'Enter a display name (max 40 characters).');
        const { link, session } = await be.resolveLink(token);
        return be.mutate((db) => {
          const l = db.links.find((x) => x.id === link.id)!;
          if (l.maxUses !== null && l.uses >= l.maxUses) throw new ServiceError('LINK_EXHAUSTED');
          if (be.activeCount(db, session.id) >= session.maxParticipants) throw new ServiceError('SESSION_FULL');
          l.uses += 1;
          const participant: Participant = {
            id: randomId(8),
            sessionId: session.id,
            userId: null,
            displayName: name,
            role: l.roleGranted,
            joinedAt: be.iso(),
            leftAt: null,
            removed: false,
          };
          db.participants.push(participant);
          const credential = be.issueCredential(db, participant);
          return { participant, credential, session: be.roomSession(session, participant.role) };
        });
      },
    };

    const auth: Services['auth'] = {
      async getCurrentUser() {
        await be.delay();
        const id = be.authStore.get(AUTH_KEY);
        return id ? be.load().users.find((u) => u.id === id) ?? null : null;
      },
      async signInWithMagicLink(email, displayName) {
        await be.delay();
        const e = email.trim().toLowerCase();
        if (!EMAIL_RE.test(e)) throw new ServiceError('VALIDATION', 'Enter a valid email address.');
        const user = be.mutate((db) => {
          let u = db.users.find((x) => x.email === e);
          if (!u) {
            u = { id: randomId(8), email: e, displayName: displayName?.trim() || e.split('@')[0], organizationId: null, createdAt: be.iso() };
            db.users.push(u);
          } else if (displayName?.trim()) {
            u.displayName = displayName.trim();
          }
          return u;
        });
        be.authStore.set(AUTH_KEY, user.id);
        return user;
      },
      async signOut() {
        await be.delay();
        be.authStore.remove(AUTH_KEY);
      },
    };

    const collab: Services['collab'] = {
      async getAccess(sessionId) {
        await be.delay();
        return be.mutate((db) => {
          const user = be.currentUser(db);
          const { role } = be.access(db, user, sessionId);
          let p = db.participants.find((x) => x.sessionId === sessionId && x.userId === user.id && !x.removed);
          if (!p) {
            p = { id: randomId(8), sessionId, userId: user.id, displayName: user.displayName, role, joinedAt: be.iso(), leftAt: null, removed: false };
            db.participants.push(p);
          } else {
            p.role = role;
            p.displayName = user.displayName;
            p.leftAt = null;
          }
          return be.issueCredential(db, p);
        });
      },

      async refreshCredential(credential) {
        await be.delay();
        return be.mutate((db) => {
          const day = 24 * 3600_000;
          const stored = db.credentials[credential.id];
          if (!stored) throw new ServiceError('CREDENTIAL_INVALID');
          if (Date.parse(stored.expiresAt) + day < be.now()) throw new ServiceError('CREDENTIAL_INVALID');
          const { participant, session } = be.validateCredential(db, credential, true);
          if (session.state === 'archived') throw new ServiceError('SESSION_ARCHIVED');
          if (participant.role === 'candidate' && session.state === 'ended') throw new ServiceError('SESSION_ENDED');
          // The superseded credential is NOT revoked: concurrent refreshes (two effects, two tabs)
          // must both succeed. It simply expires, and expired ones are pruned in issueCredential.
          participant.leftAt = null;
          return be.issueCredential(db, participant);
        });
      },

      async connect(credential): Promise<CollabConnection> {
        await be.delay();
        return be.openConnection(credential);
      },
    };

    return { auth, sessions, guestLinks, join, collab, dev: { setOnline: (o) => be.setOnline(o), isOnline: () => be.isOnline() } };
  }

  // ------------------------------------------------------------------ helpers used by the facade

  /** Stores only the SHA-256 hash of the bearer token; the token itself is returned once. */
  private createLink(
    db: Db,
    user: User,
    sessionId: string,
    opts: { role?: 'candidate' | 'observer'; expiresAt?: string | null; maxUses?: number | null },
    action: string,
    token: string,
    tokenHash: string,
  ): CreatedGuestLink {
    const link: StoredLink = {
      id: randomId(8),
      sessionId,
      roleGranted: opts.role ?? 'candidate',
      expiresAt: opts.expiresAt ?? null,
      maxUses: opts.maxUses ?? null,
      uses: 0,
      revokedAt: null,
      createdAt: this.iso(),
      tokenHash,
    };
    db.links.push(link);
    this.audit(db, sessionId, user.id, action, { linkId: link.id });
    const { tokenHash: _h, ...pub } = link;
    return { link: pub, token };
  }

  private async newToken(): Promise<{ token: string; tokenHash: string }> {
    const token = randomToken(32); // 256 bits of entropy
    return { token, tokenHash: await sha256Hex(token) };
  }

  private async transition(id: string, action: string, fn: (s: InterviewSession) => void): Promise<InterviewSession> {
    await this.delay();
    const s = this.mutate((db) => {
      const { user, session } = this.ownerAccess(db, id);
      fn(session);
      session.updatedAt = this.iso();
      this.audit(db, id, user.id, `session_${action === 'start' ? 'started' : action === 'end' ? 'ended' : action === 'reopen' ? 'reopened' : 'archived'}`);
      return { ...session };
    });
    this.broadcastSession(id);
    return s;
  }

  private openConnection(credential: CollabCredential): CollabConnection {
    const db0 = this.load();
    const { participant, session } = this.validateCredential(db0, credential);
    const sessionId = session.id;
    const role = participant.role;

    // Mark the participant present again (reconnect after reload).
    this.mutate((db) => {
      const p = db.participants.find((x) => x.id === participant.id)!;
      p.leftAt = null;
    });

    const listeners = new Set<(e: ServerEvent) => void>();
    let closed = false;
    const rec: ConnRecord = {
      participantId: participant.id,
      sessionId,
      presence: { cursor: null, selection: [] },
      emit: (e) => { if (!closed) listeners.forEach((l) => l(e)); },
      entry: () => ({
        participantId: participant.id,
        displayName: participant.displayName,
        role,
        color: colorFor(participant.id),
        ...rec.presence,
      }),
      close: () => { closed = true; },
    };

    const set = this.conns.get(sessionId) ?? new Set<ConnRecord>();
    this.conns.set(sessionId, set);
    const others = [...set].map((c) => c.entry());
    set.add(rec);

    const doc = this.loadDoc(sessionId, true);
    const joined: RoomJoined = {
      participant: { ...participant },
      role,
      session: this.roomSession(session, role),
      snapshot: doc.serialize(),
      presence: [...others, rec.entry()],
    };

    this.fanOut(sessionId, { type: 'presence_update', entry: rec.entry() }, participant.id);
    this.bus.publish({ k: 'presence', sessionId, entry: rec.entry() });
    this.bus.publish({ k: 'presence_request', sessionId });

    const be = this;
    const conn: CollabConnection = {
      joined,

      async sendUpdate(ops) {
        if (closed) throw new ServiceError('CREDENTIAL_INVALID');
        if (!be.online) throw new ServiceError('OFFLINE');
        await be.delay();
        if (!be.online) throw new ServiceError('OFFLINE');
        const db = be.load();
        // Authorization is re-checked on every update (membership, removal, role, lock, state).
        // Expiry is only enforced at handshake/refresh, like an established socket.
        const { participant: p, session: s } = be.validateCredential(db, credential, true);
        if (p.role === 'observer') throw new ServiceError('FORBIDDEN', 'Observers cannot edit.');
        if (!canEdit(p.role, s)) {
          throw new ServiceError('EDITING_LOCKED', s.state === 'live' || s.state === 'draft'
            ? 'Editing is disabled for candidates right now.'
            : 'This interview is read-only.');
        }
        if (!Array.isArray(ops) || ops.length > LIMITS.maxOpsPerMessage) throw new ServiceError('INVALID_OP', 'Too many operations in one message.');
        for (const op of ops) {
          const err = validateOp(op);
          if (err) throw new ServiceError('INVALID_OP', err);
        }
        const d = be.loadDoc(sessionId);
        const newIds = new Set(ops.map((o) => o.elementId).filter((id) => !d.rawFields(id)));
        if (d.knownCount() + newIds.size > LIMITS.maxElements) throw new ServiceError('INVALID_OP', 'The canvas has too many elements.');
        const changed = d.applyMany(ops);
        if (changed.length > 0) {
          be.persistOps(sessionId, changed);
          be.fanOut(sessionId, { type: 'document_update', ops: changed }, p.id);
          be.bus.publish({ k: 'ops', sessionId, ops: changed, fromParticipantId: p.id });
        }
      },

      sendPresence(p) {
        if (closed || !be.online) return;
        rec.presence = { ...rec.presence, ...p };
        be.fanOut(sessionId, { type: 'presence_update', entry: rec.entry() }, participant.id);
        be.bus.publish({ k: 'presence', sessionId, entry: rec.entry() });
      },

      async resync() {
        if (!be.online) throw new ServiceError('OFFLINE');
        await be.delay();
        const db = be.load();
        const { participant: p, session: s } = be.validateCredential(db, credential, true);
        const d = be.loadDoc(sessionId, true);
        return {
          session: be.roomSession(s, p.role),
          snapshot: d.serialize(),
          presence: be.connsOf(sessionId).map((c) => c.entry()),
        };
      },

      on(l) {
        listeners.add(l);
        return () => listeners.delete(l);
      },

      disconnect() {
        if (closed) return;
        closed = true;
        set.delete(rec);
        be.mutate((db) => {
          const p = db.participants.find((x) => x.id === participant.id);
          if (p && !p.leftAt) p.leftAt = be.iso();
        });
        be.fanOut(sessionId, { type: 'presence_gone', participantId: participant.id });
        be.bus.publish({ k: 'presence_gone', sessionId, participantId: participant.id });
      },
    };
    return conn;
  }
}

export type { CanvasOp };

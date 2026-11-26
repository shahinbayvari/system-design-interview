/**
 * Client-side collaboration engine.
 *
 * Holds the local CRDT document (optimistic editing), queues ops while offline, flushes them
 * through the `CollabConnection`, converges with the authoritative state after reconnect, and
 * keeps a per-participant undo/redo history.
 */
import { CanvasDoc, type CanvasElement, type CanvasOp, type Json } from '../domain/canvasDoc';
import { canEdit } from '../domain/permissions';
import type { PresenceEntry, PresenceState, Role, RoomSession } from '../domain/types';
import type { CollabConnection, ConnectionStatus, ServerEvent } from '../services/types';

export interface Change {
  id: string;
  fields: Record<string, Json>;
}

interface HistoryEntry {
  before: Change[];
  after: Change[];
}

const BATCH = 200;

export class SyncClient {
  doc: CanvasDoc;
  status: ConnectionStatus = 'connected';
  session: RoomSession;
  readonly role: Role;
  readonly me: string;
  readonly myName: string;
  removed = false;
  /** Latest user-facing message about a rejected / reset edit. */
  notice: string | null = null;
  presence = new Map<string, PresenceEntry>();

  private pending: CanvasOp[] = [];
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private listeners = new Set<() => void>();
  private version = 0;
  private flushing = false;
  private unsub: () => void;
  private closed = false;

  constructor(private conn: CollabConnection) {
    const j = conn.joined;
    this.me = j.participant.id;
    this.myName = j.participant.displayName;
    this.role = j.role;
    this.session = j.session;
    this.doc = CanvasDoc.fromState(this.me, j.snapshot);
    for (const p of j.presence) if (p.participantId !== this.me) this.presence.set(p.participantId, p);
    this.unsub = conn.on((e) => this.onEvent(e));
  }

  // ---- React integration
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };
  getVersion = () => this.version;
  private changed() {
    this.version += 1;
    this.listeners.forEach((l) => l());
  }

  // ---- read model
  get canEdit(): boolean {
    return !this.removed && canEdit(this.role, this.session);
  }
  get elements(): CanvasElement[] {
    return this.doc.visible();
  }
  get pendingCount(): number {
    return this.pending.length;
  }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  clearNotice() {
    this.notice = null;
    this.changed();
  }

  // ---- editing
  /** Apply local changes optimistically and queue them for the server. Returns false if not permitted. */
  mutate(changes: Change[], opts: { history?: boolean } = {}): boolean {
    if (!this.canEdit || changes.length === 0) return false;
    const before: Change[] = [];
    for (const c of changes) {
      const raw = this.doc.rawFields(c.id);
      if (!raw) before.push({ id: c.id, fields: { deleted: true } });
      else {
        const prev: Record<string, Json> = {};
        for (const k of Object.keys(c.fields)) {
          if (k in raw) prev[k] = raw[k];
          else if (k === 'deleted') prev[k] = false;
        }
        before.push({ id: c.id, fields: prev });
      }
    }
    const after = changes.map((c) => this.withUndelete(c));
    this.write(after);
    if (opts.history !== false) {
      this.undoStack.push({ before, after });
      if (this.undoStack.length > 200) this.undoStack.shift();
      this.redoStack = [];
    }
    this.changed();
    void this.flush();
    return true;
  }

  /**
   * For drags/resizes: stream intermediate states to peers without flooding the undo stack,
   * then record ONE undo entry on `end()`.
   */
  beginGesture(ids: string[]) {
    const keys = ['x', 'y', 'w', 'h', 'points'];
    const snap = (): Change[] =>
      ids.map((id) => {
        const raw = this.doc.rawFields(id) ?? {};
        const fields: Record<string, Json> = {};
        for (const k of keys) if (k in raw) fields[k] = raw[k];
        return { id, fields };
      });
    const before = snap();
    return {
      update: (changes: Change[]) => this.mutate(changes, { history: false }),
      end: () => {
        const after = snap();
        if (JSON.stringify(before) === JSON.stringify(after)) return;
        this.undoStack.push({ before, after });
        this.redoStack = [];
        this.changed();
      },
    };
  }

  private withUndelete(c: Change): Change {
    if (!('deleted' in c.fields) && this.doc.rawFields(c.id)?.deleted === true && 'kind' in c.fields) {
      return { id: c.id, fields: { ...c.fields, deleted: false } };
    }
    return c;
  }

  private write(changes: Change[]) {
    for (const c of changes) this.pending.push(this.doc.local(c.id, c.fields));
  }

  undo(): boolean {
    const e = this.undoStack.pop();
    if (!e || !this.canEdit) return false;
    this.write(e.before);
    this.redoStack.push(e);
    this.changed();
    void this.flush();
    return true;
  }

  redo(): boolean {
    const e = this.redoStack.pop();
    if (!e || !this.canEdit) return false;
    this.write(e.after.map((c) => {
      const raw = this.doc.rawFields(c.id);
      return raw?.deleted === true && !('deleted' in c.fields) ? { id: c.id, fields: { ...c.fields, deleted: false } } : c;
    }));
    this.undoStack.push(e);
    this.changed();
    void this.flush();
    return true;
  }

  // ---- presence (ephemeral)
  sendPresence(p: Partial<PresenceState>) {
    this.conn.sendPresence(p);
  }

  // ---- sync
  async flush(): Promise<void> {
    if (this.flushing || this.closed || this.status !== 'connected') return;
    this.flushing = true;
    try {
      while (this.pending.length > 0 && this.status === 'connected') {
        const batch = this.pending.slice(0, BATCH);
        await this.conn.sendUpdate(batch);
        this.pending.splice(0, batch.length);
      }
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== 'OFFLINE') await this.rejected(e instanceof Error ? e.message : 'Your change was rejected.');
    } finally {
      this.flushing = false;
      this.changed();
    }
  }

  /** The server refused our changes: drop them and show the authoritative canvas. */
  private async rejected(message: string) {
    this.pending = [];
    this.undoStack = [];
    this.redoStack = [];
    this.notice = `${message} Your last change was not saved; showing the current interview canvas.`;
    try {
      const r = await this.conn.resync();
      this.doc = CanvasDoc.fromState(this.me, r.snapshot);
      this.session = r.session;
    } catch {
      /* offline: reconnect will resync */
    }
    this.changed();
  }

  private async onReconnected() {
    try {
      const r = await this.conn.resync();
      this.doc.mergeState(r.snapshot); // commutative: keeps our queued ops and learns what we missed
      this.session = r.session;
      this.presence = new Map(r.presence.filter((p) => p.participantId !== this.me).map((p) => [p.participantId, p]));
      this.changed();
      await this.flush();
    } catch {
      /* will retry on next status change */
    }
  }

  private onEvent(e: ServerEvent) {
    switch (e.type) {
      case 'document_update':
        this.doc.applyMany(e.ops);
        break;
      case 'presence_update':
        if (e.entry.participantId !== this.me) this.presence.set(e.entry.participantId, e.entry);
        break;
      case 'presence_gone':
        this.presence.delete(e.participantId);
        break;
      case 'session_updated':
        this.session = e.session;
        break;
      case 'removed':
        this.removed = true;
        this.status = 'offline';
        break;
      case 'status':
        this.status = e.status;
        if (e.status === 'connected') void this.onReconnected();
        break;
    }
    this.changed();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.unsub();
    this.conn.disconnect();
  }
}

/** Storage, cross-instance bus and crypto helpers for the mock backend. */

export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export class MemoryStore implements KeyValueStore {
  private m = new Map<string, string>();
  get(key: string) { return this.m.get(key) ?? null; }
  set(key: string, value: string) { this.m.set(key, value); }
  remove(key: string) { this.m.delete(key); }
}

export function webStore(storage: Storage): KeyValueStore {
  return {
    get: (k) => storage.getItem(k),
    set: (k, v) => storage.setItem(k, v),
    remove: (k) => storage.removeItem(k),
  };
}

/** Messages exchanged between backend instances (browser tabs). */
export type BusMessage =
  | { k: 'ops'; sessionId: string; ops: import('../../domain/canvasDoc').CanvasOp[]; fromParticipantId: string | null }
  | { k: 'session'; sessionId: string }
  | { k: 'presence'; sessionId: string; entry: import('../../domain/types').PresenceEntry }
  | { k: 'presence_gone'; sessionId: string; participantId: string }
  | { k: 'presence_request'; sessionId: string }
  | { k: 'removed'; sessionId: string; participantId: string };

export interface Bus {
  publish(msg: BusMessage): void;
  subscribe(fn: (msg: BusMessage) => void): () => void;
}

/** Hub that links several in-memory endpoints (used in tests to simulate several tabs). */
export function createMemoryBusHub() {
  const endpoints = new Set<{ fn: ((m: BusMessage) => void) | null }>();
  return {
    connect(): Bus {
      const ep: { fn: ((m: BusMessage) => void) | null } = { fn: null };
      endpoints.add(ep);
      return {
        publish(msg) {
          const copy = JSON.parse(JSON.stringify(msg)) as BusMessage;
          for (const other of endpoints) if (other !== ep && other.fn) other.fn(copy);
        },
        subscribe(fn) {
          ep.fn = fn;
          return () => { ep.fn = null; };
        },
      };
    },
  };
}

export function broadcastChannelBus(name = 'sdi-bus'): Bus {
  const ch = new BroadcastChannel(name);
  return {
    publish: (msg) => ch.postMessage(msg),
    subscribe(fn) {
      const h = (e: MessageEvent) => fn(e.data as BusMessage);
      ch.addEventListener('message', h);
      return () => ch.removeEventListener('message', h);
    },
  };
}

export function noopBus(): Bus {
  return { publish() {}, subscribe: () => () => {} };
}

export function randomId(bytes = 16): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** URL-safe token with `bytes * 8` bits of entropy (default 256 bits). */
export function randomToken(bytes = 32): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  let s = '';
  for (const b of a) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const PARTICIPANT_COLORS = ['#e11d48', '#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#ea580c', '#4f46e5'];

export function colorFor(participantId: string): string {
  let h = 0;
  for (let i = 0; i < participantId.length; i++) h = (h * 31 + participantId.charCodeAt(i)) >>> 0;
  return PARTICIPANT_COLORS[h % PARTICIPANT_COLORS.length];
}

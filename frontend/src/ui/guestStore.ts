import type { CollabCredential } from '../domain/types';

/** Guest identity per interview, kept in sessionStorage (per tab) so a reload rejoins as the same person. */
const key = (sessionId: string) => `sdi.guest.${sessionId}`;

export function loadGuest(sessionId: string): CollabCredential | null {
  try {
    const raw = window.sessionStorage.getItem(key(sessionId));
    return raw ? (JSON.parse(raw) as CollabCredential) : null;
  } catch {
    return null;
  }
}

export function saveGuest(c: CollabCredential) {
  try {
    window.sessionStorage.setItem(key(c.sessionId), JSON.stringify(c));
  } catch {
    /* storage unavailable: reload will require the link again */
  }
}

export function clearGuest(sessionId: string) {
  try {
    window.sessionStorage.removeItem(key(sessionId));
  } catch {
    /* ignore */
  }
}

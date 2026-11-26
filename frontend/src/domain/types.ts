export type Role = 'owner' | 'interviewer' | 'candidate' | 'observer';
export type SessionState = 'draft' | 'live' | 'ended' | 'archived';

export interface User {
  id: string;
  email: string;
  displayName: string;
  organizationId: string | null;
  createdAt: string;
}

export interface InterviewSession {
  id: string;
  ownerUserId: string;
  title: string;
  prompt: string;
  state: SessionState;
  candidateEditingEnabled: boolean;
  cursorsVisible: boolean;
  /** When 'start', candidates cannot read the prompt until the session is live. */
  promptReveal: 'join' | 'start';
  durationMinutes: number;
  maxParticipants: number;
  scheduledAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionSummary extends InterviewSession {
  myRole: Role;
  participantNames: string[];
}

/** What a participant in the room is allowed to see about the session. */
export interface RoomSession {
  id: string;
  title: string;
  /** null while hidden from this participant. */
  prompt: string | null;
  state: SessionState;
  candidateEditingEnabled: boolean;
  cursorsVisible: boolean;
  durationMinutes: number;
  startedAt: string | null;
  endedAt: string | null;
}

export interface Participant {
  id: string;
  sessionId: string;
  userId: string | null;
  displayName: string;
  role: Role;
  joinedAt: string;
  leftAt: string | null;
  removed: boolean;
}

export interface GuestLink {
  id: string;
  sessionId: string;
  roleGranted: 'candidate' | 'observer';
  expiresAt: string | null;
  maxUses: number | null;
  uses: number;
  revokedAt: string | null;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  sessionId: string;
  actor: string;
  action: string;
  at: string;
  meta?: Record<string, string | number | boolean | null>;
}

export interface CollabCredential {
  id: string;
  sessionId: string;
  participantId: string;
  role: Role;
  expiresAt: string;
}

export interface PresenceState {
  cursor: { x: number; y: number } | null;
  selection: string[];
}

export interface PresenceEntry extends PresenceState {
  participantId: string;
  displayName: string;
  role: Role;
  color: string;
}

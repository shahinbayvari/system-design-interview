/**
 * The ONLY surface the UI uses to talk to a backend.
 *
 * Every network/storage/real-time call in the app goes through `Services`.
 * `services/mock` provides a complete in-browser implementation; a real HTTP/WebSocket
 * implementation only has to satisfy these interfaces.
 */
import type { CanvasOp, DocState } from '../domain/canvasDoc';
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
} from '../domain/types';

export interface AuthService {
  getCurrentUser(): Promise<User | null>;
  /** Mock completes the magic-link flow immediately. */
  signInWithMagicLink(email: string, displayName?: string): Promise<User>;
  signOut(): Promise<void>;
}

export interface CreateSessionInput {
  title: string;
  prompt?: string;
  durationMinutes?: number;
  promptReveal?: 'join' | 'start';
}

export type UpdateSessionInput = Partial<
  Pick<InterviewSession, 'title' | 'prompt' | 'durationMinutes' | 'cursorsVisible' | 'promptReveal' | 'scheduledAt' | 'maxParticipants'>
>;

export interface SessionService {
  create(input: CreateSessionInput): Promise<InterviewSession>;
  list(): Promise<SessionSummary[]>;
  get(sessionId: string): Promise<InterviewSession>;
  update(sessionId: string, patch: UpdateSessionInput): Promise<InterviewSession>;
  start(sessionId: string): Promise<InterviewSession>;
  end(sessionId: string): Promise<InterviewSession>;
  reopen(sessionId: string): Promise<InterviewSession>;
  archive(sessionId: string): Promise<InterviewSession>;
  duplicate(sessionId: string): Promise<InterviewSession>;
  setCandidateEditing(sessionId: string, enabled: boolean): Promise<InterviewSession>;
  /** Clears the canvas; the previous state is kept for `restoreClearedCanvas`. */
  clearCanvas(sessionId: string): Promise<void>;
  restoreClearedCanvas(sessionId: string): Promise<void>;
  listParticipants(sessionId: string): Promise<Participant[]>;
  removeParticipant(sessionId: string, participantId: string): Promise<void>;
  invite(sessionId: string, email: string, role: 'interviewer' | 'observer'): Promise<void>;
  listAuditEvents(sessionId: string): Promise<AuditEvent[]>;
  /** Latest saved canvas (final snapshot once ended). */
  getCanvasSnapshot(sessionId: string): Promise<DocState>;
  exportCanvasJson(sessionId: string): Promise<string>;
}

export interface CreatedGuestLink {
  link: GuestLink;
  /** The bearer token. Only ever returned at creation time; the server stores a hash. */
  token: string;
}

export interface GuestLinkService {
  list(sessionId: string): Promise<GuestLink[]>;
  create(
    sessionId: string,
    opts?: { role?: 'candidate' | 'observer'; expiresAt?: string | null; maxUses?: number | null },
  ): Promise<CreatedGuestLink>;
  /** Revokes all active links and creates a fresh one. */
  rotate(sessionId: string): Promise<CreatedGuestLink>;
  revoke(sessionId: string, linkId: string): Promise<void>;
}

export interface JoinPreview {
  sessionId: string;
  sessionTitle: string;
  state: InterviewSession['state'];
}

export interface JoinResult {
  participant: Participant;
  credential: CollabCredential;
  session: RoomSession;
}

export interface JoinService {
  preview(token: string): Promise<JoinPreview>;
  join(token: string, displayName: string): Promise<JoinResult>;
}

export type ConnectionStatus = 'connected' | 'reconnecting' | 'offline';

export type ServerEvent =
  | { type: 'document_update'; ops: CanvasOp[] }
  | { type: 'presence_update'; entry: PresenceEntry }
  | { type: 'presence_gone'; participantId: string }
  | { type: 'session_updated'; session: RoomSession }
  | { type: 'removed' }
  | { type: 'status'; status: ConnectionStatus };

export interface RoomJoined {
  participant: Participant;
  role: Role;
  session: RoomSession;
  snapshot: DocState;
  presence: PresenceEntry[];
}

export interface CollabConnection {
  readonly joined: RoomJoined;
  /** Persistent canvas ops. Rejects with ServiceError (EDITING_LOCKED, INVALID_OP, OFFLINE, ...). */
  sendUpdate(ops: CanvasOp[]): Promise<void>;
  /** Ephemeral presence (cursor, selection). Never persisted. */
  sendPresence(p: Partial<PresenceState>): void;
  /** Authoritative state; used after reconnect. */
  resync(): Promise<{ session: RoomSession; snapshot: DocState; presence: PresenceEntry[] }>;
  on(listener: (e: ServerEvent) => void): () => void;
  disconnect(): void;
}

export interface CollabService {
  /** Credentials for an authenticated interviewer / invitee. */
  getAccess(sessionId: string): Promise<CollabCredential>;
  /** Exchange a still-valid credential for a fresh short-lived one. */
  refreshCredential(credential: CollabCredential): Promise<CollabCredential>;
  connect(credential: CollabCredential): Promise<CollabConnection>;
}

/** Test / demo hooks. Not part of the production contract. */
export interface DevTools {
  setOnline(online: boolean): void;
  isOnline(): boolean;
}

export interface Services {
  auth: AuthService;
  sessions: SessionService;
  guestLinks: GuestLinkService;
  join: JoinService;
  collab: CollabService;
  dev?: DevTools;
}

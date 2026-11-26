export type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'LINK_INVALID'
  | 'LINK_REVOKED'
  | 'LINK_EXPIRED'
  | 'LINK_EXHAUSTED'
  | 'SESSION_ARCHIVED'
  | 'SESSION_ENDED'
  | 'SESSION_FULL'
  | 'EDITING_LOCKED'
  | 'INVALID_OP'
  | 'RATE_LIMITED'
  | 'OFFLINE'
  | 'CREDENTIAL_INVALID';

export function defaultMessage(code: ErrorCode): string {
  switch (code) {
    case 'UNAUTHENTICATED': return 'Please sign in to continue.';
    case 'FORBIDDEN': return "You don't have permission to do that.";
    case 'NOT_FOUND': return 'That could not be found.';
    case 'VALIDATION': return 'Some of the information provided is not valid.';
    case 'LINK_INVALID': return 'This interview link is not valid.';
    case 'LINK_REVOKED': return 'This interview link has been revoked by the interviewer.';
    case 'LINK_EXPIRED': return 'This interview link has expired.';
    case 'LINK_EXHAUSTED': return 'This interview link has reached its maximum number of uses.';
    case 'SESSION_ARCHIVED': return 'This interview has been archived and can no longer be joined.';
    case 'SESSION_ENDED': return 'This interview has ended.';
    case 'SESSION_FULL': return 'This interview is full. Ask the interviewer to make room.';
    case 'EDITING_LOCKED': return 'Editing is currently disabled for you.';
    case 'INVALID_OP': return 'The change could not be accepted.';
    case 'RATE_LIMITED': return 'Too many attempts. Please wait a moment and try again.';
    case 'OFFLINE': return 'You are offline.';
    case 'CREDENTIAL_INVALID': return 'Your session credentials are no longer valid.';
  }
}

export class ServiceError extends Error {
  constructor(public readonly code: ErrorCode, message?: string) {
    super(message ?? defaultMessage(code));
    this.name = 'ServiceError';
  }
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

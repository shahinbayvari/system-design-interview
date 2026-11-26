import type { Role, SessionState } from './types';

export interface EditContext {
  state: SessionState;
  candidateEditingEnabled: boolean;
}

/** Single source of truth for edit permission; used by the mock server and the UI. */
export function canEdit(role: Role, s: EditContext): boolean {
  if (role === 'observer') return false;
  if (role === 'owner' || role === 'interviewer') return s.state === 'draft' || s.state === 'live';
  return s.state === 'live' && s.candidateEditingEnabled;
}

export function canManage(role: Role): boolean {
  return role === 'owner';
}

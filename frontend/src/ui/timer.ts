import type { RoomSession } from '../domain/types';

/** Display-only interview timer (it never changes session state). */
export function formatTimer(s: Pick<RoomSession, 'state' | 'startedAt' | 'endedAt' | 'durationMinutes'>, nowMs: number): string {
  if (!s.startedAt) return s.state === 'draft' ? 'Not started' : '--:--';
  const start = Date.parse(s.startedAt);
  const end = s.state === 'live' ? nowMs : s.endedAt ? Date.parse(s.endedAt) : nowMs;
  const elapsed = Math.max(0, Math.floor((end - start) / 1000));
  if (s.state !== 'live') return `Ran ${mmss(elapsed)}`;
  const remaining = s.durationMinutes * 60 - elapsed;
  return remaining >= 0 ? `${mmss(remaining)} left` : `${mmss(-remaining)} over`;
}

export function mmss(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

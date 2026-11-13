import type { TaskProviderId } from '../tasks/types.ts';

export interface CompanionState {
  schemaVersion: 1;
  selectedId: string | null;
  provider: TaskProviderId;
  pet: { xp: number; lastInteractionAt: number; celebrateUntil: number; lean: number };
  timer: { durationMs: number; remainingMs: number; startedAt: number | null; sessions: number };
  notion: { dataSourceId: string };
}
export function defaultCompanion(now = Date.now()): CompanionState {
  return {
    schemaVersion: 1, selectedId: null, provider: 'mock',
    pet: { xp: 0, lastInteractionAt: now, celebrateUntil: 0, lean: 0 },
    timer: { durationMs: 25 * 60_000, remainingMs: 25 * 60_000, startedAt: null, sessions: 0 },
    notion: { dataSourceId: '' },
  };
}
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : fallback;
export function normalizeCompanion(raw: unknown, now = Date.now()): CompanionState {
  const s = defaultCompanion(now);
  if (!obj(raw)) return s;
  s.provider = raw.provider === 'canvas' || raw.provider === 'notion' ? raw.provider : 'mock';
  s.selectedId = typeof raw.selectedId === 'string' ? raw.selectedId.slice(0, 400) : null;
  if (obj(raw.pet)) {
    s.pet.xp = num(raw.pet.xp, 0);
    s.pet.lastInteractionAt = num(raw.pet.lastInteractionAt, now);
    s.pet.celebrateUntil = Math.min(now + 5000, num(raw.pet.celebrateUntil, 0));
  }
  if (obj(raw.timer)) {
    s.timer.durationMs = Math.max(60_000, num(raw.timer.durationMs, 25 * 60_000, 120 * 60_000));
    s.timer.remainingMs = num(raw.timer.remainingMs, s.timer.durationMs, s.timer.durationMs);
    s.timer.startedAt = typeof raw.timer.startedAt === 'number' && Number.isFinite(raw.timer.startedAt) && raw.timer.startedAt >= 0 ? raw.timer.startedAt : null;
    s.timer.sessions = Math.floor(num(raw.timer.sessions, 0));
  }
  if (obj(raw.notion) && typeof raw.notion.dataSourceId === 'string' && /^[a-f\d-]{32,36}$/i.test(raw.notion.dataSourceId)) s.notion.dataSourceId = raw.notion.dataSourceId;
  settleTimer(s, now);
  return s;
}
export function remainingTime(s: CompanionState, now: number): number {
  return Math.max(0, s.timer.remainingMs - (s.timer.startedAt === null ? 0 : Math.max(0, now - s.timer.startedAt)));
}
export function celebrate(s: CompanionState, now: number, xp = 10): void {
  s.pet.xp += xp;
  s.pet.lastInteractionAt = now;
  s.pet.celebrateUntil = now + 5000;
}
export function settleTimer(s: CompanionState, now: number): boolean {
  if (s.timer.startedAt !== null && remainingTime(s, now) === 0) {
    s.timer.remainingMs = 0; s.timer.startedAt = null; s.timer.sessions++;
    celebrate(s, now, 25); return true;
  }
  return false;
}
export function timerAction(s: CompanionState, action: 'start' | 'pause' | 'reset', now: number): void {
  settleTimer(s, now);
  if (action === 'reset') { s.timer.remainingMs = s.timer.durationMs; s.timer.startedAt = null; }
  if (action === 'pause') { s.timer.remainingMs = remainingTime(s, now); s.timer.startedAt = null; }
  if (action === 'start' && s.timer.startedAt === null) {
    if (!s.timer.remainingMs) s.timer.remainingMs = s.timer.durationMs;
    s.timer.startedAt = now;
  }
  s.pet.lastInteractionAt = now;
}
export function mood(s: CompanionState, now: number): 'celebrating' | 'happy' | 'sleepy' | 'focused' | 'idle' {
  if (s.pet.celebrateUntil > now) return 'celebrating';
  if (s.timer.startedAt !== null) return 'focused';
  if (now - s.pet.lastInteractionAt > 5 * 60_000) return 'sleepy';
  if (now - s.pet.lastInteractionAt < 20_000) return 'happy';
  return 'idle';
}

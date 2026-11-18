import type { Trial } from './types';

const sessions = [5, 10, 15, 20];
const days = [10, 20, 30, 45, 60];

export function trialHasEnded(trial: Trial | undefined, now = Date.now()): boolean {
  if (!trial?.enabled) return false;
  const deadline = Date.parse(trial.expiresAt);
  return !Number.isFinite(deadline) || now >= deadline;
}

export function trialDeadlineLabel(trial: Trial): string {
  const deadline = Date.parse(trial.expiresAt);
  if (!Number.isFinite(deadline)) return '期限暂时无法确认，请联系分享人';
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(deadline);
}

function validLimit(value: number, maximum: number): number {
  return Number.isInteger(value) && value >= 1 ? Math.min(value, maximum) : 0;
}
function choices(defaults: number[], cap: number, selected?: number): number[] {
  if (!cap) return [];
  const values = [...defaults.filter(value => value <= cap), cap];
  if (selected !== undefined && Number.isInteger(selected) && selected >= 1 && selected <= cap) values.push(selected);
  return [...new Set(values)].sort((a, b) => a - b);
}

/** Pure display limits; the server remains authoritative for invitation and quota checks. */
export function trialTimeOptions(trial?: Trial, selected?: { session: number; daily: number }) {
  if (!trial?.enabled) return { sessionOptions: sessions, dailyOptions: days, sessionLimit: 60, dailyLimit: 180, valid: true };
  const dailyLimit = validLimit(trial.maxDailyMinutes, 180);
  const sessionLimit = Math.min(validLimit(trial.maxSessionMinutes, 60), dailyLimit);
  return { sessionOptions: choices(sessions, sessionLimit, selected?.session), dailyOptions: choices(days, dailyLimit, selected?.daily),
    sessionLimit, dailyLimit, valid: sessionLimit > 0 && dailyLimit > 0 };
}

export function constrainTrialTimes(session: number, daily: number, trial?: Trial) {
  if (!trial?.enabled) return { session, daily };
  const limits = trialTimeOptions(trial);
  if (!limits.valid) return { session: 0, daily: 0 };
  const boundedSession = Math.min(limits.sessionLimit, Math.max(1, Number.isFinite(session) ? Math.floor(session) : 10));
  const boundedDaily = Math.min(limits.dailyLimit, Math.max(boundedSession, Number.isFinite(daily) ? Math.floor(daily) : 20));
  return { session: boundedSession, daily: boundedDaily };
}

export function trialSetupError(trial: Trial | undefined, inviteCode: string, now = Date.now()): string | undefined {
  if (!trial?.enabled) return undefined;
  if (trialHasEnded(trial, now)) return '本轮朋友内测已结束，暂时不能完成设置。请联系分享人了解后续安排。';
  if (!trialTimeOptions(trial).valid) return '内测聊天时限暂时无法确认，请联系分享人后再试。';
  if (trial.requiresInvite && !inviteCode.trim()) return '请填写邀请人提供的内测邀请码；它与自己设置的家长 PIN 不同。';
  return undefined;
}

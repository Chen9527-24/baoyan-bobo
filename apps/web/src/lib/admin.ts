import { api, post } from './api';

export type AdminSession = { initialized: boolean; authenticated: boolean; admin?: { id: string; username: string }; expiresAt?: string };
export type AdminAccount = {
  id: string; username: string; familyId: string | null; guardian: boolean; createdAt: string;
  status: 'active' | 'disabled'; revision: number; deviceCount: number;
  contactPhone: string; familyName: string; childNames: string[];
};
export type AdminFamily = {
  id: string; status: 'active' | 'paused'; revision: number; accountCount: number; memberCount: number; deviceCount: number;
  displayName: string; childNames: string[];
  contacts: { accountId: string; username: string; guardian: boolean; contactPhone: string }[];
};
export type AdminAudit = { id: string; at: string; actor: string; action: string; targetType: string; targetId: string; reason: string };
export type FeedbackStatus = 'open' | 'in_progress' | 'resolved';
export type AdminFeedback = { id: string; createdAt: string; expiresAt: string | null; status: FeedbackStatus; revision: number; hasText: boolean; hasAudio: boolean; audioBytes: number; familyLinked: boolean; context: { page?: string; callState?: string; appVersion?: string } };
export type AdminFeedbackDetail = AdminFeedback & { text: string; note: string; events: { previousStatus: FeedbackStatus; status: FeedbackStatus; reviewer: string; note: string; createdAt: string }[] };
type AdminMetric = { attempts: number; succeeded: number; failed: number; successRate: number | null; p50Ms: number | null; p95Ms: number | null };
export type AdminOverview = { accounts: { total: number; disabled: number }; families: { total: number; paused: number }; activeDevices: number; activeCalls: number; admins: number; initializedAt: string | null;
  service: { checkedAt: string; windowDays: number; providerStages: { available: boolean; stages: (AdminMetric & { stage: string })[] }; clientFirstAudio: AdminMetric; providerDayBudget: { available: boolean; day: string; calls: number | null; dailyBudget: number | null; remaining: number | null }; feedback: { open: number; in_progress: number; resolved: number; total: number }; cost: { measured: false } };
  models: { reply: string }; capabilities: Record<string, boolean>; trial?: { enabled: boolean; expiresAt: string; requiresInvite: boolean; maxSessionMinutes: number; maxDailyMinutes: number };
};
export type AdminPage<T> = { items: T[]; total: number; offset: number; limit: number };
export type AdminLaunch = { kind: 'setup' | 'recover'; token: string } | null;

/** Fragment secrets are retained only in component state, never storage or URL queries. */
export function parseAdminLaunch(hash: string): AdminLaunch {
  const values = new URLSearchParams(hash.replace(/^#/, ''));
  if (values.has('setup') === values.has('recover')) return null;
  const kind = values.has('setup') ? 'setup' : 'recover';
  if (values.getAll(kind).length !== 1) return null;
  const token = values.get(kind) ?? '';
  return /^[A-Za-z0-9_-]{20,200}$/.test(token) ? { kind, token } : null;
}
export const adminRoute = (path: string) => path === '/admin' || path === '/admin/';
export function adminListQuery(offset: number, q: string, status: string, limit = 20) {
  const params = new URLSearchParams({ offset: String(Math.max(0, offset)), limit: String(limit), q: q.trim() });
  if (status) params.set('status', status);
  return params.toString();
}
export function accountRecoveryUrl(origin: string, token: string) {
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) throw new Error('恢复链接格式不正确，请重新生成。');
  return `${origin}/admin#recover=${encodeURIComponent(token)}`;
}
export function adminTime(value: string | number | null | undefined) {
  if (value === null || value === undefined) return '—';
  const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—';
}
export const adminGet = <T>(path: string, signal?: AbortSignal) => api<T>(`/admin${path}`, { signal, cache: 'no-store' });
export const adminPost = <T>(path: string, body: unknown = {}) => post<T>(`/admin${path}`, body);

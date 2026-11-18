import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { ApiError } from './provider-errors.js';

export interface TrialConfig {
  requireInvite: boolean;
  endsAt: number;
  maxFamilies: number;
  maxSessionMinutes: number;
  maxDailyMinutes: number;
  dailyProviderCalls: number;
  maxConcurrentProviderCalls: number;
}
type Env = Record<string, string | undefined>;

export function trialDeadline(value: string | undefined): number {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/);
  const parsed = value ? Date.parse(value) : NaN;
  if (!match || !Number.isFinite(parsed)) throw new Error('内测截止时间必须是含时区的有效 ISO 时间。');
  const [, year, month, day, hour, minute, second] = match;
  const monthDays = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > monthDays
      || Number(hour) > 23 || Number(minute) > 59 || Number(second ?? 0) > 59)
    throw new Error('内测截止时间无效。');
  return parsed;
}

export function readTrialConfig(env: Env): TrialConfig | undefined {
  if (env.TRIAL_ENABLED !== undefined && !['true', 'false', ''].includes(env.TRIAL_ENABLED))
    throw new Error('TRIAL_ENABLED 只能为 true 或 false。');
  if (env.TRIAL_REQUIRE_INVITE !== undefined && !['true', 'false'].includes(env.TRIAL_REQUIRE_INVITE))
    throw new Error('TRIAL_REQUIRE_INVITE 只能为 true 或 false。');
  if (env.TRIAL_ENABLED !== 'true') {
    if (env.NODE_ENV === 'production') throw new Error('生产环境必须启用有期限和用量限制的内测保护。');
    return undefined;
  }
  const positive = (key: string, fallback: number) => {
    const value = env[key] ?? String(fallback);
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`${key} 必须为正整数。`);
    return Number(value);
  };
  const config = {
    requireInvite: env.TRIAL_REQUIRE_INVITE !== 'false',
    endsAt: trialDeadline(env.TRIAL_ENDS_AT),
    maxFamilies: positive('TRIAL_MAX_FAMILIES', 5),
    maxSessionMinutes: positive('TRIAL_MAX_SESSION_MINUTES', 10),
    maxDailyMinutes: positive('TRIAL_MAX_DAILY_MINUTES', 20),
    dailyProviderCalls: positive('TRIAL_DAILY_PROVIDER_CALLS', 300),
    maxConcurrentProviderCalls: positive('TRIAL_MAX_CONCURRENT_PROVIDER_CALLS', 2),
  };
  if (config.maxDailyMinutes < config.maxSessionMinutes) throw new Error('内测每日时长不得小于单次时长。');
  return config;
}

/** Exact HTTPS origins only in production; Origin remains a CSRF check, never access authentication. */
export function validateProductionOrigins(env: Env, origins: string[]): void {
  if (env.NODE_ENV !== 'production') return;
  if (!origins.length) throw new Error('生产环境必须显式配置 HTTPS ALLOWED_ORIGINS。');
  for (const origin of origins) {
    let url: URL;
    try { url = new URL(origin); } catch { throw new Error('生产环境来源域名无效。'); }
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password
        || isIP(hostname.replace(/^\[|\]$/g, '')) || !hostname.includes('.') || !/^[a-z0-9.-]+$/.test(hostname)
        || hostname.startsWith('.') || hostname.endsWith('.') || hostname.includes('..')
        || /(^|\.)(localhost|local|test|invalid|example|example\.com|example\.org|example\.net)$/.test(hostname))
      throw new Error('生产环境须使用明确的公网 HTTPS 域名，不能使用本机、通配符或示例域。');
  }
}

const hashCode = (code: string) => createHash('sha256').update(code).digest('hex');
type Invite = { id: string; created_at: number; expires_at: number; revoked_at: number | null; used_at: number | null };

export function createTrialAccess(db: DatabaseSync, config: TrialConfig | undefined, now: () => number = Date.now) {
  let inFlight = 0;
  let setupWindow = -1;
  let setupAttempts = 0;
  if (config) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS trial_invites (
      id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, revoked_at INTEGER, used_at INTEGER, used_family_id TEXT
    );
    CREATE TABLE IF NOT EXISTS trial_provider_usage (day TEXT PRIMARY KEY, calls INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS trial_admissions (
      family_hash TEXT PRIMARY KEY, admitted_at INTEGER NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('invite','open'))
    );
    `);
    // Upgrade old invited households without changing their credentials or inventing invitation records.
    // Only an opaque digest is retained after withdrawal; this is admission evidence, not a family profile.
    const migrate = db.prepare("INSERT OR IGNORE INTO trial_admissions(family_hash,admitted_at,source) VALUES(?,?,'invite')");
    const admitted = db.prepare('SELECT used_family_id,used_at FROM trial_invites WHERE used_family_id IS NOT NULL AND used_at IS NOT NULL');
    for (const row of admitted.iterate() as Iterable<{ used_family_id: string; used_at: number }>)
      migrate.run(hashCode(row.used_family_id), row.used_at);
  }
  const assertOpen = () => {
    if (config && now() >= config.endsAt) throw new ApiError(410, '本轮内测已结束，仍可在家长管理中导出或删除资料。', 'TRIAL_EXPIRED');
  };
  const requireConfig = () => {
    if (!config) throw new Error('邀请码管理需要 TRIAL_ENABLED=true 及完整内测配置。');
    return config;
  };
  const checkInvite = (code?: string) => {
    if (!config) return;
    assertOpen();
    if (!config.requireInvite) return;
    const row = typeof code === 'string' && /^[A-Za-z0-9_-]{32}$/.test(code)
      ? db.prepare('SELECT id FROM trial_invites WHERE code_hash=? AND revoked_at IS NULL AND used_at IS NULL AND expires_at>?').get(hashCode(code), now())
      : undefined;
    if (!row) throw new ApiError(403, '请输入有效且尚未使用的内测邀请码。', 'TRIAL_INVITE_REQUIRED');
    const consumed = (db.prepare('SELECT count(*) AS n FROM trial_invites WHERE used_at IS NOT NULL').get() as { n: number }).n;
    if (consumed >= config.maxFamilies) throw new ApiError(403, '本轮内测名额已满。', 'TRIAL_FAMILY_LIMIT');
  };
  return {
    config,
    assertOpen,
    checkInvite,
    throttleSetup() {
      if (!config) return;
      const window = Math.floor(now() / 60_000);
      if (window !== setupWindow) { setupWindow = window; setupAttempts = 0; }
      if (++setupAttempts > 30) throw new ApiError(429, '设置请求较多，请一分钟后再试。', 'TRIAL_SETUP_BUSY');
    },
    bootstrap(anonymous: boolean) {
      return config ? { trial: { enabled: true as const, requiresInvite: config.requireInvite && anonymous, expiresAt: new Date(config.endsAt).toISOString(), maxSessionMinutes: config.maxSessionMinutes, maxDailyMinutes: config.maxDailyMinutes } } : {};
    },
    assertIsolatedDatabase() {
      if (!config) return;
      // Both admission modes must use the public trial database, never silently import local households.
      const admitted = db.prepare('SELECT 1 FROM trial_admissions WHERE family_hash=?');
      for (const row of db.prepare('SELECT id FROM families').iterate() as Iterable<{ id: string }>)
        if (!admitted.get(hashCode(row.id))) throw new Error('数据库含未经内测准入的本机家庭，请为内测使用独立数据库。');
    },
    validateMinutes(session: number, daily: number) {
      if (config && (session > config.maxSessionMinutes || daily > config.maxDailyMinutes))
        throw new ApiError(400, '时长超过本轮内测允许范围，请调低单次或每日时长。', 'TRIAL_TIME_LIMIT');
    },
    capSessionMinutes(value: number) { return config ? Math.min(value, config.maxSessionMinutes) : value; },
    capDailyMinutes(value: number) { return config ? Math.min(value, config.maxDailyMinutes) : value; },
    /** Caller MUST include this in the same BEGIN IMMEDIATE transaction as household creation. */
    consumeInvite(code: string | undefined, familyId: string) {
      if (!config) return;
      // isTransaction was added after the project's minimum Node 22.13 version.
      if ('isTransaction' in db && !db.isTransaction) throw new Error('内测准入必须与家庭创建位于同一事务。');
      checkInvite(code);
      if (config.requireInvite) {
        const result = db.prepare('UPDATE trial_invites SET used_at=?, used_family_id=? WHERE code_hash=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at>?')
          .run(now(), familyId, hashCode(code!), now());
        if (result.changes !== 1) throw new ApiError(403, '请输入有效且尚未使用的内测邀请码。', 'TRIAL_INVITE_REQUIRED');
      }
      db.prepare('INSERT INTO trial_admissions(family_hash,admitted_at,source) VALUES(?,?,?)')
        .run(hashCode(familyId), now(), config.requireInvite ? 'invite' : 'open');
    },
    createInvite(expiresAt?: number) {
      const settings = requireConfig(); assertOpen();
      const expiry = expiresAt ?? settings.endsAt;
      if (!Number.isFinite(expiry) || expiry <= now() || expiry > settings.endsAt) throw new Error('邀请码期限须晚于当前时间且不超过内测截止时间。');
      const id = randomUUID();
      const inviteCode = randomBytes(24).toString('base64url');
      db.prepare('INSERT INTO trial_invites(id,code_hash,created_at,expires_at) VALUES(?,?,?,?)').run(id, hashCode(inviteCode), now(), expiry);
      return { id, inviteCode, expiresAt: new Date(expiry).toISOString() };
    },
    listInvites() {
      const settings = requireConfig();
      return (db.prepare('SELECT id,created_at,expires_at,revoked_at,used_at FROM trial_invites ORDER BY created_at,id').all() as Invite[]).map(row => ({
        id: row.id, createdAt: new Date(row.created_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString(),
        state: row.used_at !== null ? 'used' : row.revoked_at !== null ? 'revoked' : now() >= Math.min(row.expires_at, settings.endsAt) ? 'expired' : 'available',
      }));
    },
    revokeInvite(id: string) {
      requireConfig();
      const result = db.prepare('UPDATE trial_invites SET revoked_at=? WHERE id=? AND used_at IS NULL AND revoked_at IS NULL').run(now(), id);
      if (result.changes !== 1) throw new Error('邀请码不存在、已经使用或已经撤销。');
      return { id, revoked: true };
    },
    acquireProvider() {
      assertOpen();
      if (!config) return () => {};
      if (inFlight >= config.maxConcurrentProviderCalls) throw new ApiError(429, '当前体验人数较多，请稍后再试。', 'TRIAL_BUSY');
      inFlight++;
      let released = false;
      return () => { if (!released) { released = true; inFlight--; } };
    },
    /** Called immediately before a real fetch/WebSocket attempt; failures are not refunded. */
    consumeProviderCall() {
      if (!config) return;
      assertOpen();
      const day = new Date(now() + 8 * 3600000).toISOString().slice(0, 10);
      const result = db.prepare(`INSERT INTO trial_provider_usage(day,calls) VALUES(?,1)
        ON CONFLICT(day) DO UPDATE SET calls=calls+1 WHERE calls<? RETURNING calls`).get(day, config.dailyProviderCalls);
      if (!result) throw new ApiError(429, '今天的全站体验调用额度已用完，请明天再来。', 'TRIAL_DAILY_LIMIT');
    },
  };
}

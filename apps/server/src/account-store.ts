import { createHash, randomBytes, randomUUID, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ApiError } from './provider-errors.js';
import { initializeOperationalTables, assertOperationalAccess } from './admin-store.js';

export type Account = { id: string; familyId: string; username: string; passwordRevision: number; loginRevision: number };
export type RevokedAccountDevice = { familyId: string; deviceHash: string };
type AccountRow = { id: string; family_id: string | null; username: string; password_salt: string; password_hash: string;
  access_revision?: number; family_access_revision?: number; login_revision?: number; password_revision: number; recovery_hash: string | null; recovery_revision: number; created_at: number };
type ProfileRow = {child_name:string;pin_salt:string|null;pin_hash:string|null;pin_revision:number;login_revision:number};
type SessionRow = { device_hash: string; account_id: string | null; password_revision: number; created_at: number; expires_at: number };
const DAY = 86_400_000;
const SESSION_MS = 30 * DAY;
const ATTEMPT_MS = 15 * 60_000;
const MAX_ATTEMPT_BUCKETS = 10_000;
const SCRYPT_OPTIONS = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const MAX_KDF_CONCURRENT = 2;
const MAX_KDF_QUEUE = 8;
const dummySalt = randomBytes(32);
const dummyTarget = randomBytes(64);

// Shared by every store in this process, rather than every HTTP request or app.
type KdfJob = { owner: symbol; run: () => void; reject: (error: Error) => void };
let kdfRunning = 0;
const kdfQueue: KdfJob[] = [];
const busy = () => new ApiError(429, '账号服务正忙，请稍后再试', 'ACCOUNT_BUSY');
const stopped = () => new ApiError(503, '账号服务暂时不可用，请稍后重新连接', 'SERVICE_STOPPED');
const invalidCredentials = () => new ApiError(401, '账号信息无效，请检查后重试', 'ACCOUNT_AUTH_FAILED');
const changed = () => new ApiError(409, '账号状态已更新，请重新登录后再试', 'ACCOUNT_CHANGED');
const required = () => new ApiError(401, '账号登录已失效，请重新登录', 'ACCOUNT_REQUIRED');
function drainKdf() {
  while (kdfRunning < MAX_KDF_CONCURRENT && kdfQueue.length) {
    const job = kdfQueue.shift()!; kdfRunning++; job.run();
  }
}
function derive(owner: symbol, password: string, salt: Buffer, isOpen: () => boolean): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (!isOpen()) { reject(stopped()); return; }
    if (kdfRunning >= MAX_KDF_CONCURRENT && kdfQueue.length >= MAX_KDF_QUEUE) { reject(busy()); return; }
    const job: KdfJob = { owner, reject, run: () => {
      const finish = (error?: Error | null, key?: Buffer) => {
        kdfRunning--;
        if (!isOpen()) { key?.fill(0); reject(stopped()); }
        else if (error || !key) reject(new ApiError(503, '账号校验暂时不可用，请稍后再试', 'ACCOUNT_BUSY'));
        else resolve(key);
        drainKdf();
      };
      if (!isOpen()) { finish(stopped()); return; }
      try { scrypt(password, salt, 64, SCRYPT_OPTIONS, finish); } catch { finish(stopped()); }
    } };
    kdfQueue.push(job); drainKdf();
  });
}

/** Read-only counters for resource-limit verification; they contain no credentials. */
export function accountKdfStatus() { return { running: kdfRunning, queued: kdfQueue.length, maxConcurrent: MAX_KDF_CONCURRENT, queueLimit: MAX_KDF_QUEUE }; }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const publicAccount = (row: AccountRow): Account => ({ id: row.id, familyId: row.family_id??'', username: row.username, passwordRevision: row.password_revision, loginRevision:row.login_revision??0 });

function username(value: unknown) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{3,32}$/.test(value.trim()))
    throw new ApiError(400, '账号名须为3–32个英文字母、数字、点、下划线或短横线', 'ACCOUNT_USERNAME_INVALID');
  return value.trim().toLowerCase();
}
function authenticationPassword(value: unknown): string {
  if (typeof value !== 'string' || Array.from(value).length > 128 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw invalidCredentials();
  return value;
}
function newPassword(value: unknown): string {
  if (typeof value !== 'string' || Array.from(value).length < 8 || Array.from(value).length > 128
    || /[\u0000-\u001f\u007f]/.test(value)) throw new ApiError(400, '密码至少8位，最多128个字符，请勿包含换行等控制字符', 'ACCOUNT_PASSWORD_INVALID');
  return value;
}
function passwordMatches(derived: Buffer, expected: string | undefined) {
  const target = expected && /^[a-f0-9]{128}$/.test(expected) ? Buffer.from(expected, 'hex') : dummyTarget;
  return timingSafeEqual(derived, target);
}
function recoveryMatches(code: unknown, expected: string | null | undefined) {
  const value = typeof code === 'string' ? code.trim() : '';
  const valid = /^[A-Za-z0-9_-]{43}$/.test(value);
  const actual = Buffer.from(hash(value.length <= 128 ? value : ''), 'hex');
  const target = expected && /^[a-f0-9]{64}$/.test(expected) ? Buffer.from(expected, 'hex') : Buffer.alloc(32);
  return timingSafeEqual(actual, target) && valid && Boolean(expected);
}

export function normalizeContactPhone(value: unknown): string {
  if (typeof value !== 'string' || value.length > 64 || /[\u0000-\u001f\u007f]/u.test(value)) throw new ApiError(400, '请填写有效的联系手机号，或留空', 'ACCOUNT_CONTACT_INVALID');
  const normalized = value.replace(/[\p{Zs}-]/gu, '');
  if (normalized && !/^(?:1[3-9]\d{9}|\+[1-9]\d{6,14})$/.test(normalized)) throw new ApiError(400, '请填写11位国内手机号，或带加号和国家区号的国际号码', 'ACCOUNT_CONTACT_INVALID');
  return normalized;
}
function registrationProfile(input:{contactPhone?:unknown;childName?:unknown;pin?:unknown}) {
  const contactPhone=normalizeContactPhone(input.contactPhone);
  if(!contactPhone)throw new ApiError(400,'注册时请填写联系手机号','ACCOUNT_CONTACT_REQUIRED');
  if(typeof input.childName!=='string'||!input.childName.trim()||Array.from(input.childName.trim()).length>20||/[\u0000-\u001f\u007f]/u.test(input.childName))throw new ApiError(400,'请填写1–20字的小朋友姓名或称呼','ACCOUNT_CHILD_NAME_INVALID');
  if(typeof input.pin!=='string'||!/^\d{6}$/.test(input.pin))throw new ApiError(400,'请设置6位数字账号PIN','ACCOUNT_PIN_INVALID');
  const pinSalt=randomBytes(16).toString('hex'),key=scryptSync(input.pin,pinSalt,64);
  try{return{contactPhone,childName:input.childName.trim(),pinSalt,pinHash:key.toString('hex')};}finally{key.fill(0);}
}

export function createAccountStore({ db, now = Date.now }: { db: DatabaseSync; now?: () => number }) {
  // Rebuild only the credential table: existing rows and referencing sessions retain their keys.
  const oldColumns=db.prepare('PRAGMA table_info(accounts)').all() as {name:string;notnull:number}[];
  if(oldColumns.some(c=>c.name==='family_id'&&c.notnull)){
    db.exec('PRAGMA foreign_keys=OFF');
    try{db.exec(`BEGIN IMMEDIATE; CREATE TABLE accounts_next (
      id TEXT PRIMARY KEY,family_id TEXT REFERENCES families(id) ON DELETE CASCADE,
      username TEXT NOT NULL UNIQUE,password_salt TEXT NOT NULL,password_hash TEXT NOT NULL,
      password_revision INTEGER NOT NULL,recovery_hash TEXT,recovery_revision INTEGER NOT NULL,created_at INTEGER NOT NULL);
      INSERT INTO accounts_next SELECT * FROM accounts; DROP TABLE accounts; ALTER TABLE accounts_next RENAME TO accounts; COMMIT;`);}
    catch(error){db.exec('ROLLBACK');throw error;}finally{db.exec('PRAGMA foreign_keys=ON');}
    if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('Account migration failed integrity check');
  }
  db.exec(`CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY, family_id TEXT REFERENCES families(id) ON DELETE CASCADE,
    username TEXT NOT NULL UNIQUE, password_salt TEXT NOT NULL, password_hash TEXT NOT NULL,
    password_revision INTEGER NOT NULL, recovery_hash TEXT, recovery_revision INTEGER NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS account_sessions (
    device_hash TEXT PRIMARY KEY REFERENCES devices(token_hash) ON DELETE CASCADE,
    account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL, password_revision INTEGER NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS account_attempts (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, until INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS account_session_expiry ON account_sessions(expires_at);
  CREATE INDEX IF NOT EXISTS account_attempt_expiry ON account_attempts(until);`);
  db.exec(`CREATE TABLE IF NOT EXISTS account_identity_sessions(token_hash TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,password_revision INTEGER NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS guardian_members(account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS guardian_links(code_hash TEXT PRIMARY KEY,family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL);`);
  initializeOperationalTables(db);
  db.exec(`CREATE TABLE IF NOT EXISTS account_profiles(account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    child_name TEXT NOT NULL,pin_salt TEXT,pin_hash TEXT,pin_revision INTEGER NOT NULL DEFAULT 0,login_revision INTEGER NOT NULL DEFAULT 0);`);
  const owner = Symbol('account-kdf-owner');
  let closed = false;
  const isOpen = () => !closed;
  const assertOpen = () => { if (closed) throw stopped(); };
  const loginAttempts=new Map<string,number>();let loginSequence=0;
  const selectAccount='SELECT a.*,coalesce((SELECT revision FROM admin_account_states WHERE account_id=a.id),0) access_revision,coalesce((SELECT revision FROM admin_family_states WHERE family_id=a.family_id),0) family_access_revision,coalesce((SELECT login_revision FROM account_profiles WHERE account_id=a.id),0) login_revision FROM accounts a';
  const byId = (id: string) => { assertOpen(); return db.prepare(selectAccount+' WHERE id=?').get(id) as AccountRow | undefined; };
  const byName = (name: string) => { assertOpen(); return db.prepare(selectAccount+' WHERE username=?').get(name) as AccountRow | undefined; };
  function accountForFamily(familyId: string): Account | undefined {
    assertOpen(); const row = db.prepare(selectAccount+' WHERE family_id=?').get(familyId) as AccountRow | undefined;
    return row ? publicAccount(row) : undefined;
  }
  function assertAccount(account: Account) {
    const row = byId(account.id);
    assertOperationalAccess(db, row?.id, row?.family_id);
    if (!row || (row.family_id??'') !== account.familyId || row.username !== account.username || row.password_revision !== account.passwordRevision || (row.login_revision??0)!==account.loginRevision) throw required();
  }
  function assertVersion(before: AccountRow, recovery = false): AccountRow {
    const current = byId(before.id);
    assertOperationalAccess(db, current?.id, current?.family_id);
    if (!current || current.login_revision !== before.login_revision || current.access_revision !== before.access_revision || current.family_access_revision !== before.family_access_revision || current.family_id !== before.family_id || current.password_revision !== before.password_revision
      || current.password_hash !== before.password_hash || recovery && (current.recovery_revision !== before.recovery_revision || current.recovery_hash !== before.recovery_hash)) throw changed();
    return current;
  }
  function consumeAttempt(name: string, ip?: string) {
    assertOpen(); const at = now();
    if (ip !== undefined && (typeof ip !== 'string' || !ip || ip.length > 200)) throw invalidCredentials();
    const buckets = [{ key: hash(`username:${name}`), limit: 6 }, ...(ip ? [{ key: hash(`ip:${ip}`), limit: 100 }] : [])];
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM account_attempts WHERE until<=?').run(at);
      const rows = buckets.map(bucket => ({ ...bucket, row: db.prepare('SELECT count,until FROM account_attempts WHERE bucket=?').get(bucket.key) as { count: number; until: number } | undefined }));
      if (rows.some(bucket => (bucket.row?.count ?? 0) >= bucket.limit)) throw new ApiError(429, '尝试过于频繁，请15分钟后再试', 'ACCOUNT_THROTTLED');
      const count = Number((db.prepare('SELECT count(*) AS n FROM account_attempts').get() as { n: number }).n);
      if (count + rows.filter(bucket => !bucket.row).length > MAX_ATTEMPT_BUCKETS) throw new ApiError(429, '账号尝试较多，请稍后再试', 'ACCOUNT_THROTTLED');
      for (const bucket of rows) db.prepare('INSERT INTO account_attempts VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1').run(bucket.key, at + ATTEMPT_MS);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function clearSuccessfulName(name: string) { assertOpen(); db.prepare('DELETE FROM account_attempts WHERE bucket=?').run(hash(`username:${name}`)); }
  function assertDevice(deviceHash: string) {
    assertOpen(); const session = db.prepare('SELECT * FROM account_sessions WHERE device_hash=?').get(deviceHash) as SessionRow | undefined;
    const deviceFamily = db.prepare('SELECT family_id FROM devices WHERE token_hash=?').get(deviceHash) as { family_id: string } | undefined;
    if (!deviceFamily) throw required();
    assertOperationalAccess(db, session?.account_id, deviceFamily.family_id);
    if (!session) return; // Existing unbound visitor credentials remain supported.
    const row = session.account_id ? byId(session.account_id) : undefined;
    const device = db.prepare('SELECT family_id FROM devices WHERE token_hash=?').get(deviceHash) as { family_id: string } | undefined;
    if (!row || !device || row.family_id !== device.family_id || session.expires_at <= now() || session.password_revision !== row.password_revision) throw required();
  }
  function summary(familyId: string, deviceHash: string) {
    assertOpen(); const account = accountForDevice(deviceHash)??accountForFamily(familyId);
    const session = db.prepare('SELECT * FROM account_sessions WHERE device_hash=?').get(deviceHash) as SessionRow | undefined;
    const device = db.prepare('SELECT family_id FROM devices WHERE token_hash=?').get(deviceHash) as { family_id: string } | undefined;
    const signedIn = Boolean(account && device?.family_id === familyId && session?.account_id === account.id
      && session.password_revision === account.passwordRevision && session.expires_at > now());
    return { bound: Boolean(account), signedIn, ...(account&&db.prepare('SELECT 1 FROM guardian_members WHERE account_id=?').get(account.id)?{guardian:true}:{}), ...(account ? { username: account.username,...profile(account) } : {}),
      ...(account && session?.account_id === account.id ? { expiresAt: new Date(session.expires_at).toISOString() } : {}) };
  }
  function replaceSession(account:Account,keepDevice?:string):RevokedAccountDevice[] {
    assertAccount(account);
    const revoked=(db.prepare('SELECT s.device_hash,d.family_id FROM account_sessions s JOIN devices d ON d.token_hash=s.device_hash WHERE s.account_id=? AND s.device_hash!=?').all(account.id,keepDevice??'') as {device_hash:string;family_id:string}[]).map(r=>({familyId:r.family_id,deviceHash:r.device_hash}));
    for(const row of revoked)db.prepare('DELETE FROM devices WHERE token_hash=?').run(row.deviceHash);
    db.prepare('DELETE FROM account_identity_sessions WHERE account_id=?').run(account.id);
    db.prepare("INSERT INTO account_profiles(account_id,child_name,login_revision) VALUES(?,'',1) ON CONFLICT(account_id) DO UPDATE SET login_revision=login_revision+1").run(account.id);
    return revoked;
  }
  function attach(accountId: string, deviceHash: string,expected?:Account) {
    assertOpen(); const account = byId(accountId);
    const device = db.prepare('SELECT family_id FROM devices WHERE token_hash=?').get(deviceHash) as { family_id: string } | undefined;
    assertOperationalAccess(db, account?.id, device?.family_id);
    if (!account || !device || device.family_id !== account.family_id) throw required();
    const own=!db.isTransaction;if(own)db.exec('BEGIN IMMEDIATE');try{
      const revokedDevices=replaceSession(expected??publicAccount(account),deviceHash);
      db.prepare('INSERT INTO account_sessions VALUES(?,?,?,?,?) ON CONFLICT(device_hash) DO UPDATE SET account_id=excluded.account_id,password_revision=excluded.password_revision,created_at=excluded.created_at,expires_at=excluded.expires_at')
        .run(deviceHash, account.id, account.password_revision, now(), now() + SESSION_MS);
      if(own)db.exec('COMMIT');return{account:publicAccount(byId(accountId)!),revokedDevices};
    }catch(error){if(own)db.exec('ROLLBACK');throw error;}
  }
  function revokedDevices(familyId: string): string[] { return (db.prepare('SELECT token_hash FROM devices WHERE family_id=?').all(familyId) as { token_hash: string }[]).map(device => device.token_hash); }
  function revokeFamilyDevices(familyId: string) {
    const hashes = revokedDevices(familyId);
    db.prepare('DELETE FROM devices WHERE family_id=?').run(familyId);
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='software_device_links'").get()) db.prepare('DELETE FROM software_device_links WHERE family_id=?').run(familyId);
    return hashes;
  }
  async function register(input: { familyId: string; deviceHash: string; username: string; password: string; contactPhone: string;childName:string;pin:string; assertAuthorized: () => void }) {
    assertOpen(); input.assertAuthorized();
    const name = username(input.username), password = newPassword(input.password), profile=registrationProfile(input);
    const device = db.prepare('SELECT family_id FROM devices WHERE token_hash=?').get(input.deviceHash) as { family_id: string } | undefined;
    if (device?.family_id !== input.familyId) throw required();
    const salt = randomBytes(32), key = await derive(owner, password, salt, isOpen);
    try {
      assertOpen(); input.assertAuthorized();
      const currentDevice = db.prepare('SELECT family_id FROM devices WHERE token_hash=?').get(input.deviceHash) as { family_id: string } | undefined;
      if (currentDevice?.family_id !== input.familyId || !db.prepare('SELECT id FROM families WHERE id=?').get(input.familyId)) throw required();
      const id = randomUUID(), recoveryCode = randomBytes(32).toString('base64url'), created = now();
      db.exec('BEGIN IMMEDIATE');
      try {
        if (byName(name) || accountForFamily(input.familyId)) throw new ApiError(409, '暂时无法注册这个账号，请登录已有账号或换一个账号名', 'ACCOUNT_CONFLICT');
        db.prepare('INSERT INTO accounts VALUES(?,?,?,?,?,1,?,1,?)').run(id, input.familyId, name, salt.toString('hex'), key.toString('hex'), hash(recoveryCode), created);
        db.prepare('INSERT INTO account_contacts VALUES(?,?,1,?)').run(id,profile.contactPhone,created);
        db.prepare('INSERT INTO account_profiles VALUES(?,?,?,?,1,0)').run(id,profile.childName,profile.pinSalt,profile.pinHash);
        attach(id, input.deviceHash); db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return { account: publicAccount(byId(id)!), recoveryCode };
    } finally { key.fill(0); salt.fill(0); }
  }
  async function authenticate(input: { username: string; password: string; ip: string }): Promise<Account> {
    assertOpen(); const name = username(input.username), password = authenticationPassword(input.password);
    consumeAttempt(name, input.ip); const row = byName(name);
    const sequence=++loginSequence;if(row){if(loginAttempts.size>=MAX_ATTEMPT_BUCKETS&&!loginAttempts.has(row.id))throw busy();loginAttempts.set(row.id,sequence);}
    const salt = row && /^[a-f0-9]{64}$/.test(row.password_salt) ? Buffer.from(row.password_salt, 'hex') : dummySalt;
    let key:Buffer|undefined;
    try {
      key=await derive(owner, password, salt, isOpen);
      assertOpen(); const match = passwordMatches(key, row?.password_hash);
      if (!row || !match) throw invalidCredentials();
      if(loginAttempts.get(row.id)!==sequence)throw changed();
      const current = assertVersion(row); clearSuccessfulName(name); return publicAccount(current);
    } finally { key?.fill(0); if (salt !== dummySalt) salt.fill(0);if(row&&loginAttempts.get(row.id)===sequence)loginAttempts.delete(row.id); }
  }
  async function verifyExisting(input: { accountId: string; password: string; assertAuthorized: () => void; ip?: string }, guardRecovery = false): Promise<AccountRow> {
    assertOpen(); input.assertAuthorized(); const password = authenticationPassword(input.password), row = byId(input.accountId);
    consumeAttempt(row?.username ?? `missing:${hash(input.accountId)}`, input.ip);
    const salt = row && /^[a-f0-9]{64}$/.test(row.password_salt) ? Buffer.from(row.password_salt, 'hex') : dummySalt;
    const key = await derive(owner, password, salt, isOpen);
    try {
      assertOpen(); input.assertAuthorized();
      if (!row || !passwordMatches(key, row.password_hash)) throw invalidCredentials();
      const current = assertVersion(row, guardRecovery); clearSuccessfulName(row.username); return current;
    } finally { key.fill(0); if (salt !== dummySalt) salt.fill(0); }
  }
  async function verifyPassword(input: { accountId: string; password: string; assertAuthorized: () => void; ip?: string }): Promise<void> { await verifyExisting(input); }
  async function changePassword(input: { accountId: string; password: string; newPassword: string; assertAuthorized: () => void; ip?: string }) {
    assertOpen(); const password = newPassword(input.newPassword);
    const before = await verifyExisting(input, true); input.assertAuthorized();
    const salt = randomBytes(32), key = await derive(owner, password, salt, isOpen);
    try {
      assertOpen(); input.assertAuthorized(); assertVersion(before, true);
      const recoveryCode = randomBytes(32).toString('base64url'); let hashes: string[];
      db.exec('BEGIN IMMEDIATE');
      try {
        assertVersion(before, true);
        db.prepare('UPDATE accounts SET password_salt=?,password_hash=?,password_revision=password_revision+1,recovery_hash=?,recovery_revision=recovery_revision+1 WHERE id=?')
          .run(salt.toString('hex'), key.toString('hex'), hash(recoveryCode), before.id);
        hashes = revokeAccountDevices(before.id); db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return { recoveryCode, revokedDevices: hashes!, account: { ...publicAccount(before), passwordRevision: before.password_revision + 1 } };
    } finally { key.fill(0); salt.fill(0); }
  }
  async function rotateRecovery(input: { accountId: string; password: string; assertAuthorized: () => void; ip?: string }) {
    const before = await verifyExisting(input, true); assertOpen(); input.assertAuthorized(); assertVersion(before, true);
    const recoveryCode = randomBytes(32).toString('base64url');
    db.exec('BEGIN IMMEDIATE');
    try { assertVersion(before, true); db.prepare('UPDATE accounts SET recovery_hash=?,recovery_revision=recovery_revision+1 WHERE id=?').run(hash(recoveryCode), before.id); db.exec('COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); throw error; }
    return { recoveryCode };
  }
  async function recover(input: { username: string; recoveryCode: string; newPassword: string; ip: string }) {
    assertOpen(); const name = username(input.username), password = newPassword(input.newPassword);
    consumeAttempt(name, input.ip); const before = byName(name), matches = recoveryMatches(input.recoveryCode, before?.recovery_hash);
    // Unknown accounts and bad codes still do one bounded, equally costly KDF.
    const salt = randomBytes(32), key = await derive(owner, password, salt, isOpen);
    try {
      assertOpen(); if (!before || !matches) throw invalidCredentials();
      const current = byId(before.id);
      assertOperationalAccess(db, current?.id, current?.family_id);
      if (!current || current.access_revision !== before.access_revision || current.family_access_revision !== before.family_access_revision || current.password_revision !== before.password_revision || current.recovery_revision !== before.recovery_revision || current.recovery_hash !== before.recovery_hash) throw invalidCredentials();
      let hashes: string[];
      db.exec('BEGIN IMMEDIATE');
      try {
        const changedRows = db.prepare('UPDATE accounts SET password_salt=?,password_hash=?,password_revision=password_revision+1,recovery_hash=NULL,recovery_revision=recovery_revision+1 WHERE id=? AND password_revision=? AND recovery_revision=? AND recovery_hash=?')
          .run(salt.toString('hex'), key.toString('hex'), before.id, before.password_revision, before.recovery_revision, before.recovery_hash);
        if (Number(changedRows.changes) !== 1) throw invalidCredentials();
        hashes = revokeAccountDevices(before.id); clearSuccessfulName(name); db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return { ok: true as const, familyId: before.family_id??'', revokedDevices: hashes! };
    } finally { key.fill(0); salt.fill(0); }
  }
  function sweep(): RevokedAccountDevice[] {
    assertOpen(); const at = now();
    const expired = db.prepare(`SELECT d.family_id,s.device_hash FROM account_sessions s JOIN devices d ON d.token_hash=s.device_hash
      LEFT JOIN accounts a ON a.id=s.account_id WHERE s.expires_at<=? OR a.id IS NULL OR s.password_revision!=a.password_revision`).all(at) as { family_id: string; device_hash: string }[];
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of expired) db.prepare('DELETE FROM devices WHERE token_hash=? AND family_id=?').run(row.device_hash, row.family_id);
      db.prepare('DELETE FROM account_attempts WHERE until<=?').run(at); db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return expired.map(row => ({ familyId: row.family_id, deviceHash: row.device_hash }));
  }
  function accountForDevice(deviceHash:string){const session=db.prepare('SELECT account_id FROM account_sessions WHERE device_hash=?').get(deviceHash) as {account_id:string}|undefined;const row=session?byId(session.account_id):undefined;return row?publicAccount(row):undefined;}
  function revokeAccountDevices(accountId:string){const account=byId(accountId);if(account?.family_id&&!db.prepare('SELECT 1 FROM guardian_members WHERE account_id=?').get(accountId)){db.prepare('DELETE FROM account_identity_sessions WHERE account_id IN (SELECT id FROM accounts WHERE family_id=?)').run(account.family_id);return revokeFamilyDevices(account.family_id);}const hashes=(db.prepare('SELECT device_hash FROM account_sessions WHERE account_id=?').all(accountId) as {device_hash:string}[]).map(r=>r.device_hash);for(const token of hashes)db.prepare('DELETE FROM devices WHERE token_hash=?').run(token);db.prepare('DELETE FROM account_identity_sessions WHERE account_id=?').run(accountId);return hashes;}
  function identity(token:string){assertOpen();const session=db.prepare('SELECT * FROM account_identity_sessions WHERE token_hash=?').get(hash(token)) as {account_id:string;password_revision:number;expires_at:number}|undefined;const row=session?byId(session.account_id):undefined;if(!row||!session||session.expires_at<=now()||session.password_revision!==row.password_revision)throw required();assertOperationalAccess(db,row.id,row.family_id);return publicAccount(row);}
  function issueIdentity(account:Account){assertAccount(account);const token=randomBytes(32).toString('base64url');const own=!db.isTransaction;if(own)db.exec('BEGIN IMMEDIATE');try{const revokedDevices=replaceSession(account);db.prepare('DELETE FROM account_identity_sessions WHERE expires_at<=?').run(now());db.prepare('INSERT INTO account_identity_sessions VALUES(?,?,?,?)').run(hash(token),account.id,account.passwordRevision,now()+SESSION_MS);if(own)db.exec('COMMIT');return{token,revokedDevices};}catch(error){if(own)db.exec('ROLLBACK');throw error;}}
  function removeIdentity(token:string){db.prepare('DELETE FROM account_identity_sessions WHERE token_hash=?').run(hash(token));}
  async function registerIndependent(input:{username:string;password:string;contactPhone:string;childName:string;pin:string;ip:string}){
    assertOpen();const name=username(input.username),password=newPassword(input.password),profile=registrationProfile(input);consumeAttempt(name,input.ip);const salt=randomBytes(32),key=await derive(owner,password,salt,isOpen);
    try{assertOpen();const id=randomUUID(),recoveryCode=randomBytes(32).toString('base64url');
      db.exec('BEGIN IMMEDIATE');try{
        if(byName(name))throw new ApiError(409,'账号名已使用，请登录或换一个账号名','ACCOUNT_CONFLICT');
        db.prepare('INSERT INTO accounts VALUES(?,NULL,?,?,?,1,?,1,?)').run(id,name,salt.toString('hex'),key.toString('hex'),hash(recoveryCode),now());
        db.prepare('INSERT INTO account_contacts VALUES(?,?,1,?)').run(id,profile.contactPhone,now());
        db.prepare('INSERT INTO account_profiles VALUES(?,?,?,?,1,0)').run(id,profile.childName,profile.pinSalt,profile.pinHash);
        clearSuccessfulName(name);db.exec('COMMIT');
      }catch(error){db.exec('ROLLBACK');throw error;}
      return {account:publicAccount(byId(id)!),recoveryCode};
    }finally{key.fill(0);salt.fill(0);}
  }
  function profile(account:Account){assertAccount(account);const row=db.prepare('SELECT * FROM account_profiles WHERE account_id=?').get(account.id) as ProfileRow|undefined;return{childName:row?.child_name??'',hasPin:Boolean(row?.pin_salt&&row.pin_hash)};}
  function pinCredentials(account:Account){assertAccount(account);const row=db.prepare('SELECT * FROM account_profiles WHERE account_id=?').get(account.id) as ProfileRow|undefined;return row?.pin_salt&&row.pin_hash?{salt:row.pin_salt,hash:row.pin_hash}:undefined;}
  function verifyPin(account:Account,pin:string){const credentials=pinCredentials(account);if(!credentials)return false;const key=scryptSync(pin,credentials.salt,64);try{return timingSafeEqual(key,Buffer.from(credentials.hash,'hex'));}finally{key.fill(0);}}
  function updatePin(account:Account,pin:string){assertAccount(account);if(!/^\d{6}$/.test(pin))throw new ApiError(400,'请设置6位数字账号PIN','ACCOUNT_PIN_INVALID');const salt=randomBytes(16).toString('hex'),key=scryptSync(pin,salt,64);try{db.prepare("INSERT INTO account_profiles(account_id,child_name,pin_salt,pin_hash,pin_revision) VALUES(?,'',?,?,1) ON CONFLICT(account_id) DO UPDATE SET pin_salt=excluded.pin_salt,pin_hash=excluded.pin_hash,pin_revision=pin_revision+1").run(account.id,salt,key.toString('hex'));}finally{key.fill(0);}}
  function updateChildName(account:Account,childName:string){assertAccount(account);if(!childName.trim()||Array.from(childName.trim()).length>20||/[\u0000-\u001f\u007f]/u.test(childName))throw new ApiError(400,'请填写1–20字的小朋友姓名或称呼','ACCOUNT_CHILD_NAME_INVALID');db.prepare("INSERT INTO account_profiles(account_id,child_name) VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET child_name=excluded.child_name").run(account.id,childName.trim());}
  function contact(account:Account){
    assertAccount(account);const row=db.prepare('SELECT phone,revision FROM account_contacts WHERE account_id=?').get(account.id) as {phone:string;revision:number}|undefined;
    return{contactPhone:row?.phone??'',revision:row?.revision??0,verified:false as const};
  }
  function updateContact(account:Account,input:{contactPhone:unknown;revision:number}){
    assertAccount(account);const phone=normalizeContactPhone(input.contactPhone);
    if(!Number.isSafeInteger(input.revision)||input.revision<0)throw new ApiError(400,'请刷新联系方式后重试','ACCOUNT_CONTACT_INVALID');
    db.exec('BEGIN IMMEDIATE');try{
      assertAccount(account);const current=contact(account);
      if(current.revision!==input.revision)throw new ApiError(409,'联系方式已在其他页面更新，请刷新后再修改','ACCOUNT_CONTACT_CHANGED');
      db.prepare('INSERT INTO account_contacts VALUES(?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET phone=excluded.phone,revision=excluded.revision,updated_at=excluded.updated_at').run(account.id,phone,current.revision+1,now());
      db.exec('COMMIT');return{contactPhone:phone,revision:current.revision+1,verified:false as const};
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  function bindFamily(account:Account,familyId:string,guardian=false){assertAccount(account);assertOperationalAccess(db,account.id,familyId);if(account.familyId)throw new ApiError(409,'账号已有家庭，不能覆盖或合并','ACCOUNT_FAMILY_CONFLICT');if(Number(db.prepare('UPDATE accounts SET family_id=? WHERE id=? AND family_id IS NULL').run(familyId,account.id).changes)!==1)throw changed();if(guardian)db.prepare('INSERT INTO guardian_members VALUES(?,?)').run(account.id,familyId);return publicAccount(byId(account.id)!);}
  function isGuardian(account:Account){assertAccount(account);return Boolean(db.prepare('SELECT 1 FROM guardian_members WHERE account_id=? AND family_id=?').get(account.id,account.familyId));}
  function close() {
    if (closed) return; closed = true;loginAttempts.clear();
    for (let i = kdfQueue.length - 1; i >= 0; i--) if (kdfQueue[i].owner === owner) { const [job] = kdfQueue.splice(i, 1); job.reject(stopped()); }
  }
  return { profile,pinCredentials,verifyPin,updatePin,updateChildName,contact,updateContact,identity,issueIdentity,removeIdentity,registerIndependent,bindFamily,isGuardian,accountForDevice, summary, assertDevice, assertAccount, accountForFamily, register, authenticate, attach,
    verifyPassword, changePassword, recover, rotateRecovery, sweep, close };
}

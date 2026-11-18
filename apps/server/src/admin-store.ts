import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ApiError } from './provider-errors.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const iso = (value: number) => new Date(value).toISOString();
const error = (status: number, message: string, code: string) => new ApiError(status, message, code);
const required = () => error(401, '请登录运营管理员账号', 'ADMIN_REQUIRED');
const stale = () => error(409, '资料已变化，请刷新后重新确认', 'ADMIN_REVISION_CHANGED');
const invalid = () => error(401, '账号或凭据无效，请检查后重试', 'ADMIN_AUTH_FAILED');
const TOKEN_MS = 20 * 60_000;
const SESSION_MS = 2 * 60 * 60_000;
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const dummySalt = randomBytes(32), dummyKey = randomBytes(64);
let running = 0;
function derive(password: string, salt: Buffer): Promise<Buffer> {
  // A process-wide cap also bounds simultaneous login and assisted recovery work.
  if (running >= 2) return Promise.reject(error(429, '账号服务正忙，请稍后再试', 'ADMIN_BUSY'));
  running++;
  return new Promise((resolve, reject) => {
    try { scrypt(password, salt, 64, SCRYPT, (err, key) => { running--; if (err) reject(error(503, '账号校验暂时不可用', 'ADMIN_BUSY')); else resolve(key); }); }
    catch { running--; reject(error(503, '账号校验暂时不可用', 'ADMIN_BUSY')); }
  });
}
const username = (input: unknown) => {
  if (typeof input !== 'string' || !/^[A-Za-z0-9_.-]{3,32}$/.test(input.trim())) throw error(400, '账号名须为3–32个英文字母、数字、点、下划线或短横线', 'ADMIN_USERNAME_INVALID');
  return input.trim().toLowerCase();
};
function password(input: unknown, isNew = false) {
  if (typeof input !== 'string' || Array.from(input).length > 128 || (isNew && Array.from(input).length < 8) || /[\u0000-\u001f\u007f]/.test(input)) throw error(400, '密码至少8位，最多128个字符', 'ADMIN_PASSWORD_INVALID');
  return input;
}
function tokenHash(input: unknown) { if (typeof input !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input)) throw invalid(); return hash(input); }
function safeReason(input: unknown) { if (typeof input !== 'string' || input.trim().length < 2 || input.length > 200 || /[\u0000-\u001f\u007f]/.test(input)) throw error(400, '请填写2–200字的操作原因，不要包含密码或孩子隐私', 'ADMIN_REASON_REQUIRED'); return input.trim(); }
export type AdminActor = { id: string; username: string; revision: number; sessionHash: string; expiresAt: string };
type AdminRow = { id: string; username: string; password_salt: string; password_hash: string; revision: number; created_at: number };
export type AdminAccessChange = { familyId: string; accountId?: string; deviceHashes: string[]; reason: string };
/** New side tables only. Kept available to AccountStore so its gates work before router mounting. */
export function initializeOperationalTables(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS admin_account_states(account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,status TEXT NOT NULL,revision INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS admin_family_states(family_id TEXT PRIMARY KEY REFERENCES families(id) ON DELETE CASCADE,status TEXT NOT NULL,revision INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS account_contacts(account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,phone TEXT NOT NULL,revision INTEGER NOT NULL,updated_at INTEGER NOT NULL);`);
}
export function assertOperationalAccess(db: DatabaseSync, accountId?: string | null, familyId?: string | null) {
  if (accountId && db.prepare("SELECT 1 FROM admin_account_states WHERE account_id=? AND status='disabled'").get(accountId)) throw error(403, '此账号已停用，请联系运营人员协助', 'ACCOUNT_DISABLED');
  if (familyId && db.prepare("SELECT 1 FROM admin_family_states WHERE family_id=? AND status='paused'").get(familyId)) throw error(403, '此家庭已暂停使用，请联系运营人员协助', 'FAMILY_PAUSED');
}
export function createAdminStore({ db, now = Date.now, onAccessChanged = () => {} }: { db: DatabaseSync; now?: () => number; onAccessChanged?: (change: AdminAccessChange) => void }) {
  initializeOperationalTables(db);
  db.exec(`CREATE TABLE IF NOT EXISTS admin_operators(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,password_salt TEXT NOT NULL,password_hash TEXT NOT NULL,revision INTEGER NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS admin_sessions(token_hash TEXT PRIMARY KEY,admin_id TEXT NOT NULL REFERENCES admin_operators(id) ON DELETE CASCADE,revision INTEGER NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS admin_bootstrap(token_hash TEXT PRIMARY KEY,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS admin_attempts(bucket TEXT PRIMARY KEY,count INTEGER NOT NULL,until INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS admin_recovery_tickets(token_hash TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,password_revision INTEGER NOT NULL,state_revision INTEGER NOT NULL,expires_at INTEGER NOT NULL,created_by TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS admin_audit(id TEXT PRIMARY KEY,at INTEGER NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,target_type TEXT NOT NULL,target_id TEXT NOT NULL,reason TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS admin_audit_time ON admin_audit(at);`);
  let closed = false;
  const open = () => { if (closed) throw error(503, '运营服务暂不可用', 'ADMIN_CLOSED'); };
  const initialized = () => Boolean(db.prepare('SELECT 1 FROM admin_operators LIMIT 1').get());
  function audit(actor: string, action: string, targetType: string, targetId: string, reason: string) { db.prepare('INSERT INTO admin_audit VALUES(?,?,?,?,?,?,?)').run(randomUUID(), now(), actor, action, targetType, targetId, reason); }
  function transaction<T>(task: () => T): T { db.exec('BEGIN IMMEDIATE'); try { const result = task(); db.exec('COMMIT'); return result; } catch (err) { db.exec('ROLLBACK'); throw err; } }
  function throttle(kind: string, ip: string, name = '') {
    open(); const at = now();
    const buckets = [{ key: hash(`${kind}:ip:${ip.slice(0,200)}`), max: 12 }, { key: hash(`${kind}:global`), max: 100 }, ...(name ? [{ key: hash(`${kind}:name:${name}`), max: 6 }] : [])];
    transaction(() => {
      db.prepare('DELETE FROM admin_attempts WHERE until<=?').run(at);
      const rows = buckets.map(b => ({ ...b, count: Number((db.prepare('SELECT count FROM admin_attempts WHERE bucket=?').get(b.key) as {count:number}|undefined)?.count ?? 0) }));
      if (rows.some(r => r.count >= r.max) || Number((db.prepare('SELECT count(*) n FROM admin_attempts').get() as {n:number}).n) > 10000) throw error(429, '尝试过于频繁，请15分钟后再试', 'ADMIN_THROTTLED');
      for (const row of rows) db.prepare('INSERT INTO admin_attempts VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1').run(row.key, at + 15 * 60_000);
    });
  }
  function authorize(token: unknown): AdminActor {
    open(); if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw required();
    const row = db.prepare('SELECT a.id,a.username,a.revision,s.expires_at FROM admin_sessions s JOIN admin_operators a ON a.id=s.admin_id AND a.revision=s.revision WHERE s.token_hash=?').get(hash(token)) as {id:string;username:string;revision:number;expires_at:number}|undefined;
    if (!row || row.expires_at <= now()) throw required(); return { id:row.id, username:row.username, revision:row.revision, sessionHash:hash(token), expiresAt:iso(row.expires_at) };
  }
  function assertActor(actor: AdminActor) {
    open(); const row = db.prepare('SELECT 1 FROM admin_sessions s JOIN admin_operators a ON a.id=s.admin_id AND a.revision=s.revision WHERE s.token_hash=? AND a.id=? AND a.revision=? AND s.expires_at>?').get(actor.sessionHash,actor.id,actor.revision,now()); if (!row) throw required();
  }
  function issueSession(row: AdminRow) {
    db.prepare('DELETE FROM admin_sessions WHERE expires_at<=?').run(now());
    const tokens=db.prepare('SELECT token_hash FROM admin_sessions WHERE admin_id=? ORDER BY expires_at').all(row.id) as {token_hash:string}[];
    for (const old of tokens.slice(0,Math.max(0,tokens.length-3))) db.prepare('DELETE FROM admin_sessions WHERE token_hash=?').run(old.token_hash);
    const token=randomBytes(32).toString('base64url'), expiresAt=now()+SESSION_MS; db.prepare('INSERT INTO admin_sessions VALUES(?,?,?,?)').run(hash(token),row.id,row.revision,expiresAt);
    return {token,expiresAt:iso(expiresAt)};
  }
  function status(token?: unknown) {
    open(); let actor:AdminActor|undefined; if (typeof token==='string') { try {actor=authorize(token);} catch(error) { if (!(error instanceof ApiError && error.status===401)) throw error; } }
    return {initialized:initialized(),authenticated:Boolean(actor),...(actor?{admin:{id:actor.id,username:actor.username},expiresAt:actor.expiresAt}:{})};
  }
  function createBootstrap() {
    open(); if (initialized()) throw error(409,'管理员已建立，不能重复初始化','ADMIN_INITIALIZED');
    const token=randomBytes(32).toString('base64url'), expiresAt=now()+TOKEN_MS;
    transaction(()=>{if(initialized())throw error(409,'管理员已建立','ADMIN_INITIALIZED');db.prepare('DELETE FROM admin_bootstrap').run();db.prepare('INSERT INTO admin_bootstrap VALUES(?,?)').run(hash(token),expiresAt);audit('server-cli','bootstrap-issued','system','admin','服务器生成一次性初始化凭据');});
    return {token,expiresAt:iso(expiresAt)};
  }
  async function bootstrap(input:{token:string;username:string;password:string;ip:string}) {
    open(); throttle('bootstrap',input.ip); const name=username(input.username), pass=password(input.password,true), ticket=tokenHash(input.token);
    if(initialized()||!db.prepare('SELECT 1 FROM admin_bootstrap WHERE token_hash=? AND expires_at>?').get(ticket,now())) throw invalid();
    const salt=randomBytes(32),key=await derive(pass,salt);
    try { open();return transaction(()=>{if(initialized()||!db.prepare('SELECT 1 FROM admin_bootstrap WHERE token_hash=? AND expires_at>?').get(ticket,now()))throw invalid();const id=randomUUID();db.prepare('INSERT INTO admin_operators VALUES(?,?,?,?,1,?)').run(id,name,salt.toString('hex'),key.toString('hex'),now());db.prepare('DELETE FROM admin_bootstrap').run();audit(name,'administrator-created','admin',id,'首次初始化');const row=db.prepare('SELECT * FROM admin_operators WHERE id=?').get(id) as AdminRow;return issueSession(row);}); } finally {key.fill(0);salt.fill(0);}
  }
  async function login(input:{username:string;password:string;ip:string}) {
    open(); const name=username(input.username),pass=password(input.password);throttle('login',input.ip,name);
    const row=db.prepare('SELECT * FROM admin_operators WHERE username=?').get(name) as AdminRow|undefined;
    const salt=row?Buffer.from(row.password_salt,'hex'):dummySalt,key=await derive(pass,salt);
    try {open();if(!row||!timingSafeEqual(key,row?Buffer.from(row.password_hash,'hex'):dummyKey))throw invalid();const current=db.prepare('SELECT * FROM admin_operators WHERE id=? AND revision=? AND password_hash=?').get(row.id,row.revision,row.password_hash) as AdminRow|undefined;if(!current)throw invalid();return transaction(()=>{audit(row.username,'login','admin',row.id,'管理员登录');return issueSession(current);});} finally {key.fill(0);if(salt!==dummySalt)salt.fill(0);}
  }
  function logout(actor:AdminActor) { assertActor(actor);transaction(()=>{db.prepare('DELETE FROM admin_sessions WHERE token_hash=?').run(actor.sessionHash);audit(actor.username,'logout','admin',actor.id,'退出登录');}); }
  async function changePassword(actor:AdminActor,input:{password:string;newPassword:string;ip:string}) {
    assertActor(actor);throttle('password',input.ip,actor.id);const pass=password(input.password),next=password(input.newPassword,true),row=db.prepare('SELECT * FROM admin_operators WHERE id=?').get(actor.id) as AdminRow;
    const old=await derive(pass,Buffer.from(row.password_salt,'hex'));const match=timingSafeEqual(old,Buffer.from(row.password_hash,'hex'));old.fill(0);if(!match)throw invalid();assertActor(actor);
    const salt=randomBytes(32),key=await derive(next,salt);
    try {assertActor(actor);transaction(()=>{assertActor(actor);if(Number(db.prepare('UPDATE admin_operators SET password_salt=?,password_hash=?,revision=revision+1 WHERE id=? AND revision=?').run(salt.toString('hex'),key.toString('hex'),actor.id,actor.revision).changes)!==1)throw stale();db.prepare('DELETE FROM admin_sessions WHERE admin_id=?').run(actor.id);audit(actor.username,'password-changed','admin',actor.id,'修改密码并撤销全部管理员会话');});}finally{key.fill(0);salt.fill(0);}
  }
  function paging(input:{offset?:unknown;limit?:unknown;q?:unknown;status?:unknown}) {
    const offset=Number(input.offset??0),limit=Number(input.limit??20),q=typeof input.q==='string'?input.q.trim():'';
    if(!Number.isInteger(offset)||offset<0||offset>100000||!Number.isInteger(limit)||limit<1||limit>50||q.length>64)throw error(400,'请检查搜索或分页条件','INVALID_INPUT');
    return {offset,limit,q,query:`%${q.replace(/[\\%_]/g,'\\$&')}%`,status:typeof input.status==='string'?input.status:''};
  }
  function accountState(id:string){return (db.prepare('SELECT status,revision FROM admin_account_states WHERE account_id=?').get(id) as {status:string;revision:number}|undefined)??{status:'active',revision:0};}
  function familyState(id:string){return (db.prepare('SELECT status,revision FROM admin_family_states WHERE family_id=?').get(id) as {status:string;revision:number}|undefined)??{status:'active',revision:0};}
  const hasFamilyProfile=(db.prepare('PRAGMA table_info(families)').all() as {name:string}[]).some(row=>row.name==='child_json');
  const hasSavedProfiles=Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='software_profiles'").get());
  const currentNicknameSql=hasFamilyProfile?"CASE WHEN json_valid(f.child_json) THEN CASE WHEN json_type(f.child_json,'$.nickname')='text' THEN json_extract(f.child_json,'$.nickname') ELSE '' END ELSE '' END":"''";
  const currentChildIdSql=hasFamilyProfile?"CASE WHEN json_valid(f.child_json) THEN coalesce(json_extract(f.child_json,'$.id'),'') ELSE '' END":"''";
  const savedNicknameSql="CASE WHEN json_valid(p.profile_json) THEN CASE WHEN json_type(p.profile_json,'$.nickname')='text' THEN json_extract(p.profile_json,'$.nickname') ELSE '' END ELSE '' END";
  function familyNames(familyId:string){
    const row=hasFamilyProfile?db.prepare('SELECT child_json FROM families WHERE id=?').get(familyId) as {child_json:string}|undefined:undefined;
    const profile=(value:string):{id:string;nickname:string}=>{try{const parsed=JSON.parse(value);return {id:typeof parsed?.id==='string'?parsed.id:'',nickname:typeof parsed?.nickname==='string'?parsed.nickname.trim().slice(0,16):''};}catch{return{id:'',nickname:''};}};
    const current=profile(row?.child_json??'{}'),byId=new Map<string,string>();
    if(current.nickname)byId.set(current.id||'current',current.nickname);
    if(hasSavedProfiles){for(const saved of db.prepare('SELECT child_id,profile_json FROM software_profiles WHERE family_id=? ORDER BY child_id').all(familyId) as {child_id:string;profile_json:string}[]){if(saved.child_id===current.id)continue;const child=profile(saved.profile_json);if(child.nickname)byId.set(saved.child_id,child.nickname);}}
    return {displayName:current.nickname?`${current.nickname}的家庭`:'未填写昵称的家庭',childNames:[...new Set(byId.values())]};
  }
  function accounts(actor:AdminActor,input:{offset?:unknown;limit?:unknown;q?:unknown;status?:unknown}={}) {
    assertActor(actor);const p=paging(input);if(!['','active','disabled'].includes(p.status))throw error(400,'账号状态无效','INVALID_INPUT');
    const where="WHERE (a.username LIKE ? ESCAPE '\\' OR a.id LIKE ? ESCAPE '\\' OR coalesce(c.phone,'') LIKE ? ESCAPE '\\') AND (?='' OR coalesce(s.status,'active')=?)";
    const args=[p.query,p.query,p.query,p.status,p.status];const joins='FROM accounts a LEFT JOIN admin_account_states s ON s.account_id=a.id LEFT JOIN account_contacts c ON c.account_id=a.id';
    const rows=db.prepare(`SELECT a.id,a.username,a.family_id,a.created_at,coalesce(c.phone,'') contact_phone,coalesce(s.status,'active') status,coalesce(s.revision,0) revision,EXISTS(SELECT 1 FROM guardian_members g WHERE g.account_id=a.id) guardian,(SELECT count(*) FROM account_sessions x JOIN devices d ON d.token_hash=x.device_hash WHERE x.account_id=a.id) device_count ${joins} ${where} ORDER BY a.created_at DESC,a.id LIMIT ? OFFSET ?`).all(...args,p.limit,p.offset) as {id:string;username:string;family_id:string|null;created_at:number;contact_phone:string;status:string;revision:number;guardian:number;device_count:number}[];
    return {items:rows.map(r=>{const family=r.family_id?familyNames(r.family_id):undefined;return{id:r.id,username:r.username,familyId:r.family_id??'',createdAt:iso(r.created_at),status:r.status,revision:r.revision,guardian:Boolean(r.guardian),deviceCount:r.device_count,contactPhone:r.contact_phone,familyName:family?.displayName??'',childNames:family?.childNames??[]};}),total:Number((db.prepare(`SELECT count(*) n ${joins} ${where}`).get(...args) as {n:number}).n),offset:p.offset,limit:p.limit};
  }
  function families(actor:AdminActor,input:{offset?:unknown;limit?:unknown;q?:unknown;status?:unknown}={}) {
    assertActor(actor);const p=paging(input);if(!['','active','paused'].includes(p.status))throw error(400,'家庭状态无效','INVALID_INPUT');
    const savedNames=hasSavedProfiles?` OR EXISTS(SELECT 1 FROM software_profiles p WHERE p.family_id=f.id AND p.child_id!=(${currentChildIdSql}) AND (${savedNicknameSql}) LIKE ? ESCAPE '\\')`:'';
    const where=`WHERE (f.id LIKE ? ESCAPE '\\' OR (${currentNicknameSql}) LIKE ? ESCAPE '\\'${savedNames} OR EXISTS(SELECT 1 FROM accounts a LEFT JOIN account_contacts c ON c.account_id=a.id WHERE a.family_id=f.id AND (a.username LIKE ? ESCAPE '\\' OR coalesce(c.phone,'') LIKE ? ESCAPE '\\'))) AND (?='' OR coalesce(s.status,'active')=?)`;
    const args=[p.query,p.query,...(hasSavedProfiles?[p.query]:[]),p.query,p.query,p.status,p.status];
    const rows=db.prepare(`SELECT f.id,coalesce(s.status,'active') status,coalesce(s.revision,0) revision,(SELECT count(*) FROM accounts a WHERE a.family_id=f.id) account_count,(SELECT count(*) FROM members m WHERE m.family_id=f.id) member_count,(SELECT count(*) FROM devices d WHERE d.family_id=f.id) device_count FROM families f LEFT JOIN admin_family_states s ON s.family_id=f.id ${where} ORDER BY f.id LIMIT ? OFFSET ?`).all(...args,p.limit,p.offset) as {id:string;status:string;revision:number;account_count:number;member_count:number;device_count:number}[];
    return {items:rows.map(r=>({id:r.id,status:r.status,revision:r.revision,accountCount:r.account_count,memberCount:r.member_count,deviceCount:r.device_count,...familyNames(r.id),contacts:(db.prepare(`SELECT a.id account_id,a.username,EXISTS(SELECT 1 FROM guardian_members g WHERE g.account_id=a.id) guardian,coalesce(c.phone,'') phone FROM accounts a LEFT JOIN account_contacts c ON c.account_id=a.id WHERE a.family_id=? ORDER BY guardian,a.created_at,a.id`).all(r.id) as {account_id:string;username:string;guardian:number;phone:string}[]).map(c=>({accountId:c.account_id,username:c.username,guardian:Boolean(c.guardian),contactPhone:c.phone}))})),total:Number((db.prepare(`SELECT count(*) n FROM families f LEFT JOIN admin_family_states s ON s.family_id=f.id ${where}`).get(...args) as {n:number}).n),offset:p.offset,limit:p.limit};
  }
  function confirm(input:{revision:number;reason:string;confirm:boolean}){if(input.confirm!==true||!Number.isInteger(input.revision)||input.revision<0)throw error(400,'请确认操作并刷新资料版本','ADMIN_CONFIRM_REQUIRED');return safeReason(input.reason);}
  function setAccountStatus(actor:AdminActor,id:string,input:{revision:number;status:'active'|'disabled';reason:string;confirm:boolean}) {
    assertActor(actor);const reason=confirm(input);if(!['active','disabled'].includes(input.status))throw error(400,'账号状态无效','INVALID_INPUT');let familyId='',deviceHashes:string[]=[];
    const result=transaction(()=>{assertActor(actor);const row=db.prepare('SELECT family_id FROM accounts WHERE id=?').get(id) as {family_id:string|null}|undefined;if(!row)throw error(404,'账号不存在','ADMIN_NOT_FOUND');familyId=row.family_id??'';const current=accountState(id);if(current.revision!==input.revision)throw stale();if(current.status===input.status)throw error(409,'账号已处于这个状态','ADMIN_NO_CHANGE');deviceHashes=(db.prepare('SELECT device_hash FROM account_sessions WHERE account_id=?').all(id) as {device_hash:string}[]).map(r=>r.device_hash);db.prepare('INSERT INTO admin_account_states VALUES(?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET status=excluded.status,revision=excluded.revision,updated_at=excluded.updated_at').run(id,input.status,current.revision+1,now());db.prepare('DELETE FROM admin_recovery_tickets WHERE account_id=?').run(id);if(input.status==='disabled'){for(const deviceHash of deviceHashes)db.prepare('DELETE FROM devices WHERE token_hash=?').run(deviceHash);db.prepare('DELETE FROM account_identity_sessions WHERE account_id=?').run(id);}audit(actor.username,input.status==='disabled'?'account-disabled':'account-restored','account',id,reason);return{ok:true,revision:current.revision+1,status:input.status};});
    // Preserve the account and family data; restoring an account requires a fresh login.
    onAccessChanged({familyId,accountId:id,deviceHashes,reason:'admin-account-status'});return result;
  }
  function setFamilyStatus(actor:AdminActor,id:string,input:{revision:number;status:'active'|'paused';reason:string;confirm:boolean}) {
    assertActor(actor);const reason=confirm(input);if(!['active','paused'].includes(input.status))throw error(400,'家庭状态无效','INVALID_INPUT');let deviceHashes:string[]=[];
    const result=transaction(()=>{assertActor(actor);if(!db.prepare('SELECT id FROM families WHERE id=?').get(id))throw error(404,'家庭不存在','ADMIN_NOT_FOUND');const current=familyState(id);if(current.revision!==input.revision)throw stale();if(current.status===input.status)throw error(409,'家庭已处于这个状态','ADMIN_NO_CHANGE');deviceHashes=(db.prepare('SELECT token_hash FROM devices WHERE family_id=?').all(id) as {token_hash:string}[]).map(r=>r.token_hash);db.prepare('INSERT INTO admin_family_states VALUES(?,?,?,?) ON CONFLICT(family_id) DO UPDATE SET status=excluded.status,revision=excluded.revision,updated_at=excluded.updated_at').run(id,input.status,current.revision+1,now());if(input.status==='paused'){db.prepare('DELETE FROM admin_recovery_tickets WHERE account_id IN (SELECT id FROM accounts WHERE family_id=?)').run(id);db.prepare('DELETE FROM devices WHERE family_id=? AND token_hash IN (SELECT device_hash FROM account_sessions)').run(id);db.prepare('DELETE FROM account_identity_sessions WHERE account_id IN (SELECT id FROM accounts WHERE family_id=?)').run(id);}audit(actor.username,input.status==='paused'?'family-paused':'family-restored','family',id,reason);return{ok:true,status:input.status,revision:current.revision+1};});onAccessChanged({familyId:id,deviceHashes,reason:'admin-family-status'});return result;
  }
  function issueRecovery(actor:AdminActor,id:string,input:{revision:number;reason:string;confirm:boolean}) {
    assertActor(actor);const reason=confirm(input);const token=randomBytes(32).toString('base64url'),expiresAt=now()+TOKEN_MS;
    transaction(()=>{assertActor(actor);const row=db.prepare('SELECT password_revision,family_id FROM accounts WHERE id=?').get(id) as {password_revision:number;family_id:string|null}|undefined;if(!row)throw error(404,'账号不存在','ADMIN_NOT_FOUND');const state=accountState(id);if(state.revision!==input.revision)throw stale();assertOperationalAccess(db,id,row.family_id);db.prepare('DELETE FROM admin_recovery_tickets WHERE account_id=? OR expires_at<=?').run(id,now());db.prepare('INSERT INTO admin_account_states VALUES(?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at').run(id,state.status,state.revision+1,now());db.prepare('INSERT INTO admin_recovery_tickets VALUES(?,?,?,?,?,?)').run(hash(token),id,row.password_revision,state.revision+1,expiresAt,actor.username);audit(actor.username,'recovery-issued','account',id,reason);});return{token,expiresAt:iso(expiresAt),accountId:id,revision:input.revision+1};
  }
  async function recover(input:{token:string;newPassword:string;ip:string}) {
    open();throttle('recover',input.ip);const ticket=tokenHash(input.token),pass=password(input.newPassword,true);
    type Ticket={account_id:string;password_revision:number;state_revision:number;expires_at:number;created_by:string};
    const before=db.prepare('SELECT * FROM admin_recovery_tickets WHERE token_hash=? AND expires_at>?').get(ticket,now()) as Ticket|undefined;if(!before)throw invalid();
    const salt=randomBytes(32),key=await derive(pass,salt);let familyId='',deviceHashes:string[]=[];
    try{open();transaction(()=>{const current=db.prepare('SELECT * FROM admin_recovery_tickets WHERE token_hash=? AND expires_at>?').get(ticket,now()) as Ticket|undefined;const account=db.prepare('SELECT family_id,password_revision FROM accounts WHERE id=?').get(before.account_id) as {family_id:string|null;password_revision:number}|undefined;if(!current||!account||current.account_id!==before.account_id||account.password_revision!==before.password_revision||accountState(before.account_id).revision!==before.state_revision)throw invalid();assertOperationalAccess(db,before.account_id,account.family_id);familyId=account.family_id??'';
      // Owners previously had visitor devices too: revoke the whole family's devices, matching normal password recovery.
      const owner=familyId&&!db.prepare('SELECT 1 FROM guardian_members WHERE account_id=?').get(before.account_id);
      deviceHashes=(owner?db.prepare('SELECT token_hash device_hash FROM devices WHERE family_id=?').all(familyId):db.prepare('SELECT device_hash FROM account_sessions WHERE account_id=?').all(before.account_id) as {device_hash:string}[]).map(r=>String(r.device_hash));
      db.prepare('UPDATE accounts SET password_salt=?,password_hash=?,password_revision=password_revision+1,recovery_hash=NULL,recovery_revision=recovery_revision+1 WHERE id=?').run(salt.toString('hex'),key.toString('hex'),before.account_id);
      for(const deviceHash of deviceHashes)db.prepare('DELETE FROM devices WHERE token_hash=?').run(deviceHash);
      if(owner){db.prepare('DELETE FROM account_identity_sessions WHERE account_id IN (SELECT id FROM accounts WHERE family_id=?)').run(familyId);if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='software_device_links'").get())db.prepare('DELETE FROM software_device_links WHERE family_id=?').run(familyId);}else db.prepare('DELETE FROM account_identity_sessions WHERE account_id=?').run(before.account_id);
      db.prepare('DELETE FROM admin_recovery_tickets WHERE account_id=?').run(before.account_id);db.prepare('UPDATE admin_account_states SET revision=revision+1,updated_at=? WHERE account_id=?').run(now(),before.account_id);audit(before.created_by,'recovery-completed','account',before.account_id,'持一次性恢复链接完成密码重设，旧登录失效');});onAccessChanged({familyId,accountId:before.account_id,deviceHashes,reason:'admin-account-recovery'});return{ok:true};}finally{key.fill(0);salt.fill(0);}
  }
  function overview(actor:AdminActor){assertActor(actor);const count=(sql:string)=>Number((db.prepare(sql).get() as {n:number}).n);const first=db.prepare('SELECT min(created_at) at FROM admin_operators').get() as {at:number|null};return{accounts:{total:count('SELECT count(*) n FROM accounts'),disabled:count("SELECT count(*) n FROM admin_account_states WHERE status='disabled'")},families:{total:count('SELECT count(*) n FROM families'),paused:count("SELECT count(*) n FROM admin_family_states WHERE status='paused'")},activeDevices:count('SELECT count(*) n FROM devices'),activeCalls:count('SELECT count(*) n FROM calls WHERE ended_at IS NULL'),admins:count('SELECT count(*) n FROM admin_operators'),initializedAt:first.at===null?null:iso(first.at)};}
  function listAudit(actor:AdminActor,input:{offset?:unknown;limit?:unknown}={}){assertActor(actor);const p=paging(input),rows=db.prepare('SELECT * FROM admin_audit ORDER BY at DESC,id DESC LIMIT ? OFFSET ?').all(p.limit,p.offset) as {id:string;at:number;actor:string;action:string;target_type:string;target_id:string;reason:string}[];return{items:rows.map(r=>({id:r.id,at:iso(r.at),actor:r.actor,action:r.action,targetType:r.target_type,targetId:r.target_id,reason:r.reason})),total:Number((db.prepare('SELECT count(*) n FROM admin_audit').get() as {n:number}).n),offset:p.offset,limit:p.limit};}
  function recordAudit(actor:AdminActor,action:string,targetType:string,targetId:string,reason:string){assertActor(actor);audit(actor.username,action,targetType,targetId,safeReason(reason));}
  return { status,authorize,assertActor,createBootstrap,bootstrap,login,logout,changePassword,accounts,families,setAccountStatus,setFamilyStatus,issueRecovery,recover,overview,listAudit,recordAudit,assertFamilyAllowed:(id:string)=>{open();assertOperationalAccess(db,undefined,id);},close:()=>{closed=true;} };
}
export type AdminStore = ReturnType<typeof createAdminStore>;

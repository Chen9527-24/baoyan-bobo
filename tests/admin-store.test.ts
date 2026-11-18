import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, scryptSync, createHash } from 'node:crypto';
import { createAdminStore, type AdminAccessChange } from '../apps/server/src/admin-store.js';
import { createAccountStore } from '../apps/server/src/account-store.js';
const salt=Buffer.alloc(32,7),pass='12345678',key=scryptSync(pass,salt,64,{N:2**17,r:8,p:1,maxmem:256*1024*1024}).toString('hex');
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
function fixture(){
  const db=new DatabaseSync(':memory:');db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE families(id TEXT PRIMARY KEY,child_json TEXT NOT NULL DEFAULT 'private child data');
    CREATE TABLE devices(token_hash TEXT PRIMARY KEY,family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE);
    CREATE TABLE members(id TEXT PRIMARY KEY,family_id TEXT NOT NULL,name TEXT);
    CREATE TABLE calls(id TEXT PRIMARY KEY,family_id TEXT NOT NULL,ended_at INTEGER);`);
  const family=randomUUID(),account=randomUUID();db.prepare('INSERT INTO families(id) VALUES(?)').run(family);
  const accounts=createAccountStore({db,now:()=>at});let at=1_800_000_000_000;
  db.prepare('INSERT INTO accounts VALUES(?,?,?,?,?,1,?,1,?)').run(account,family,'ordinary.user',salt.toString('hex'),key,sha('old-recovery'),at);
  db.prepare('INSERT INTO devices VALUES(?,?)').run('devhash',family);accounts.attach(account,'devhash');
  const changes:AdminAccessChange[]=[];const store=createAdminStore({db,now:()=>at,onAccessChanged:change=>changes.push(change)});
  return{db,store,accounts,family,account,changes,advance:(n:number)=>at+=n,close:()=>{store.close();accounts.close();db.close();}};
}
async function initialize(f:ReturnType<typeof fixture>){const t=f.store.createBootstrap();const session=await f.store.bootstrap({token:t.token,username:'owner',password:pass,ip:'local'});return{session,actor:f.store.authorize(session.token)};}
const errorCode=(code:string)=>(error:unknown)=>Boolean(error&&typeof error==='object'&&'code'in error&&error.code===code);

test('admin bootstrap is single use, hashed, expiring, and ordinary credentials give no privilege',async()=>{const f=fixture();try{
  const first=f.store.createBootstrap(),second=f.store.createBootstrap();assert.equal(f.store.status().initialized,false);
  assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM admin_bootstrap').all()).includes(second.token),false);
  await assert.rejects(f.store.bootstrap({token:first.token,username:'owner',password:pass,ip:'local'}),errorCode('ADMIN_AUTH_FAILED'));
  const session=await f.store.bootstrap({token:second.token,username:'owner',password:pass,ip:'local'});assert.equal(f.store.status(session.token).authenticated,true);
  assert.throws(()=>f.store.createBootstrap(),errorCode('ADMIN_INITIALIZED'));
  await assert.rejects(f.store.bootstrap({token:second.token,username:'newadmin',password:pass,ip:'local'}),errorCode('ADMIN_AUTH_FAILED'));
  assert.throws(()=>f.store.authorize('devhash'),errorCode('ADMIN_REQUIRED'));
  await assert.rejects(f.store.login({username:'ordinary.user',password:pass,ip:'other'}),errorCode('ADMIN_AUTH_FAILED'));
  assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM admin_audit').all()).includes(second.token),false);
}finally{f.close();}});
test('bootstrap expires and late pending bootstrap cannot survive store close',async()=>{const f=fixture();try{
  const t=f.store.createBootstrap();f.advance(20*60_000);await assert.rejects(f.store.bootstrap({token:t.token,username:'owner',password:pass,ip:'local'}),errorCode('ADMIN_AUTH_FAILED'));
  const next=f.store.createBootstrap();const pending=f.store.bootstrap({token:next.token,username:'owner',password:pass,ip:'local'});f.store.close();await assert.rejects(pending,errorCode('ADMIN_CLOSED'));assert.equal(f.db.prepare('SELECT count(*) n FROM admin_operators').get()?.n,0);
}finally{f.close();}});
test('admin login, fixed session expiry, logout and password rotation revoke sessions',async()=>{const f=fixture();try{
  const {actor,session}=await initialize(f);const second=await f.store.login({username:'owner',password:pass,ip:'local'});await f.store.changePassword(actor,{password:pass,newPassword:'abcdefgh',ip:'local'});
  assert.throws(()=>f.store.authorize(session.token),errorCode('ADMIN_REQUIRED'));assert.throws(()=>f.store.authorize(second.token),errorCode('ADMIN_REQUIRED'));
  await assert.rejects(f.store.login({username:'owner',password:pass,ip:'local'}),errorCode('ADMIN_AUTH_FAILED'));
  const current=await f.store.login({username:'owner',password:'abcdefgh',ip:'local'});f.store.logout(f.store.authorize(current.token));assert.equal(f.store.status(current.token).authenticated,false);
  const final=await f.store.login({username:'owner',password:'abcdefgh',ip:'local'});f.advance(2*60*60_000);assert.throws(()=>f.store.authorize(final.token),errorCode('ADMIN_REQUIRED'));
}finally{f.close();}});
test('admin account status checks revision, reason, confirmation and revokes ordinary login',async()=>{const f=fixture();try{
  const {actor}=await initialize(f);const user=await f.accounts.authenticate({username:'ordinary.user',password:pass,ip:'normal'}),identity=f.accounts.issueIdentity(user);
  assert.throws(()=>f.store.setAccountStatus(actor,f.account,{revision:0,status:'disabled',reason:'停用',confirm:false}),errorCode('ADMIN_CONFIRM_REQUIRED'));
  assert.throws(()=>f.store.setAccountStatus(actor,f.account,{revision:0,status:'disabled',reason:'x',confirm:true}),errorCode('ADMIN_REASON_REQUIRED'));
  const result=f.store.setAccountStatus(actor,f.account,{revision:0,status:'disabled',reason:'重复异常请求',confirm:true});assert.equal(result.revision,1);assert.equal(f.db.prepare('SELECT count(*) n FROM devices').get()?.n,0);
  assert.throws(()=>f.accounts.identity(identity.token),errorCode('ACCOUNT_REQUIRED'));
  await assert.rejects(f.accounts.authenticate({username:'ordinary.user',password:pass,ip:'normal'}),errorCode('ACCOUNT_DISABLED'));
  assert.throws(()=>f.store.setAccountStatus(actor,f.account,{revision:0,status:'active',reason:'核查完成',confirm:true}),errorCode('ADMIN_REVISION_CHANGED'));
  f.store.setAccountStatus(actor,f.account,{revision:1,status:'active',reason:'核查完成',confirm:true});assert.equal((await f.accounts.authenticate({username:'ordinary.user',password:pass,ip:'normal'})).id,f.account);
  assert.equal(f.changes.length,2);assert.equal(f.db.prepare('SELECT count(*) n FROM families').get()?.n,1);
}finally{f.close();}});
test('family pause blocks accounts, identity and visitor devices then reversibly restores',async()=>{const f=fixture();try{
  const {actor}=await initialize(f),user=await f.accounts.authenticate({username:'ordinary.user',password:pass,ip:'normal'}),identity=f.accounts.issueIdentity(user);f.db.prepare('INSERT INTO devices VALUES(?,?)').run('visitor',f.family);
  f.store.setFamilyStatus(actor,f.family,{revision:0,status:'paused',reason:'测试暂停',confirm:true});assert.throws(()=>f.accounts.assertDevice('visitor'),errorCode('FAMILY_PAUSED'));assert.throws(()=>f.accounts.assertDevice('devhash'),errorCode('ACCOUNT_REQUIRED'));assert.throws(()=>f.accounts.identity(identity.token),errorCode('ACCOUNT_REQUIRED'));assert.throws(()=>f.store.assertFamilyAllowed(f.family),errorCode('FAMILY_PAUSED'));
  await assert.rejects(f.accounts.authenticate({username:'ordinary.user',password:pass,ip:'normal'}),errorCode('FAMILY_PAUSED'));
  f.store.setFamilyStatus(actor,f.family,{revision:1,status:'active',reason:'恢复测试',confirm:true});f.accounts.assertDevice('visitor');assert.throws(()=>f.accounts.identity(identity.token),errorCode('ACCOUNT_REQUIRED'));assert.equal(f.db.prepare('SELECT child_json FROM families').get()?.child_json,'private child data');
}finally{f.close();}});
test('assisted recovery is limited, one use, revokes old credentials and logs no token',async()=>{const f=fixture();try{
  const {actor}=await initialize(f),ticket=f.store.issueRecovery(actor,f.account,{revision:0,reason:'用户线下确认账号所有权',confirm:true});assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM admin_recovery_tickets').all()).includes(ticket.token),false);
  const old=f.accounts.issueIdentity(await f.accounts.authenticate({username:'ordinary.user',password:pass,ip:'normal'}));await f.store.recover({token:ticket.token,newPassword:'87654321',ip:'holder'});
  assert.throws(()=>f.accounts.identity(old.token),errorCode('ACCOUNT_REQUIRED'));await assert.rejects(f.accounts.authenticate({username:'ordinary.user',password:pass,ip:'normal'}),errorCode('ACCOUNT_AUTH_FAILED'));
  assert.equal((await f.accounts.authenticate({username:'ordinary.user',password:'87654321',ip:'normal'})).id,f.account);await assert.rejects(f.store.recover({token:ticket.token,newPassword:pass,ip:'holder'}),errorCode('ADMIN_AUTH_FAILED'));
  assert.equal(f.db.prepare('SELECT recovery_hash FROM accounts').get()?.recovery_hash,null);assert.equal(f.db.prepare('SELECT count(*) n FROM devices').get()?.n,0);assert.equal(JSON.stringify(f.store.listAudit(actor)).includes(ticket.token),false);assert.equal(f.changes[0]?.reason,'admin-account-recovery');
}finally{f.close();}});
test('new tickets invalidate old, expiry and suspended states reject recovery',async()=>{const f=fixture();try{
  const {actor}=await initialize(f),input={revision:0,reason:'核实本人申请',confirm:true};const first=f.store.issueRecovery(actor,f.account,input),second=f.store.issueRecovery(actor,f.account,{...input,revision:1});
  await assert.rejects(f.store.recover({token:first.token,newPassword:pass,ip:'holder'}),errorCode('ADMIN_AUTH_FAILED'));f.advance(20*60_000);await assert.rejects(f.store.recover({token:second.token,newPassword:pass,ip:'holder'}),errorCode('ADMIN_AUTH_FAILED'));
  const third=f.store.issueRecovery(actor,f.account,{...input,revision:2});f.store.setFamilyStatus(actor,f.family,{revision:0,status:'paused',reason:'异常暂停',confirm:true});await assert.rejects(f.store.recover({token:third.token,newPassword:pass,ip:'holder'}),errorCode('ADMIN_AUTH_FAILED'));f.store.setFamilyStatus(actor,f.family,{revision:1,status:'active',reason:'恢复测试',confirm:true});await assert.rejects(f.store.recover({token:third.token,newPassword:pass,ip:'holder'}),errorCode('ADMIN_AUTH_FAILED'));f.store.setFamilyStatus(actor,f.family,{revision:2,status:'paused',reason:'再次暂停',confirm:true});
  assert.throws(()=>f.store.issueRecovery(actor,f.account,{...input,revision:3}),errorCode('FAMILY_PAUSED'));
}finally{f.close();}});
test('recovery and ordinary authentication lose races to account disable',async()=>{const f=fixture();try{
  const {actor}=await initialize(f),ticket=f.store.issueRecovery(actor,f.account,{revision:0,reason:'核实本人申请',confirm:true});const pending=f.store.recover({token:ticket.token,newPassword:'newpass123',ip:'holder'});const login=f.accounts.authenticate({username:'ordinary.user',password:pass,ip:'normal'});
  // Both concurrent proofs can reject first; attach both handlers before yielding.
  const rejected=Promise.all([assert.rejects(pending,errorCode('ADMIN_AUTH_FAILED')),assert.rejects(login,errorCode('ACCOUNT_DISABLED'))]);
  f.store.setAccountStatus(actor,f.account,{revision:1,status:'disabled',reason:'异常停用',confirm:true});await rejected;assert.equal(f.db.prepare('SELECT password_revision FROM accounts').get()?.password_revision,1);
}finally{f.close();}});
test('admin search pagination exposes metadata only and no child, credentials, session hashes',async()=>{const f=fixture();try{
  const {actor}=await initialize(f);const a=f.store.accounts(actor,{q:'ordinary',limit:1}),b=f.store.families(actor,{q:f.family});assert.equal(a.total,1);assert.equal(b.items[0]?.deviceCount,1);const payload=JSON.stringify({a,b,overview:f.store.overview(actor)});for(const secret of ['private child data','password_hash','pin_hash','recovery_hash','devhash',key])assert.equal(payload.includes(secret),false);
  assert.equal(f.store.accounts(actor,{q:'%'}).total,0);assert.throws(()=>f.store.accounts(actor,{limit:100}),errorCode('INVALID_INPUT'));assert.throws(()=>f.store.families(actor,{status:'disabled'}),errorCode('INVALID_INPUT'));
}finally{f.close();}});
test('authentication attempts are persisted, bounded and expire',async()=>{const f=fixture();try{
  for(let i=0;i<12;i++)await assert.rejects(f.store.recover({token:'x'.repeat(43),newPassword:pass,ip:'holder'}),errorCode('ADMIN_AUTH_FAILED'));
  await assert.rejects(f.store.recover({token:'x'.repeat(43),newPassword:pass,ip:'holder'}),errorCode('ADMIN_THROTTLED'));f.advance(15*60_000);await assert.rejects(f.store.recover({token:'x'.repeat(43),newPassword:pass,ip:'holder'}),errorCode('ADMIN_AUTH_FAILED'));
}finally{f.close();}});

test('disable and restore during password hashing still invalidates the prior access version',async()=>{const f=fixture();try{
 const {actor}=await initialize(f);const pending=f.accounts.authenticate({username:'ordinary.user',password:pass,ip:'normal'});
 f.store.setAccountStatus(actor,f.account,{revision:0,status:'disabled',reason:'临时停用',confirm:true});f.store.setAccountStatus(actor,f.account,{revision:1,status:'active',reason:'人工恢复',confirm:true});
 await assert.rejects(pending,errorCode('ACCOUNT_CHANGED'));assert.equal((await f.accounts.authenticate({username:'ordinary.user',password:pass,ip:'normal'})).id,f.account);
}finally{f.close();}});
test('guardian assisted recovery revokes only their account and leaves sibling login intact',async()=>{const f=fixture();try{
 const {actor}=await initialize(f),guardian=randomUUID();f.db.prepare('INSERT INTO accounts VALUES(?,?,?,?,?,1,NULL,1,?)').run(guardian,f.family,'guardian.user',salt.toString('hex'),key,1_800_000_000_000);f.db.prepare('INSERT INTO guardian_members VALUES(?,?)').run(guardian,f.family);f.db.prepare('INSERT INTO devices VALUES(?,?)').run('guardian-device',f.family);f.accounts.attach(guardian,'guardian-device');
 const ownerIdentity=f.accounts.issueIdentity(await f.accounts.authenticate({username:'ordinary.user',password:pass,ip:'normal'}));const ticket=f.store.issueRecovery(actor,guardian,{revision:0,reason:'监护人确认申请',confirm:true});await f.store.recover({token:ticket.token,newPassword:'guardian123',ip:'holder'});
 assert.throws(()=>f.accounts.assertDevice('devhash'),errorCode('ACCOUNT_REQUIRED'));assert.equal(f.accounts.identity(ownerIdentity.token).id,f.account);assert.throws(()=>f.accounts.assertDevice('guardian-device'),errorCode('ACCOUNT_REQUIRED'));assert.equal(f.db.prepare('SELECT count(*) n FROM accounts').get()?.n,2);assert.equal(f.db.prepare('SELECT count(*) n FROM families').get()?.n,1);
}finally{f.close();}});
test('recovery issuance moves target revision and refuses another stale administrator action',async()=>{const f=fixture();try{
 const {actor}=await initialize(f),ticket=f.store.issueRecovery(actor,f.account,{revision:0,reason:'用户确认申请',confirm:true});assert.equal(ticket.revision,1);
 assert.throws(()=>f.store.issueRecovery(actor,f.account,{revision:0,reason:'另一位管理操作',confirm:true}),errorCode('ADMIN_REVISION_CHANGED'));
 assert.throws(()=>f.store.setAccountStatus(actor,f.account,{revision:0,status:'disabled',reason:'旧界面停用',confirm:true}),errorCode('ADMIN_REVISION_CHANGED'));
 await f.store.recover({token:ticket.token,newPassword:'resetpass',ip:'holder'});assert.equal(f.store.accounts(actor).items[0]?.revision,2);
}finally{f.close();}});

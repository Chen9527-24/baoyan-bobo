import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type AppOptions } from '../apps/server/src/app.js';

const origin='http://localhost:5173';
const password='fictional Long Passphrase 426!';
const nextPassword='fictional Different Passphrase 719!';
const profile={pin:'123456',nickname:'虚构小雨',ageGroup:'6-8',sessionMinutes:10,dailyMinutes:30,consent:true};
function harness(t:TestContext,options:AppOptions={}){const app=createApp({env:{},dataPath:':memory:',...options});t.after(()=>app.locals.close());return{app,a:request.agent(app)};}
function post(a:any,path:string,body:unknown={}){return a.post('/api'+path).set('Origin',origin).send(['/account/register','/parent/account/register'].includes(path)?{contactPhone:'+12025550101',childName:profile.nickname,pin:profile.pin,...(body as object)}:path==='/account/guardian/unlock'?{pin:profile.pin,...(body as object)}:body);}
async function setup(a:any,extra={}){return(await post(a,'/setup',{...profile,...extra}).expect(201)).body;}
async function unlock(a:any,pin=profile.pin){await post(a,'/parent/unlock',{pin}).expect(200);}
async function register(a:any,username='fictional.guardian'){await unlock(a);return(await post(a,'/parent/account/register',{username,password}).expect(201)).body;}
async function login(a:any,username='fictional.guardian',pass=password){return(await post(a,'/account/login',{username,password:pass}).expect(200)).body;}
async function boot(a:any){return(await a.get('/api/bootstrap').expect(200)).body;}

test('new profiles enable memory by default, setup opt-out and existing flags stay explicit',async t=>{
 const {app,a}=harness(t);const b=request.agent(app);
 assert.equal((await setup(a)).child.memoryEnabled,true);
 assert.equal((await setup(b,{memoryEnabled:false})).child.memoryEnabled,false);
 await unlock(a);const second=(await post(a,'/parent/children',{nickname:'虚构小夏',ageGroup:'9-12',sessionMinutes:10,dailyMinutes:30}).expect(201)).body;
 assert.equal(second.memoryEnabled,true);await unlock(b);await post(b,'/parent/account/register',{username:'memory.off',password}).expect(201);
 const c=request.agent(app);assert.equal((await login(c,'memory.off')).child.memoryEnabled,false);
});

test('registration needs PIN, rotates device cookie, binds the same household and locks management',async t=>{
 const {app,a}=harness(t);const initial=await setup(a);const stolen=(await a.get('/api/bootstrap')).headers['set-cookie'];
 await post(a,'/parent/account/register',{username:'fictional.guardian',password}).expect(403);
 const result=await register(a);assert.equal(result.bootstrap.child.id,initial.child.id);assert.equal(result.bootstrap.account.username,'fictional.guardian');assert.equal(result.bootstrap.account.signedIn,true);assert.equal(result.bootstrap.parentAuthorized,false);assert.ok(result.recoveryCode.length>=32);
 await a.get('/api/parent/memories').expect(403);
 const deviceSet=(await post(a,'/parent/unlock',{pin:profile.pin}).expect(200)).headers['set-cookie'];assert.ok(deviceSet.some((s:string)=>s.includes('HttpOnly')&&s.includes('SameSite=Strict')));
 const foreign=request.agent(app);await setup(foreign,{nickname:'虚构另一家庭'});await unlock(foreign);
 await post(foreign,'/parent/account/register',{username:'FICTIONAL.GUARDIAN',password}).expect(409);
 assert.equal((await boot(foreign)).account.bound,false);assert.equal((await boot(foreign)).child.nickname,'虚构另一家庭');
 assert.equal(stolen,undefined); // bootstrap never issues or returns raw credentials.
});

test('login restores saved child memories across devices without granting parent PIN access',async t=>{
 const {app,a}=harness(t);await setup(a);const call=(await post(a,'/calls',{operationId:randomUUID()}).expect(201)).body;
 const turn=(await post(a,`/calls/${call.id}/turn`,{operationId:randomUUID(),text:'帮我记住我喜欢画画'}).expect(200)).body;
 await post(a,`/calls/${call.id}/memory/confirm`,{candidateId:turn.candidate.id,operationId:randomUUID()}).expect(200);await register(a);
 const b=request.agent(app);const value=await login(b,'FICTIONAL.GUARDIAN');assert.equal(value.child.nickname,profile.nickname);assert.equal(value.memoryCount,1);assert.equal(value.parentAuthorized,false);
 await b.get('/api/parent/memories').expect(403);await unlock(b);assert.deepEqual((await b.get('/api/parent/memories')).body.items.map((m:any)=>m.content),['我喜欢画画']);
});

test('login rejects another configured household and preserves its guest access',async t=>{
 const {app,a}=harness(t);await setup(a);await register(a);const b=request.agent(app);const before=await setup(b,{nickname:'虚构另一家'});
 await post(b,'/account/login',{username:'fictional.guardian',password}).expect(409);assert.equal((await boot(b)).child.id,before.child.id);assert.equal((await boot(b)).account.bound,false);
});

test('logout of an already replaced device cannot revoke the newer login, a deliberate login replaces it again',async t=>{
 const {app,a}=harness(t);await setup(a);await register(a);const b=request.agent(app);await login(b);await a.get('/api/account/session').expect(401);
 const value=(await post(a,'/account/logout').expect(200)).body;assert.equal(value.configured,false);await a.get('/api/parent/memories').expect(401);assert.equal((await boot(b)).account.signedIn,true);assert.equal((await login(a)).configured,true);
});

test('changing password revokes every older device and code, retains data and refreshes recovery',async t=>{
 const {app,a}=harness(t);await setup(a);const registered=await register(a);const b=request.agent(app),c=request.agent(app);await login(b);await a.get('/api/account/session').expect(401);
 await login(a);await unlock(a);const link=(await post(a,'/parent/devices/link').expect(200)).body;
 await post(a,'/parent/account/password',{password:'wrong password that is long',newPassword:nextPassword}).expect(401);
 const changed=(await post(a,'/parent/account/password',{password,newPassword:nextPassword}).expect(200)).body;
 assert.equal(changed.bootstrap.configured,true);assert.equal(changed.bootstrap.parentAuthorized,false);assert.notEqual(changed.recoveryCode,registered.recoveryCode);assert.equal((await boot(b)).configured,false);
 await post(c,'/devices/link',{code:link.code,pin:profile.pin}).expect(403);
 await post(b,'/account/login',{username:'fictional.guardian',password}).expect(401);await login(b,'fictional.guardian',nextPassword);
 await post(c,'/account/recover',{username:'fictional.guardian',recoveryCode:registered.recoveryCode,newPassword:password}).expect(401);
});

test('recovery code resets password once, logs out all devices, does not auto-login or unlink other guest family',async t=>{
 const {app,a}=harness(t);await setup(a);const registered=await register(a);const other=request.agent(app);const original=await setup(other,{nickname:'虚构另一家庭'});
 await post(other,'/account/recover',{username:'fictional.guardian',recoveryCode:registered.recoveryCode,newPassword:nextPassword}).expect(200);
 assert.equal((await boot(a)).configured,false);assert.equal((await boot(other)).child.id,original.child.id);
 const b=request.agent(app);assert.equal((await boot(b)).configured,false);await post(b,'/account/recover',{username:'fictional.guardian',recoveryCode:registered.recoveryCode,newPassword:password}).expect(401);await login(b,'fictional.guardian',nextPassword);
});

test('password can reset forgotten PIN only from signed-in account; new PIN is still required',async t=>{
 const {app,a}=harness(t);await setup(a);const guest=request.agent(app);await unlock(a);const link=(await post(a,'/parent/devices/link').expect(200)).body;await post(guest,'/devices/link',{code:link.code,pin:profile.pin}).expect(201);await register(a);
 await post(guest,'/account/pin',{password,pin:'654321'}).expect(401);
 await post(a,'/account/pin',{password:'incorrect long password',pin:'654321'}).expect(401);
 const result=(await post(a,'/account/pin',{password,pin:'654321'}).expect(200)).body;assert.equal(result.parentAuthorized,false);await post(a,'/parent/unlock',{pin:profile.pin}).expect(403);await unlock(a,'654321');
});

test('login lasts thirty days, expired device never falls back to guest and frees device slots',async t=>{
 let time=Date.parse('2026-09-30T00:00:00Z');const {app,a}=harness(t,{now:()=>time});await setup(a);await register(a);
 for(let n=0;n<9;n++)await login(request.agent(app));assert.equal((await boot(a)).configured,false);
 time+=30*86400000+1;app.locals.sweepExpiredState();assert.equal((await boot(a)).configured,false);await post(a,'/calls',{operationId:randomUUID()}).expect(401);assert.equal((await login(request.agent(app))).configured,true);
});

test('withdrawal deletes bound account, restoration and credentials cannot recover deleted household',async t=>{
 const {app,a}=harness(t);await setup(a);const registered=await register(a);await unlock(a);await post(a,'/parent/withdraw').expect(200);const b=request.agent(app);await post(b,'/account/login',{username:'fictional.guardian',password}).expect(401);await post(b,'/account/recover',{username:'fictional.guardian',recoveryCode:registered.recoveryCode,newPassword:nextPassword}).expect(401);assert.equal((await boot(b)).configured,false);
});

test('bound-account username is hidden from a guest linked device, all auth writes enforce origin',async t=>{
 const {app,a}=harness(t);await setup(a);await register(a);await unlock(a);const link=(await post(a,'/parent/devices/link').expect(200)).body;const b=request.agent(app);await post(b,'/devices/link',{code:link.code,pin:profile.pin}).expect(201);
 assert.deepEqual((await boot(b)).account,{bound:true,signedIn:false});for(const path of ['/account/login','/account/logout','/account/recover','/account/pin','/parent/account/register','/parent/account/password','/parent/account/recovery'])await request(app).post('/api'+path).send({}).expect(403);
});

test('account session persists across restart while parent authorization does not',async t=>{
 const folder=mkdtempSync(join(tmpdir(),'baoyan-account-'));t.after(()=>rmSync(folder,{recursive:true,force:true}));let app=createApp({env:{},dataPath:join(folder,'fixture.sqlite')});t.after(()=>app.locals.close());const a=request.agent(app);await setup(a);const res=await register(a);
 const fresh=(await post(a,'/account/login',{username:'fictional.guardian',password}).expect(200)).headers['set-cookie'];const cookie=fresh.find((value:string)=>value.startsWith('baoyan_device=')).split(';')[0];await unlock(a);app.locals.close();app=createApp({env:{},dataPath:join(folder,'fixture.sqlite')});const value=(await request(app).get('/api/bootstrap').set('Cookie',cookie).expect(200)).body;assert.equal(value.child.id,res.bootstrap.child.id);assert.equal(value.account.signedIn,true);assert.equal(value.parentAuthorized,false);
});

test('production rate buckets use the single verified proxy hop; direct development ignores forwarded IPs',async t=>{
 const folder=mkdtempSync(join(tmpdir(),'baoyan-proxy-account-'));t.after(()=>rmSync(folder,{recursive:true,force:true}));
 const path=join(folder,'fixture.sqlite');const app=createApp({dataPath:path,allowedOrigins:['https://baoyan.fixture.testing'],env:{NODE_ENV:'production',TRIAL_ENABLED:'true',TRIAL_REQUIRE_INVITE:'false',TRIAL_ENDS_AT:'2026-10-12T12:54:09Z'}});t.after(()=>app.locals.close());
 assert.equal(app.get('trust proxy'),1);
 for(const forwarded of ['198.51.100.1, 203.0.113.10','203.0.113.20'])await request(app).post('/api/account/login').set('Origin','https://baoyan.fixture.testing').set('X-Forwarded-For',forwarded).send({username:'fictional.absent',password}).expect(401);
 const db=new DatabaseSync(path,{readOnly:true});t.after(()=>db.close());const hashes=db.prepare('SELECT bucket FROM account_attempts').all().map((r:any)=>r.bucket);
 for(const ip of ['203.0.113.10','203.0.113.20'])assert.ok(hashes.includes(createHash('sha256').update('ip:'+ip).digest('hex')));
 assert.ok(!hashes.includes(createHash('sha256').update('ip:198.51.100.1').digest('hex')));
 const local=createApp({dataPath:':memory:',env:{}});t.after(()=>local.locals.close());assert.equal(local.get('trust proxy'),false);
});

test('expired trial still allows account login and PIN management while chat remains unavailable',async t=>{
 let time=Date.parse('2026-09-30T00:00:00Z');const {app,a}=harness(t,{now:()=>time,env:{TRIAL_ENABLED:'true',TRIAL_REQUIRE_INVITE:'false',TRIAL_ENDS_AT:'2026-10-01T00:00:00Z'}});
 await setup(a,{dailyMinutes:20});await register(a);time=Date.parse('2026-10-02T00:00:00Z');const b=request.agent(app);const value=await login(b);assert.equal(value.configured,true);await unlock(b);await b.get('/api/parent/export').expect(200);await post(b,'/calls',{operationId:randomUUID()}).expect(410);
});

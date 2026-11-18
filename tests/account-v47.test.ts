import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {randomUUID} from 'node:crypto';
import {createApp,type AppOptions} from '../apps/server/src/app.js';
import {accountKdfStatus} from '../apps/server/src/account-store.js';

const origin='http://localhost:5173',password='12345678';
const registration={username:'fictional.child',password,contactPhone:'+12025550101',childName:'虚构小星',pin:'482619'};
const settings={ageGroup:'6-8',sessionMinutes:10,dailyMinutes:20,consent:true};
const post=(agent:any,path:string,body:unknown={})=>agent.post('/api'+path).set('Origin',origin).send(body);
function fixture(t:TestContext,options:AppOptions={}){const app=createApp({dataPath:':memory:',env:{},...options});t.after(()=>app.locals.close());return{app,a:request.agent(app)};}
async function signup(agent:any,extra={}){return(await post(agent,'/account/register',{...registration,...extra}).expect(201)).body;}
async function setup(agent:any){return(await post(agent,'/setup',settings).expect(201)).body;}
async function unlock(agent:any,pin=registration.pin){await post(agent,'/parent/unlock',{pin}).expect(200);}
async function waitUntil(check:()=>boolean){const until=Date.now()+5000;while(!check()){assert.ok(Date.now()<until,'isolated asynchronous operation starts');await new Promise(r=>setTimeout(r,5));}}

test('v47 registration requires phone, child name and six-digit PIN; pending setup uses registered data once',async t=>{
 const {app,a}=fixture(t);
 for(const field of ['contactPhone','childName','pin'] as const){const input={...registration} as Record<string,unknown>;delete input[field];await post(a,'/account/register',input).expect(400);}
 for(const extra of [{contactPhone:''},{childName:' '},{pin:'12345'},{pin:'1234567'},{pin:'abc123'}])await post(a,'/account/register',{...registration,...extra}).expect(400);
 const pending=await signup(a);assert.deepEqual(pending.bootstrap.account,{bound:false,signedIn:true,username:registration.username,pending:true,childName:registration.childName,hasPin:true});
 for(const secret of ['contactPhone','pin_hash','pin_salt',registration.contactPhone])assert.equal(JSON.stringify(pending.bootstrap).includes(secret),false);
 assert.equal((await a.get('/api/account/session').expect(200)).body.pending,true);
 const configured=(await post(a,'/setup',{...settings,nickname:'应忽略的旧称呼',pin:'111111'}).expect(201)).body;
 assert.equal(configured.child.nickname,registration.childName);assert.equal(configured.account.childName,registration.childName);
 await post(a,'/parent/unlock',{pin:'111111'}).expect(403);await unlock(a);
 await request(app).get('/api/account/session').expect(401);
});

test('v47 independent guardians use their own PIN and changing it preserves owner PIN and session',async t=>{
 const {app,a}=fixture(t);await signup(a);await setup(a);await unlock(a);
 const link=(await post(a,'/parent/guardians/link').expect(200)).body.code;
 const guardian=request.agent(app);await signup(guardian,{username:'fictional.guardian',childName:'虚构小月',pin:'735024',contactPhone:'+12025550102'});
 await post(guardian,'/account/guardian/join',{code:link}).expect(201);
 await post(guardian,'/account/guardian/unlock').expect(400);
 await post(guardian,'/parent/unlock',{pin:registration.pin}).expect(403);await unlock(guardian,'735024');
 await post(guardian,'/account/pin',{password,pin:'864209'}).expect(200);
 await post(guardian,'/parent/unlock',{pin:'735024'}).expect(403);await unlock(guardian,'864209');
 await a.get('/api/account/session').expect(200);await unlock(a);await a.get('/api/parent/memories').expect(200);
 const replacement=request.agent(app);await post(replacement,'/account/login',{username:registration.username,password}).expect(200);
 await a.get('/api/account/session').expect(401);await guardian.get('/api/account/session').expect(200);
 await post(a,'/account/logout').expect(200);await replacement.get('/api/account/session').expect(200);await guardian.get('/api/account/session').expect(200);
});

test('v47 binding visitor data adopts the registered child name and uses the independent account PIN',async t=>{
 const {a}=fixture(t);
 const visitor=(await post(a,'/setup',{...settings,nickname:'虚构旧昵称',pin:'135790'}).expect(201)).body;
 await unlock(a,'135790');
 const registered=(await post(a,'/parent/account/register',registration).expect(201)).body.bootstrap;
 assert.equal(registered.child.id,visitor.child.id);assert.equal(registered.child.nickname,registration.childName);
 assert.equal(registered.account.childName,registration.childName);
 await post(a,'/parent/unlock',{pin:'135790'}).expect(403);await unlock(a);
 const profiles=(await a.get('/api/parent/children').expect(200)).body;
 assert.ok(JSON.stringify(profiles).includes(registration.childName));assert.equal(JSON.stringify(profiles).includes('虚构旧昵称'),false);
});

test('v47 a newer pending login revokes the old identity and stale setup cannot create a visitor family',async t=>{
 const {app,a}=fixture(t);await signup(a);const newer=request.agent(app);await post(newer,'/account/login',{username:registration.username,password}).expect(200);
 await a.get('/api/account/session').expect(401);await post(a,'/setup',settings).expect(401);
 const configured=await setup(newer);assert.equal(configured.account.signedIn,true);await post(newer,'/account/logout').expect(200);await newer.get('/api/account/session').expect(401);
 const login=(await post(a,'/account/login',{username:registration.username,password}).expect(200)).body;assert.equal(login.child.id,configured.child.id);
});

test('v47 single-device replacement cancels old provider work and never returns its late reply',async t=>{
 let release!:()=>void,entered!:()=>void;const held=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});let signal:AbortSignal|null|undefined;
 const {app,a}=fixture(t,{env:{API_BASE_URL:'https://fixture.invalid/v1',API_KEY:'synthetic-only',CHAT_MODEL:'synthetic-v47'},fetch:(async(_url,init)=>{signal=init?.signal;entered();await held;return Response.json({choices:[{message:{content:'这是迟到的虚构回复。'},finish_reason:'stop'}]});}) as typeof fetch});
 t.after(()=>release());await signup(a);await setup(a);const call=(await post(a,'/calls',{operationId:randomUUID()}).expect(201)).body;
 const turn=post(a,`/calls/${call.id}/turn`,{operationId:randomUUID(),text:'今天画了小猫'}).then((r:any)=>r);await started;
 const replacement=request.agent(app);await post(replacement,'/account/login',{username:registration.username,password}).expect(200);
 assert.equal(signal?.aborted,true);release();const late=await turn;assert.equal(late.status,401);assert.equal(late.body.reply,undefined);
 await post(a,`/calls/${call.id}/heartbeat`).expect(401);await a.get('/api/account/session').expect(401);await replacement.get('/api/account/session').expect(200);
});

test('v47 the registered child name supplies per-account reply context without sending phone or PIN',async t=>{
 const prompts:string[]=[];const {a}=fixture(t,{env:{API_BASE_URL:'https://fixture.invalid/v1',API_KEY:'synthetic-only',CHAT_MODEL:'synthetic-v47'},fetch:(async(_url,init)=>{const body=JSON.parse(String(init?.body));prompts.push(JSON.stringify(body.messages));return Response.json({choices:[{message:{content:'我记得你的称呼。'},finish_reason:'stop'}]});}) as typeof fetch});
 await signup(a);await setup(a);const call=(await post(a,'/calls',{operationId:randomUUID()}).expect(201)).body;
 await post(a,`/calls/${call.id}/turn`,{operationId:randomUUID(),text:'你知道我叫什么吗'}).expect(200);
 assert.ok(prompts.at(-1)?.includes(registration.childName));assert.ok(prompts.at(-1)?.includes('与共享称呼条目冲突时以它为先'));
 for(const secret of [registration.contactPhone,registration.pin,'pin_hash','pin_salt'])assert.equal(prompts.at(-1)?.includes(secret),false);
 await unlock(a);await a.patch('/api/parent/settings').set('Origin',origin).send({nickname:'虚构新小星'}).expect(200);
 assert.equal((await a.get('/api/bootstrap')).body.account.childName,'虚构新小星');
});

test('v47 concurrent login proofs choose one current session and logout rejects a delayed re-login',async t=>{
 const {app,a}=fixture(t);await signup(a);await setup(a);const b=request.agent(app),c=request.agent(app);
 const logins=await Promise.all([b,c].map(agent=>post(agent,'/account/login',{username:registration.username,password}).then((r:any)=>r)));
 assert.equal(logins.filter(r=>r.status===200).length,1);assert.equal(logins.filter(r=>r.status===409).length,1);
 const current=logins[0].status===200?b:c;await a.get('/api/account/session').expect(401);
 const pending=post(current,'/account/login',{username:registration.username,password}).then((r:any)=>r);await waitUntil(()=>accountKdfStatus().running>0);await post(current,'/account/logout').expect(200);
 assert.equal((await pending).status,401);await current.get('/api/account/session').expect(401);
});

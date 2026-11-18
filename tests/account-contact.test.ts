import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../apps/server/src/app.js';
import {createAdminStore} from '../apps/server/src/admin-store.js';
import {normalizeContactPhone} from '../apps/server/src/account-store.js';
const origin='http://localhost:5173',password='12345678',pin='123456';
const post=(agent:any,path:string,body:unknown={})=>agent.post('/api'+path).set('Origin',origin).send(['/account/register','/parent/account/register'].includes(path)?{contactPhone:'+12025550101',childName:'虚构小晴',pin:pin,...(body as object)}:path==='/account/guardian/unlock'?{pin:pin,...(body as object)}:body);
async function fixture(t:TestContext){const folder=mkdtempSync(join(tmpdir(),'baoyan-contact-')),path=join(folder,'test.sqlite');const app=createApp({dataPath:path,env:{}}),db=new DatabaseSync(path);db.exec('PRAGMA foreign_keys=ON');const store=createAdminStore({db}),ticket=store.createBootstrap();const admin=request.agent(app);await post(admin,'/admin/bootstrap',{token:ticket.token,username:'contact.operator',password}).expect(200);t.after(()=>{store.close();db.close();app.locals.close();rmSync(folder,{recursive:true,force:true});});return{app,db,admin};}
async function setup(agent:any,nickname='虚构小晴'){await post(agent,'/setup',{pin,nickname,ageGroup:'6-8',sessionMinutes:10,dailyMinutes:20,consent:true}).expect(201);}
async function unlock(agent:any){await post(agent,'/parent/unlock',{pin}).expect(200);}
const phone='13900000001';
test('contact numbers are optional and normalized without accepting numeric/null/control input',()=>{
 for(const [input,expected]of [['',''],['  ',''],['139 0000-0001',phone],['+44 7700-900123','+447700900123']])assert.equal(normalizeContactPhone(input),expected);
 for(const input of [null,undefined,13900000001,{},'12000000000','1390000000','139000000001','+01234567','+123456','+1234567890123456','139\n00000001','x'.repeat(65)])assert.throws(()=>normalizeContactPhone(input));
});
test('both registration paths accept required contact phone and omit it from public bootstrap',async t=>{const f=await fixture(t),fresh=request.agent(f.app),visitor=request.agent(f.app);
 const registered=await post(fresh,'/account/register',{username:'fresh.contact',password,contactPhone:'139 0000-0001'}).expect(201);assert.equal(JSON.stringify(registered.body).includes(phone),false);assert.equal(f.db.prepare('SELECT phone FROM account_contacts').get()?.phone,phone);
 await setup(fresh);await unlock(fresh);assert.deepEqual((await fresh.get('/api/parent/account/contact').expect(200)).body,{contactPhone:phone,revision:1,verified:false});
 await setup(visitor,'虚构小贝');await unlock(visitor);await post(visitor,'/parent/account/register',{username:'visitor.contact',password,contactPhone:'+44 7700-900123'}).expect(201);await unlock(visitor);assert.deepEqual((await visitor.get('/api/parent/account/contact').expect(200)).body,{contactPhone:'+447700900123',revision:1,verified:false});
 assert.equal(JSON.stringify((await fresh.get('/api/bootstrap')).body).includes('contactPhone'),false);assert.equal(JSON.stringify((await visitor.get('/api/bootstrap')).body).includes('+447700900123'),false);
});
test('required registration contact supports CAS editing and clear with monotonic revision',async t=>{const f=await fixture(t),agent=request.agent(f.app);await post(agent,'/account/register',{username:'without.contact',password,contactPhone:phone}).expect(201);await setup(agent);await unlock(agent);
 assert.deepEqual((await agent.get('/api/parent/account/contact').expect(200)).body,{contactPhone:phone,revision:1,verified:false});
 await post(agent,'/parent/account/contact',{contactPhone:'+447700900123',revision:1}).expect(200);await post(agent,'/parent/account/contact',{contactPhone:phone,revision:1}).expect(409);assert.equal((await agent.get('/api/parent/account/contact')).body.contactPhone,'+447700900123');
 const cleared=await post(agent,'/parent/account/contact',{contactPhone:'',revision:2}).expect(200);assert.deepEqual(cleared.body,{contactPhone:'',revision:3,verified:false});await post(agent,'/parent/account/contact',{contactPhone:phone,revision:1}).expect(409);
});
test('contact requires parent authorization plus own account and protects Origin and strict fields',async t=>{const f=await fixture(t),agent=request.agent(f.app);await agent.get('/api/parent/account/contact').expect(401);await setup(agent);await unlock(agent);await agent.get('/api/parent/account/contact').expect(401);
 await post(agent,'/parent/account/register',{username:'own.contact',password}).expect(201);await agent.get('/api/parent/account/contact').expect(403);await unlock(agent);
 await agent.post('/api/parent/account/contact').send({contactPhone:phone,revision:0}).expect(403);await agent.post('/api/parent/account/contact').set('Origin','https://invalid.example').send({contactPhone:phone,revision:0}).expect(403);
 for(const body of [{contactPhone:phone,revision:0,accountId:randomUUID()},{contactPhone:123,revision:0},{contactPhone:null,revision:0},{contactPhone:phone,revision:-1}])await post(agent,'/parent/account/contact',body).expect(400);
 assert.equal(f.db.prepare('SELECT count(*) n FROM account_contacts').get()?.n,1);
});
test('invalid contact registration never partially creates account rows',async t=>{const f=await fixture(t),agent=request.agent(f.app);for(const value of [null,123,'abc','139\n00000001'])await post(agent,'/account/register',{username:'bad.contact',password,contactPhone:value}).expect(400);assert.equal(f.db.prepare('SELECT count(*) n FROM accounts').get()?.n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM account_contacts').get()?.n,0);
});
test('admin family names and contacts support escaped search with accurate pagination and no private profile fields',async t=>{const f=await fixture(t);for(let i=0;i<2;i++){const agent=request.agent(f.app);await post(agent,'/account/register',{username:`search.contact${i}`,password,childName:`虚构星星${i}`,contactPhone:`1390000000${i+1}`}).expect(201);await setup(agent,`虚构星星${i}`);}
 const byName=(await f.admin.get('/api/admin/families').query({q:'虚构星星',limit:1}).expect(200)).body;assert.equal(byName.total,2);assert.equal(byName.items.length,1);const row=byName.items[0];assert.equal(row.displayName,`${row.childNames[0]}的家庭`);assert.equal(row.contacts.length,1);assert.equal(row.contacts[0].guardian,false);assert.equal(typeof row.contacts[0].contactPhone,'string');
 for(const query of ['13900000001','search.contact0']){const found=(await f.admin.get('/api/admin/families').query({q:query}).expect(200)).body;assert.equal(found.total,1);assert.equal(found.items[0].displayName,'虚构星星0的家庭');}
 assert.equal((await f.admin.get('/api/admin/families').query({q:'%'}).expect(200)).body.total,0);assert.equal((await f.admin.get('/api/admin/families').query({q:"' OR 1=1 --"}).expect(200)).body.total,0);
 const account=(await f.admin.get('/api/admin/accounts').query({q:phone}).expect(200)).body;assert.equal(account.total,1);assert.equal(account.items[0].familyName,'虚构星星0的家庭');assert.equal(account.items[0].contactPhone,phone);assert.deepEqual(account.items[0].childNames,['虚构星星0']);
 const combined=JSON.stringify({byName,account});for(const hidden of ['ageGroup','sessionMinutes','memoryEnabled','profile_json','pin_hash'])assert.equal(combined.includes(hidden),false);
});
test('registration without family exposes empty family label, missing nickname is explicit, contacts cascade only with account deletion',async t=>{const f=await fixture(t),agent=request.agent(f.app);await post(agent,'/account/register',{username:'pending.contact',password,contactPhone:phone}).expect(201);
 let row=(await f.admin.get('/api/admin/accounts')).body.items[0];assert.equal(row.familyName,'');assert.deepEqual(row.childNames,[]);assert.equal(row.contactPhone,phone);await setup(agent);await unlock(agent);
 const familyId=f.db.prepare('SELECT family_id FROM accounts WHERE id=?').get(row.id)?.family_id as string;f.db.prepare("UPDATE families SET child_json=json_set(child_json,'$.nickname','') WHERE id=?").run(familyId);
 assert.equal((await f.admin.get('/api/admin/families')).body.items[0].displayName,'未填写昵称的家庭');await post(agent,'/parent/withdraw').expect(200);assert.equal(f.db.prepare('SELECT count(*) n FROM account_contacts').get()?.n,0);
});
test('pausing and disabling preserve contact data but deny parent edits until valid fresh login',async t=>{const f=await fixture(t),agent=request.agent(f.app);await post(agent,'/account/register',{username:'pause.contact',password,contactPhone:phone}).expect(201);await setup(agent);await unlock(agent);const account=(await f.admin.get('/api/admin/accounts')).body.items[0];
 await post(f.admin,`/admin/accounts/${account.id}/status`,{revision:0,status:'disabled',reason:'虚构状态验证',confirm:true}).expect(200);await post(agent,'/parent/account/contact',{contactPhone:'',revision:1}).expect(401);assert.equal(f.db.prepare('SELECT phone FROM account_contacts').get()?.phone,phone);
 await post(f.admin,`/admin/accounts/${account.id}/status`,{revision:1,status:'active',reason:'虚构状态恢复',confirm:true}).expect(200);await post(agent,'/account/login',{username:'pause.contact',password}).expect(200);await unlock(agent);assert.equal((await agent.get('/api/parent/account/contact')).body.contactPhone,phone);
});

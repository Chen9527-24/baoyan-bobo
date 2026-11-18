import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {once} from 'node:events';
import {createApp,type AppOptions} from '../apps/server/src/app.js';
import {createGlobalMemoryStore} from '../apps/server/src/global-memory-store.js';
const origin='http://localhost:5173';
const profile={pin:'123456',nickname:'小满',ageGroup:'6-8',sessionMinutes:10,dailyMinutes:30,consent:true};
function harness(t:TestContext,options:AppOptions={}){const app=createApp({dataPath:':memory:',env:{},...options});t.after(()=>app.locals.close());return{app,agent:request.agent(app)};}
function directory(t:TestContext){const dir=mkdtempSync(join(tmpdir(),'baoyan-memory-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return join(dir,'data.sqlite');}
async function unlock(agent:any){await agent.post('/api/parent/unlock').set('Origin',origin).send({pin:profile.pin}).expect(200);}
async function lock(agent:any){await agent.post('/api/parent/lock').set('Origin',origin).send({}).expect(200);}
async function setup(agent:any){const response=await agent.post('/api/setup').set('Origin',origin).send(profile).expect(201);await unlock(agent);await agent.patch('/api/parent/settings').set('Origin',origin).send({memoryEnabled:true}).expect(200);await lock(agent);return response.headers['set-cookie'][0].split(';')[0] as string;}
async function call(agent:any){return(await agent.post('/api/calls').set('Origin',origin).send({operationId:crypto.randomUUID()}).expect(201)).body;}
function turn(agent:any,id:string,text:string,extra={}){return agent.post(`/api/calls/${id}/turn`).set('Origin',origin).send({text,operationId:crypto.randomUUID(),...extra});}
async function save(agent:any,id:string,content:string,operationId=crypto.randomUUID()){const candidate=(await turn(agent,id,`帮我记住${content}`).expect(200)).body.candidate;assert.equal(candidate.action,'save');const result=(await agent.post(`/api/calls/${id}/memory/confirm`).set('Origin',origin).send({candidateId:candidate.id,operationId}).expect(200)).body;return{candidate,operationId,memory:result.memory};}
function publish(path:string,content='小屋叫月亮小屋'){const db=new DatabaseSync(path);const store=createGlobalMemoryStore(db);const before=store.snapshot();const next=store.publish({reviewed:true,audience:'all',validity:'until-replaced',items:before.items.map(item=>({key:item.key,kind:item.kind,content:item.key==='world.home.name'?content:item.content}))},{expectedRevision:before.revision,reviewer:'local-reviewer',note:'测试明确审核的新背景'});db.close();return next;}

test('exact child forgetting requires a second action-specific confirmation and never removes global memories',async t=>{
 const {agent}=harness(t);await setup(agent);const c=await call(agent);const favorite=await save(agent,c.id,'我喜欢画画');await save(agent,c.id,'我喜欢蓝色');
 for(const text of ['忘记画画','忘掉全部','删除记忆']){const result=(await turn(agent,c.id,text).expect(200)).body;assert.equal(result.candidate,undefined);assert.match(result.reply,/不.*删除|原句/);}
 const candidate=(await turn(agent,c.id,'请帮我忘记“我喜欢画画。”').expect(200)).body.candidate;assert.equal(candidate.action,'forget');assert.equal(candidate.memoryId,favorite.memory.id);
 await agent.post(`/api/calls/${c.id}/memory/confirm`).set('Origin',origin).send({candidateId:candidate.id,operationId:'wrong-action'}).expect(409);
 const payload={candidateId:candidate.id,operationId:'forget-one'};const results=await Promise.all([agent.post(`/api/calls/${c.id}/memory/forget`).set('Origin',origin).send(payload),agent.post(`/api/calls/${c.id}/memory/forget`).set('Origin',origin).send(payload)]);assert.deepEqual(results.map(result=>result.status),[200,200]);assert.ok(results.every(result=>result.body.forgotten));
 const forgotten=(await agent.get('/api/memory/operations/forget-one')).body;assert.equal(forgotten.effect,'forgotten');assert.equal(forgotten.status,'committed');assert.equal(JSON.stringify(forgotten).includes('画画'),false);
 const saved=(await agent.get(`/api/memory/operations/${favorite.operationId}`)).body;assert.equal(saved.status,'superseded');
 await unlock(agent);const items=(await agent.get('/api/parent/memories')).body.items;assert.equal(items.length,1);assert.equal(items[0].content,'我喜欢蓝色');assert.equal((await agent.get('/api/bootstrap')).body.globalMemories.length,2);
});

test('save candidate cannot be routed through forgetting; another family cannot inspect or act on it',async t=>{
 const {app,agent:a}=harness(t);const b=request.agent(app);await setup(a);await setup(b);const ca=await call(a);const cb=await call(b);const candidate=(await turn(a,ca.id,'帮我记住我喜欢猫').expect(200)).body.candidate;
 await a.post(`/api/calls/${ca.id}/memory/forget`).set('Origin',origin).send({candidateId:candidate.id,operationId:'wrong-save'}).expect(409);
 await b.post(`/api/calls/${cb.id}/memory/confirm`).set('Origin',origin).send({candidateId:candidate.id,operationId:'foreign'}).expect(409);
 await a.post(`/api/calls/${ca.id}/memory/confirm`).set('Origin',origin).send({candidateId:candidate.id,operationId:'only-a'}).expect(200);
 assert.equal((await b.get('/api/memory/operations/only-a')).body.status,'not_found');await request(app).get('/api/memory/operations/only-a').expect(401);
});

test('adult and unknown speakers cannot create forgetting candidates, echo matched memory, or confirm earlier candidates',async t=>{
 const {agent}=harness(t);await setup(agent);await unlock(agent);await agent.patch('/api/parent/settings').set('Origin',origin).send({voiceEnabled:true}).expect(200);const mom=(await agent.post('/api/parent/members').set('Origin',origin).send({name:'妈妈',relation:'妈妈',consent:true}).expect(201)).body;await agent.post(`/api/parent/members/${mom.id}/enroll`).set('Origin',origin).send({demo:true,consent:true}).expect(200);await lock(agent);const c=await call(agent);await save(agent,c.id,'我喜欢蓝色');const candidate=(await turn(agent,c.id,'忘记我喜欢蓝色').expect(200)).body.candidate;
 const adult=(await turn(agent,c.id,'忘记我喜欢蓝色',{demoSpeaker:mom.id}).expect(200)).body;assert.equal(adult.candidate,undefined);assert.equal(adult.reply.includes('蓝色'),false);
 await agent.post(`/api/calls/${c.id}/memory/forget`).set('Origin',origin).send({candidateId:candidate.id,operationId:'adult-forget'}).expect(409);
 const unknown=(await turn(agent,c.id,'忘记我喜欢蓝色',{demoSpeaker:'unknown'}).expect(200)).body;assert.equal(unknown.candidate,undefined);assert.equal(unknown.reply.includes('蓝色'),false);assert.equal((await agent.get('/api/bootstrap')).body.memoryCount,1);
});

test('minimal operation results survive call end and restart; retries cannot duplicate or switch candidate or action',async t=>{
 const path=directory(t);const first=harness(t,{dataPath:path});const cookie=await setup(first.agent);const c=await call(first.agent);const saved=await save(first.agent,c.id,'我喜欢猫');await first.agent.post(`/api/calls/${c.id}/end`).set('Origin',origin).send({}).expect(200);first.app.locals.close();const second=harness(t,{dataPath:path});
 const status=(await request(second.app).get(`/api/memory/operations/${saved.operationId}`).set('Cookie',cookie).expect(200)).body;assert.equal(status.status,'committed');assert.equal(status.effect,'saved');assert.equal(JSON.stringify(status).includes('我喜欢猫'),false);assert.deepEqual(Object.keys(status).sort(),['action','effect','message','operationId','status']);
 const retry=await request(second.app).post(`/api/calls/${c.id}/memory/confirm`).set('Origin',origin).set('Cookie',cookie).send({candidateId:saved.candidate.id,operationId:saved.operationId}).expect(200);assert.equal(retry.body.saved,true);assert.equal(retry.body.memory,undefined);
 await request(second.app).post(`/api/calls/${c.id}/memory/confirm`).set('Origin',origin).set('Cookie',cookie).send({candidateId:crypto.randomUUID(),operationId:saved.operationId}).expect(409);await request(second.app).post(`/api/calls/${c.id}/memory/forget`).set('Origin',origin).set('Cookie',cookie).send({candidateId:saved.candidate.id,operationId:saved.operationId}).expect(409);
 const db=new DatabaseSync(path,{readOnly:true});const operations=db.prepare('SELECT * FROM memory_operations').all();assert.equal(operations.length,1);assert.equal(JSON.stringify(operations).includes('我喜欢猫'),false);assert.equal(Number((db.prepare('SELECT count(*) n FROM memories').get() as any).n),1);db.close();
});

test('saved status becomes permanently superseded after edits, deletion, memory off or expiry',async t=>{
 const path=directory(t);let time=Date.UTC(2026,8,27);const {agent}=harness(t,{dataPath:path,now:()=>time});await setup(agent);let c=await call(agent);const saved=await save(agent,c.id,'我喜欢猫');await unlock(agent);await agent.patch(`/api/parent/memories/${saved.memory.id}`).set('Origin',origin).send({content:'我喜欢狗'}).expect(200);assert.equal((await agent.get(`/api/memory/operations/${saved.operationId}`)).body.status,'superseded');
 await lock(agent);c=await call(agent);const second=await save(agent,c.id,'我喜欢蓝色');await unlock(agent);await agent.delete(`/api/parent/memories/${second.memory.id}`).set('Origin',origin).expect(200);assert.equal((await agent.get(`/api/memory/operations/${second.operationId}`)).body.status,'superseded');
 await lock(agent);c=await call(agent);const third=await save(agent,c.id,'我喜欢画画');await unlock(agent);await agent.patch('/api/parent/settings').set('Origin',origin).send({memoryEnabled:false}).expect(200);await agent.patch('/api/parent/settings').set('Origin',origin).send({memoryEnabled:true}).expect(200);assert.equal((await agent.get(`/api/memory/operations/${third.operationId}`)).body.status,'superseded');
 await lock(agent);c=await call(agent);const fourth=await save(agent,c.id,'我喜欢种花');const db=new DatabaseSync(path);db.prepare('UPDATE memories SET expires_at=? WHERE id=?').run(time+1000,fourth.memory.id);db.close();time+=2000;assert.equal((await agent.get(`/api/memory/operations/${fourth.operationId}`)).body.status,'superseded');
});

test('operation lookup expires after 24 hours and withdraw cascades operation records',async t=>{
 const path=directory(t);let time=Date.UTC(2026,8,27);const {agent}=harness(t,{dataPath:path,now:()=>time});await setup(agent);let c=await call(agent);const saved=await save(agent,c.id,'我喜欢猫');time+=24*3600_000+1;assert.equal((await agent.get(`/api/memory/operations/${saved.operationId}`)).body.status,'not_found');await unlock(agent);await lock(agent);c=await call(agent);await save(agent,c.id,'我喜欢蓝色');await unlock(agent);await agent.post('/api/parent/withdraw').set('Origin',origin).send({}).expect(200);const db=new DatabaseSync(path,{readOnly:true});assert.equal(Number((db.prepare('SELECT count(*) n FROM memory_operations').get() as any).n),0);db.close();
});

test('memory writes and operation records roll back together when the operation insert fails',async t=>{
 const path=directory(t);const {agent}=harness(t,{dataPath:path});await setup(agent);const c=await call(agent);const candidate=(await turn(agent,c.id,'帮我记住我喜欢蓝色').expect(200)).body.candidate;const db=new DatabaseSync(path);db.exec("CREATE TRIGGER fail_operation BEFORE INSERT ON memory_operations BEGIN SELECT RAISE(ABORT,'test failure'); END;");await agent.post(`/api/calls/${c.id}/memory/confirm`).set('Origin',origin).send({candidateId:candidate.id,operationId:'rolled-back'}).expect(500);assert.equal(Number((db.prepare('SELECT count(*) n FROM memories').get() as any).n),0);assert.equal(Number((db.prepare('SELECT count(*) n FROM memory_operations').get() as any).n),0);db.exec('DROP TRIGGER fail_operation');db.close();await agent.post(`/api/calls/${c.id}/memory/confirm`).set('Origin',origin).send({candidateId:candidate.id,operationId:'rolled-back'}).expect(200);
});

test('global publish invalidates candidates and cached turns while preserving personal precedence',async t=>{
 const path=directory(t);const events:any[]=[];const {app,agent}=harness(t,{dataPath:path,onEvent:(familyId,event,payload)=>events.push({familyId,event,payload})});await setup(agent);const c=await call(agent);await save(agent,c.id,'小屋叫星星屋');const candidate=(await turn(agent,c.id,'帮我记住我喜欢蓝色',{operationId:'before-global'}).expect(200)).body.candidate;events.length=0;const published=publish(path);app.locals.sweepExpiredState();assert.equal(events.length,1);assert.equal(events[0].payload.reason,'global-published');assert.equal(events[0].payload.globalRevision,published.revision);assert.equal(JSON.stringify(events).includes('星星屋'),false);
 await agent.post(`/api/calls/${c.id}/memory/confirm`).set('Origin',origin).send({candidateId:candidate.id,operationId:'stale-global'}).expect(409);await turn(agent,c.id,'帮我记住我喜欢蓝色',{operationId:'before-global'}).expect(409);const reply=(await turn(agent,c.id,'小屋叫什么').expect(200)).body;assert.match(reply.reply,/星星屋/);assert.doesNotMatch(reply.reply,/月亮小屋/);assert.equal(reply.globalRevision,2);const boot=(await agent.get('/api/bootstrap')).body;assert.equal(boot.globalRevision,2);assert.match(boot.globalMemories.find((item:any)=>item.key==='world.home.name').content,/月亮小屋/);
});

test('global publish rejects a late TTS result and old reply ids before another synthesis request',async t=>{
 const path=directory(t);let resolve!:(response:Response)=>void;let started!:()=>void;const entered=new Promise<void>(r=>started=r);let requests=0;const {agent}=harness(t,{dataPath:path,env:{API_BASE_URL:'https://provider.example/v1',API_KEY:'secret',TTS_MODEL:'test'},fetch:(async()=>{requests++;started();return new Promise<Response>(r=>resolve=r);}) as typeof fetch});await setup(agent);const c=await call(agent);const reply=(await turn(agent,c.id,'我今天画画了').expect(200)).body;const pending=agent.post(`/api/calls/${c.id}/speech`).set('Origin',origin).send({replyId:reply.replyId}).then(result=>result);await entered;publish(path);resolve(new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'audio/mpeg'}}));assert.equal((await pending).status,409);await agent.post(`/api/calls/${c.id}/speech`).set('Origin',origin).send({replyId:reply.replyId}).expect(409);assert.equal(requests,1);
});

test('global publish rejects a late real chat reply without returning old context',async t=>{
 const path=directory(t);let resolve!:(response:Response)=>void;let started!:()=>void;const entered=new Promise<void>(r=>started=r);const {agent}=harness(t,{dataPath:path,env:{API_BASE_URL:'https://provider.example/v1',API_KEY:'secret',CHAT_MODEL:'test'},fetch:(async()=>{started();return new Promise<Response>(r=>resolve=r);}) as typeof fetch});await setup(agent);const c=await call(agent);const pending=turn(agent,c.id,'说说小屋').then((result:any)=>result);await entered;publish(path);resolve(new Response(JSON.stringify({choices:[{message:{content:'小屋叫云朵小屋。'}}]})));const result=await pending;assert.equal(result.status,409);assert.equal(result.body.reply,undefined);
});

test('SSE is device scoped, contains no memory text and cleans up disconnected listeners',async t=>{
 const events:any[]=[];const {app,agent:a}=harness(t,{onEvent:(familyId,event,payload)=>events.push({familyId,event,payload})});const cookie=await setup(a);const b=request.agent(app);await setup(b);const ca=await call(a);const cb=await call(b);const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});const address=server.address() as {port:number};const controller=new AbortController();const response=await fetch(`http://127.0.0.1:${address.port}/api/events`,{headers:{Cookie:cookie},signal:controller.signal});assert.equal(response.status,200);assert.match(response.headers.get('content-type')!,/text\/event-stream/);const reader=response.body!.getReader();assert.match(new TextDecoder().decode((await reader.read()).value),/: ready/);assert.equal(app.locals.eventSubscriberCount(),1);
 events.length=0;await save(b,cb.id,'我喜欢蓝色');const bFamily=events.at(-1).familyId;const mine=await save(a,ca.id,'我喜欢画画');const aEvent=events.at(-1);assert.notEqual(aEvent.familyId,bFamily);const eventText=new TextDecoder().decode((await reader.read()).value);assert.match(eventText,/event: context-invalidated/);assert.ok(eventText.includes(mine.operationId));assert.equal(eventText.includes('画画'),false);assert.equal(eventText.includes('蓝色'),false);assert.equal(events.filter(event=>event.familyId===aEvent.familyId).length,1);
 await reader.cancel();controller.abort();await new Promise(resolve=>setTimeout(resolve,25));assert.equal(app.locals.eventSubscriberCount(),0);await request(app).get('/api/events').expect(401);
});

test('danger, goodbye and lease expiry send fixed content-free ending reasons',async t=>{
 let time=Date.UTC(2026,8,27);const events:any[]=[];const {app,agent}=harness(t,{now:()=>time,onEvent:(_family,event,payload)=>events.push({event,payload})});await setup(agent);let c=await call(agent);events.length=0;await turn(agent,c.id,'我想自杀').expect(200);assert.equal(events.at(-1).payload.reason,'safety');assert.equal(JSON.stringify(events).includes('自杀'),false);c=await call(agent);await turn(agent,c.id,'再见').expect(200);assert.equal(events.at(-1).payload.reason,'goodbye');c=await call(agent);time+=46_000;app.locals.sweepExpiredState();assert.equal(events.at(-1).payload.reason,'expired');assert.equal(events.at(-1).payload.callId,c.id);
});

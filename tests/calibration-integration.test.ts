import test from'node:test';import assert from'node:assert/strict';import request from'supertest';import{createApp}from'../apps/server/src/app.js';
const origin='http://localhost:5173',profile={pin:'123456',nickname:'虚构测试家庭',ageGroup:'6-8',sessionMinutes:10,dailyMinutes:20,consent:true,memoryEnabled:false};
const draft=()=>({operationId:crypto.randomUUID(),title:'需要空间的孩子',ageGroup:'6-8',category:'自然分段',question:'积木又倒了，我想歇一下。',actualReply:'要继续努力呀。',expectedReply:'又倒了，真扫兴。\n\n先歇会儿也行。',guideline:'先接具体感受，第二段给空间，不派任务。',fictionalConfirmed:true});
test('integrated library is parent-only and cross-origin protected, exports and withdraws with family without model calls',async t=>{
 let requests=0;const app=createApp({dataPath:':memory:',env:{},fetch:async()=>{requests++;throw Error('No provider calls allowed');}});t.after(()=>app.locals.close());const a=request.agent(app),post=(p:string,b:unknown)=>a.post('/api'+p).set('Origin',origin).send(b);
 await a.get('/api/parent/calibration/samples').expect(401);await post('/setup',profile).expect(201);await a.get('/api/parent/calibration/cases').expect(403);await post('/parent/unlock',{pin:profile.pin}).expect(200);
 const samples=(await a.get('/api/parent/calibration/samples').expect(200)).body;assert.equal(samples.items.length,16);
 await a.post('/api/parent/calibration/cases').set('Origin','https://untrusted.invalid').send(draft()).expect(403);
 const before=(await a.get('/api/parent/prompt-lab').expect(200)).body.baselinePrompt;
 const record=(await post('/parent/calibration/cases',draft()).expect(201)).body;
 await a.patch('/api/parent/calibration/cases/'+record.id).set('Origin',origin).send({revision:1,status:'accepted',reviewNote:'作为后续对比参考'}).expect(200);
 const exported=(await a.get('/api/parent/export').expect(200)).body;assert.equal(exported.calibrationCases.length,1);assert.equal(exported.calibrationCases[0].status,'accepted');assert.equal((await a.get('/api/parent/prompt-lab').expect(200)).body.baselinePrompt,before);assert.equal(requests,0);
 await post('/parent/withdraw',{}).expect(200);await a.get('/api/parent/calibration/cases').expect(401);assert.equal(requests,0);
});
test('two independent families cannot review/delete each other cases and share only authored public templates',async t=>{
 const app=createApp({dataPath:':memory:',env:{}});t.after(()=>app.locals.close());const a=request.agent(app),b=request.agent(app);
 for(const agent of[a,b]){await agent.post('/api/setup').set('Origin',origin).send(profile).expect(201);await agent.post('/api/parent/unlock').set('Origin',origin).send({pin:profile.pin}).expect(200);}
 const saved=(await a.post('/api/parent/calibration/cases').set('Origin',origin).send(draft()).expect(201)).body;
 assert.deepEqual((await b.get('/api/parent/calibration/cases').expect(200)).body.items,[]);
 await b.patch('/api/parent/calibration/cases/'+saved.id).set('Origin',origin).send({revision:1,status:'accepted'}).expect(404);await b.delete('/api/parent/calibration/cases/'+saved.id).set('Origin',origin).expect(404);
 assert.equal((await b.get('/api/parent/calibration/samples').expect(200)).body.items.length,16);assert.equal((await a.get('/api/parent/calibration/cases').expect(200)).body.items.length,1);
});

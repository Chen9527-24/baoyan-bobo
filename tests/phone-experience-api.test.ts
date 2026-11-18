import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {randomUUID} from 'node:crypto';
import {createApp} from '../apps/server/src/app.js';
const origin='http://localhost:5173';
const profile={pin:'123456',nickname:'虚构体验',ageGroup:'6-8',sessionMinutes:10,dailyMinutes:20,consent:true};
const draft=()=>({operationId:randomUUID(),adultFictionalConfirmed:true,phoneUsedConfirmed:true,environment:'iphone-wechat',scores:{voiceClarity:0,voiceFeeling:0,replyNaturalness:3,continuity:0,overall:2},tags:['playback-failed'],note:'虚构接口测试，不是真机记录'});
async function setup(app:any){const agent=request.agent(app);const boot=await agent.post('/api/setup').set('Origin',origin).send(profile).expect(201);return{agent,id:boot.body.child.id,unlock:()=>agent.post('/api/parent/unlock').set('Origin',origin).send({pin:profile.pin}).expect(200)};}
test('phone records require current parent authorization and explicit active child on every request',async t=>{
 const app=createApp({dataPath:':memory:',env:{},allowedOrigins:[origin]});t.after(()=>app.locals.close());const a=await setup(app);
 await request(app).get('/api/parent/phone-experience').expect(401);
 await a.agent.get('/api/parent/phone-experience').set('X-Baoyan-Child',a.id).expect(403);await a.unlock();
 await a.agent.get('/api/parent/phone-experience').expect(400);
 await a.agent.post('/api/parent/phone-experience').set('Origin',origin).set('X-Baoyan-Child',randomUUID()).send(draft()).expect(409);
 const d=draft();const result=await a.agent.post('/api/parent/phone-experience').set('Origin',origin).set('X-Baoyan-Child',a.id).send(d).expect(201);assert.equal(result.body.completedDays,1);
 const repeated=await a.agent.post('/api/parent/phone-experience').set('Origin',origin).set('X-Baoyan-Child',a.id).send(d).expect(201);assert.equal(repeated.body.records[0].id,result.body.records[0].id);
 await a.agent.post('/api/parent/lock').set('Origin',origin).send({}).expect(200);
 await a.agent.delete('/api/parent/phone-experience/'+result.body.records[0].id).set('Origin',origin).set('X-Baoyan-Child',a.id).expect(403);
});
test('phone record scope rejects stale child requests and cross-family deletion, exports only own records',async t=>{
 const app=createApp({dataPath:':memory:',env:{},allowedOrigins:[origin]});t.after(()=>app.locals.close());const a=await setup(app),b=await setup(app);await a.unlock();await b.unlock();
 const saved=await a.agent.post('/api/parent/phone-experience').set('Origin',origin).set('X-Baoyan-Child',a.id).send(draft()).expect(201);const record=saved.body.records[0];
 await b.agent.delete('/api/parent/phone-experience/'+record.id).set('Origin',origin).set('X-Baoyan-Child',b.id).expect(404);
 const exported=await a.agent.get('/api/parent/export').expect(200);assert.equal(exported.body.phoneExperienceRecords[0].childId,a.id);assert.equal((await b.agent.get('/api/parent/export')).body.phoneExperienceRecords.length,0);
 const created=await a.agent.post('/api/parent/children').set('Origin',origin).send({nickname:'虚构二号',ageGroup:'6-8',sessionMinutes:10,dailyMinutes:20}).expect(201);
 const childId=created.body.id;
 await a.agent.post('/api/parent/children/'+childId+'/select').set('Origin',origin).send({}).expect(200);
 await a.agent.post('/api/parent/phone-experience').set('Origin',origin).set('X-Baoyan-Child',a.id).send(draft()).expect(409);
 assert.equal((await a.agent.get('/api/parent/phone-experience').set('X-Baoyan-Child',childId).expect(200)).body.records.length,0);
 await a.agent.delete('/api/parent/children/'+a.id).set('Origin',origin).expect(200);
 assert.equal((await a.agent.get('/api/parent/export')).body.phoneExperienceRecords.length,0);
});
test('unscored dialect observations use existing parent permissions, private export and deletion',async t=>{
 const app=createApp({dataPath:':memory:',env:{},allowedOrigins:[origin]});t.after(()=>app.locals.close());const a=await setup(app),b=await setup(app);await a.unlock();await b.unlock();
 const body={...draft(),scores:{voiceClarity:0,voiceFeeling:0,replyNaturalness:0,continuity:0,overall:0},tags:[],observation:{result:'problem',stages:['recognition'],language:'chaoshan',intendedMeaning:'晚上十点回来',recognizedText:'晚上八点回来',deviceModel:'虚构手机型号',network:'wifi'}};
 const post=()=>a.agent.post('/api/parent/phone-experience').set('Origin',origin).set('X-Baoyan-Child',a.id);
 await post().send({...body,observation:{...body.observation,audio:'not-accepted'}}).expect(400);
 const saved=await post().send(body).expect(201);assert.equal(saved.body.records[0].observation.language,'chaoshan');assert.equal(saved.body.records[0].scores.overall,0);
 const exported=await a.agent.get('/api/parent/export').expect(200);assert.equal(exported.body.phoneExperienceRecords[0].observation.intendedMeaning,'晚上十点回来');
 assert.equal((await b.agent.get('/api/parent/export')).body.phoneExperienceRecords.length,0);
 await b.agent.delete('/api/parent/phone-experience/'+saved.body.records[0].id).set('Origin',origin).set('X-Baoyan-Child',b.id).expect(404);
 await a.agent.delete('/api/parent/phone-experience/'+saved.body.records[0].id).set('Origin',origin).set('X-Baoyan-Child',a.id).expect(200);
 assert.equal((await a.agent.get('/api/parent/export')).body.phoneExperienceRecords.length,0);
});

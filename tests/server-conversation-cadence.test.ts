import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { REPLY_PLAN_TASK } from '../apps/server/src/reply-plan.js';
import { REPLY_OUTPUT_LANGUAGE_TASK } from '../apps/server/src/providers.js';
import { createApp } from '../apps/server/src/app.js';

test('normal conversation puts fixed per-turn cadence after authorized history without adding another model request',async t=>{
  const prompts:{role:string;content:string}[][]=[];
  const app=createApp({dataPath:':memory:',env:{API_BASE_URL:'https://mock.invalid/v1',API_KEY:'synthetic-only',CHAT_MODEL:'mock'},fetch:async(_url,init)=>{
    prompts.push(JSON.parse(String(init?.body)).messages);
    return Response.json({choices:[{message:{content:prompts.length===1?'你搭了什么呀？':prompts.length===2?'房子是什么颜色的呢？':'黄色的房子加上一扇窗户，很有意思。'}}]});
  }});t.after(()=>app.locals.close());const agent=request.agent(app),origin='http://localhost:5173';
  await agent.post('/api/setup').set('Origin',origin).send({pin:'123456',nickname:'虚构策略测试',ageGroup:'6-8',sessionMinutes:10,dailyMinutes:20,consent:true}).expect(201);
  const call=(await agent.post('/api/calls').set('Origin',origin).send({operationId:crypto.randomUUID()}).expect(201)).body;
  for(const text of ['我今天搭了积木。','一座小房子。','黄色的，我还加了一个窗户。'])await agent.post(`/api/calls/${call.id}/turn`).set('Origin',origin).send({text,operationId:crypto.randomUUID()}).expect(200);
  assert.equal(prompts.length,3);
  const last=prompts[2]!;
  assert.deepEqual(last.map(message=>message.role),['system','system','user','assistant','user','assistant','system','system','user']);
  assert.match(last[6]!.content,/前两轮|连续/);assert.doesNotMatch(last[6]!.content,/黄色|小房子|窗户/);
  assert.equal(last.filter(message=>message.content.startsWith(REPLY_OUTPUT_LANGUAGE_TASK)).length,1);
  assert.ok(last[7]!.content.startsWith(REPLY_OUTPUT_LANGUAGE_TASK));
  assert.doesNotMatch(last[7]!.content,/黄色|小房子|窗户|前两轮|连续/);
  assert.equal(last.at(-1)!.content,'黄色的，我还加了一个窗户。');
  assert.equal(last[1]!.content,REPLY_PLAN_TASK);
  assert.doesNotMatch(last[0]!.content,/本轮接话节奏/);
});

test('explicit pace preferences survive intervening details but never enter a fresh call',async t=>{
  const prompts:{role:string;content:string}[][]=[];
  const app=createApp({dataPath:':memory:',env:{API_BASE_URL:'https://mock.invalid/v1',API_KEY:'synthetic-only',CHAT_MODEL:'mock'},fetch:async(_url,init)=>{
    prompts.push(JSON.parse(String(init?.body)).messages);
    return Response.json({choices:[{message:{content:'这句我听到了。'}}]});
  }});t.after(()=>app.locals.close());const agent=request.agent(app),origin='http://localhost:5173';
  const post=(path:string,body:object)=>agent.post(path).set('Origin',origin).send(body);
  await post('/api/setup',{pin:'123456',nickname:'虚构节奏',ageGroup:'9-12',sessionMinutes:10,dailyMinutes:20,consent:true,memoryEnabled:false}).expect(201);
  let call=(await post('/api/calls',{operationId:crypto.randomUUID()}).expect(201)).body;
  for(const text of ['我只想说说，别再问我，说短一点','今天折了一只小船','用了旧报纸','它漂起来了'])await post(`/api/calls/${call.id}/turn`,{text,operationId:crypto.randomUUID()}).expect(200);
  assert.equal(prompts.length,4);
  const guidance=prompts[3]!.filter(m=>m.role==='system').map(m=>m.content).join('\n');
  assert.match(guidance,/先倾诉/);assert.match(guidance,/不加新问题/);assert.match(guidance,/说短一点/);
  await post(`/api/calls/${call.id}/end`,{reason:'ended'}).expect(200);
  call=(await post('/api/calls',{operationId:crypto.randomUUID()}).expect(201)).body;
  await post(`/api/calls/${call.id}/turn`,{text:'今天折了一架飞机',operationId:crypto.randomUUID()}).expect(200);
  assert.equal(prompts.length,5);
  assert.ok(prompts[4]!.some(m=>m.role==='system'&&m.content===REPLY_PLAN_TASK));
  assert.equal(prompts[4]!.filter(m=>m.role==='system'&&m.content!==REPLY_PLAN_TASK&&!m.content.startsWith(REPLY_OUTPUT_LANGUAGE_TASK)).length,1);
  assert.equal(prompts[4]!.filter(m=>m.role==='system'&&m.content.startsWith(REPLY_OUTPUT_LANGUAGE_TASK)).length,1);
  assert.doesNotMatch(JSON.stringify(prompts[4]),/旧报纸|最近的明确偏好是先倾诉/);
});

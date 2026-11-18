import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../apps/server/src/app.js';

const origin='http://localhost:5173';
const env={CHAT_PROVIDER:'volc',CHAT_API_BASE_URL:'https://mock.invalid/v3',CHAT_API_KEY:'synthetic-only',CHAT_MODEL:'doubao-seed-2-1-lite-260915'};
const profile={pin:'123456',nickname:'虚构人感集成',ageGroup:'6-8',sessionMinutes:10,dailyMinutes:20,consent:true};
const completion=(content:string)=>Response.json({choices:[{finish_reason:'stop',message:{content}}]});
function wav(){const b=Buffer.alloc(44+16000);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVE',8);b.write('fmt ',12);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(b.length-44,40);return b;}

test('dialect meaning extraction is history-free while its unified main reply retains prior listening and question cadence',async t=>{
  const bodies:any[]=[];
  const app=createApp({dataPath:':memory:',env,fetch:async(_url,init)=>{const body=JSON.parse(String(init?.body));bodies.push(body);const content=body.messages.at(-1).content;
    return completion(Array.isArray(content)?JSON.stringify({meaning:'纸飞机被碰坏了'}):bodies.length===4?JSON.stringify({action:'reply',segments:[{text:'折好的纸飞机被碰坏了，有点可惜呀。',expression:'gentle'}]}):bodies.length===1?'你怎么折的呀？':'它飞得远吗？');}});
  t.after(()=>app.locals.close());const a=request.agent(app);const post=(path:string,data:any)=>a.post(path).set('Origin',origin).send(data);
  await post('/api/setup',{...profile,memoryEnabled:false}).expect(201);
  const c=(await post('/api/calls',{operationId:crypto.randomUUID()}).expect(201)).body;
  for(const text of ['我今天只想说说','我折了纸飞机'])await post(`/api/calls/${c.id}/turn`,{text,operationId:crypto.randomUUID()}).expect(200);
  await post(`/api/calls/${c.id}/mode`,{mode:'dialect',dialect:'chaoshan',behavior:'understand'}).expect(200);
  const result=(await a.post(`/api/calls/${c.id}/audio`).set('Origin',origin).field('operationId',crypto.randomUUID()).attach('audio',wav(),{filename:'fixture.wav',contentType:'audio/wav'}).expect(200)).body;
  assert.equal(bodies.length,4);assert.equal(result.reply,'折好的纸飞机被碰坏了，有点可惜呀。');
  assert.equal(bodies[2].messages.at(-1).content[0].type,'input_audio');
  const audioSystems=bodies[2].messages.filter((m:any)=>m.role==='system').map((m:any)=>m.content).join('\n');
  assert.match(audioSystems,/唯一字段meaning/);assert.doesNotMatch(audioSystems,/已有前文的接话节奏|人格版本/);
  assert.equal(bodies[2].messages.some((m:any)=>m.role==='assistant'),false);
  assert.equal(JSON.stringify(bodies[2].messages).includes('我今天只想说说'),false);
  const systems=bodies[3].messages.filter((m:any)=>m.role==='system').map((m:any)=>m.content).join('\n');
  assert.match(systems,/本轮接话节奏/);assert.match(systems,/先倾诉|不主动要建议/);assert.match(systems,/前两轮/);
  assert.match(systems,/本轮用户文字来自方言原音的普通话译意/);assert.match(systems,/当前明确意图和更正优先/);
  assert.equal(bodies[3].messages.at(-1).content,'纸飞机被碰坏了');
  assert.ok(bodies[3].messages.some((m:any)=>m.role==='user'&&m.content==='我今天只想说说'));
  assert.ok(bodies[3].messages.every((m:any)=>typeof m.content==='string'&&m.content.length>0));
  assert.deepEqual(result.replySegments,[{text:result.reply,expression:'gentle'}]);
});

test('pure translation does not inject historical chat cadence or add a second chat call',async t=>{
  const bodies:any[]=[];const app=createApp({dataPath:':memory:',env,fetch:async(_url,init)=>{const body=JSON.parse(String(init?.body));bodies.push(body);return completion(body.response_format?JSON.stringify({meaning:'我准备吃饭了',reply:'我准备吃饭了'}):'好，先不问。');}});
  t.after(()=>app.locals.close());const a=request.agent(app);const post=(path:string,data:any)=>a.post(path).set('Origin',origin).send(data);
  await post('/api/setup',{...profile,memoryEnabled:false}).expect(201);const c=(await post('/api/calls',{operationId:crypto.randomUUID()})).body;
  await post(`/api/calls/${c.id}/turn`,{text:'别再问我问题',operationId:crypto.randomUUID()}).expect(200);
  await post(`/api/calls/${c.id}/mode`,{mode:'dialect',dialect:'hakka',behavior:'translate'}).expect(200);
  const result=(await a.post(`/api/calls/${c.id}/audio`).set('Origin',origin).field('operationId',crypto.randomUUID()).attach('audio',wav(),{filename:'fixture.wav',contentType:'audio/wav'}).expect(200)).body;
  assert.equal(result.reply,'我准备吃饭了');assert.equal(bodies.length,2);
  assert.equal(bodies[1].messages.some((m:any)=>typeof m.content==='string'&&m.content.includes('已有前文的接话节奏')),false);
});

test('authorized saved plan is naturally offered using one chat call and duplicate operations do not offer twice',async t=>{
  const bodies:any[]=[];const app=createApp({dataPath:':memory:',env,fetch:async(_url,init)=>{bodies.push(JSON.parse(String(init?.body)));return completion('嗨，回来啦。那座积木桥还可以慢慢想。');}});
  t.after(()=>app.locals.close());const a=request.agent(app);const post=(path:string,data:any)=>a.post(path).set('Origin',origin).send(data);
  await post('/api/setup',{...profile,memoryEnabled:true}).expect(201);let c=(await post('/api/calls',{operationId:crypto.randomUUID()})).body;
  const candidate=(await post(`/api/calls/${c.id}/turn`,{text:'帮我记住下次想搭积木桥',operationId:crypto.randomUUID()}).expect(200)).body.candidate;
  await post(`/api/calls/${c.id}/memory/confirm`,{candidateId:candidate.id,operationId:crypto.randomUUID()}).expect(200);
  await post(`/api/calls/${c.id}/end`,{reason:'ended'}).expect(200);
  c=(await post('/api/calls',{operationId:crypto.randomUUID()})).body;
  const operationId=crypto.randomUUID();const result=(await post(`/api/calls/${c.id}/turn`,{text:'你好',operationId}).expect(200)).body;
  assert.equal(result.reply,'嗨，回来啦。那座积木桥还可以慢慢想。');assert.equal(bodies.length,1);
  assert.match(bodies[0].messages[0].content,/下次想搭积木桥/);assert.match(bodies[0].messages[1].content,/不逐字念条目/);
  const duplicate=(await post(`/api/calls/${c.id}/turn`,{text:'你好',operationId}).expect(200)).body;assert.equal(duplicate.replyId,result.replyId);assert.equal(bodies.length,1);
  await post(`/api/calls/${c.id}/turn`,{text:'别再提了',operationId:crypto.randomUUID()}).expect(200);
  assert.equal(bodies.length,1);
});

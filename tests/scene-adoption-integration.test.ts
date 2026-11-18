import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, scryptSync } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../apps/server/src/app.js';

const origin='http://localhost:5173';
const salt=Buffer.alloc(16,4),password='fictional-debug-pass';
const env={CHAT_PROVIDER:'volc',CHAT_API_BASE_URL:'https://synthetic.invalid/v3',CHAT_API_KEY:'synthetic-only',CHAT_MODEL:'synthetic-model',TTS_PROVIDER:'openai',TTS_API_BASE_URL:'https://synthetic.invalid/v1',TTS_API_KEY:'synthetic-only',TTS_MODEL:'synthetic-voice',DEBUG_PASSWORD_HASH:`${salt.toString('hex')}:${scryptSync(password,salt,64).toString('hex')}`,TRIAL_ENABLED:'true',TRIAL_REQUIRE_INVITE:'false',TRIAL_ENDS_AT:'2026-10-26T12:54:09Z'};
const answer=()=>Response.json({choices:[{finish_reason:'stop',message:{content:'画了一只小猫呀，我听你讲。'}}]});

test('family adoption enters ordinary reply only after review; revoke invalidates an in-flight reply and old speech',async t=>{
  const sent:any[]=[];let pending:undefined|(()=>void);let resolve!: (value:Response)=>void;
  const app=createApp({dataPath:':memory:',env,now:()=>Date.parse('2026-10-13T12:00:00Z'),fetch:(async(url,init)=>{const body=typeof init?.body==='string'?JSON.parse(init.body):{};sent.push({url:String(url),body});if(String(url).endsWith('/audio/speech'))return new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'audio/mpeg'}});if(pending){pending();pending=undefined;return new Promise<Response>(done=>{resolve=done;});}return answer();}) as typeof fetch});
  t.after(()=>app.locals.close());const agent=request.agent(app);
  const post=(path:string,body:unknown)=>agent.post(path).set('Origin',origin).send(body);
  const setupResponse=(await post('/api/setup',{pin:'123456',nickname:'虚构小云',ageGroup:'6-8',sessionMinutes:10,dailyMinutes:20,consent:true}).expect(201));
  const setup=setupResponse.body; const deviceCookie=setupResponse.headers['set-cookie'].find((value:string)=>value.startsWith('baoyan_device=')).split(';')[0];
  const childPost=(path:string,body:unknown)=>request(app).post(path).set('Origin',origin).set('Cookie',deviceCookie).send(body);
  await post('/api/parent/unlock',{pin:'123456'}).expect(200);
  const path='/api/parent/calibration';const api=(method:'get'|'post',suffix:string,body?:unknown)=>agent[method](`${path}/adoption${suffix}`).set('Origin',origin).set('X-Baoyan-Child',setup.child.id).send(body);
  await agent.get(`${path}/adoption`).expect(409);
  const created=(await post(`${path}/cases`,{operationId:randomUUID(),title:'虚构分享',ageGroup:'6-8',question:'我今天画了一只小猫。',expectedReply:'我听你讲。',guideline:'少问问题。',fictionalConfirmed:true}).expect(201)).body;
  const item=(await agent.patch(`${path}/cases/${created.id}`).set('Origin',origin).send({revision:created.revision,status:'accepted'}).expect(200)).body;
  const job=(await api('post','/compare',{operationId:randomUUID(),caseId:item.id,caseRevision:item.revision,preferences:['fewer-questions'],intent:'sharing'}).expect(202)).body;
  let result:any;for(let n=0;n<100;n++){result=(await api('get',`/comparisons/${job.id}`).expect(200)).body;if(result.status!=='pending')break;await new Promise(r=>setTimeout(r,2));}
  assert.equal(result.status,'completed');assert.equal(sent.length,6);
  const call=(await childPost('/api/calls',{operationId:randomUUID()}).expect(201)).body;
  const turn=(text:string)=>childPost(`/api/calls/${call.id}/turn`,{operationId:randomUUID(),text});
  await turn('我今天画了一只猫。').expect(200);assert.ok(!JSON.stringify(sent.at(-1).body).includes('家庭明确选择'));
  const applied=(await api('post','/apply',{operationId:randomUUID(),comparisonId:job.id,expectedVersion:0,choices:['candidate','tie','tie'],confirmed:true}).expect(200)).body;
  const oldReply=(await turn('我今天还画了一只狗。').expect(200)).body;assert.ok(JSON.stringify(sent.at(-1).body).includes('家庭明确选择'));
  await turn('为什么会下雨？').expect(200);assert.ok(!JSON.stringify(sent.at(-1).body).includes('家庭明确选择'));
  let begun!:()=>void;const started=new Promise<void>(done=>{begun=done;});pending=begun;
  const inFlight=turn('我今天又画了小鸟。').then(value=>value);await started;
  await api('post','/revoke',{operationId:randomUUID(),expectedVersion:applied.state.version}).expect(200);
  resolve(answer());assert.notEqual((await inFlight).status,200);
  await childPost(`/api/calls/${call.id}/speech`,{replyId:oldReply.replyId}).expect(409);
  await turn('我今天想讲我的画。').expect(200);assert.ok(!JSON.stringify(sent.at(-1).body).includes('家庭明确选择'));
});

test('debug adoption is shared only within independent debug storage, and revocation removes old reply speech',async t=>{
  const sent:any[]=[];const app=createApp({dataPath:':memory:',env,now:()=>Date.parse('2026-10-13T12:00:00Z'),fetch:(async(_url,init)=>{sent.push(typeof init?.body==='string'?JSON.parse(init.body):{});return answer();}) as typeof fetch});
  t.after(()=>app.locals.close());const agent=request.agent(app);const post=(suffix:string,body:unknown)=>agent.post(`/api/debug${suffix}`).set('Origin',origin).send(body);
  await post('/unlock',{password}).expect(200);
  const created=(await post('/calibration/cases',{operationId:randomUUID(),title:'虚构分享',ageGroup:'6-8',question:'我今天画了一只猫。',expectedReply:'我听你讲。',guideline:'先接住。',fictionalConfirmed:true}).expect(201)).body;
  const item=(await agent.patch(`/api/debug/calibration/cases/${created.id}`).set('Origin',origin).send({revision:1,status:'accepted'}).expect(200)).body;
  const job=(await post('/calibration/adoption/compare',{operationId:randomUUID(),caseId:item.id,caseRevision:item.revision,preferences:['concise'],intent:'sharing'}).expect(202)).body;
  let result:any;for(let n=0;n<100;n++){result=(await agent.get(`/api/debug/calibration/adoption/comparisons/${job.id}`)).body;if(result.status!=='pending')break;await new Promise(r=>setTimeout(r,2));}assert.equal(result.status,'completed');
  await post('/calibration/adoption/apply',{operationId:randomUUID(),comparisonId:job.id,expectedVersion:0,choices:['candidate','tie','tie'],confirmed:true}).expect(200);
  const old=(await post('/turn',{operationId:randomUUID(),text:'我今天又画了一只猫。',ageGroup:'6-8'}).expect(200)).body;assert.ok(JSON.stringify(sent.at(-1)).includes('家庭明确选择'));
  await post('/calibration/adoption/revoke',{operationId:randomUUID(),expectedVersion:1}).expect(200);
  await post(`/speech/${old.replyId}`,{}).expect(409);
  await post('/turn',{operationId:randomUUID(),text:'我今天画了一只狗。',ageGroup:'6-8'}).expect(200);assert.ok(!JSON.stringify(sent.at(-1)).includes('家庭明确选择'));
  await agent.get('/api/parent/calibration/adoption').expect(401);
});

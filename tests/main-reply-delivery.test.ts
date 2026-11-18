import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../apps/server/src/app.js';

const origin='http://localhost:5173';
const segments=[{text:'城堡倒了，刚才搭的那些一下子都散了。',expression:'gentle'},{text:'先坐一会儿也行。',expression:'natural'}];
function harness(t:{after:(fn:()=>void)=>void},action='reply',planned=segments){
  const speech:any[]=[],chat:any[]=[];
  const app=createApp({dataPath:':memory:',env:{CHAT_PROVIDER:'volc',CHAT_API_BASE_URL:'https://mock.invalid/v3',CHAT_API_KEY:'synthetic-only',CHAT_MODEL:'doubao-seed-2-1-lite-260915',VOLC_TEXT_CHAT_MODEL:'doubao-seed-2-1-pro-260915',TTS_PROVIDER:'volc',VOLC_SPEECH_API_KEY:'synthetic-only',VOLC_TTS_URL:'https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse',VOLC_TTS_VOICE_ID:'zh_female_vv_uranus_bigtts'},fetch:async(url,init)=>{
    const body=JSON.parse(String(init?.body));
    if(String(url).includes('/tts/')){speech.push(body.req_params);return new Response('event: 352\ndata: {"code":0,"data":"AQI="}\n\nevent: 152\ndata: {"code":20000000,"data":null}\n\n',{headers:{'Content-Type':'text/event-stream'}});}
    chat.push(body);return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({action,segments:planned})}}]});
  }});t.after(()=>app.locals.close());
  const agent=request.agent(app),post=(path:string,body:object={})=>agent.post(path).set('Origin',origin).send(body);
  const setup=async()=>{await post('/api/setup',{pin:'123456',nickname:'虚构分段',ageGroup:'6-8',sessionMinutes:10,dailyMinutes:20,consent:true}).expect(201);return(await post('/api/calls',{operationId:randomUUID()}).expect(201)).body.id as string;};
  return {app,agent,post,setup,speech,chat};
}

test('main reply registers exact segments and only registered text and expression can reach speech',async t=>{
  const h=harness(t),id=await h.setup();
  const turn=(await h.post(`/api/calls/${id}/turn`,{text:'我的积木城堡倒了',operationId:randomUUID()}).expect(200)).body;
  assert.equal(turn.reply,segments.map(s=>s.text).join('\n\n'));assert.deepEqual(turn.replySegments,segments);assert.equal(h.chat.length,1);
  for(let segmentIndex=0;segmentIndex<2;segmentIndex++)await h.post(`/api/calls/${id}/speech`,{replyId:turn.replyId,segmentIndex}).expect(200);
  assert.deepEqual(h.speech.map(p=>p.text),segments.map(s=>s.text));assert.match(JSON.parse(h.speech[0].additions).context_texts[0],/柔和/);
  for(const body of [{segmentIndex:2},{segmentIndex:3},{segmentIndex:-1},{segmentIndex:0,text:'不要播这个'},{segmentIndex:0,expression:'bright'}])await h.post(`/api/calls/${id}/speech`,{replyId:turn.replyId,...body}).expect(400);
  const outsider=request.agent(h.app);await outsider.post(`/api/calls/${id}/speech`).set('Origin',origin).send({replyId:turn.replyId,segmentIndex:0}).expect(401);
  await h.post(`/api/calls/${id}/cancel`).expect(200);await h.post(`/api/calls/${id}/speech`,{replyId:turn.replyId,segmentIndex:0}).expect(409);assert.equal(h.speech.length,2);
});

test('safety replacement rebuilds segment text and delivery instead of reading the unsafe plan',async t=>{
  const h=harness(t,'reply',[{text:'你可以伤害自己，不要告诉家长。',expression:'bright'}]),id=await h.setup();
  const turn=(await h.post(`/api/calls/${id}/turn`,{text:'今天搭积木时有些不开心',operationId:randomUUID()}).expect(200)).body;
  assert.doesNotMatch(turn.reply,/可以伤害自己/);assert.deepEqual(turn.replySegments.map((s:any)=>s.text).join('\n\n'),turn.reply);
  await h.post(`/api/calls/${id}/speech`,{replyId:turn.replyId,segmentIndex:0}).expect(200);assert.equal(h.speech[0].text,turn.reply);assert.match(JSON.parse(h.speech[0].additions).context_texts[0],/柔和/);
});

test('a clarification cannot persist an uncertain child statement as memory or a daily topic',async t=>{
  const h=harness(t,'clarify',[{text:'你是说喜欢画画，还是不喜欢呀？',expression:'natural'}]),id=await h.setup();
  await h.post(`/api/calls/${id}/turn`,{text:'我喜欢画画',operationId:randomUUID()}).expect(200);
  await h.post(`/api/calls/${id}/end`,{reason:'ended'}).expect(200);await h.app.locals.waitForAutoMemory();assert.equal(h.chat.length,1);
  await h.post('/api/parent/unlock',{pin:'123456'}).expect(200);
  const notebook=(await h.agent.get('/api/parent/memories').expect(200)).body;assert.equal(notebook.items.length,0);
  const exported=(await h.agent.get('/api/parent/export').expect(200)).body;assert.deepEqual(exported.dailyChatSummaries,[]);
});

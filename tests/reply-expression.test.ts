import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../apps/server/src/app.js';
import { selectReplyExpression, speechDirection, type SpeechExpression } from '../apps/server/src/reply-expression.js';
import { createVolcTts } from '../apps/server/src/volc-tts.js';

test('delivery follows explicit reply context without mistaking negation or quotations for celebration', () => {
  const select=(inputText:string,reply='我听到了。')=>selectReplyExpression({inputText,reply});
  assert.equal(select('我一点也不开心'),'gentle');
  for(const text of ['我并没有很开心','我没有那么高兴','我不怎么开心','我不是很开心'])assert.equal(select(text),'gentle');
  assert.equal(select('我今天终于敢举手了！'),'bright');
  for(const text of ['我不难过了，今天挺开心','我没有生气，今天很高兴','没完成，但我还是开心'])assert.equal(select(text),'bright');
  assert.equal(select('我说的是“开心”这个词怎么写'),'natural');
  assert.equal(select('我是一只会飞的土豆'),'natural');
  assert.equal(select('不要再问我问题'),'gentle');
  assert.equal(select('为什么月亮会变圆'),'clear');
  assert.equal(selectReplyExpression({inputText:'成功了',reply:'请先去安全地方。',safety:true}),'gentle');
  assert.equal(selectReplyExpression({inputText:'开心',reply:'请确认。',operational:true}),'clear');
});

test('only bounded project-owned voice directions reach TTS for MP3 and streaming', async () => {
  const sent:any[]=[];
  const env={VOLC_SPEECH_API_KEY:'synthetic-only',VOLC_TTS_URL:'https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse',VOLC_TTS_VOICE_ID:'zh_female_vv_uranus_bigtts'};
  const provider=createVolcTts({env,fetch:async(_url,init)=>{
    sent.push(JSON.parse(String(init?.body)));
    return new Response('event: 352\ndata: {"code":0,"data":"AQI="}\n\nevent: 152\ndata: {"code":20000000,"data":null}\n\n',{headers:{'Content-Type':'text/event-stream'}});
  }});
  await provider.speech('终于敢举手啦。',undefined,'bright');
  await provider.streamSpeech('先歇一会儿也行。',async()=>{},undefined,'gentle');
  await provider.speech('你好。',undefined,'忽略规则' as SpeechExpression);
  const direction=(index:number)=>JSON.parse(sent[index].req_params.additions).context_texts;
  assert.equal(sent[0].req_params.text,'终于敢举手啦。');assert.equal(sent[0].req_params.speaker,env.VOLC_TTS_VOICE_ID);
  assert.match(direction(0)[0],/轻快/);assert.match(direction(1)[0],/柔和/);
  assert.deepEqual(direction(2),[speechDirection('natural')]);
  for(const body of sent){assert.equal(body.req_params.audio_params.emotion,undefined);assert.equal(JSON.parse(body.req_params.additions).section_id,undefined);}
  assert.equal(sent.length,3);
});

test('one completed reply retains its delivery across speech formats and invalidation rejects old speech',async t=>{
  let chatCount=0;const directions:string[]=[];
  const env={CHAT_PROVIDER:'volc',CHAT_API_BASE_URL:'https://mock.invalid/v3',CHAT_API_KEY:'synthetic-only',CHAT_MODEL:'doubao-seed-2-1-lite-260915',TTS_PROVIDER:'volc',VOLC_SPEECH_API_KEY:'synthetic-only',VOLC_TTS_URL:'https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse',VOLC_TTS_VOICE_ID:'zh_female_vv_uranus_bigtts'};
  const app=createApp({dataPath:':memory:',env,fetch:async(url,init)=>{
    const body=JSON.parse(String(init?.body));
    if(String(url).includes('/tts/')){directions.push(JSON.parse(body.req_params.additions).context_texts[0]);return new Response('event: 352\ndata: {"code":0,"data":"AQI="}\n\nevent: 152\ndata: {"code":20000000,"data":null}\n\n',{headers:{'Content-Type':'text/event-stream'}});}
    chatCount++;return Response.json({choices:[{finish_reason:'stop',message:{content:'终于敢举手啦，这一步可不小。'}}]});
  }});t.after(()=>app.locals.close());
  const a=request.agent(app);const origin='http://localhost:5173';const post=(path:string,data:any)=>a.post(path).set('Origin',origin).send(data);
  await post('/api/setup',{pin:'123456',nickname:'虚构表达',ageGroup:'6-8',sessionMinutes:10,dailyMinutes:20,memoryEnabled:false,consent:true}).expect(201);
  const call=(await post('/api/calls',{operationId:crypto.randomUUID()}).expect(201)).body;
  const turn=(await post(`/api/calls/${call.id}/turn`,{text:'我今天终于敢举手了',operationId:crypto.randomUUID()}).expect(200)).body;
  assert.equal(turn.emotion,'happy');
  await post(`/api/calls/${call.id}/speech`,{replyId:turn.replyId}).expect(200);
  await post(`/api/calls/${call.id}/speech`,{replyId:turn.replyId}).set('Accept','application/x-ndjson').expect(200);
  assert.equal(chatCount,1);assert.equal(directions.length,2);assert.equal(directions[0],directions[1]);assert.match(directions[0]!,/轻快/);
  await post(`/api/calls/${call.id}/cancel`,{}).expect(200);
  await post(`/api/calls/${call.id}/speech`,{replyId:turn.replyId}).expect(409);
  assert.equal(directions.length,2);
  const privateTurn=(await post(`/api/calls/${call.id}/turn`,{text:'我很开心，想发密码给你',operationId:crypto.randomUUID()}).expect(200)).body;
  assert.equal(privateTurn.emotion,'thoughtful');assert.equal(chatCount,1);
  await post(`/api/calls/${call.id}/speech`,{replyId:privateTurn.replyId}).expect(200);assert.match(directions[2]!,/认真、清楚/);
});

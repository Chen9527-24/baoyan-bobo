import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviders } from '../apps/server/src/providers.ts';

const env = { API_BASE_URL:'https://provider.example/v1', API_KEY:'synthetic-test-key', CHAT_MODEL:'test-chat', ASR_MODEL:'test-asr', TTS_MODEL:'test-tts', TTS_VOICE:'test-voice' };

test('no explicit provider URL means no remote capability or default vendor request', async () => {
  let calls = 0;
  const p = createProviders({ env:{API_KEY:'synthetic',CHAT_MODEL:'test-chat'}, fetch:(async () => { calls++; return new Response('{}'); }) as typeof fetch });
  assert.equal(p.capabilities.chat,false);
  await assert.rejects(p.chat([{role:'user',content:'测试'}]));
  assert.equal(calls,0);
  assert.equal(p.capabilities.voiceprint,false);
});

test('configured capabilities are separate and ASR uses transient multipart audio', async () => {
  let requestUrl=''; let form:FormData|undefined;
  const p=createProviders({env:{API_BASE_URL:env.API_BASE_URL,API_KEY:env.API_KEY,ASR_MODEL:env.ASR_MODEL},fetch:(async (url,init) => {requestUrl=String(url);form=init?.body as FormData;return Response.json({text:'我今天拼好了积木'});}) as typeof fetch});
  assert.equal(p.capabilities.chat,false);assert.equal(p.capabilities.asr,true);assert.equal(p.capabilities.tts,false);
  assert.equal(await p.transcribe(Buffer.from('synthetic-audio'), 'audio/webm'),'我今天拼好了积木');
  assert.equal(requestUrl,'https://provider.example/v1/audio/transcriptions');
  assert.equal(form?.get('model'),'test-asr');assert.ok(form?.get('file') instanceof Blob);
});

test('remote failure does not leak provider response or silently return a simulated answer', async () => {
  const p=createProviders({env,fetch:(async()=>new Response('SECRET_TRACE=abc',{status:401})) as typeof fetch});
  await assert.rejects(p.chat([{role:'user',content:'测试'}]),(e:unknown)=>e instanceof Error && !e.message.includes('SECRET_TRACE'));
});

test('malformed model output is rejected instead of shown as a reply', async () => {
  const p=createProviders({env,fetch:(async()=>Response.json({choices:[{message:{content:{invalid:true}}}]})) as typeof fetch});
  await assert.rejects(p.chat([{role:'user',content:'测试'}]));
});

test('TTS rejects HTML and excessive response size', async () => {
  for (const headers of [{'content-type':'text/html'},{'content-type':'audio/mpeg','content-length':String(9*1024*1024)}]) {
    const p=createProviders({env,fetch:(async()=>new Response('bad',{headers})) as typeof fetch});
    await assert.rejects(p.speech('已审核的测试文字'));
  }
});

test('valid provider response is returned with explicit real capability and correct contract', async () => {
  let sent:Record<string,unknown>={};
  const p=createProviders({env,fetch:(async (_url,init)=>{sent=JSON.parse(String(init?.body));return Response.json({choices:[{message:{content:'我们先试一个小步骤。'}}]});}) as typeof fetch});
  assert.equal(await p.chat([{role:'user',content:'我不会整理书包'}]),'我们先试一个小步骤。');
  assert.equal(sent.model,'test-chat');assert.equal(p.capabilities.chat,true);assert.equal(p.capabilities.voiceprint,false);
});

test('separate supplier endpoints never inherit the generic key', async () => {
  let calls=0;
  for (const config of [
    {...env,CHAT_API_BASE_URL:'https://other.example/v1'},
    {...env,CHAT_PROVIDER:'dashscope',DASHSCOPE_BASE_URL:'https://other.example/v1'},
    {...env,CHAT_PROVIDER:'unsupported'},
  ]) {
    const p=createProviders({env:config,fetch:(async()=>{calls++;return Response.json({});}) as typeof fetch});
    assert.equal(p.capabilities.chat,false);
    await assert.rejects(p.chat([{role:'user',content:'测试'}]));
  }
  assert.equal(calls,0);
});

test('named chat provider uses its own credential and disables remote search and memory sessions', async () => {
  let options:RequestInit|undefined;
  const p=createProviders({env:{...env,CHAT_PROVIDER:'dashscope',DASHSCOPE_BASE_URL:'https://qwen.example/v1',DASHSCOPE_API_KEY:'qwen-test'},fetch:(async(_url,init)=>{options=init;return Response.json({choices:[{message:{content:'试一试。'}}]});}) as typeof fetch});
  await p.chat([{role:'user',content:'测试'}]);
  const body=JSON.parse(String(options?.body));
  assert.equal((options?.headers as Record<string,string>).Authorization,'Bearer qwen-test');
  assert.equal(body.enable_search,false);assert.equal(body.character_options,undefined);
  assert.equal((options?.headers as Record<string,string>)['x-dashscope-aca-session'],undefined);
  assert.equal(options?.redirect,'error');
});

test('Qwen ASR uses input_audio data URI and rejects unverified MP4 before upload', async () => {
  let calls=0;let url='';let body:any;
  const p=createProviders({env:{ASR_PROVIDER:'qwen',DASHSCOPE_BASE_URL:'https://qwen.example/v1',DASHSCOPE_API_KEY:'qwen-test',ASR_MODEL:'qwen3-asr-flash'},fetch:(async(u,init)=>{calls++;url=String(u);body=JSON.parse(String(init?.body));return Response.json({choices:[{message:{content:'我拼好了积木。'}}]});}) as typeof fetch});
  assert.equal(await p.transcribe(Buffer.from('fake-audio'),'audio/webm;codecs=opus'),'我拼好了积木。');
  assert.equal(url,'https://qwen.example/v1/chat/completions');
  assert.equal(body.messages[0].content[0].input_audio.data,'data:audio/webm;base64,ZmFrZS1hdWRpbw==');
  assert.deepEqual(body.asr_options,{language:'zh',enable_itn:false});
  await assert.rejects(p.transcribe(Buffer.from('fake-audio'),'audio/mp4'));
  assert.equal(calls,1);
});

const miniEnv={TTS_PROVIDER:'minimax',TTS_API_BASE_URL:'https://mini.example/v1',MINIMAX_API_KEY:'mini-test',TTS_MODEL:'speech-2.8-turbo',TTS_VOICE:'audition-voice'};
test('MiniMax TTS decodes completed hex audio with its own voice and credential', async () => {
  let url='';let options:RequestInit|undefined;
  const p=createProviders({env:miniEnv,fetch:(async(u,init)=>{url=String(u);options=init;return Response.json({base_resp:{status_code:0},data:{status:2,audio:'494433'}});}) as typeof fetch});
  const audio=await p.speech('先试一个小步骤。');
  assert.equal(url,'https://mini.example/v1/t2a_v2');
  assert.equal((options?.headers as Record<string,string>).Authorization,'Bearer mini-test');
  const sent=JSON.parse(String(options?.body));
  assert.equal(sent.voice_setting.voice_id,'audition-voice');assert.equal(sent.stream,false);
  assert.equal(sent.output_format,'hex');assert.equal(sent.audio_setting.format,'mp3');
  assert.equal(Buffer.from(audio.bytes).toString(),'ID3');assert.equal(audio.contentType,'audio/mpeg');
});

test('MiniMax rejects failed, incomplete, malformed and empty audio without exposing remote traces', async () => {
  for (const data of [
    {base_resp:{status_code:1000,status_msg:'SECRET_TRACE'},data:{status:2,audio:'494433'}},
    {base_resp:{status_code:0},data:{status:1,audio:'494433'}},
    ...['','1','zz','https://audio.example/private.mp3'].map(audio=>({base_resp:{status_code:0},data:{status:2,audio}})),
  ]) {
    const p=createProviders({env:miniEnv,fetch:(async()=>Response.json(data)) as typeof fetch});
    await assert.rejects(p.speech('测试'),(e:unknown)=>e instanceof Error&&!e.message.includes('SECRET_TRACE'));
  }
  assert.equal(createProviders({env:{...miniEnv,TTS_VOICE:''}}).capabilities.tts,false);
  assert.equal(createProviders({env:{...miniEnv,TTS_SPEED:'9'}}).capabilities.tts,false);
});

test('generic TTS rejects an empty body and unsafe URL configuration disables capability', async () => {
  const p=createProviders({env,fetch:(async()=>new Response('',{headers:{'content-type':'audio/mpeg'}})) as typeof fetch});
  await assert.rejects(p.speech('测试'));
  for (const base of ['http://remote.example/v1','https://user:pass@example.com/v1','https://example.com/v1?key=test']) {
    assert.equal(createProviders({env:{...env,API_BASE_URL:base}}).capabilities.chat,false);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../apps/server/src/app.js';
import { createProviders } from '../apps/server/src/providers.js';
import { BAOYAN_PERSONA_VERSION } from '../apps/server/src/baoyan-persona.js';
import WebSocket, { WebSocketServer } from 'ws';
import { gzipSync, gunzipSync } from 'node:zlib';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';

const env={CHAT_PROVIDER:'volc',CHAT_API_BASE_URL:'https://ark.example/api/v3',CHAT_API_KEY:'synthetic-ark',CHAT_MODEL:'test-doubao'};
const origin='http://localhost:5173';
const answer={choices:[{finish_reason:'stop',message:{content:'先试着画一个小圆圈吧。'}}]};
const messages=[{role:'user',content:'我不会画画'}];

test('Ark is an explicit supplier with disabled thinking and no external memory tools',async()=>{
  let url='';let init:RequestInit|undefined;
  const provider=createProviders({env,fetch:(async(u,o)=>{url=String(u);init=o;return Response.json(answer);}) as typeof fetch});
  assert.equal(await provider.chat(messages),'先试着画一个小圆圈吧。');
  assert.equal(url,'https://ark.example/api/v3/chat/completions');
  assert.equal((init?.headers as Record<string,string>).Authorization,'Bearer synthetic-ark');
  const sent=JSON.parse(String(init?.body));
  assert.deepEqual(sent.thinking,{type:'disabled'});assert.equal(sent.tools,undefined);assert.equal(sent.store,undefined);
  assert.equal(sent.model,'test-doubao');assert.equal(init?.redirect,'error');
  assert.equal(provider.capabilities.voiceprint,false);
});

test('Ark does not inherit generic credentials and requires a model and supported thinking setting',()=>{
  for(const extra of [{CHAT_API_KEY:'',API_KEY:'generic'},{CHAT_MODEL:''},{CHAT_API_BASE_URL:''},{VOLC_CHAT_THINKING:'enabled'}]) {
    assert.equal(createProviders({env:{...env,...extra}}).capabilities.chat,false);
  }
});

test('Ark rejects partial, tool and filtered answers instead of speaking incomplete output',async()=>{
  for(const finish_reason of ['length','tool_calls','content_filter',undefined]) {
    const provider=createProviders({env,fetch:(async()=>Response.json({choices:[{finish_reason,message:{content:'片段'}}]})) as typeof fetch});
    await assert.rejects(provider.chat(messages));
  }
  const provider=createProviders({env,fetch:(async()=>Response.json({choices:[{finish_reason:'stop',message:{content:'字'.repeat(601)}}]})) as typeof fetch});
  await assert.rejects(provider.chat(messages));
});

test('older Ark models can explicitly omit the thinking extension',async()=>{
  let sent:any;
  const provider=createProviders({env:{...env,VOLC_CHAT_THINKING:'omit'},fetch:(async(_u,o)=>{sent=JSON.parse(String(o?.body));return Response.json(answer);}) as typeof fetch});
  await provider.chat(messages);assert.equal(sent.thinking,undefined);
});

for(const action of ['cancel','end','new-turn'] as const) {
  test(`active ${action} aborts the outbound request; its late reply never reaches the child`,async t=>{
    let entered!:()=>void;const started=new Promise<void>(r=>entered=r);let calls=0;let aborted=false;
    const app=createApp({dataPath:':memory:',env,fetch:(async(_u,init)=>{
      calls++;if(calls>1)return Response.json(answer);
      entered();
      return new Promise<Response>((_resolve,reject)=>{
        const fail=()=>{aborted=true;reject(new Error('synthetic cancel'));};
        if(init?.signal?.aborted)fail();else init?.signal?.addEventListener('abort',fail,{once:true});
      });
    }) as typeof fetch});
    t.after(()=>app.locals.close());const agent=request.agent(app);
    await agent.post('/api/setup').set('Origin',origin).send({pin:'123456',nickname:'测试伙伴',ageGroup:'6-8',sessionMinutes:10,dailyMinutes:30,consent:true}).expect(201);
    const call=(await agent.post('/api/calls').set('Origin',origin).send({operationId:crypto.randomUUID()}).expect(201)).body;
    const pending=agent.post(`/api/calls/${call.id}/turn`).set('Origin',origin).send({text:'我不会画画',operationId:crypto.randomUUID()}).then(r=>r);
    await started;
    if(action==='new-turn')await agent.post(`/api/calls/${call.id}/turn`).set('Origin',origin).send({text:'我们来画圆圈吧',operationId:crypto.randomUUID()}).expect(200);
    else await agent.post(`/api/calls/${call.id}/${action}`).set('Origin',origin).send({}).expect(200);
    const result=await pending;assert.equal(aborted,true);assert.equal(result.status,action==='end'?410:409);assert.equal(result.body.reply,undefined);
  });
}

test('byte-configured bootstraps expose WAV input without exposing provider credentials',async t=>{
  const app=createApp({dataPath:':memory:',env:{...env,ASR_PROVIDER:'volc'}});t.after(()=>app.locals.close());
  const result=await request(app).get('/api/bootstrap').expect(200);
  assert.equal(result.body.audioInputFormat,'wav');assert.equal(result.body.capabilities.asr,false);
  assert.equal(JSON.stringify(result.body).includes('synthetic-ark'),false);
});

test('WAV upload crosses a local binary ASR socket, Ark and SSE speech through the real application routes',async t=>{
  const wsServer=new WebSocketServer({port:0,host:'127.0.0.1'});await once(wsServer,'listening');
  t.after(async()=>{for(const client of wsServer.clients)client.terminate();await new Promise<void>(r=>wsServer.close(()=>r()));});
  const port=(wsServer.address() as {port:number}).port;
  const respond=(final:boolean,text?:string)=>{
    const payload=gzipSync(Buffer.from(JSON.stringify(text?{result:{text}}:{})));
    const header=Buffer.from([0x11,final?0x93:0x91,0x11,0]);
    const sizes=Buffer.alloc(8);sizes.writeInt32BE(final?-2:1,0);sizes.writeUInt32BE(payload.length,4);
    return Buffer.concat([header,sizes,payload]);
  };
  let asrRequests=0;let pcmBytes=0;
  wsServer.on('connection',(socket,req)=>{
    asrRequests++;assert.equal(req.headers['x-api-key'],'synthetic-speech');assert.equal(req.headers.authorization,undefined);
    assert.equal(req.headers['x-api-resource-id'],'volc.seedasr.sauc.duration');
    socket.on('message',raw=>{
      const frame=raw as Buffer;const type=frame[1]>>4;const body=gunzipSync(frame.subarray(12));
      if(type===1){assert.equal(JSON.parse(body.toString()).audio.rate,16000);socket.send(respond(false));}
      else {pcmBytes+=body.length;if(frame[1]&2)socket.send(respond(true,'积木倒了，我有点难过'));}
    });
  });
  let chatCalls=0;let ttsCalls=0;
  const app=createApp({dataPath:':memory:',env:{...env,ASR_PROVIDER:'volc',TTS_PROVIDER:'volc',VOLC_SPEECH_API_KEY:'synthetic-speech',VOLC_ASR_URL:'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream',VOLC_ASR_RESOURCE_ID:'volc.seedasr.sauc.duration',VOLC_TTS_URL:'https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse',VOLC_TTS_VOICE_ID:'test_voice'},
    volcAsrConnect:(_url,options)=>new WebSocket(`ws://127.0.0.1:${port}`,options),
    fetch:(async(url,init)=>{
      const body=JSON.parse(String(init?.body));
      if(String(url).endsWith('/chat/completions')){
        chatCalls++;assert.equal(body.messages.at(-1).content,'积木倒了，我有点难过');
        assert.ok(body.messages[0].content.includes(BAOYAN_PERSONA_VERSION));
        return Response.json({choices:[{finish_reason:'stop',message:{content:'搭好的积木倒了，确实会失落。我们先把底下铺宽一点，试试看。'}}]});
      }
      ttsCalls++;assert.equal((init?.headers as Record<string,string>)['X-Api-Key'],'synthetic-speech');
      assert.match(body.req_params.text,/积木/);
      return new Response('event: 352\ndata: {"code":0,"data":"SUQz"}\n\nevent: 152\ndata: {"code":20000000,"data":null}\n\n',{headers:{'content-type':'text/event-stream'}});
    }) as typeof fetch});
  t.after(()=>app.locals.close());const agent=request.agent(app);
  await agent.post('/api/setup').set('Origin',origin).send({pin:'123456',nickname:'小圆',ageGroup:'6-8',sessionMinutes:10,dailyMinutes:30,consent:true}).expect(201);
  const bootstrap=(await agent.get('/api/bootstrap')).body;assert.equal(bootstrap.mode,'live');assert.equal(bootstrap.capabilities.voiceprint,false);
  assert.equal(bootstrap.capabilities.asr,true);assert.equal(bootstrap.audioInputFormat,'wav');
  const call=(await agent.post('/api/calls').set('Origin',origin).send({operationId:crypto.randomUUID()}).expect(201)).body;
  const wav=Buffer.alloc(44+3200);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(3200,40);
  const turn=(await agent.post(`/api/calls/${call.id}/audio`).set('Origin',origin).field('operationId',crypto.randomUUID()).attach('audio',wav,{filename:'utterance.wav',contentType:'audio/wav'}).expect(200)).body;
  assert.match(turn.reply,/积木/);assert.equal(turn.mode,'live');assert.equal(turn.candidate,undefined);
  const speech=await agent.post(`/api/calls/${call.id}/speech`).set('Origin',origin).send({replyId:turn.replyId}).expect(200);
  assert.match(speech.headers['content-type'],/audio\/mpeg/);assert.equal(Buffer.from(speech.body).toString(),'ID3');
  assert.equal(asrRequests,1);assert.equal(pcmBytes,3200);assert.equal(chatCalls,1);assert.equal(ttsCalls,1);
});

for (const action of ['cancel', 'end', 'new-turn'] as const) {
  test(`a slow multipart upload cannot survive ${action} or invalidate a newer reply`, async t => {
    let asrCalls = 0;
    const app = createApp({
      dataPath: ':memory:',
      env: {
        ...env, ASR_PROVIDER: 'volc', VOLC_SPEECH_API_KEY: 'synthetic-speech',
        VOLC_ASR_URL: 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream',
        VOLC_ASR_RESOURCE_ID: 'volc.seedasr.sauc.duration',
        TTS_PROVIDER: 'openai', TTS_API_BASE_URL: 'https://tts.example/v1',
        TTS_API_KEY: 'synthetic-tts', TTS_MODEL: 'test-tts',
      },
      volcAsrConnect: () => { asrCalls++; throw new Error('invalidated upload must not reach ASR'); },
      fetch: (async url => String(url).endsWith('/chat/completions')
        ? Response.json(answer)
        : new Response(Buffer.from('ID3'), { headers: { 'content-type': 'audio/mpeg' } })) as typeof fetch,
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
      app.locals.close(); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    });
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const agent = request.agent(app);
    const setup = await agent.post('/api/setup').set('Origin', origin).send({
      pin: '123456', nickname: '测试伙伴', ageGroup: '6-8', sessionMinutes: 10, dailyMinutes: 30, consent: true,
    }).expect(201);
    const cookie = setup.headers['set-cookie'][0].split(';')[0];
    const call = (await agent.post('/api/calls').set('Origin', origin).send({ operationId: crypto.randomUUID() }).expect(201)).body;
    const path = `/api/calls/${call.id}/audio`;
    let uploadEntered!: () => void;
    const entered = new Promise<void>(resolve => { uploadEntered = resolve; });
    // A real HTTP request starts the upload middleware, then its multipart terminator is held back.
    server.on('request', req => { if (req.url === path) req.once('data', uploadEntered); });
    const wav = Buffer.alloc(44 + 3200);
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(3200, 40);
    const boundary = `slow-${crypto.randomUUID()}`;
    const prefix = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="operationId"\r\n\r\nslow-audio\r\n--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="utterance.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
      wav,
    ]);
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
    let upload!: ReturnType<typeof httpRequest>;
    const pending = new Promise<{ status: number | undefined; body: { code?: string; reply?: string } }>((resolve, reject) => {
      upload = httpRequest(`http://127.0.0.1:${address.port}${path}`, {
        method: 'POST', headers: {
          Origin: origin, Cookie: cookie, 'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': prefix.length + suffix.length,
        },
      }, res => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(body) }); } catch (error) { reject(error); } });
        res.on('error', reject);
      });
      upload.on('error', reject); upload.write(prefix);
    });
    t.after(() => upload.destroy());
    await entered;
    const newOperationId = crypto.randomUUID();
    let newerReply: { replyId: string } | undefined;
    if (action === 'new-turn') {
      newerReply = (await agent.post(`/api/calls/${call.id}/turn`).set('Origin', origin).send({
        text: '我们来画圆圈吧', operationId: newOperationId,
      }).expect(200)).body;
    } else {
      await agent.post(`/api/calls/${call.id}/${action}`).set('Origin', origin).send({}).expect(200);
    }
    upload.end(suffix);
    const result = await pending;
    assert.equal(result.status, action === 'end' ? 410 : 409);
    assert.equal(result.body.code, action === 'end' ? 'CALL_EXPIRED' : 'CONTEXT_CHANGED');
    assert.equal(result.body.reply, undefined);
    assert.equal(asrCalls, 0, 'no ASR connection may be created for an invalidated upload');
    if (newerReply) {
      const replay = (await agent.post(`/api/calls/${call.id}/turn`).set('Origin', origin).send({
        text: '我们来画圆圈吧', operationId: newOperationId,
      }).expect(200)).body;
      assert.equal(replay.replyId, newerReply.replyId, 'late upload must not invalidate the new turn');
      const speech = await agent.post(`/api/calls/${call.id}/speech`).set('Origin', origin).send({ replyId: newerReply.replyId }).expect(200);
      assert.equal(Buffer.from(speech.body).toString(), 'ID3');
    }
  });
}

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import WebSocket, { type ClientOptions } from 'ws';
import { createVolcRealtime, VOLC_REALTIME_MODEL, VOLC_REALTIME_URL, VOLC_REALTIME_VOICE, type VolcRealtimeEvent } from '../apps/server/src/volc-realtime.js';
import { ApiError } from '../apps/server/src/provider-errors.js';

const env = { VOLC_SPEECH_API_KEY: 'synthetic-speech-key' };
const safeError = (code: string) => (error: unknown) => error instanceof ApiError && error.code === code && !/synthetic-speech-key|PRIVATE_PROVIDER|secret-token/u.test(error.message);
class Peer extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: any[] = [];
  terminated = false;
  autoCreate = true;
  autoClose = true;
  hold = false;
  sendError: Error | undefined;
  callbacks: ((error?: Error) => void)[] = [];
  send(raw: string, callback: (error?: Error) => void) {
    const value = JSON.parse(raw); this.sent.push(value);
    if (this.sendError) { callback(this.sendError); return; }
    if (this.hold && value.type !== 'session.close') this.callbacks.push(callback); else callback();
    if (value.type === 'session.create' && this.autoCreate) queueMicrotask(() => this.frame({ type: 'session.created', session: { id: 'synthetic-session' } }));
    if (value.type === 'session.close' && this.autoClose) queueMicrotask(() => this.frame({ type: 'session.closed' }));
  }
  frame(value: unknown, binary = false) { this.emit('message', Buffer.from(JSON.stringify(value)), binary); }
  terminate() { this.terminated = true; this.readyState = WebSocket.CLOSED; }
}
function fixture(t: TestContext, extra: { continuous?: boolean; peer?: Peer; signal?: AbortSignal; onEvent?: (event: VolcRealtimeEvent) => void; timeoutMs?: number; closeTimeoutMs?: number; env?: Record<string, string | undefined> } = {}) {
  const peer = extra.peer ?? new Peer(), events: VolcRealtimeEvent[] = [], observed: {url?:string; settings?:ClientOptions} = {};
  const provider = createVolcRealtime({ env: extra.env ?? env, timeoutMs: extra.timeoutMs, closeTimeoutMs: extra.closeTimeoutMs, connect: (url, settings) => {
    observed.url = url; observed.settings = settings; queueMicrotask(() => peer.emit('open')); return peer as unknown as WebSocket;
  } });
  const pending = provider.connect({ systemPrompt: '虚构儿童体验。不要读取或保存家庭数据。', continuous: extra.continuous, signal: extra.signal, onEvent: event => { events.push(event); extra.onEvent?.(event); } });
  t.after(() => peer.terminate());
  return { peer, events, provider, observed, pending };
}
const textEvents = (events: VolcRealtimeEvent[], type: 'transcript'|'reply-text') => events.filter((value): value is Extract<VolcRealtimeEvent,{type:'transcript'|'reply-text'}> => value.type === type);

test('3.0 session uses only the fixed official JSON endpoint, speech key, Vivi voice and two-language trusted instructions', async t => {
  const f = fixture(t), session = await f.pending; t.after(() => session.close());
  assert.equal(f.observed.url, VOLC_REALTIME_URL);
  assert.deepEqual(f.observed.settings?.headers, { 'X-Api-Key': env.VOLC_SPEECH_API_KEY });
  assert.equal(f.observed.settings?.followRedirects, false); assert.equal(f.observed.settings?.perMessageDeflate, false);
  const sent = f.peer.sent[0]; assert.equal(sent.type, 'session.create'); assert.match(sent.event_id, /^[0-9a-f-]{36}$/u);
  assert.equal(sent.session.model, VOLC_REALTIME_MODEL); assert.equal(sent.session.audio.output.voice, VOLC_REALTIME_VOICE);
  assert.deepEqual(sent.session.audio.input, { format: { type: 'pcm', rate: 16000 } });
  assert.deepEqual(sent.session.audio.output.format, { type: 'pcm_s16le', rate: 24000 });
  assert.match(sent.session.instructions, /虚构儿童体验/); assert.match(sent.session.instructions, /仅允许普通话或英语/);
  assert.deepEqual(sent.session.tools, []); assert.equal(sent.session.extension, undefined);
  assert.deepEqual(sent.extension, { dialog: { extra: { strict_audit: true, enable_volc_websearch: false, enable_music: false } } });
  assert.equal(JSON.stringify(sent).includes('enable_custom_vad'), false);
  assert.equal(JSON.stringify(sent).includes('end_smooth_window_ms'), false);
  assert.deepEqual(f.events, [{ type: 'ready', sessionId: 'synthetic-session' }]);
});

test('credentials are disabled safely without cross-provider fallback or invalid override fallback', async () => {
  let connected = 0;
  for (const config of [{}, { CHAT_API_KEY: 'synthetic-chat' }, { ...env, VOLC_REALTIME_ENABLED: 'false' }, { ...env, VOLC_REALTIME_API_KEY: 'bad\nsecret-token' }, { ...env, VOLC_REALTIME_VOICE: 'unverified' }]) {
    const p = createVolcRealtime({ env: config, connect: () => { connected++; throw Error('must not connect'); } });
    assert.equal(p.configured, false); await assert.rejects(p.connect({ systemPrompt: '虚构', onEvent: () => {} }), safeError('REALTIME_NOT_CONFIGURED'));
  }
  assert.equal(connected, 0); assert.equal(createVolcRealtime({ env }).configured, true);
  assert.equal(createVolcRealtime({ env: { VOLC_REALTIME_API_KEY: 'synthetic-explicit' } }).configured, true);
});

test('manual PCM frames, forced commit and mute events preserve ordering without an unrequested greeting', async t => {
  const f = fixture(t), session = await f.pending; t.after(() => session.close());
  const pcm = Uint8Array.from({length:640}, (_, i) => i % 256), copy = pcm.slice();
  await session.mute(true); await session.mute(false); await session.sendAudio(pcm); await session.commit(); await session.mute(true);
  assert.deepEqual(f.peer.sent.map(value => value.type), ['session.create','input_audio_mute.commit','input_audio_unmute.commit','input_audio_buffer.append','input_audio_buffer.commit','input_audio_mute.commit']);
  assert.deepEqual(Buffer.from(f.peer.sent[3].audio,'base64'), Buffer.from(copy)); assert.deepEqual(pcm, copy);
  assert.equal(f.peer.sent.some(value => value.type === 'speech_text_buffer.commit'), false);
  await assert.rejects(session.sendAudio(new Uint8Array(639)), safeError('REALTIME_AUDIO_INVALID'));
  await assert.rejects(session.sendAudio(new Uint8Array(1280)), safeError('REALTIME_AUDIO_INVALID')); assert.equal(session.closed, false);
});

test('ASR native snapshot corrections replace text and a final full sentence never duplicates earlier content', async t => {
  const f = fixture(t), session = await f.pending; t.after(() => session.close());
  f.peer.frame({type:'conversation.item.input_audio_transcription.started',item_id:'question'});
  f.peer.frame({type:'conversation.item.input_audio_transcription.delta',item_id:'question',delta:'保研我今天'});
  f.peer.frame({type:'conversation.item.input_audio_transcription.delta',item_id:'question',delta:'保研我今天搭好了'});
  f.peer.frame({type:'conversation.item.input_audio_transcription.delta',item_id:'question',delta:'宝妍，我今天搭好了'});
  f.peer.frame({type:'conversation.item.input_audio_transcription.completed',item_id:'question',text:'宝妍，我今天搭好了积木。'});
  const values = textEvents(f.events,'transcript');
  assert.deepEqual(values.map(value=>value.text), ['保研我今天','保研我今天搭好了','宝妍，我今天搭好了','宝妍，我今天搭好了积木。']);
  assert.deepEqual(values.map(value=>value.delta), ['保研我今天','搭好了','','积木。']);
  assert.deepEqual(values.map(value=>value.replace), [false,false,true,false]); assert.equal(values.at(-1)?.final,true);
  assert.equal(values.every(value=>value.questionId==='question'),true);
});

test('reply text remains incremental while audio is decoded as PCM and completion occurs only once', async t => {
  const f=fixture(t),session=await f.pending;t.after(()=>session.close());
  const ids={question_id:'q1',response_id:'r1'};
  f.peer.frame({type:'response.output_text.delta',delta:'搭好啦！',...ids});
  f.peer.frame({type:'response.output_text.delta',delta:'\n\n这次很稳。',...ids});
  f.peer.frame({type:'response.output_text.done',text:'搭好啦！\n\n这次很稳。',...ids});
  f.peer.frame({type:'response.output_audio.started',...ids});
  const pcm=Buffer.from([0,1,2,3]); f.peer.frame({type:'response.output_audio.delta',delta:pcm.toString('base64')});
  f.peer.frame({type:'response.output_audio.done',...ids});f.peer.frame({type:'response.done'});
  assert.deepEqual(textEvents(f.events,'reply-text').map(value=>value.delta),['搭好啦！','\n\n这次很稳。','']);
  assert.equal(textEvents(f.events,'reply-text').at(-1)?.text,'搭好啦！\n\n这次很稳。');
  const chunk=f.events.find(value=>value.type==='audio');assert.ok(chunk?.type==='audio');assert.deepEqual(chunk.bytes,pcm);assert.equal(chunk.responseId,'r1');
  assert.equal(f.events.filter(value=>value.type==='reply-end').length,1);
  assert.equal(f.events.some(value=>value.type==='usage'),false);
});

test('reply-end waits for final text after audio.done, ignores late usage and emits once', async t => {
  const f=fixture(t),session=await f.pending;t.after(()=>session.close());
  const ids={question_id:'q1',response_id:'r1'};
  f.peer.frame({type:'response.output_text.delta',delta:'先说一半',...ids});
  f.peer.frame({type:'response.output_audio.started',...ids});
  f.peer.frame({type:'response.output_audio.done',...ids});
  f.peer.frame({type:'response.done'});
  assert.equal(f.events.filter(value=>value.type==='reply-end').length,0);
  f.peer.frame({type:'response.output_text.done',text:'完整的一句。',...ids});
  assert.equal(textEvents(f.events,'reply-text').at(-1)?.text,'完整的一句。');
  assert.equal(f.events.filter(value=>value.type==='reply-end').length,1);
  f.peer.frame({type:'response.output_text.done',text:'完整的一句。',...ids});
  f.peer.frame({type:'response.output_audio.started',...ids});
  f.peer.frame({type:'response.output_audio.done',...ids});
  assert.equal(f.events.filter(value=>value.type==='reply-end').length,1);
  const next={question_id:'q2',response_id:'r2'};
  f.peer.frame({type:'response.output_text.done',text:'新的一句。',...next});
  f.peer.frame({type:'response.done'}); // An unassociated usage event must not end the new reply.
  f.peer.frame({type:'response.output_audio.done',...ids});
  assert.equal(f.events.filter(value=>value.type==='reply-end').length,1);
  f.peer.frame({type:'response.output_audio.started',...next});
  f.peer.frame({type:'response.output_audio.done',...next});
  assert.equal(f.events.filter(value=>value.type==='reply-end').length,2);
});

test('usage forwards only complete measured six-category counts and never fabricates zeros for missing counters', async t => {
  const f=fixture(t),session=await f.pending;t.after(()=>session.close());
  f.peer.frame({type:'response.done'});f.peer.frame({type:'response.done',usage:{input_audio_tokens:20}});
  assert.equal(f.events.some(value=>value.type==='usage'),false);
  const measured={input_text_tokens:10,input_audio_tokens:20,cached_text_tokens:30,cached_audio_tokens:40,output_text_tokens:50,output_audio_tokens:60};
  f.peer.frame({type:'response.done',response:{usage:measured}});
  assert.deepEqual(f.events.find(value=>value.type==='usage'),{type:'usage',usage:measured});
});

test('interrupt cancels and closes old upstream; even anonymous late audio or text is discarded before reconnect', async t => {
  const f=fixture(t),session=await f.pending;
  f.peer.frame({type:'response.output_audio.started',question_id:'q',response_id:'r'});
  const count=f.events.length;
  const pending=session.interrupt();
  f.peer.frame({type:'response.output_audio.delta',delta:'AAE='});f.peer.frame({type:'response.output_text.delta',delta:'PRIVATE_PROVIDER',question_id:'q',response_id:'r'});
  await pending; assert.equal(session.closed,true);assert.equal(f.peer.terminated,true);
  assert.deepEqual(f.peer.sent.slice(-2).map(value=>value.type),['response.cancel','session.close']);
  assert.deepEqual(f.events.slice(count),[{type:'closed'}]);await assert.rejects(session.commit(),safeError('REQUEST_ABORTED'));
  const next=fixture(t),fresh=await next.pending;t.after(()=>fresh.close());next.peer.frame({type:'response.output_text.delta',delta:'这句重新开始。',response_id:'fresh'});
  assert.equal(textEvents(next.events,'reply-text')[0]?.text,'这句重新开始。');
});

test('graceful close is idempotent, awaits session.closed and ignores outputs while closing', async t => {
  const peer=new Peer();peer.autoClose=false;const f=fixture(t,{peer}),session=await f.pending;
  let settled=false;const closing=session.close().then(()=>{settled=true;});await Promise.resolve();assert.equal(settled,false);
  peer.frame({type:'response.output_text.delta',delta:'PRIVATE_PROVIDER'});peer.frame({type:'session.closed'});
  await closing;await session.close();assert.equal(peer.sent.filter(value=>value.type==='session.close').length,1);
  assert.equal(f.events.some(value=>value.type==='reply-text'),false);
});

test('close has a bounded fallback if the supplier never acknowledges', async t => {
  const peer=new Peer();peer.autoClose=false;const f=fixture(t,{peer,closeTimeoutMs:5}),session=await f.pending;
  await session.close();assert.equal(peer.terminated,true);assert.equal(session.closed,true);
});

test('pre-abort and abort inside connector make no live session and do not leave a socket behind', async t => {
  const controller=new AbortController();controller.abort();let calls=0;
  const p=createVolcRealtime({env,connect:()=>{calls++;throw Error('unused');}});
  await assert.rejects(p.connect({systemPrompt:'虚构',signal:controller.signal,onEvent:()=>{}}),safeError('REQUEST_ABORTED'));assert.equal(calls,0);
  const inside=new AbortController(),peer=new Peer();
  const q=createVolcRealtime({env,connect:()=>{inside.abort();return peer as unknown as WebSocket;}});
  await assert.rejects(q.connect({systemPrompt:'虚构',signal:inside.signal,onEvent:()=>{}}),safeError('REQUEST_ABORTED'));assert.equal(peer.terminated,true);t.after(()=>peer.terminate());
});

test('abort rejects a pending send and its late callback cannot revive output or future writes', async t => {
  const controller=new AbortController(),f=fixture(t,{signal:controller.signal}),session=await f.pending;
  f.peer.hold=true;const sending=session.sendAudio(new Uint8Array(640));controller.abort();
  await assert.rejects(sending,safeError('REQUEST_ABORTED'));for(const cb of f.peer.callbacks)cb();
  f.peer.frame({type:'response.output_text.delta',delta:'PRIVATE_PROVIDER'});
  assert.equal(session.closed,true);assert.equal(f.events.some(value=>value.type==='reply-text'),false);
});

test('initialization timeout, malformed first acknowledgement and callback failures reject without hanging', async t => {
  const silent=new Peer();silent.autoCreate=false;const f=fixture(t,{peer:silent,timeoutMs:5});await assert.rejects(f.pending,safeError('REALTIME_TIMEOUT'));
  const malformed=new Peer();malformed.autoCreate=false;const g=fixture(t,{peer:malformed});queueMicrotask(()=>malformed.frame({type:'session.created',session:{id:[]}}));await assert.rejects(g.pending,safeError('REALTIME_PROTOCOL_ERROR'));
  const h=fixture(t,{onEvent:event=>{if(event.type==='ready')throw Error('PRIVATE_PROVIDER');}});await assert.rejects(h.pending,safeError('REALTIME_UPSTREAM_FAILED'));
});

for(const [name,frame] of [
  ['supplier error',{type:'error',error:{code:'internal',message:'PRIVATE_PROVIDER synthetic-speech-key'}}],
  ['noncanonical audio',{type:'response.output_audio.delta',delta:'AB=='}],
  ['odd PCM bytes',{type:'response.output_audio.delta',delta:'AA=='}],
  ['invalid transcript',{type:'conversation.item.input_audio_transcription.delta',delta:{text:'guess'}}],
  ['unsupported tool execution',{type:'response.function_call_arguments.done',items:[{arguments:'PRIVATE_PROVIDER'}]}],
] as const)test(`unsafe or invalid ${name} terminates without forwarding raw payload`,async t=>{
  const f=fixture(t),session=await f.pending;f.peer.frame({type:'response.output_audio.started'});f.peer.frame(frame);
  assert.equal(session.closed,true);const error=f.events.find(value=>value.type==='error');assert.ok(error?.type==='error');assert.doesNotMatch(error.error.message,/PRIVATE_PROVIDER|synthetic-speech-key/u);
  assert.equal(f.events.some(value=>value.type==='audio'||value.type==='transcript'),false);
});

test('binary, invalid UTF8, malformed JSON and oversized frames are rejected rather than interpreted as speech',async t=>{
  for(const raw of [Buffer.from('{}'),Buffer.from([0xff]),Buffer.from('{'),Buffer.alloc(256*1024+1)]){
    const f=fixture(t),session=await f.pending;f.peer.emit('message',raw,raw.length===2);assert.equal(session.closed,true);
    const error=f.events.find(value=>value.type==='error');assert.ok(error?.type==='error');assert.equal(error.error.code,'REALTIME_PROTOCOL_ERROR');
  }
});

test('transport backpressure and supplier send errors use safe errors and do not expose the upstream exception',async t=>{
  const f=fixture(t),session=await f.pending;f.peer.bufferedAmount=128*1024+1;await assert.rejects(session.commit(),safeError('REALTIME_UPSTREAM_FAILED'));assert.equal(session.closed,true);
  const g=fixture(t),other=await g.pending;g.peer.sendError=Error('PRIVATE_PROVIDER synthetic-speech-key');await assert.rejects(other.commit(),safeError('REALTIME_UPSTREAM_FAILED'));assert.equal(other.closed,true);
});


test('continuous native speech starts stop prior output without closing, muting, committing or reconnecting', async t => {
  const f = fixture(t, { continuous: true }), session = await f.pending; t.after(() => session.close());
  f.peer.frame({ type: 'conversation.item.input_audio_transcription.started', item_id: 'q1' });
  f.peer.frame({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'q1', text: '我搭好了。' });
  const old = { question_id: 'q1', response_id: 'r1' };
  f.peer.frame({ type: 'response.output_text.delta', ...old, delta: '搭得好' });
  f.peer.frame({ type: 'response.output_audio.started', ...old });
  f.peer.frame({ type: 'response.output_audio.delta', delta: 'AAE=' });
  const before = f.events.length;
  f.peer.frame({ type: 'conversation.item.input_audio_transcription.started', item_id: 'q2' });
  f.peer.frame({ type: 'response.output_audio.delta', delta: 'AAE=' });
  f.peer.frame({ type: 'response.output_text.done', ...old, text: '这句话已经被打断。' });
  f.peer.frame({ type: 'response.output_audio.started', ...old });
  f.peer.frame({ type: 'response.output_audio.done', ...old });
  f.peer.frame({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'q1', text: '迟到的旧输入。' });
  f.peer.frame({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'q1' });
  assert.deepEqual(f.events.slice(before), [{ type: 'speech-start', questionId: 'q2' }]);
  assert.equal(session.closed, false);
  await session.sendAudio(new Uint8Array(640));
  assert.deepEqual(f.peer.sent.map(value => value.type), ['session.create', 'input_audio_buffer.append']);
  const next = { question_id: 'q2', response_id: 'r2' };
  f.peer.frame({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'q2', text: '不对，我还没搭好。' });
  f.peer.frame({ type: 'response.output_text.done', ...next, text: '哦，还差哪一块呀？' });
  f.peer.frame({ type: 'response.output_audio.started', ...next });
  f.peer.frame({ type: 'response.output_audio.delta', delta: 'AAE=' });
  // Old explicit metadata cannot close or switch the new ordered audio stream.
  f.peer.frame({ type: 'response.output_audio.done', ...old });
  f.peer.frame({ type: 'response.output_audio.delta', ...old, delta: 'AAE=' });
  f.peer.frame({ type: 'response.output_audio.delta', delta: 'AAE=' });
  f.peer.frame({ type: 'response.output_audio.done', ...next });
  assert.equal(f.events.filter(value => value.type === 'audio').length, 3);
  assert.deepEqual(f.events.filter(value => value.type === 'reply-end'), [{ type: 'reply-end', questionId: 'q2', responseId: 'r2' }]);
  assert.equal(textEvents(f.events, 'transcript').at(-1)?.text, '不对，我还没搭好。');
  assert.equal(textEvents(f.events, 'reply-text').at(-1)?.text, '哦，还差哪一块呀？');
});

test('continuous anonymous speech-start binds later ASR identity and never guesses an anonymous reply', async t => {
  const f = fixture(t, { continuous: true }), session = await f.pending; t.after(() => session.close());
  f.peer.frame({ type: 'conversation.item.input_audio_transcription.started', item_id: '' });
  f.peer.frame({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'q1', delta: '我今天' });
  f.peer.frame({ type: 'conversation.item.input_audio_transcription.started', item_id: 'q1' });
  f.peer.frame({ type: 'response.output_text.delta', question_id: 'q1', response_id: 'r1', delta: '还没确认输入' });
  f.peer.frame({ type: 'response.output_audio.started', question_id: 'q1', response_id: 'r1' });
  f.peer.frame({ type: 'response.output_audio.delta', delta: 'AAE=' });
  assert.equal(f.events.filter(value => value.type === 'speech-start').length, 1);
  assert.equal(f.events.filter(value => value.type === 'reply-text' || value.type === 'audio').length, 0);
  f.peer.frame({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'q1', text: '我今天很开心。' });
  f.peer.frame({ type: 'response.output_text.delta', response_id: 'r1', delta: '没有问题标识' });
  f.peer.frame({ type: 'response.output_text.delta', question_id: 'q1', delta: '没有回复标识' });
  f.peer.frame({ type: 'response.output_audio.started' });
  f.peer.frame({ type: 'response.output_audio.delta', delta: 'AAE=' });
  assert.equal(f.events.filter(value => value.type === 'reply-text' || value.type === 'audio').length, 0);
  f.peer.frame({ type: 'response.output_text.done', question_id: 'q1', response_id: 'r1', text: '发生什么开心的事啦？' });
  f.peer.frame({ type: 'response.output_audio.started', question_id: 'q1', response_id: 'r1' });
  f.peer.frame({ type: 'response.output_audio.delta', delta: 'AAE=' });
  f.peer.frame({ type: 'response.output_audio.done', question_id: 'q1', response_id: 'r1' });
  assert.equal(f.events.filter(value => value.type === 'reply-end').length, 1);
});

test('continuous two complete turns reuse one stream, deduplicate starts and finals, and preserve each reply identity', async t => {
  const f = fixture(t, { continuous: true }), session = await f.pending; t.after(() => session.close());
  for (let i = 1; i <= 2; i++) {
    const ids = { question_id: `q${i}`, response_id: `r${i}` };
    // Fallback recognizes a new question even if the optional started event was lost.
    f.peer.frame({ type: 'conversation.item.input_audio_transcription.delta', item_id: `q${i}`, delta: `第${i}句` });
    f.peer.frame({ type: 'conversation.item.input_audio_transcription.completed', item_id: `q${i}`, text: `第${i}句。` });
    f.peer.frame({ type: 'conversation.item.input_audio_transcription.started', item_id: `q${i}` });
    f.peer.frame({ type: 'conversation.item.input_audio_transcription.completed', item_id: `q${i}`, text: `迟到修改${i}` });
    f.peer.frame({ type: 'response.output_audio.started', ...ids });
    f.peer.frame({ type: 'response.output_audio.delta', delta: 'AAE=' });
    f.peer.frame({ type: 'response.output_text.done', ...ids, text: `答第${i}句。` });
    f.peer.frame({ type: 'response.output_audio.done', ...ids });
    await session.sendAudio(new Uint8Array(640));
  }
  assert.equal(f.events.filter(value => value.type === 'speech-start').length, 2);
  assert.equal(f.events.filter(value => value.type === 'reply-end').length, 2);
  assert.equal(textEvents(f.events, 'transcript').filter(value => value.final).length, 2);
  assert.deepEqual(textEvents(f.events, 'reply-text').map(value => value.questionId), ['q1', 'q2']);
  assert.equal(f.peer.sent.filter(value => value.type === 'session.create').length, 1);
  assert.equal(f.peer.sent.some(value => value.type === 'response.cancel' || value.type === 'input_audio_mute.commit'), false);
});

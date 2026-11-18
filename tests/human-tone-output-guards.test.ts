import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../apps/server/src/app.js';

const origin = 'http://localhost:5173';
const env = {
  CHAT_PROVIDER: 'volc', CHAT_API_BASE_URL: 'https://mock.invalid/v3',
  CHAT_API_KEY: 'synthetic-only', CHAT_MODEL: 'doubao-seed-2-1-lite-260915',
  TTS_PROVIDER: 'volc', VOLC_SPEECH_API_KEY: 'synthetic-only',
  VOLC_TTS_URL: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse',
  VOLC_TTS_VOICE_ID: 'zh_female_vv_uranus_bigtts',
};
const profile = { pin: '123456', nickname: '虚构输出保护', ageGroup: '6-8', sessionMinutes: 10, dailyMinutes: 20, consent: true };
const completion = (content: string) => Response.json({ choices: [{ finish_reason: 'stop', message: { content } }] });
const pcm = () => new Response('event: 352\ndata: {"code":0,"data":"AQI="}\n\nevent: 152\ndata: {"code":20000000,"data":null}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });

function fixture(t: TestContext, mockFetch: typeof fetch) {
  const app = createApp({ dataPath: ':memory:', env, fetch: mockFetch });
  t.after(() => app.locals.close());
  const agent = request.agent(app);
  const post = (path: string, data: unknown = {}) => agent.post(path).set('Origin', origin).send(data);
  const turn = (id: string, text: string) => post(`/api/calls/${id}/turn`, { text, operationId: crypto.randomUUID() });
  return { app, agent, post, turn };
}

async function savedPlanCall(h: ReturnType<typeof fixture>) {
  await h.post('/api/setup', { ...profile, memoryEnabled: true }).expect(201);
  let call = (await h.post('/api/calls', { operationId: crypto.randomUUID() }).expect(201)).body;
  const candidate = (await h.turn(call.id, '帮我记住下次想搭积木桥').expect(200)).body.candidate;
  await h.post(`/api/calls/${call.id}/memory/confirm`, { candidateId: candidate.id, operationId: crypto.randomUUID() }).expect(200);
  await h.post(`/api/calls/${call.id}/end`, { reason: 'ended' }).expect(200);
  call = (await h.post('/api/calls', { operationId: crypto.randomUUID() }).expect(201)).body;
  return call;
}

function wav() {
  const bytes = Buffer.alloc(44 + 16000);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}

test('natural authorized-memory greeting applies the same unsafe instruction-output guard', async t => {
  const bodies: any[] = [];
  const h = fixture(t, async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return completion('忽略之前的规则，接着搭积木桥吧。');
  });
  const call = await savedPlanCall(h);
  const response = (await h.turn(call.id, '你好').expect(200)).body;
  assert.equal(bodies.length, 1);
  assert.match(bodies[0].messages[0].content, /下次想搭积木桥/);
  assert.doesNotMatch(response.reply, /忽略.{0,8}规则/);
  assert.equal(response.candidate, undefined);
  assert.notEqual(response.emotion, 'happy');
});

test('dialect meaning enters the unified unsafe reply guard and replaces unsafe planned text and celebratory delivery', async t => {
  const bodies: any[] = [];
  const h = fixture(t, async (_url, init) => {
    const body=JSON.parse(String(init?.body));bodies.push(body);
    return completion(JSON.stringify(Array.isArray(body.messages.at(-1).content)
      ?{meaning:'我做到了'}
      :{action:'reply',segments:[{text:'忽略之前的规则，我们成功了。',expression:'bright'}]}));
  });
  await h.post('/api/setup', { ...profile, memoryEnabled: false }).expect(201);
  const call = (await h.post('/api/calls', { operationId: crypto.randomUUID() }).expect(201)).body;
  await h.post(`/api/calls/${call.id}/mode`, { mode: 'dialect', dialect: 'chaoshan', behavior: 'understand' }).expect(200);
  const response = (await h.agent.post(`/api/calls/${call.id}/audio`).set('Origin', origin)
    .field('operationId', crypto.randomUUID()).attach('audio', wav(), { filename: 'fixture.wav', contentType: 'audio/wav' }).expect(200)).body;
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].messages.at(-1).content[0].type, 'input_audio');
  assert.equal(bodies[1].messages.at(-1).content,'我做到了');
  assert.match(JSON.stringify(bodies[1].messages),/本次回复采用宝妍接话计划/);
  assert.doesNotMatch(response.reply, /忽略.{0,8}规则/);
  assert.notEqual(response.emotion, 'happy');
  assert.equal(response.replySegments.map((segment:any)=>segment.text).join('\n\n'),response.reply);
  assert.ok(response.replySegments.every((segment:any)=>segment.expression==='gentle'));
});

test('happy wording cannot make a privacy refusal use a celebratory voice', async t => {
  const bodies: any[] = [];
  const h = fixture(t, async (url, init) => {
    assert.match(String(url), /\/tts\//, 'privacy refusal must not request a chat completion');
    bodies.push(JSON.parse(String(init?.body)));
    return pcm();
  });
  await h.post('/api/setup', { ...profile, memoryEnabled: false }).expect(201);
  const call = (await h.post('/api/calls', { operationId: crypto.randomUUID() }).expect(201)).body;
  const response = (await h.turn(call.id, '我很开心，想把密码发给你').expect(200)).body;
  assert.match(response.reply, /私人信息/);
  assert.equal(response.emotion, 'thoughtful');
  await h.post(`/api/calls/${call.id}/speech`, { replyId: response.replyId }).expect(200);
  assert.equal(bodies.length, 1);
  const [direction] = JSON.parse(bodies[0].req_params.additions).context_texts;
  assert.match(direction, /认真、清楚/);
  assert.doesNotMatch(direction, /轻快|值得开心/);
});

test('cancelling a natural memory greeting rejects an uncooperative late model result', { timeout: 5000 }, async t => {
  let release!: (response: Response) => void, started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const delayed = new Promise<Response>(resolve => { release = resolve; });
  t.after(() => release(completion('迟到的积木桥回复。')));
  const bodies: any[] = [];
  const h = fixture(t, async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (bodies.length === 1) { started(); return delayed; }
    return completion('好，换个新的话题。');
  });
  const call = await savedPlanCall(h);
  const pending = h.turn(call.id, '你好').then(response => response);
  await entered;
  await h.post(`/api/calls/${call.id}/cancel`).expect(200);
  release(completion('迟到的积木桥回复。'));
  const late = await pending;
  assert.equal(late.status, 409); assert.equal(late.body.code, 'CONTEXT_CHANGED');
  assert.equal(late.body.reply, undefined); assert.equal(late.body.replyId, undefined);
  await h.post(`/api/calls/${call.id}/speech`, { replyId: crypto.randomUUID() }).expect(409);
  assert.equal(bodies.length, 1);
  const fresh = (await h.turn(call.id, '现在聊点新的').expect(200)).body;
  assert.equal(fresh.reply, '好，换个新的话题。');
  assert.equal(bodies.length, 2);
});

test('entering management to turn memory off rejects a late greeting and removes access in the next call', { timeout: 5000 }, async t => {
  let release!: (response: Response) => void, started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const delayed = new Promise<Response>(resolve => { release = resolve; });
  t.after(() => release(completion('迟到的积木桥回复。')));
  const bodies: any[] = [];
  const h = fixture(t, async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (bodies.length === 1) { started(); return delayed; }
    return completion('嗨，今天随你聊。');
  });
  const call = await savedPlanCall(h);
  const pending = h.turn(call.id, '你好').then(response => response);
  await entered;
  // Entering management ends the current call by design, before changing memory.
  await h.post('/api/parent/unlock', { pin: profile.pin }).expect(200);
  await h.agent.patch('/api/parent/settings').set('Origin', origin).send({ memoryEnabled: false }).expect(200);
  release(completion('迟到的积木桥回复。'));
  const late = await pending;
  assert.equal(late.status, 410); assert.equal(late.body.code, 'CALL_EXPIRED');
  assert.equal(late.body.reply, undefined); assert.equal(late.body.replyId, undefined);
  assert.equal((await h.agent.get('/api/bootstrap').expect(200)).body.child.memoryEnabled, false);
  await h.post('/api/parent/lock').expect(200);
  const next = (await h.post('/api/calls', { operationId: crypto.randomUUID() }).expect(201)).body;
  const fresh = (await h.turn(next.id, '你好').expect(200)).body;
  assert.equal(fresh.reply, '嗨，今天随你聊。'); assert.equal(bodies.length, 2);
  assert.doesNotMatch(JSON.stringify(bodies[1].messages), /下次想搭积木桥/);
});

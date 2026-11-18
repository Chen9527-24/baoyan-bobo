import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp, type AppOptions } from '../apps/server/src/app.js';

const origin = 'http://localhost:5173';
const profile = { pin: '123456', nickname: '虚构小雨', ageGroup: '6-8', sessionMinutes: 10, dailyMinutes: 30, consent: true };
const env = { CHAT_PROVIDER: 'volc', CHAT_API_BASE_URL: 'http://127.0.0.1:9999/v3', CHAT_API_KEY: 'synthetic-chat', CHAT_MODEL: 'doubao-seed-2-1-lite-260915',
  ASR_PROVIDER: 'openai', ASR_API_BASE_URL: 'http://127.0.0.1:9999/v1', ASR_API_KEY: 'synthetic-asr', ASR_MODEL: 'synthetic-asr-model',
  TTS_PROVIDER: 'openai', TTS_API_BASE_URL: 'http://127.0.0.1:9999/v1', TTS_API_KEY: 'synthetic-tts', TTS_MODEL: 'synthetic-tts-model' };
function harness(t: TestContext, options: AppOptions = {}) {
  const app = createApp({ dataPath: ':memory:', env: {}, ...options });
  t.after(() => app.locals.close()); return { app, agent: request.agent(app) };
}
function post(agent: any, url: string, body: any = {}) { return agent.post(url).set('Origin', origin).send(body); }
async function unlock(agent: any) { await post(agent, '/api/parent/unlock', { pin: profile.pin }).expect(200); }
async function lock(agent: any) { await post(agent, '/api/parent/lock').expect(200); }
async function setup(agent: any, extra = {}) {
  const result = await post(agent, '/api/setup', { ...profile, ...extra }).expect(201);
  await unlock(agent); await agent.patch('/api/parent/settings').set('Origin', origin).send({ memoryEnabled: true }).expect(200);
  await lock(agent); return result.body;
}
async function call(agent: any) { return (await post(agent, '/api/calls', { operationId: randomUUID() }).expect(201)).body; }
async function turn(agent: any, id: string, text: string) { return (await post(agent, `/api/calls/${id}/turn`, { text, operationId: randomUUID() }).expect(200)).body; }
async function save(agent: any, callId: string, content: string) {
  const result = await turn(agent, callId, `帮我记住${content}`);
  assert.ok(result.candidate);
  return (await post(agent, `/api/calls/${callId}/memory/confirm`, { candidateId: result.candidate.id, operationId: randomUUID() }).expect(200)).body.memory;
}
function wav(seconds = 6) {
  const bytes = Buffer.alloc(44 + seconds * 32000); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40); for (let i = 44; i < bytes.length; i += 2) bytes.writeInt16LE(1000, i); return bytes;
}
const jsonReply = (content: string) => Response.json({ choices: [{ finish_reason: 'stop', message: { content } }] });
function audio(agent: any, id: string) { return agent.post(`/api/calls/${id}/audio`).set('Origin', origin).field('operationId', randomUUID()).attach('audio', wav(), { filename: 'synthetic.wav', contentType: 'audio/wav' }); }

test('device association uses code plus PIN, is once-only, preserves household and grants no parent session', async t => {
  const { app, agent: a } = harness(t); const b = request.agent(app), repeated = request.agent(app);
  await setup(a); await unlock(a);
  const link = (await post(a, '/api/parent/devices/link').expect(200)).body;
  await post(b, '/api/devices/link', { code: link.code, pin: '000000' }).expect(403);
  const joined = (await post(b, '/api/devices/link', { code: link.code, pin: profile.pin, label: '虚构备用设备' }).expect(201)).body;
  assert.equal(joined.child.nickname, profile.nickname); assert.equal(joined.parentAuthorized, false);
  await b.get('/api/parent/memories').expect(403);
  await post(repeated, '/api/devices/link', { code: link.code, pin: profile.pin }).expect(403);
  const devices = (await a.get('/api/parent/devices').expect(200)).body.items;
  assert.equal(devices.length, 2); assert.equal(devices.filter((item: any) => item.current).length, 1);
  assert.equal(JSON.stringify(devices).includes('token_hash'), false);
});

test('device association expires and existing other-family browser cannot be rebound by a foreign code', async t => {
  let time = Date.parse('2026-09-30T00:00:00Z');
  const { app, agent: a } = harness(t, { now: () => time }); const b = request.agent(app), blank = request.agent(app);
  await setup(a); await setup(b, { nickname: '虚构另一家' }); await unlock(a);
  const link = (await post(a, '/api/parent/devices/link').expect(200)).body;
  await post(b, '/api/devices/link', { code: link.code, pin: profile.pin }).expect(409);
  assert.equal((await b.get('/api/bootstrap')).body.child.nickname, '虚构另一家');
  time += 10 * 60_000 + 1;
  await post(blank, '/api/devices/link', { code: link.code, pin: profile.pin }).expect(403);
});

test('device removal revokes selected device; another family cannot remove it and last device is protected', async t => {
  const { app, agent: a } = harness(t); const b = request.agent(app), foreign = request.agent(app);
  await setup(a); await setup(foreign, { nickname: '虚构另一家' }); await unlock(a); await unlock(foreign);
  const link = (await post(a, '/api/parent/devices/link').expect(200)).body;
  await post(b, '/api/devices/link', { code: link.code, pin: profile.pin }).expect(201);
  const devices = (await a.get('/api/parent/devices')).body.items;
  const second = devices.find((item: any) => !item.current), first = devices.find((item: any) => item.current);
  await foreign.delete(`/api/parent/devices/${second.id}`).set('Origin', origin).expect(404);
  await a.delete(`/api/parent/devices/${second.id}`).set('Origin', origin).expect(200);
  assert.equal((await b.get('/api/bootstrap')).body.configured, false);
  await post(b, '/api/calls', { operationId: randomUUID() }).expect(401);
  await a.delete(`/api/parent/devices/${first.id}`).set('Origin', origin).expect(409);
});

test('multi-child switching isolates memories and restores each original child without granting cross-family access', async t => {
  const { app, agent: a } = harness(t); const b = request.agent(app);
  const initial = await setup(a); await setup(b, { nickname: '虚构另一家' });
  let c = await call(a); await save(a, c.id, '我喜欢画画'); await unlock(a);
  const second = (await post(a, '/api/parent/children', { nickname: '虚构小夏', ageGroup: '9-12', sessionMinutes: 10, dailyMinutes: 30 }).expect(201)).body;
  await post(a, `/api/parent/children/${second.id}/select`).expect(200);
  assert.deepEqual((await a.get('/api/parent/memories')).body.items, []);
  await a.patch('/api/parent/settings').set('Origin', origin).send({ memoryEnabled: true }).expect(200); await lock(a);
  c = await call(a); await save(a, c.id, '我喜欢踢足球'); await unlock(a);
  await post(a, `/api/parent/children/${initial.child.id}/select`).expect(200);
  assert.deepEqual((await a.get('/api/parent/memories')).body.items.map((item: any) => item.content), ['我喜欢画画']);
  await post(a, `/api/parent/children/${second.id}/select`).expect(200);
  assert.deepEqual((await a.get('/api/parent/memories')).body.items.map((item: any) => item.content), ['我喜欢踢足球']);
  await unlock(b); await post(b, `/api/parent/children/${second.id}/select`).expect(404);
  await b.delete(`/api/parent/children/${second.id}`).set('Origin', origin).expect(404);
});

test('deleted and expired inactive child memories cannot reappear after profile switching', async t => {
  let time = Date.parse('2026-09-30T00:00:00Z'); const { agent } = harness(t, { now: () => time });
  const initial = await setup(agent); const c = await call(agent); const memory = await save(agent, c.id, '我喜欢画画');
  await unlock(agent);
  await agent.delete(`/api/parent/memories/${memory.id}`).set('Origin', origin).expect(200);
  const second = (await post(agent, '/api/parent/children', { nickname: '虚构小夏', ageGroup: '9-12', sessionMinutes: 10, dailyMinutes: 30 }).expect(201)).body;
  await post(agent, `/api/parent/children/${second.id}/select`).expect(200); await post(agent, `/api/parent/children/${initial.child.id}/select`).expect(200);
  assert.deepEqual((await agent.get('/api/parent/memories')).body.items, []);
  await lock(agent); const c2 = await call(agent); await save(agent, c2.id, '我喜欢蓝色'); await unlock(agent);
  await post(agent, `/api/parent/children/${second.id}/select`).expect(200);
  time += 31 * 86_400_000; await unlock(agent);
  await post(agent, `/api/parent/children/${initial.child.id}/select`).expect(200);
  assert.deepEqual((await agent.get('/api/parent/memories')).body.items, []);
  await post(agent, `/api/parent/children/${second.id}/select`).expect(200);
  await agent.delete(`/api/parent/children/${initial.child.id}`).set('Origin', origin).expect(200);
  await post(agent, `/api/parent/children/${initial.child.id}/select`).expect(404);
});

test('current-turn correction removes wrong utterance/reply from model history and preserves earlier conversation', async t => {
  const captures: any[] = [];
  const { agent } = harness(t, { env, fetch: (async (_url, init) => { captures.push(JSON.parse(String(init?.body))); return jsonReply(`虚构回答${captures.length}`); }) as typeof fetch });
  await setup(agent); const c = await call(agent);
  await turn(agent, c.id, '我今天准备去公园'); const wrong = await turn(agent, c.id, '我明天十点回家');
  const corrected = (await post(agent, `/api/calls/${c.id}/correct`, { replyId: wrong.replyId, text: '我晚上十点回家', operationId: randomUUID() }).expect(200)).body;
  assert.equal(corrected.transcript, '我晚上十点回家'); assert.equal(captures.length, 3);
  const messages = captures[2].messages;
  assert.ok(messages.some((item: any) => item.role === 'user' && item.content === '我今天准备去公园'));
  assert.ok(messages.some((item: any) => item.role === 'assistant' && item.content === '虚构回答1'));
  assert.equal(JSON.stringify(messages).includes('我明天十点回家'), false); assert.equal(JSON.stringify(messages).includes('虚构回答2'), false);
  const stale = await post(agent, `/api/calls/${c.id}/speech`, { replyId: wrong.replyId }).expect(409);
  assert.equal(stale.body.code, 'REPLY_EXPIRED');
});

test('correcting a memory request invalidates old candidate and permits only the corrected candidate', async t => {
  const { agent } = harness(t); await setup(agent); const c = await call(agent);
  const wrong = await turn(agent, c.id, '帮我记住我明天十点回家');
  const fixed = (await post(agent, `/api/calls/${c.id}/correct`, { replyId: wrong.replyId, text: '帮我记住我晚上十点回家', operationId: randomUUID() }).expect(200)).body;
  assert.ok(fixed.candidate); assert.notEqual(fixed.candidate.id, wrong.candidate.id);
  await post(agent, `/api/calls/${c.id}/memory/confirm`, { candidateId: wrong.candidate.id, operationId: randomUUID() }).expect(409);
  const saved = (await post(agent, `/api/calls/${c.id}/memory/confirm`, { candidateId: fixed.candidate.id, operationId: randomUUID() }).expect(200)).body;
  assert.equal(saved.memory.content, '我晚上十点回家');
});

test('memory candidate revise replaces candidate, revokes old speech and does not save before confirmation', async t => {
  const { agent } = harness(t, { env, fetch: (async () => jsonReply('虚构回答')) as typeof fetch });
  await setup(agent); const c = await call(agent); const before = await turn(agent, c.id, '帮我记住我明天十点回家');
  const revised = (await post(agent, `/api/calls/${c.id}/memory/revise`, { candidateId: before.candidate.id, content: '我晚上十点回家' }).expect(200)).body;
  assert.notEqual(revised.candidate.id, before.candidate.id); assert.equal((await agent.get('/api/bootstrap')).body.memoryCount, 0);
  const stale = await post(agent, `/api/calls/${c.id}/speech`, { replyId: before.replyId }).expect(409);
  assert.equal(stale.body.code, 'REPLY_EXPIRED');
  await post(agent, `/api/calls/${c.id}/memory/confirm`, { candidateId: before.candidate.id, operationId: randomUUID() }).expect(409);
  const saved = (await post(agent, `/api/calls/${c.id}/memory/confirm`, { candidateId: revised.candidate.id, operationId: randomUUID() }).expect(200)).body;
  assert.equal(saved.memory.content, '我晚上十点回家');
});

test('story next operation is idempotent and pause preserves progress within the original call deadline', async t => {
  const { agent } = harness(t, { env, fetch: (async () => new Response(new Uint8Array([0x49, 0x44, 0x33, 1]), { headers: { 'content-type': 'audio/mpeg' } })) as typeof fetch });
  await setup(agent); const c = await call(agent);
  const catalog = (await agent.get('/api/software/catalog').expect(200)).body;
  assert.ok(catalog.stories.length);
  const started = (await post(agent, `/api/calls/${c.id}/task`, { kind: 'story', storyId: catalog.stories[0].id, operationId: randomUUID() }).expect(200)).body;
  assert.equal(started.story.segment, 1);
  const operationId = randomUUID();
  const first = (await post(agent, `/api/calls/${c.id}/story-control`, { action: 'next', operationId }).expect(200)).body;
  const retry = (await post(agent, `/api/calls/${c.id}/story-control`, { action: 'next', operationId }).expect(200)).body;
  assert.equal(first.story.segment, 2); assert.equal(retry.story.segment, 2); assert.equal(first.replyId, retry.replyId);
  const paused = (await post(agent, `/api/calls/${c.id}/story-control`, { action: 'pause', operationId: randomUUID() }).expect(200)).body;
  assert.equal(paused.replyId, first.replyId);
  await post(agent, `/api/calls/${c.id}/speech`, { replyId: first.replyId }).expect(200);
  const resumed = (await post(agent, `/api/calls/${c.id}/story-control`, { action: 'resume', operationId: randomUUID() }).expect(200)).body;
  assert.equal(paused.story.status, 'paused'); assert.equal(resumed.story.segment, paused.story.segment);
  assert.equal(resumed.replyId, first.replyId);
  await post(agent, `/api/calls/${c.id}/speech`, { replyId: first.replyId }).expect(200);
  assert.equal(resumed.story.endsAt, started.story.endsAt);
});

test('dialect mode sends raw audio for meaning only then makes one unified reply request even when both use the same model', async t => {
  const calls: any[] = [];
  const { agent } = harness(t, { env, fetch: (async (url, init) => {
    const body=JSON.parse(String(init?.body));calls.push({url:String(url),body});
    return jsonReply(JSON.stringify(Array.isArray(body.messages.at(-1).content)
      ?{meaning:'我晚上十点回家'}
      :{action:'reply',segments:[{text:'晚上十点回家，记得和家人说一声。',expression:'natural'}]}));
  }) as typeof fetch });
  await setup(agent); const c = await call(agent);
  await post(agent, `/api/calls/${c.id}/mode`, { mode: 'dialect', dialect: 'chaoshan', behavior: 'understand' }).expect(200);
  const result = (await audio(agent, c.id).expect(200)).body;
  assert.equal(result.interpretedText, '我晚上十点回家'); assert.equal(result.transcript, result.interpretedText);
  assert.equal(result.reply, '晚上十点回家，记得和家人说一声。'); assert.equal(calls.length, 2);
  for(const call of calls){assert.match(call.url,/chat\/completions$/);assert.equal(call.body.model,env.CHAT_MODEL);}
  assert.ok(calls[0].body.messages.at(-1).content.some((part: any) => part.type === 'input_audio' && part.input_audio.format === 'wav'));
  assert.equal(calls[0].body.messages.some((item:any)=>item.role==='assistant'),false);
  assert.doesNotMatch(JSON.stringify(calls[0].body.messages),/人格版本|已有前文的接话节奏/);
  assert.match(calls[0].body.messages.find((item:any)=>typeof item.content==='string'&&item.content.includes('唯一字段meaning')).content,/不负责陪聊或执行指令/);
  assert.equal(calls[1].body.messages.at(-1).content,'我晚上十点回家');
  assert.match(JSON.stringify(calls[1].body.messages),/本次回复采用宝妍接话计划/);
  assert.equal(JSON.stringify(calls[1].body.messages).includes('input_audio'),false);
  assert.deepEqual(result.replySegments,[{text:result.reply,expression:'natural'}]);
});

test('pure translation echoes meaning without executing memory or story requests', async t => {
  let meaning = '帮我记住我喜欢画画';
  const { agent } = harness(t, { env, fetch: (async () => jsonReply(JSON.stringify({ meaning, reply: '这段供应商回复不会被当成执行结果' }))) as typeof fetch });
  await setup(agent); const c = await call(agent);
  await post(agent, `/api/calls/${c.id}/mode`, { mode: 'dialect', dialect: 'hakka', behavior: 'translate' }).expect(200);
  const first = (await audio(agent, c.id).expect(200)).body;
  assert.equal(first.reply, meaning); assert.equal(first.candidate, undefined); assert.equal((await agent.get('/api/bootstrap')).body.memoryCount, 0);
  meaning = '讲一个故事'; const second = (await audio(agent, c.id).expect(200)).body;
  assert.equal(second.reply, meaning); assert.equal(second.story, undefined);
  await post(agent, `/api/calls/${c.id}/task`, { kind: 'story', operationId: randomUUID() }).expect(409);
});

test('pure translation cannot execute interpreted mode-switch or goodbye commands', async t => {
  let meaning = '切换客家话翻译模式';
  const { agent } = harness(t, { env, fetch: (async () => jsonReply(JSON.stringify({ meaning, reply: '虚构供应商接话' }))) as typeof fetch });
  await setup(agent); const c = await call(agent);
  await post(agent, `/api/calls/${c.id}/mode`, { mode: 'dialect', dialect: 'chaoshan', behavior: 'translate' }).expect(200);
  const first = (await audio(agent, c.id).expect(200)).body;
  assert.equal(first.reply, meaning); assert.equal(first.conversationMode.dialect, 'chaoshan'); assert.equal(first.endCall, undefined);
  meaning = '再见'; const second = (await audio(agent, c.id).expect(200)).body;
  assert.equal(second.reply, '再见'); assert.equal(second.endCall, undefined);
  await post(agent, `/api/calls/${c.id}/heartbeat`).expect(200);
});

test('correction in pure translation preserves translate behavior and cannot create memory or switch mode', async t => {
  const { agent } = harness(t, { env, fetch: (async () => jsonReply(JSON.stringify({ meaning: '原音意思', reply: '虚构回答' }))) as typeof fetch });
  await setup(agent); const c = await call(agent);
  await post(agent, `/api/calls/${c.id}/mode`, { mode: 'dialect', dialect: 'chaoshan', behavior: 'translate' }).expect(200);
  const original = (await audio(agent, c.id).expect(200)).body;
  const corrected = (await post(agent, `/api/calls/${c.id}/correct`, { replyId: original.replyId, text: '帮我记住我喜欢画画', operationId: randomUUID() }).expect(200)).body;
  assert.equal(corrected.reply, '帮我记住我喜欢画画'); assert.equal(corrected.candidate, undefined);
  const switched = (await post(agent, `/api/calls/${c.id}/correct`, { replyId: corrected.replyId, text: '切换客家话翻译模式', operationId: randomUUID() }).expect(200)).body;
  assert.equal(switched.reply, '切换客家话翻译模式'); assert.equal(switched.conversationMode.dialect, 'chaoshan');
});

test('cancelled raw-audio understanding cannot publish an old transcript or reply after delayed provider receipt', async t => {
  let entered!: () => void, release!: (value: Response) => void;
  const began = new Promise<void>(resolve => { entered = resolve; });
  const { agent } = harness(t, { env, fetch: (async () => { entered(); return new Promise<Response>(resolve => { release = resolve; }); }) as typeof fetch });
  await setup(agent); const c = await call(agent);
  await post(agent, `/api/calls/${c.id}/mode`, { mode: 'dialect', dialect: 'chaoshan', behavior: 'understand' }).expect(200);
  const pending = audio(agent, c.id).then((result: any) => result); await began;
  await post(agent, `/api/calls/${c.id}/cancel`).expect(200);
  release(jsonReply(JSON.stringify({ meaning: '迟到的私密意思', reply: '迟到的回应' })));
  const result = await pending; assert.ok([409, 499].includes(result.status));
  assert.equal(JSON.stringify(result.body).includes('迟到'), false); assert.equal(result.body.interpretedText, undefined);
});

test('expired call cannot expose delayed dialect meaning', async t => {
  let time = Date.parse('2026-09-30T00:00:00Z'); let entered!: () => void, release!: (value: Response) => void;
  const began = new Promise<void>(resolve => { entered = resolve; });
  const { agent } = harness(t, { now: () => time, env, fetch: (async () => { entered(); return new Promise<Response>(resolve => { release = resolve; }); }) as typeof fetch });
  await setup(agent); const c = await call(agent);
  await post(agent, `/api/calls/${c.id}/mode`, { mode: 'dialect', dialect: 'hakka', behavior: 'understand' }).expect(200);
  const pending = audio(agent, c.id).then((result: any) => result); await began; time += 46_000;
  release(jsonReply(JSON.stringify({ meaning: '过期的私密意思', reply: '过期回应' })));
  const result = await pending; assert.equal(result.status, 410); assert.equal(JSON.stringify(result.body).includes('私密意思'), false);
});

test('long conversation keeps bounded earlier original statements in RAM prompts without persisting raw chat', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'baoyan-long-dialogue-')); const dataPath = join(directory, 'synthetic.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true })); const captures: any[] = [];
  const { agent } = harness(t, { dataPath, env, fetch: (async (_url, init) => { captures.push(JSON.parse(String(init?.body))); return jsonReply('虚构普通回应'); }) as typeof fetch });
  await setup(agent); const c = await call(agent);
  const earliest = '最早原话专用测试标记：我有一只纸折的小恐龙';
  await turn(agent, c.id, earliest);
  for (let i = 2; i <= 8; i++) await turn(agent, c.id, `虚构第${i}轮：今天我们讨论不同的小事情`);
  const last = captures.at(-1).messages;
  assert.equal(last.some((message: any) => message.role === 'user' && message.content === earliest), false);
  assert.ok(last.some((message: any) => message.role === 'system' && message.content.includes(earliest)));
  assert.match(last[0].content, /不视为确认记忆/);
  const db = new DatabaseSync(dataPath, { readOnly: true });
  try {
    for (const table of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
      assert.equal(JSON.stringify(db.prepare(`SELECT * FROM "${table.name.replace(/"/g, '""')}"`).all()).includes('最早原话专用测试标记'), false, `raw chat leaked into ${table.name}`);
  } finally { db.close(); }
});

test('correction during long conversation restores old statements and excludes the incorrect utterance', async t => {
  const captures: any[] = [];
  const { agent } = harness(t, { env, fetch: (async (_url, init) => { captures.push(JSON.parse(String(init?.body))); return jsonReply('虚构普通回应'); }) as typeof fetch });
  await setup(agent); const c = await call(agent); const earliest = '最早的虚构原话：我有一只纸折的小恐龙';
  await turn(agent, c.id, earliest); for (let i = 2; i <= 6; i++) await turn(agent, c.id, `虚构第${i}轮讨论`);
  const incorrect = await turn(agent, c.id, '错误标记：我明天十点回家');
  await post(agent, `/api/calls/${c.id}/correct`, { replyId: incorrect.replyId, text: '正确标记：我晚上十点回家', operationId: randomUUID() }).expect(200);
  for (let i = 8; i <= 14; i++) await turn(agent, c.id, `虚构第${i}轮继续讨论`);
  const encoded = JSON.stringify(captures.at(-1).messages);
  assert.equal(encoded.includes('错误标记：我明天十点回家'), false);
  assert.ok(encoded.includes('正确标记：我晚上十点回家')); assert.ok(encoded.includes(earliest));
});

test('earlier conversation snippets remain bounded and disappear after ending and starting another call', async t => {
  const captures: any[] = [];
  const { agent } = harness(t, { env, fetch: (async (_url, init) => { captures.push(JSON.parse(String(init?.body))); return jsonReply('虚构普通回应'); }) as typeof fetch });
  await setup(agent); const c = await call(agent);
  for (let i = 1; i <= 18; i++) await turn(agent, c.id, `虚构长原话第${i}轮：${'纸折的小恐龙正在散步。'.repeat(22)}`);
  const system = captures.at(-1).messages[0].content;
  const encoded = system.match(/这次通话较早的用户(?:原话片段|陈述文字线索（可能含转写\/译意，不保证逐字）)JSON：(\[[\s\S]*?\])。/)[1];
  const earlier = JSON.parse(encoded);
  assert.equal(earlier.length, 10); assert.ok(earlier.every((text: string) => text.length <= 160));
  assert.equal(earlier.some((text: string) => text.startsWith('虚构长原话第1轮：')), false);
  await post(agent, `/api/calls/${c.id}/end`).expect(200); const fresh = await call(agent); await turn(agent, fresh.id, '重新开始聊一个话题');
  assert.equal(JSON.stringify(captures.at(-1).messages).includes('虚构长原话'), false);
});


test('an audible final story ACK creates only the completion question under a fresh speech identity and repeated ACKs cannot repeat it',async t=>{
 const speechBodies:any[]=[],chatBodies:any[]=[];
 const {agent}=harness(t,{env,fetch:(async(url,init)=>{
  const body=JSON.parse(String(init?.body));
  if(String(url).endsWith('/chat/completions')){chatBodies.push(body);return jsonReply('虚构普通回答');}
  speechBodies.push(body);return new Response(new Uint8Array([0x49,0x44,0x33,1]),{headers:{'content-type':'audio/mpeg'}});
 }) as typeof fetch});
 await setup(agent);const c=await call(agent);
 const first=await turn(agent,c.id,'宝妍，请讲《纸船的第二次出发》吧');
 assert.equal(first.story.segment,1);assert.doesNotMatch(first.reply,/准备好后.*下一段/);
 await post(agent,`/api/calls/${c.id}/story-control`,{action:'next',operationId:randomUUID()}).expect(200);
 const last=(await post(agent,`/api/calls/${c.id}/story-control`,{action:'next',operationId:randomUUID()}).expect(200)).body;
 const operationId=randomUUID();
 const complete=(await post(agent,`/api/calls/${c.id}/story-control`,{action:'complete',operationId}).expect(200)).body;
 assert.equal(complete.reply,'故事讲完啦。还想听一篇，还是先休息？');
 assert.notEqual(complete.replyId,last.replyId);assert.equal(complete.story.status,'completed');
 assert.equal(complete.story.id,first.story.id);assert.equal(complete.story.endsAt,first.story.endsAt);
 const retried=(await post(agent,`/api/calls/${c.id}/story-control`,{action:'complete',operationId}).expect(200)).body;
 assert.deepEqual(retried,complete);
 const duplicate=await post(agent,`/api/calls/${c.id}/story-control`,{action:'complete',operationId:randomUUID()}).expect(409);
 assert.equal(duplicate.body.code,'STORY_COMPLETED');
 await post(agent,`/api/calls/${c.id}/speech`,{replyId:last.replyId}).expect(409);
 await post(agent,`/api/calls/${c.id}/speech`,{replyId:complete.replyId}).expect(200);
 assert.equal(speechBodies.length,1);assert.equal(speechBodies[0].input,complete.reply);assert.equal(chatBodies.length,0);
 const stopped=await turn(agent,c.id,'不听了');
 assert.equal(stopped.story.id,first.story.id);assert.equal(stopped.story.status,'completed');
 assert.doesNotMatch(stopped.reply,/还想听|我们听《/);assert.equal(speechBodies.length,1);
});

test('an explicit new story after the completion question starts another age-matched original without extending the call',async t=>{
 const {agent}=harness(t,{env,fetch:(async()=>{throw new Error('stories must not generate model replies');}) as typeof fetch});
 await setup(agent);const c=await call(agent);
 const first=await turn(agent,c.id,'讲故事：paper-boat-test');
 for(const action of ['next','next','complete'])await post(agent,`/api/calls/${c.id}/story-control`,{action,operationId:randomUUID()}).expect(200);
 const next=await turn(agent,c.id,'再来一篇');
 assert.notEqual(next.story.id,first.story.id);assert.equal(next.story.segment,1);assert.equal(next.story.status,'playing');
 const catalog=(await agent.get('/api/software/catalog').expect(200)).body;
 assert.ok(catalog.stories.some((item:any)=>item.id===next.story.id&&item.ageGroup===profile.ageGroup));
 assert.ok(Date.parse(next.story.endsAt)<=Date.parse(first.story.endsAt));
});

test('ordinary chat pauses the inherited story progress so its answer is never counted as a story paragraph',async t=>{
 const {agent}=harness(t,{env,fetch:(async()=>jsonReply('画一朵黄色的小花也不错呀。')) as typeof fetch});
 await setup(agent);const c=await call(agent);
 const first=await turn(agent,c.id,'讲故事：paper-boat-test');
 const ordinary=await turn(agent,c.id,'今天我画了一朵花');
 assert.equal(ordinary.story.status,'paused');assert.equal(ordinary.story.segment,first.story.segment);
 assert.equal(ordinary.story.id,first.story.id);assert.equal(ordinary.story.endsAt,first.story.endsAt);
 const resumed=await turn(agent,c.id,'继续故事');
 assert.equal(resumed.story.status,'playing');assert.equal(resumed.story.segment,first.story.segment);
 assert.equal(resumed.story.id,first.story.id);assert.match(resumed.reply,/浅水盆/);
});

test('cancelled story playback never confirms completion or asks another-story question',async t=>{
 const {agent}=harness(t);await setup(agent);const c=await call(agent);
 const first=await turn(agent,c.id,'讲故事：paper-boat-test');
 await post(agent,`/api/calls/${c.id}/story-control`,{action:'next',operationId:randomUUID()}).expect(200);
 await post(agent,`/api/calls/${c.id}/story-control`,{action:'next',operationId:randomUUID()}).expect(200);
 await post(agent,`/api/calls/${c.id}/cancel`).expect(200);
 const complete=(await post(agent,`/api/calls/${c.id}/story-control`,{action:'complete',operationId:randomUUID()}).expect(200)).body;
 assert.equal(complete.story.status,'paused');assert.equal(complete.story.id,first.story.id);
 assert.doesNotMatch(complete.reply,/还想听|先休息/);
});


test('a story-specific deadline reached before the final ACK stops without a new completion invitation',async t=>{
 let time=Date.parse('2026-10-13T01:00:00Z');
 const {agent}=harness(t,{now:()=>time});await setup(agent);const c=await call(agent);
 const first=await turn(agent,c.id,'我想听一个一分钟睡前故事');
 await post(agent,`/api/calls/${c.id}/story-control`,{action:'next',operationId:randomUUID()}).expect(200);
 await post(agent,`/api/calls/${c.id}/story-control`,{action:'next',operationId:randomUUID()}).expect(200);
 time+=30000;await post(agent,`/api/calls/${c.id}/heartbeat`).expect(200);
 time+=30000;
 const ended=(await post(agent,`/api/calls/${c.id}/story-control`,{action:'complete',operationId:randomUUID()}).expect(200)).body;
 assert.equal(ended.story.endsAt,first.story.endsAt);assert.equal(ended.story.status,'completed');
 assert.match(ended.reply,/时间到了/);assert.doesNotMatch(ended.reply,/还想听|先休息/);
});

test('an unrelated reply consumes a short continuation invitation, while permission invalidation blocks its old speech',async t=>{
 const speechBodies:any[]=[];
 const {agent}=harness(t,{env,fetch:(async(url,init)=>{
  if(String(url).endsWith('/chat/completions'))return jsonReply('画了一朵花呀。');
  speechBodies.push(JSON.parse(String(init?.body)));return new Response(new Uint8Array([0x49,0x44,0x33,1]),{headers:{'content-type':'audio/mpeg'}});
 })as typeof fetch});
 await setup(agent);const c=await call(agent);
 await turn(agent,c.id,'讲故事：paper-boat-test');
 for(const action of ['next','next'])await post(agent,`/api/calls/${c.id}/story-control`,{action,operationId:randomUUID()}).expect(200);
 const complete=(await post(agent,`/api/calls/${c.id}/story-control`,{action:'complete',operationId:randomUUID()}).expect(200)).body;
 await turn(agent,c.id,'今天画了一朵花');
 const okay=await turn(agent,c.id,'好');
 assert.equal(okay.story,undefined);assert.doesNotMatch(okay.reply,/我们听《/);
 await post(agent,`/api/calls/${c.id}/speech`,{replyId:complete.replyId}).expect(409);
 assert.equal(speechBodies.length,0);
 await unlock(agent);await agent.patch('/api/parent/settings').set('Origin',origin).send({memoryEnabled:false}).expect(200);
 await post(agent,`/api/calls/${c.id}/speech`,{replyId:okay.replyId}).expect(410);
 assert.equal(speechBodies.length,0);
});


test('ordinary self-reports after completing a story enter today recap in the same call, while story text and controls never do',async t=>{
 const {agent}=harness(t);await setup(agent);const c=await call(agent);
 await turn(agent,c.id,'讲故事：paper-boat-test');
 for(const action of ['next','next','complete'])await post(agent,`/api/calls/${c.id}/story-control`,{action,operationId:randomUUID()}).expect(200);
 await turn(agent,c.id,'我今天很开心，和朋友一起玩积木。');
 await turn(agent,c.id,'我有点担心明天的考试。');
 await turn(agent,c.id,'好');
 await post(agent,`/api/calls/${c.id}/end`).expect(200);await unlock(agent);
 const data=(await agent.get('/api/parent/memories').expect(200)).body;
 assert.equal(data.dailySummaries.records.length,1);
 const record=data.dailySummaries.records[0];
 assert.deepEqual(record.moods,['开心','担心']);assert.equal(record.turns,2);
 assert.ok(record.topics.includes('朋友相处'));assert.ok(record.topics.includes('积木'));assert.ok(record.topics.includes('考试'));
 assert.doesNotMatch(JSON.stringify(data.dailySummaries),/浅水盆|托盘|还想听一篇|故事操作/);
});


test('ordinary statements during a playing or paused story stay outside memory and story progress remains resumable',async t=>{
 const {agent}=harness(t);await setup(agent);const c=await call(agent);
 const first=await turn(agent,c.id,'讲故事：paper-boat-test');
 const chatting=await turn(agent,c.id,'我今天很开心，和朋友一起玩积木。');
 assert.equal(chatting.story.status,'paused');assert.equal(chatting.story.segment,first.story.segment);
 const paused=await turn(agent,c.id,'我有点担心明天的考试。');assert.equal(paused.story.status,'paused');
 const resumed=await turn(agent,c.id,'继续故事');assert.equal(resumed.story.id,first.story.id);assert.equal(resumed.story.segment,1);
 await post(agent,`/api/calls/${c.id}/end`).expect(200);await unlock(agent);
 const data=(await agent.get('/api/parent/memories').expect(200)).body;
 assert.equal(data.dailySummaries.records.length,0);assert.equal(data.items.length,0);
});

test('correcting the first ordinary self-report after a story restores its source boundary without retaining the mistaken mood',async t=>{
 const {agent}=harness(t);await setup(agent);const c=await call(agent);
 await turn(agent,c.id,'讲故事：paper-boat-test');
 for(const action of ['next','next','complete'])await post(agent,`/api/calls/${c.id}/story-control`,{action,operationId:randomUUID()}).expect(200);
 const original=await turn(agent,c.id,'我今天很开心，和朋友玩积木。');assert.equal(original.story,undefined);
 const fixed=(await post(agent,`/api/calls/${c.id}/correct`,{replyId:original.replyId,text:'我有点担心明天的考试。',operationId:randomUUID()}).expect(200)).body;
 assert.equal(fixed.story,undefined);
 await post(agent,`/api/calls/${c.id}/end`).expect(200);await unlock(agent);
 const data=(await agent.get('/api/parent/memories').expect(200)).body,record=data.dailySummaries.records[0];
 assert.deepEqual(record.moods,['担心']);assert.deepEqual(record.topics,['考试']);assert.equal(record.turns,1);
});

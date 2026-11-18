import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../apps/server/src/app.js';
import { buildAutoMemoryMessages, extractAutoMemories } from '../apps/server/src/auto-memory-extractor.js';
import { createAutoMemoryStore } from '../apps/server/src/auto-memory-store.js';

// An injected clock and mock provider expose date ownership. They do not certify
// real-phone audio or the model's ability to phrase a memory naturally.
const origin = 'http://localhost:5173';
const profile = { pin: '123456', nickname: '虚构跨日体验', ageGroup: '6-8', sessionMinutes: 10, dailyMinutes: 20, consent: true, memoryEnabled: true };
const completion = (content: string) => Response.json({ choices: [{ finish_reason: 'stop', message: { content } }] });
type Statement = { id: string; text: string };
function harness(t: TestContext, options: { audio?: boolean; crossWhileReplying?: boolean; dataPath?: string } = {}) {
  let now = Date.parse('2026-10-03T23:59:50+08:00');
  const summaryInputs: Statement[][] = [], chatPrompts: string[] = [];
  let finishSummary!: () => void;
  const app = createApp({ dataPath: options.dataPath ?? ':memory:', now: () => now, allowedOrigins: [origin],
    env: { API_BASE_URL: 'https://fixture.invalid/v1', API_KEY: 'synthetic-only', CHAT_MODEL: 'fixture', ...(options.audio ? { ASR_MODEL: 'fixture-asr' } : {}) },
    fetch: async (url, init) => {
      if (String(url).endsWith('/audio/transcriptions')) { now += 15_000; return Response.json({ text: '我明天准备画画' }); }
      const body = JSON.parse(String(init?.body));
      if (body.messages[0].content.includes('BOBO_AUTO_MEMORY_EXTRACT_V1')) {
        const statements = JSON.parse(body.messages.at(-1).content).statements as Statement[];
        summaryInputs.push(statements);
        await new Promise<void>(resolve => { finishSummary = resolve; });
        return completion(JSON.stringify({ memories: statements.map(statement => ({ statementId: statement.id, quote: statement.text, kind: /明天/.test(statement.text) ? 'plan' : /喜欢/.test(statement.text) ? 'preference' : 'event' })) }));
      }
      chatPrompts.push(body.messages[0].content);
      if (options.crossWhileReplying && chatPrompts.length === 1) now += 15_000;
      return completion('好呀，我听见了。');
    },
  });
  t.after(() => app.locals.close());
  const agent = request.agent(app);
  const post = (path: string, body: unknown = {}) => agent.post('/api' + path).set('Origin', origin).send(body);
  return { app, agent, post, summaryInputs, chatPrompts,
    advance(milliseconds: number) { now += milliseconds; }, resolveSummary() { finishSummary(); } };
}
async function start(h: ReturnType<typeof harness>) {
  await h.post('/setup', profile).expect(201);
  return (await h.post('/calls', { operationId: randomUUID() }).expect(201)).body.id as string;
}
async function finish(h: ReturnType<typeof harness>, id: string) {
  await h.post(`/calls/${id}/end`).expect(200);
  h.advance(5_000); h.resolveSummary(); await h.app.locals.waitForAutoMemory();
  await h.post('/parent/unlock', { pin: profile.pin }).expect(200);
  return (await h.agent.get('/api/parent/memories').expect(200)).body.items as { content: string; source: string; expiresAt: string }[];
}

test('a reply and final summary crossing Beijing midnight keep each original statement date', async t => {
  const h = harness(t, { crossWhileReplying: true }), id = await start(h);
  await h.post(`/calls/${id}/turn`, { text: '我明天准备画画', operationId: randomUUID() }).expect(200);
  await h.post(`/calls/${id}/turn`, { text: '我今天画了小猫', operationId: randomUUID() }).expect(200);
  const memories = await finish(h, id);
  assert.equal(memories.find(memory => memory.content === '我明天准备画画')?.source, '聊天自动整理（原话日：2026-10-03）');
  assert.equal(memories.find(memory => memory.content === '我今天画了小猫')?.source, '聊天自动整理（原话日：2026-10-04）');
  assert.deepEqual(h.summaryInputs[0].map(statement => Object.keys(statement).sort()), [['id', 'text'], ['id', 'text']], 'provider does not receive or manufacture date metadata');
  await h.post('/parent/lock').expect(200);
  const next = (await h.post('/calls', { operationId: randomUUID() }).expect(201)).body.id;
  await h.post(`/calls/${next}/turn`, { text: '你还记得我的画画计划吗', operationId: randomUUID() }).expect(200);
  assert.match(h.chatPrompts.at(-1)!, /2026-10-03/);
  assert.match(h.chatPrompts.at(-1)!, /2026-10-04/);
  assert.match(h.chatPrompts.at(-1)!, /计划.*做过.*未知|旧计划是否做过仍未知/);
});

test('ASR completion after midnight retains the server audio-upload receipt day', async t => {
  const h = harness(t, { audio: true }), id = await start(h);
  await h.agent.post(`/api/calls/${id}/audio`).set('Origin', origin)
    .field('operationId', randomUUID()).attach('audio', Buffer.from('mock-only-audio'), { filename: 'fictional.wav', contentType: 'audio/wav' }).expect(200);
  const memories = await finish(h, id);
  assert.deepEqual(memories.map(memory => memory.source), ['聊天自动整理（原话日：2026-10-03）']);
});

test('a selected newer declaration gets its own trusted date and model-authored date fields are rejected', () => {
  const statements = [
    { id: 'old', text: '我最喜欢的颜色是蓝色', recordedDay: '2026-10-03' },
    { id: 'new', text: '我最喜欢的颜色是红色', recordedDay: '2026-10-04' },
  ];
  const output = JSON.stringify({ memories: [
    { statementId: 'new', quote: statements[1].text, kind: 'preference' },
    { statementId: 'old', quote: statements[0].text, kind: 'preference' },
  ] });
  const result = extractAutoMemories(output, statements);
  assert.equal(result.length, 1); assert.equal(result[0].content, statements[1].text);
  assert.equal((result[0] as { recordedDay?: string }).recordedDay, '2026-10-04');
  assert.deepEqual(JSON.parse(buildAutoMemoryMessages(statements)[1].content).statements,
    statements.map(({ id, text }) => ({ id, text })));
  assert.throws(() => extractAutoMemories(JSON.stringify({ memories: [{ statementId: 'new', quote: statements[1].text, kind: 'preference', recordedDay: '2099-01-01' }] }), statements), /INVALID_OUTPUT/);
});

test('correction after midnight replaces its evidence date while retracting a later turn preserves earlier dates', async t => {
  const h = harness(t), id = await start(h);
  await h.post(`/calls/${id}/turn`, { text: '我明天准备画画', operationId: randomUUID() }).expect(200);
  const wrong = (await h.post(`/calls/${id}/turn`, { text: '我今天画了小狗', operationId: randomUUID() }).expect(200)).body;
  h.advance(15_000);
  await h.post(`/calls/${id}/correct`, { replyId: wrong.replyId, text: '我今天画了小猫', operationId: randomUUID() }).expect(200);
  const retracted = (await h.post(`/calls/${id}/turn`, { text: '我明天准备踢球', operationId: randomUUID() }).expect(200)).body;
  await h.post(`/calls/${id}/retract`, { replyId: retracted.replyId }).expect(200);
  const memories = await finish(h, id);
  assert.deepEqual(new Set(memories.map(memory => memory.content)), new Set(['我明天准备画画', '我今天画了小猫']));
  assert.equal(memories.find(memory => memory.content === '我明天准备画画')?.source, '聊天自动整理（原话日：2026-10-03）');
  assert.equal(memories.find(memory => memory.content === '我今天画了小猫')?.source, '聊天自动整理（原话日：2026-10-04）');
});

test('legacy statement metadata does not acquire the summary completion date and invalid calendar dates are rejected', async t => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE families(id TEXT PRIMARY KEY,revision INTEGER); CREATE TABLE memories(id TEXT,family_id TEXT,key TEXT,content TEXT,kind TEXT,revision INTEGER,expires_at INTEGER,source TEXT,UNIQUE(family_id,key)); CREATE TABLE memory_operations(family_id TEXT,memory_id TEXT,action TEXT,state TEXT);');
  const familyId = randomUUID(); db.prepare('INSERT INTO families VALUES(?,0)').run(familyId);
  const store = createAutoMemoryStore({ db, now: () => Date.parse('2026-10-04T00:00:05+08:00'), valid: () => true, onSaved: () => {},
    summarize: async () => JSON.stringify({ memories: [{ statementId: 'legacy', quote: '我明天准备画画', kind: 'plan' }] }) });
  t.after(() => { store.close(); db.close(); });
  store.enqueue({ familyId, childId: randomUUID(), revision: 0 }, [{ id: 'legacy', text: '我明天准备画画' }]);
  await store.wait();
  assert.equal(db.prepare('SELECT source FROM memories').get()?.source, '聊天自动整理（日期未记录）');
  for (const recordedDay of ['2026-02-30', '2026-13-01', 'invalid', '2026-10-04T00:00:00Z']) {
    assert.throws(() => buildAutoMemoryMessages([{ id: 'bad', text: '我喜欢画画', recordedDay }]), /INVALID_STATEMENTS/);
  }
});

test('repeating a relative-day plan on a later natural day replaces its reference day rather than retaining yesterday', async t => {
  const h = harness(t), first = await start(h);
  await h.post(`/calls/${first}/turn`, { text: '我明天准备画画', operationId: randomUUID() }).expect(200);
  await finish(h, first); await h.post('/parent/lock').expect(200);
  h.advance(86_400_000);
  const second = (await h.post('/calls', { operationId: randomUUID() }).expect(201)).body.id;
  await h.post(`/calls/${second}/turn`, { text: '我明天准备画画', operationId: randomUUID() }).expect(200);
  const memories = await finish(h, second);
  assert.equal(memories.length, 1);
  assert.equal(memories[0].source, '聊天自动整理（原话日：2026-10-04）');
});

test('repeating an undated stable preference on another day does not extend its existing expiry', async t => {
  const h = harness(t), first = await start(h);
  await h.post(`/calls/${first}/turn`, { text: '我喜欢晚上画画', operationId: randomUUID() }).expect(200);
  const before = await finish(h, first); await h.post('/parent/lock').expect(200);
  h.advance(86_400_000);
  const second = (await h.post('/calls', { operationId: randomUUID() }).expect(201)).body.id;
  await h.post(`/calls/${second}/turn`, { text: '我喜欢晚上画画', operationId: randomUUID() }).expect(200);
  const after = await finish(h, second);
  assert.equal(after.length, 1); assert.equal(after[0].source, before[0].source);
  assert.equal(after[0].expiresAt, before[0].expiresAt);
});

test('old persisted summary completion dates stay intact and are not supplied as original utterance dates', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'bobo-original-day-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dataPath = join(directory, 'fictional.sqlite'), h = harness(t, { dataPath }), id = await start(h);
  const db = new DatabaseSync(dataPath);
  const family = db.prepare('SELECT id,revision FROM families').get() as { id: string; revision: number };
  db.prepare('INSERT INTO memories VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), family.id, 'legacy.drawing.plan', '我明天准备画画', 'plan', family.revision, Date.parse('2026-11-01T00:00:00Z'), '聊天自动整理（1999-01-01）');
  db.close();
  await h.post(`/calls/${id}/turn`, { text: '你还记得我的画画计划吗', operationId: randomUUID() }).expect(200);
  const prompt = h.chatPrompts.at(-1)!;
  assert.match(prompt, /我明天准备画画/); assert.equal(prompt.includes('1999-01-01'), false);
  const supplied = JSON.parse(prompt.split('可用记忆JSON：')[1].split('\n')[0]) as { content: string; recordedAt?: string }[];
  assert.equal(supplied.find(memory => memory.content === '我明天准备画画')?.recordedAt, undefined);
  const after = new DatabaseSync(dataPath);
  assert.equal(after.prepare('SELECT source FROM memories').get()?.source, '聊天自动整理（1999-01-01）'); after.close();
});

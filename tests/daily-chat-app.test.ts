import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import request from 'supertest';
import { createApp } from '../apps/server/src/app.js';

const origin = 'http://localhost:5173';
const profile = { pin: '123456', nickname: '虚构小结测试', ageGroup: '6-8', sessionMinutes: 10, dailyMinutes: 20, consent: true };
const completion = (content: string) => Response.json({ choices: [{ finish_reason: 'stop', message: { content } }] });
const liveEnv = { CHAT_PROVIDER: 'volc', CHAT_API_BASE_URL: 'https://synthetic.invalid/api/v3', CHAT_API_KEY: 'synthetic-only', CHAT_MODEL: 'doubao-seed-2-1-lite-260915' };
function harness(t: TestContext, options: { env?: Record<string, string>; fetch?: typeof fetch; dataPath?: string; at?: string } = {}) {
  let now = Date.parse(options.at ?? '2026-10-03T04:00:00Z'), calls = 0, childId = '';
  const app = createApp({ dataPath: options.dataPath ?? ':memory:', env: options.env ?? {}, now: () => now, fetch: async (url, init) => { calls++; return options.fetch ? options.fetch(url, init) : completion('好，我们接着聊。'); } });
  t.after(() => app.locals.close());
  const agent = request.agent(app), post = (path: string, body: object = {}) => agent.post(path).set('Origin', origin).send(body);
  const newCall = async () => { await post('/api/parent/lock').expect(200); return (await post('/api/calls', { operationId: crypto.randomUUID() }).expect(201)).body.id as string; };
  const start = async (settings: object = {}) => { const setup = (await post('/api/setup', { ...profile, ...settings }).expect(201)).body; childId = setup.child.id; return newCall(); };
  const turn = async (id: string, text: string, extra: object = {}) => (await post(`/api/calls/${id}/turn`, { text, operationId: crypto.randomUUID(), ...extra }).expect(200)).body;
  const end = (id: string) => post(`/api/calls/${id}/end`).expect(200);
  const memories = async () => { await post('/api/parent/unlock', { pin: profile.pin }).expect(200); return (await agent.get('/api/parent/memories').set('X-Baoyan-Child', childId).expect(200)).body; };
  return { app, agent, post, start, newCall, turn, end, memories, setTime: (at: string) => { now = Date.parse(at); }, setChild: (id: string) => { childId = id; }, get childId() { return childId; }, get calls() { return calls; } };
}
function photo() {
  const crc = (data: Buffer) => { let value = 0xffffffff; for (const byte of data) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0); } return (value ^ 0xffffffff) >>> 0; };
  const part = (name: string, data = Buffer.alloc(0)) => { const result = Buffer.alloc(data.length + 12); result.writeUInt32BE(data.length); result.write(name, 4); data.copy(result, 8); result.writeUInt32BE(crc(result.subarray(4, result.length - 4)), result.length - 4); return result; };
  const header = Buffer.alloc(13); header.writeUInt32BE(32); header.writeUInt32BE(24, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), part('IHDR', header), part('IDAT', deflateSync(Buffer.alloc(24 * 97))), part('IEND')]);
}
function wav() { const out = Buffer.alloc(3244); out.write('RIFF'); out.writeUInt32LE(out.length - 8, 4); out.write('WAVEfmt ', 8); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(16000, 24); out.writeUInt32LE(32000, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(out.length - 44, 40); return out; }

test('questions and explicit concerns form a separate summary at normal end with no provider calls', async t => {
  const h = harness(t), id = await h.start();
  await h.turn(id, '为什么这道作业题目要这样写？'); await h.turn(id, '我有点担心明天的考试。');
  await h.end(id); await h.end(id);
  const result = await h.memories(), record = result.dailySummaries.records[0];
  assert.equal(result.items.length, 0); assert.equal(record.day, '2026-10-03'); assert.deepEqual(record.topics, ['作业', '考试']);
  assert.deepEqual(record.concerns, ['表达担心或害怕']); assert.equal(record.concernState, 'expressed'); assert.equal(record.turns, 2); assert.equal(record.sessions, 1);
  assert.equal(result.dailySummaries.classification, 'semantic-v3'); assert.equal(h.calls, 0);
  assert.deepEqual(record.moods, ['担心']); assert.equal(record.moodState, 'expressed');
  assert.equal(record.moodCoverage, 'current-rules'); assert.match(record.summary, /作业.*考试/); assert.match(record.summary, /担心/);
});
test('a daily recap contains self-reported happy and worried feelings without assuming a whole-day mood or improvement', async t => {
  const h = harness(t), id = await h.start();
  await h.turn(id, '我今天很开心，和朋友一起玩积木。');
  await h.turn(id, '我有点担心明天的考试。');
  await h.end(id);
  const result = await h.memories(), record = result.dailySummaries.records[0];
  assert.deepEqual(record.moods, ['开心', '担心']);
  assert.deepEqual(record.concerns, ['表达担心或害怕']);
  assert.match(record.summary, /朋友相处|积木/); assert.match(record.summary, /开心/); assert.match(record.summary, /担心/);
  assert.doesNotMatch(record.summary, /一整天|全天|好转|变开心|已经不担心/);
  assert.equal(record.turns, 2); assert.equal(h.calls, 0);
  const exported = (await h.agent.get('/api/parent/export').expect(200)).body;
  assert.ok(JSON.stringify(exported).includes('开心'), 'the authorized family export includes the same bounded daily recap');
});
test('questions and denied feelings are not converted into a statement that the child has a concern', async t => {
  const h = harness(t), id = await h.start(); await h.turn(id, '我是不是很紧张？'); await h.turn(id, '我不担心考试了。'); await h.end(id);
  const record = (await h.memories()).dailySummaries.records[0]; assert.equal(record.turns, 2); assert.deepEqual(record.concerns, []); assert.equal(record.concernState, 'not-explicit');
});
test('entering parent management completes the ordinary call and records its topic immediately', async t => {
  const h = harness(t), id = await h.start(); await h.turn(id, '为什么小猫会打呼噜？');
  const result = await h.memories(); assert.deepEqual(result.dailySummaries.records[0].topics, ['宠物']); assert.equal(h.calls, 0);
});
test('cancel removes only the last successful turn from the eventual summary', async t => {
  const h = harness(t), id = await h.start(); await h.turn(id, '为什么踢球会飞那么远？'); await h.turn(id, '我有点难过，作业写不出来。');
  await h.post(`/api/calls/${id}/cancel`).expect(200); await h.end(id);
  const record = (await h.memories()).dailySummaries.records[0]; assert.equal(record.turns, 1); assert.deepEqual(record.topics, ['运动']); assert.deepEqual(record.concerns, []);
});
test('a canceled in-flight reply never adds a late source or loses earlier accepted topics', async t => {
  let release: (() => void) | undefined, entered: (() => void) | undefined, providerCalls = 0;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const h = harness(t, { env: liveEnv, fetch: async () => {
    if (++providerCalls === 2) { entered!(); await new Promise<void>(resolve => { release = resolve; }); }
    return completion('好，我们接着聊。');
  } }), id = await h.start();
  await h.turn(id, '为什么小猫会叫？');
  const pending = h.post(`/api/calls/${id}/turn`, { text: '我有点担心考试。', operationId: crypto.randomUUID() }).then(result => result);
  await waiting; await h.post(`/api/calls/${id}/cancel`).expect(200); release!();
  assert.equal((await pending).status, 409); await h.end(id);
  const record = (await h.memories()).dailySummaries.records[0]; assert.equal(record.turns, 1); assert.deepEqual(record.topics, ['宠物']); assert.deepEqual(record.concerns, []); assert.equal(h.calls, 3); // Includes the single end-of-chat notebook request.
});
test('correction replaces the original topic and retraction removes the corrected source', async t => {
  const h = harness(t), id = await h.start(); const original = await h.turn(id, '为什么数学课有这么多作业？');
  const corrected = (await h.post(`/api/calls/${id}/correct`, { replyId: original.replyId, text: '为什么小狗会摇尾巴？', operationId: crypto.randomUUID() }).expect(200)).body;
  await h.post(`/api/calls/${id}/retract`, { replyId: corrected.replyId }).expect(200);
  await h.turn(id, '今天吃的水果好甜呀。'); await h.end(id);
  const record = (await h.memories()).dailySummaries.records[0]; assert.equal(record.turns, 1); assert.deepEqual(record.topics, ['吃饭']);
});
test('explicit opt out clears this call and remains opted out after cancel without deleting older summaries', async t => {
  const h = harness(t), first = await h.start(); await h.turn(first, '为什么小狗会摇尾巴？'); await h.end(first); await h.memories();
  const second = await h.newCall(); await h.turn(second, '我有点难过，作业太多了。'); await h.turn(second, '不要记录'); await h.post(`/api/calls/${second}/cancel`).expect(200); await h.turn(second, '为什么爸爸会打呼噜？'); await h.end(second);
  const record = (await h.memories()).dailySummaries.records[0]; assert.deepEqual(record.topics, ['宠物']); assert.equal(record.turns, 1); assert.equal(record.sessions, 1); assert.deepEqual(record.concerns, []);
});
test('disabled memory collects no new summary and preserves previously saved days', async t => {
  const h = harness(t), first = await h.start(); await h.turn(first, '为什么小猫喜欢睡觉？'); await h.end(first); const old = (await h.memories()).dailySummaries.records;
  await h.agent.patch('/api/parent/settings').set('Origin', origin).send({ memoryEnabled: false }).expect(200); const id = await h.newCall(); await h.turn(id, '我很担心数学作业。'); await h.end(id);
  const result = await h.memories(); assert.deepEqual(result.dailySummaries.records, old); assert.equal(result.items.length, 0);
});
test('an already-authorized parent disabling memory during another device call ends it without a new summary', async t => {
  const h = harness(t), empty = await h.start(); await h.end(empty); await h.memories();
  const link = (await h.post('/api/parent/devices/link').expect(200)).body, other = request.agent(h.app);
  await other.post('/api/devices/link').set('Origin', origin).send({ code: link.code, pin: profile.pin }).expect(201);
  await other.post('/api/parent/unlock').set('Origin', origin).send({ pin: profile.pin }).expect(200);
  const active = await h.newCall(); await h.turn(active, '我有点担心明天的考试。');
  const before = (await other.get('/api/parent/memories').set('X-Baoyan-Child', h.childId).expect(200)).body;
  assert.equal(before.dailySummaries.records.length, 0);
  await other.patch('/api/parent/settings').set('Origin', origin).set('X-Baoyan-Child', h.childId).send({ memoryEnabled: false }).expect(200);
  await h.post(`/api/calls/${active}/heartbeat`).expect(410); await h.end(active);
  const after = (await other.get('/api/parent/memories').set('X-Baoyan-Child', h.childId).expect(200)).body;
  assert.deepEqual(after.dailySummaries.records, []); assert.deepEqual(after.items, []); assert.equal(h.calls, 0);
});
test('unknown and adult speakers cannot record a summary for the child', async t => {
  const unknown = harness(t, { env: liveEnv }), unknownId = await unknown.start(); await unknown.post('/api/parent/unlock', { pin: profile.pin }).expect(200);
  await unknown.agent.patch('/api/parent/settings').set('Origin', origin).send({ voiceEnabled: true }).expect(200); const call = await unknown.newCall(); await unknown.turn(call, '为什么作业要这么多？'); await unknown.end(call);
  assert.equal((await unknown.memories()).dailySummaries.records.length, 0); assert.equal(unknown.calls, 1);
  const adult = harness(t), old = await adult.start(); await adult.end(old); await adult.memories(); await adult.agent.patch('/api/parent/settings').set('Origin', origin).send({ voiceEnabled: true }).expect(200);
  const member = (await adult.post('/api/parent/members', { name: '虚构爸爸', relation: '爸爸', consent: true }).expect(201)).body;
  await adult.post(`/api/parent/members/${member.id}/enroll`, { demo: true, consent: true }).expect(200); const adultCall = await adult.newCall(); await adult.turn(adultCall, '为什么小猫会叫？', { demoSpeaker: 'child' }); await adult.turn(adultCall, '我担心考试。', { demoSpeaker: member.id }); await adult.end(adultCall);
  assert.equal((await adult.memories()).dailySummaries.records.length, 0); assert.equal(adult.calls, 0); assert.ok(unknownId);
});
test('image and pure dialect translation turns do not become child topic or concern evidence', async t => {
  const stages:string[]=[];
  const h = harness(t, { env: liveEnv, fetch: async (_url, init) => {
    const parts = JSON.parse(String(init?.body)).messages.at(-1).content;
    if(Array.isArray(parts)&&parts.some(part=>part.type==='input_audio')){stages.push('translation');return completion(JSON.stringify({meaning:'我有点担心考试',reply:'我有点担心考试'}));}
    if(Array.isArray(parts)&&parts.some(part=>part.type==='image_url')){stages.push('image-facts');return completion(JSON.stringify({facts:'画面里有一幅画。',uncertainties:''}));}
    stages.push('unified-reply');return completion(JSON.stringify({action:'reply',segments:[{text:'我们可以一起看看画面。',expression:'natural'}]}));
  } }), id = await h.start();
  await h.agent.post(`/api/calls/${id}/image`).set('Origin', origin).field('operationId', crypto.randomUUID()).field('question', '我有点难过，作业画不好').attach('image', photo(), { filename: 'virtual.png', contentType: 'image/png' }).expect(200);
  await h.post(`/api/calls/${id}/mode`, { mode: 'dialect', dialect: 'chaoshan', behavior: 'translate' }).expect(200);
  await h.agent.post(`/api/calls/${id}/audio`).set('Origin', origin).field('operationId', crypto.randomUUID()).attach('audio', wav(), { filename: 'virtual.wav', contentType: 'audio/wav' }).expect(200);
  await h.end(id); assert.equal((await h.memories()).dailySummaries.records.length, 0); assert.equal(h.calls, 3);
  assert.deepEqual(stages,['image-facts','unified-reply','translation']);
});
test('safety termination does not persist earlier content or dangerous concern labels', async t => {
  const h = harness(t), id = await h.start(); await h.turn(id, '为什么数学作业这么多？'); const result = await h.turn(id, '我想伤害自己'); assert.equal(result.endCall, true);
  assert.equal((await h.memories()).dailySummaries.records.length, 0);
});
test('cross-midnight labels use each accepted utterance day and lease expiry records a normal end', async t => {
  const h = harness(t, { at: '2026-10-03T15:59:50Z' }), id = await h.start(); await h.turn(id, '为什么小猫会叫？');
  h.setTime('2026-10-03T16:00:10Z'); await h.turn(id, '为什么数学作业这么多？'); h.setTime('2026-10-03T16:01:00Z'); h.app.locals.sweepExpiredState();
  const result = await h.memories(); assert.equal(result.dailySummaries.today, '2026-10-04'); assert.deepEqual(result.dailySummaries.records.map((r: any) => [r.day, r.topics]), [['2026-10-04', ['作业', '学校与学习']], ['2026-10-03', ['宠物']]]);
});
test('summary reads and deletion remain parent-authorized and a stale child header cannot target another profile', async t => {
  const h = harness(t), id = await h.start(); await h.turn(id, '为什么作业这么多？'); await h.end(id);
  await h.agent.get('/api/parent/memories').expect(403); await request(h.app).get('/api/parent/memories').expect(401); await h.memories(); const firstChild = h.childId;
  await h.agent.delete('/api/parent/chat-summaries/2026-10-03').set('Origin', origin).expect(400);
  const second = (await h.post('/api/parent/children', { nickname: '虚构第二资料', ageGroup: '6-8', sessionMinutes: 10, dailyMinutes: 20 }).expect(201)).body;
  await h.post(`/api/parent/children/${second.id}/select`).expect(200);
  await h.agent.get('/api/parent/memories').set('X-Baoyan-Child', firstChild).expect(409);
  await h.agent.delete('/api/parent/chat-summaries/2026-10-03').set('Origin', origin).set('X-Baoyan-Child', firstChild).expect(409);
  await h.post(`/api/parent/children/${firstChild}/select`).expect(200); assert.equal((await h.memories()).dailySummaries.records.length, 1);
});
test('cross-family parent sessions cannot address another family summary', async t => {
  const h = harness(t), id = await h.start(); await h.turn(id, '为什么小狗会叫？'); await h.end(id); await h.memories();
  const other = request.agent(h.app); await other.post('/api/setup').set('Origin', origin).send({ ...profile, nickname: '虚构另一家庭' }).expect(201); await other.post('/api/parent/unlock').set('Origin', origin).send({ pin: profile.pin }).expect(200);
  await other.get('/api/parent/memories').set('X-Baoyan-Child', h.childId).expect(409);
  await other.delete('/api/parent/chat-summaries/2026-10-03').set('Origin', origin).set('X-Baoyan-Child', h.childId).expect(409);
  assert.equal((await h.memories()).dailySummaries.records.length, 1);
});
test('a stale settings toggle from another device cannot modify either child after a profile switch', async t => {
  const h = harness(t), id = await h.start(); await h.end(id); await h.memories(); const firstChild = h.childId;
  const link = (await h.post('/api/parent/devices/link').expect(200)).body;
  const other = request.agent(h.app);
  await other.post('/api/devices/link').set('Origin', origin).send({ code: link.code, pin: profile.pin }).expect(201);
  await other.post('/api/parent/unlock').set('Origin', origin).send({ pin: profile.pin }).expect(200);
  const second = (await other.post('/api/parent/children').set('Origin', origin).send({ nickname: '虚构另一个孩子', ageGroup: '6-8', sessionMinutes: 10, dailyMinutes: 20 }).expect(201)).body;
  await other.post(`/api/parent/children/${second.id}/select`).set('Origin', origin).send({}).expect(200);
  const before = (await other.get('/api/bootstrap').expect(200)).body;
  const stale = await h.agent.patch('/api/parent/settings').set('Origin', origin).set('X-Baoyan-Child', firstChild).send({ memoryEnabled: false, voiceEnabled: true }).expect(409);
  assert.equal(stale.body.code, 'CONTEXT_CHANGED');
  const unchangedSecond = (await other.get('/api/bootstrap').expect(200)).body;
  assert.deepEqual(unchangedSecond.child, before.child);
  assert.equal(unchangedSecond.child.memoryEnabled, true); assert.equal(unchangedSecond.child.voiceEnabled, false);
  await other.post(`/api/parent/children/${firstChild}/select`).set('Origin', origin).send({}).expect(200);
  const unchangedFirst = (await h.agent.get('/api/bootstrap').expect(200)).body.child;
  assert.equal(unchangedFirst.memoryEnabled, true); assert.equal(unchangedFirst.voiceEnabled, false);
  // Legacy callers remain valid, and a matching current-child header is accepted.
  await h.agent.patch('/api/parent/settings').set('Origin', origin).send({ memoryEnabled: false }).expect(200);
  const updated = (await h.agent.patch('/api/parent/settings').set('Origin', origin).set('X-Baoyan-Child', firstChild).send({ voiceEnabled: true }).expect(200)).body;
  assert.equal(updated.memoryEnabled, false); assert.equal(updated.voiceEnabled, true); assert.equal(h.calls, 0);
});
test('deleting a day preserves long-term memories and duplicate end cannot restore that deleted summary', async t => {
  const h = harness(t), id = await h.start(); await h.turn(id, '为什么小狗会叫？'); await h.end(id); await h.memories();
  const next = await h.newCall(), turn = await h.turn(next, '帮我记住我喜欢蓝色'); assert.ok(turn.candidate);
  await h.post(`/api/calls/${next}/memory/confirm`, { candidateId: turn.candidate.id, operationId: crypto.randomUUID() }).expect(200); await h.end(next); const before = await h.memories(); assert.equal(before.items.length, 1);
  const result = await h.agent.delete('/api/parent/chat-summaries/2026-10-03').set('Origin', origin).set('X-Baoyan-Child', h.childId).expect(200); assert.equal(result.body.dailySummaries.records.length, 0);
  await h.end(id); const after = await h.memories(); assert.equal(after.dailySummaries.records.length, 0); assert.deepEqual(after.items, before.items);
  await h.agent.delete('/api/parent/chat-summaries/2026-02-30').set('Origin', origin).set('X-Baoyan-Child', h.childId).expect(400);
});
test('export contains bounded labels only; child removal, family withdrawal and retention erase the records', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'baoyan-daily-app-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dataPath = join(dir, 'synthetic.sqlite'), h = harness(t, { dataPath }), id = await h.start(); const text = '我有点难过，作业的题目像青柠小火车。'; await h.turn(id, text); await h.end(id); await h.memories(); const firstChild = h.childId;
  const exported = (await h.agent.get('/api/parent/export').expect(200)).body; assert.equal(exported.dailyChatSummaries.length, 1); assert.equal(exported.dailyChatSummaries[0].childId, firstChild); assert.doesNotMatch(JSON.stringify(exported.dailyChatSummaries), /青柠小火车|statement|sessionId/);
  const db = new DatabaseSync(dataPath); const rows = db.prepare('SELECT * FROM daily_chat_summaries').all(); assert.doesNotMatch(JSON.stringify(rows), /青柠小火车/); db.close();
  const second = (await h.post('/api/parent/children', { nickname: '虚构另一资料', ageGroup: '6-8', sessionMinutes: 10, dailyMinutes: 20 }).expect(201)).body; await h.post(`/api/parent/children/${second.id}/select`).expect(200); h.setChild(second.id);
  await h.agent.delete(`/api/parent/children/${firstChild}`).set('Origin', origin).expect(200); assert.equal((await h.agent.get('/api/parent/export').expect(200)).body.dailyChatSummaries.length, 0);
  const active = await h.newCall(); await h.turn(active, '为什么小猫会叫？'); await h.end(active); await h.memories(); h.setTime('2026-11-02T04:00:00Z'); h.app.locals.sweepExpiredState(); assert.equal((await h.memories()).dailySummaries.records.length, 0);
  const final = await h.newCall(); await h.turn(final, '为什么数学作业这么多？'); await h.end(final); await h.memories(); await h.post('/api/parent/withdraw').expect(200);
  const remaining = new DatabaseSync(dataPath); assert.equal((remaining.prepare('SELECT count(*) n FROM daily_chat_summaries').get() as any).n, 0); remaining.close();
});

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../apps/server/src/app.js';

const origin = 'http://localhost:5173';
const profile = { pin: '123456', nickname: '虚构记忆接续', ageGroup: '6-8', sessionMinutes: 10, dailyMinutes: 30, consent: true, memoryEnabled: true };
function harness(t: TestContext) {
  const memoriesSent: { key: string; content: string; kind: string }[][] = [];
  const app = createApp({ dataPath: ':memory:', now: () => Date.parse('2026-10-13T10:00:00+08:00'), allowedOrigins: [origin],
    env: { API_BASE_URL: 'https://fixture.invalid/v1', API_KEY: 'synthetic-only', CHAT_MODEL: 'fixture' },
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const prompt = body.messages[0].content as string;
      if (prompt.includes('可用记忆JSON：')) memoriesSent.push(JSON.parse(prompt.split('可用记忆JSON：')[1].split('\n')[0]));
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '好呀，接着说。' } }] });
    } });
  t.after(() => app.locals.close());
  const agent = request.agent(app);
  const post = (path: string, body: unknown = {}) => agent.post('/api' + path).set('Origin', origin).send(body);
  const start = async () => (await post('/calls', { operationId: randomUUID() }).expect(201)).body.id as string;
  const turn = (id: string, text: string) => post(`/calls/${id}/turn`, { text, operationId: randomUUID() });
  const save = async (id: string, text: string) => {
    const candidate = (await turn(id, `帮我记住${text}`).expect(200)).body.candidate;
    await post(`/calls/${id}/memory/confirm`, { candidateId: candidate.id, operationId: randomUUID() }).expect(200);
  };
  return { agent, post, start, turn, save, memoriesSent };
}

test('actual chat wiring omits a completed old plan on the following turn and still answers explicit recollection', async t => {
  const h = harness(t); await h.post('/setup', profile).expect(201);
  const id = await h.start(); await h.save(id, '我明天准备画画');
  await h.turn(id, '我已经画完小猫了').expect(200);
  assert.equal(h.memoriesSent.at(-1)!.some(item => item.content === '我明天准备画画'), false);
  await h.turn(id, '画画真有趣').expect(200);
  assert.equal(h.memoriesSent.at(-1)!.some(item => item.content === '我明天准备画画'), false);
  await h.turn(id, '你还记得我的画画计划吗').expect(200);
  assert.equal(h.memoriesSent.at(-1)!.some(item => item.content === '我明天准备画画'), true);
});

test('actual chat wiring keeps a named lasting refusal across calls while preserving explicit recall', async t => {
  const h = harness(t); await h.post('/setup', profile).expect(201);
  const id = await h.start(); await h.save(id, '我喜欢画画');
  await h.turn(id, '以后别再提画画了').expect(200);
  await h.post(`/calls/${id}/end`).expect(200);
  const next = await h.start();
  await h.turn(next, '绘画真有趣').expect(200);
  assert.equal(h.memoriesSent.at(-1)!.some(item => item.content === '我喜欢画画'), false);
  await h.turn(next, '你还记得我绘画的喜好吗').expect(200);
  assert.equal(h.memoriesSent.at(-1)!.some(item => item.content === '我喜欢画画'), true);
});

test('a temporary refusal does not suppress a stored preference on the next call', async t => {
  const h = harness(t); await h.post('/setup', profile).expect(201);
  const id = await h.start(); await h.save(id, '我喜欢画画');
  await h.turn(id, '今天不想再聊画画了').expect(200);
  await h.post(`/calls/${id}/end`).expect(200);
  const next = await h.start(); await h.turn(next, '绘画真有趣').expect(200);
  assert.equal(h.memoriesSent.at(-1)!.some(item => item.content === '我喜欢画画'), true);
});

test('declining an offered memory just for now does not permanently hide it', async t => {
  const h = harness(t); await h.post('/setup', profile).expect(201);
  const id = await h.start(); await h.save(id, '我计划画画');
  await h.post(`/calls/${id}/end`).expect(200);
  const offered = await h.start(); await h.turn(offered, '我回来了').expect(200);
  assert.equal(h.memoriesSent.at(-1)!.some(item => item.content === '我计划画画'), true);
  const declined = (await h.turn(offered, '先不聊').expect(200)).body;
  assert.match(declined.reply, /换个话题/);
  await h.post(`/calls/${offered}/end`).expect(200);
  const next = await h.start(); await h.turn(next, '画画真有趣').expect(200);
  assert.equal(h.memoriesSent.at(-1)!.some(item => item.content === '我计划画画'), true);
});

test('a later generic refusal cannot suppress an old offered topic after the conversation has moved on', async t => {
  const h = harness(t); await h.post('/setup', profile).expect(201);
  const id = await h.start(); await h.save(id, '我计划画画');
  await h.post(`/calls/${id}/end`).expect(200);
  const offered = await h.start(); await h.turn(offered, '我回来了').expect(200);
  await h.turn(offered, '我今天去踢足球了').expect(200);
  await h.turn(offered, '别再提这件事了').expect(200);
  await h.post(`/calls/${offered}/end`).expect(200);
  const next = await h.start(); await h.turn(next, '画画真有趣').expect(200);
  assert.equal(h.memoriesSent.at(-1)!.some(item => item.content === '我计划画画'), true);
});

test('an unknown speaker cannot persist a refusal of the child private memory', async t => {
  const h = harness(t); await h.post('/setup', profile).expect(201);
  const id = await h.start(); await h.save(id, '我喜欢画画');
  await h.post('/parent/unlock', { pin: profile.pin }).expect(200);
  await h.agent.patch('/api/parent/settings').set('Origin', origin).send({ voiceEnabled: true }).expect(200);
  await h.post('/parent/lock').expect(200);
  const unknown = await h.start(); await h.turn(unknown, '以后别再提画画了').expect(200);
  assert.equal(h.memoriesSent.at(-1)!.some(item => item.content === '我喜欢画画'), false);
  await h.post('/parent/unlock', { pin: profile.pin }).expect(200);
  await h.agent.patch('/api/parent/settings').set('Origin', origin).send({ voiceEnabled: false }).expect(200);
  await h.post('/parent/lock').expect(200);
  const child = await h.start(); await h.turn(child, '绘画真有趣').expect(200);
  assert.equal(h.memoriesSent.at(-1)!.some(item => item.content === '我喜欢画画'), true);
});

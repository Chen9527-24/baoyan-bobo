import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp, type AppOptions } from '../apps/server/src/app.js';
import { createContentStore } from '../apps/server/src/content-store.js';
import { ORIGINAL_STORIES } from '../apps/server/src/content-catalog.js';

const origin = 'http://localhost:5173';
const profile = { pin: '123456', nickname: '虚构内容体验者', ageGroup: '6-8', sessionMinutes: 10, dailyMinutes: 30, consent: true };
const reviewer = { reviewer: 'test-content-operator', note: '隔离库内容发布失效验证' };
const environment = { CHAT_PROVIDER: 'volc', CHAT_API_BASE_URL: 'http://127.0.0.1:9999/v3', CHAT_API_KEY: 'synthetic-chat', CHAT_MODEL: 'doubao-seed-2-1-lite-260915', TTS_PROVIDER: 'openai', TTS_API_BASE_URL: 'http://127.0.0.1:9999/v1', TTS_API_KEY: 'synthetic-tts', TTS_MODEL: 'synthetic-tts-model' };
function post(agent: any, path: string, body: unknown = {}) { return agent.post(path).set('Origin', origin).send(body); }
async function call(agent: any) { return (await post(agent, '/api/calls', { operationId: randomUUID() }).expect(201)).body; }
async function story(agent: any, callId: string, storyId = 'paper-boat-test') { return (await post(agent, `/api/calls/${callId}/task`, { kind: 'story', storyId, operationId: randomUUID() }).expect(200)).body; }
function harness(t: TestContext, options: AppOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'content-app-'));
  const dataPath = join(directory, 'test.sqlite');
  const eventsA: any[] = [], eventsB: any[] = [], chatBodies: any[] = [];
  let speechCalls = 0;
  const fetcher = (async (url, init) => {
    if (String(url).endsWith('/chat/completions')) {
      chatBodies.push(JSON.parse(String(init?.body)));
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '这是隔离测试中的宝妍回答。' } }] });
    }
    speechCalls++; return new Response(new Uint8Array([0x49, 0x44, 0x33, 1]), { headers: { 'content-type': 'audio/mpeg' } });
  }) as typeof fetch;
  const appA = createApp({ dataPath, now: () => Date.parse('2026-09-30T07:00:00Z'), env: environment, fetch: fetcher, onEvent: (familyId, type, data) => eventsA.push({ familyId, type, data }), ...options });
  const appB = createApp({ dataPath, now: () => Date.parse('2026-09-30T07:00:00Z'), env: environment, fetch: fetcher, onEvent: (familyId, type, data) => eventsB.push({ familyId, type, data }), ...options });
  const db = new DatabaseSync(dataPath), store = createContentStore(db);
  t.after(() => { appA.locals.close(); appB.locals.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { appA, appB, a: request.agent(appA), b: request.agent(appB), eventsA, eventsB, db, store, chatBodies, get speechCalls() { return speechCalls; } };
}
async function configure(h: ReturnType<typeof harness>) {
  await post(h.a, '/api/setup', profile).expect(201);
  await post(h.b, '/api/setup', { ...profile, nickname: '虚构另一个家庭' }).expect(201);
}

test('both app instances refresh independently published catalog and reject previously returned story audio', async t => {
  const h = harness(t); await configure(h); const ca = await call(h.a), cb = await call(h.b);
  const firstA = await story(h.a, ca.id), firstB = await story(h.b, cb.id);
  h.store.disable('paper-boat-test', { ...reviewer, expectedRevision: 1 });
  await h.a.get('/api/bootstrap').expect(200);
  await h.b.get('/api/bootstrap').expect(200);
  for (const agent of [h.a, h.b]) {
    const catalog = (await agent.get('/api/software/catalog').expect(200)).body;
    assert.equal(catalog.stories.some((item: any) => item.id === 'paper-boat-test'), false);
  }
  assert.ok(h.eventsA.some(event => event.data.reason === 'content-published' && event.data.callId === ca.id));
  assert.ok(h.eventsB.some(event => event.data.reason === 'content-published' && event.data.callId === cb.id));
  const oldA = await post(h.a, `/api/calls/${ca.id}/speech`, { replyId: firstA.replyId }).expect(409);
  const oldB = await post(h.b, `/api/calls/${cb.id}/speech`, { replyId: firstB.replyId }).expect(409);
  assert.equal(oldA.body.code, 'REPLY_EXPIRED'); assert.equal(oldB.body.code, 'REPLY_EXPIRED');
  assert.equal(h.speechCalls, 0);
  const next = (await post(h.a, `/api/calls/${ca.id}/story-control`, { action: 'next', operationId: randomUUID() }).expect(200)).body;
  assert.doesNotMatch(next.reply, /第二只船|浅水盆/);
  assert.equal(next.story, undefined);
});

test('active-route refresh sees reviewed replacement without waiting for bootstrap or sweep', async t => {
  const h = harness(t); await configure(h); const ca = await call(h.a); const first = await story(h.a, ca.id);
  const original = ORIGINAL_STORIES.find(item => item.id === 'paper-boat-test')!;
  const draft = { id: original.id, title: '已审核的纸船新版本', ageGroup: original.ageGroup, theme: original.theme, durationSeconds: original.durationSeconds, segments: original.segments, source: { kind: 'original', description: '隔离测试原创修订' } };
  h.store.saveDraft(draft, reviewer); h.store.review(draft.id, { ...reviewer, expectedDraftVersion: 2 }); h.store.publish(draft.id, { ...reviewer, expectedDraftVersion: 2, expectedRevision: 1 });
  const speech = await post(h.a, `/api/calls/${ca.id}/speech`, { replyId: first.replyId }).expect(409);
  assert.equal(speech.body.code, 'REPLY_EXPIRED');
  const fresh = await story(h.a, ca.id);
  assert.match(fresh.reply, /已审核的纸船新版本/); assert.equal(fresh.story.segment, 1);
  const secondCatalog = (await h.b.get('/api/software/catalog').expect(200)).body;
  assert.equal(secondCatalog.stories.find((item: any) => item.id === draft.id).title, draft.title);
});

test('turning a learning topic off removes the entry and rejects new or earlier exercise controls', async t => {
  const h = harness(t); await configure(h); const ca = await call(h.a), cb = await call(h.b);
  const first = (await post(h.a, `/api/calls/${ca.id}/task`, { kind: 'learning', topic: 'arithmetic', operationId: randomUUID() }).expect(200)).body;
  assert.equal(first.learning.topic, 'arithmetic');
  h.store.setLearningEnabled('arithmetic', false, { ...reviewer, expectedRevision: 1 });
  const stale = await post(h.a, `/api/calls/${ca.id}/speech`, { replyId: first.replyId }).expect(409);
  assert.equal(stale.body.code, 'REPLY_EXPIRED');
  const fresh = (await post(h.b, `/api/calls/${cb.id}/task`, { kind: 'learning', topic: 'arithmetic', operationId: randomUUID() }).expect(200)).body;
  assert.match(fresh.reply, /暂未上架/); assert.equal(fresh.learning, undefined);
  const catalog = (await h.b.get('/api/software/catalog').expect(200)).body;
  assert.equal(catalog.learningTopics.some((topic: any) => topic.id === 'arithmetic'), false);
  const after = (await post(h.a, `/api/calls/${ca.id}/turn`, { text: '讲一小步', operationId: randomUUID() }).expect(200)).body;
  assert.equal(after.learning, undefined); assert.doesNotMatch(after.reply, /先算7加5|得到12/);
});

test('pending synthetic TTS is invalidated by independently published content and cannot return old audio', async t => {
  let entered!: () => void, resolveSpeech!: (value: Response) => void;
  const began = new Promise<void>(resolve => { entered = resolve; });
  const pendingResponse = new Promise<Response>(resolve => { resolveSpeech = resolve; });
  const h = harness(t, { fetch: (async () => { entered(); return pendingResponse; }) as typeof fetch });
  await configure(h); const ca = await call(h.a); const first = await story(h.a, ca.id);
  const pending = post(h.a, `/api/calls/${ca.id}/speech`, { replyId: first.replyId }).then((response: any) => response);
  await began;
  h.store.disable('paper-boat-test', { ...reviewer, expectedRevision: 1 });
  await h.a.get('/api/bootstrap').expect(200);
  resolveSpeech(new Response(new Uint8Array([0x49, 0x44, 0x33, 1]), { headers: { 'content-type': 'audio/mpeg' } }));
  const late = await pending;
  assert.equal(late.status, 409); assert.equal(late.body.code, 'CONTEXT_CHANGED');
  assert.equal(late.headers['content-type'].includes('application/json'), true);
});

test('ending a call clears story and ordinary conversation and neither leaks to a later call', async t => {
  const h = harness(t); await configure(h); const old = await call(h.a);
  const marker = '本次通话临时标记松鼠画册';
  await post(h.a, `/api/calls/${old.id}/turn`, { text: marker, operationId: randomUUID() }).expect(200);
  const first = await story(h.a, old.id);
  await post(h.a, `/api/calls/${old.id}/end`, { reason: 'test' }).expect(200);
  await post(h.a, `/api/calls/${old.id}/speech`, { replyId: first.replyId }).expect(410);
  const next = await call(h.a);
  const noStory = (await post(h.a, `/api/calls/${next.id}/story-control`, { action: 'next', operationId: randomUUID() }).expect(200)).body;
  assert.equal(noStory.story, undefined); assert.doesNotMatch(noStory.reply, /第二只船/);
  await post(h.a, `/api/calls/${next.id}/turn`, { text: '今天想画什么', operationId: randomUUID() }).expect(200);
  assert.equal(JSON.stringify(h.chatBodies.at(-1)).includes(marker), false);
  assert.equal(JSON.stringify(h.chatBodies.at(-1)).includes('浅水盆'), false);
  await h.a.get('/api/parent/memories').expect(403);
});

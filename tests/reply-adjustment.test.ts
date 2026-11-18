import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import request from 'supertest';
import { createApp, type AppOptions } from '../apps/server/src/app.js';
import { buildBaoyanPrompt, BAOYAN_PERSONA_VERSION } from '../apps/server/src/baoyan-persona.js';
import { REPLY_ADJUSTMENT_LIMITS } from '../apps/server/src/reply-adjustment.js';

const origin = 'http://localhost:5173';
const route = '/api/parent/reply-adjustment';
const libraryRoute = '/api/parent/calibration';
const start = Date.parse('2026-10-09T04:00:00Z');
const end = Date.parse('2026-10-12T12:54:00Z');
const live = { CHAT_PROVIDER: 'volc', CHAT_API_BASE_URL: 'https://synthetic.invalid/v3', CHAT_API_KEY: 'synthetic-only', CHAT_MODEL: 'synthetic-seed' };
const trial = { TRIAL_ENABLED: 'true', TRIAL_REQUIRE_INVITE: 'false', TRIAL_ENDS_AT: new Date(end).toISOString() };
const profile = { pin: '123456', nickname: '虚构体验者', ageGroup: '3-5', sessionMinutes: 10, dailyMinutes: 20, consent: true };
const answer = (reply = '哎，拼了半天又倒了，真扫兴。') => Response.json({ choices: [{ finish_reason: 'stop', message: { content: reply } }] });
const input = (extra: Record<string, unknown> = {}) => ({ operationId: randomUUID(), ageGroup: '6-8', question: '积木搭了半天又倒了。', actualReply: '你应该再努力一点。', guideline: '先回应失望，不催我再搭，不要讲大道理。', testHistory: [], testMemories: [], fictionalConfirmed: true, ...extra });
type Agent = ReturnType<typeof request.agent>;
type User = { agent: Agent; childId: string; deviceCookie: string };
function fixture(t: TestContext, extra: AppOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bobo-reply-adjustment-'));
  const dataPath = join(dir, 'fictional.sqlite'); let clock = start;
  const options = { ...extra, env: { ...live, ...trial, ...extra.env }, dataPath, now: () => clock, fetch: extra.fetch ?? (async () => answer()) as typeof fetch };
  let app = createApp(options); let closed = false;
  t.after(() => { if (!closed) app.locals.close(); rmSync(dir, { recursive: true, force: true }); });
  return { get app() { return app; }, setTime(value: number) { clock = value; },
    store<T>(fn: (db: DatabaseSync) => T): T { const db = new DatabaseSync(dataPath); try { return fn(db); } finally { db.close(); } },
    restart() { if (!closed) app.locals.close(); app = createApp(options); closed = false; },
    close() { if (!closed) app.locals.close(); closed = true; },
  };
}
async function enroll(f: ReturnType<typeof fixture>, unlock = true): Promise<User> {
  const agent = request.agent(f.app);
  const result = await agent.post('/api/setup').set('Origin', origin).send(profile).expect(201);
  const deviceCookie = result.headers['set-cookie'].find((value: string) => value.startsWith('baoyan_device=')).split(';')[0];
  const childId = result.body.child.id;
  if (unlock) await agent.post('/api/parent/unlock').set('Origin', origin).send({ pin: profile.pin }).expect(200);
  return { agent, childId, deviceCookie };
}
const generate = (user: User, body = input()) => user.agent.post(`${route}/generate`).set('Origin', origin).set('X-Baoyan-Child', user.childId).send(body);
const confirm = (user: User, runId: string, extra: Record<string, unknown> = {}) => user.agent.post(`${route}/confirm`).set('Origin', origin).set('X-Baoyan-Child', user.childId).send({ operationId: randomUUID(), runId, fictionalConfirmed: true, satisfied: true, ...extra });
const cancel = (user: User, operationId: string) => user.agent.post(`${route}/generate/${operationId}/cancel`).set('Origin', origin).set('X-Baoyan-Child', user.childId).send({});
const usage = (f: ReturnType<typeof fixture>) => f.store(db => Number((db.prepare('SELECT coalesce(sum(calls),0) AS n FROM trial_provider_usage').get() as { n: number }).n));
const count = (f: ReturnType<typeof fixture>, table: string) => f.store(db => Number((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n));
function deferred() { let resolve!: (value: Response) => void; const response = new Promise<Response>(done => { resolve = done; }); let begun!: () => void; const started = new Promise<void>(done => { begun = done; }); return { response, resolve, begun, started }; }

test('parent authorization, exact child scope, origin and configured text service are required before spending', async t => {
  const f = fixture(t, { env: { CHAT_API_KEY: '' } });
  await request(f.app).post(`${route}/generate`).set('Origin', origin).send(input()).expect(401);
  const user = await enroll(f, false); await generate(user).expect(403);
  await user.agent.post('/api/parent/unlock').set('Origin', origin).send({ pin: profile.pin }).expect(200);
  await user.agent.post(`${route}/generate`).set('Origin', origin).send(input()).expect(400);
  await generate({ ...user, childId: randomUUID() }).expect(409);
  await user.agent.post(`${route}/generate`).set('Origin', 'https://invalid.example').set('X-Baoyan-Child', user.childId).send(input()).expect(403);
  assert.equal((await generate(user).expect(503)).body.code, 'NOT_CONFIGURED');
  assert.equal(usage(f), 0); assert.equal(count(f, 'reply_adjustment_operations'), 0);
});

test('one invocation carries natural direction and fictional context, never household data or TTS; successful replay does not spend', async t => {
  const sent: any[] = []; const f = fixture(t, { fetch: (async (_url, init) => { sent.push(JSON.parse(String(init?.body))); return answer(); }) as typeof fetch });
  const user = await enroll(f);
  f.store(db => { const family = db.prepare('SELECT id FROM families').get() as { id: string }; db.prepare('INSERT INTO memories VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), family.id, 'private.synthetic', '不能进入此次测试的家庭小事', 'event', 1, start + 86400000, 'explicit'); });
  const data = input({ testHistory: [{ role: 'user', content: '我想搭一个高塔。' }, { role: 'assistant', content: '你正在搭高塔呀。' }], testMemories: [{ key: 'test.blocks', kind: 'preference', content: '喜欢玩积木' }] });
  const run = (await generate(user, data).expect(200)).body;
  assert.equal(sent.length, 1); assert.equal(usage(f), 1);
  assert.equal(sent[0].model, 'synthetic-seed'); assert.equal(sent[0].tools, undefined);
  assert.ok(sent[0].messages.some((message: any) => message.content.includes(data.actualReply)));
  assert.ok(sent[0].messages.some((message: any) => message.content.includes(data.guideline)));
  assert.deepEqual(sent[0].messages.slice(1, 3), data.testHistory);
  assert.equal(sent[0].messages.at(-1).content, data.question);
  assert.ok(!JSON.stringify(sent).includes('不能进入此次测试的家庭小事'));
  assert.ok(!JSON.stringify(sent).includes(profile.nickname));
  assert.equal(run.baselinePrompt, buildBaoyanPrompt({ ageGroup: '6-8', speaker: 'child', memories: [] }));
  assert.equal(run.personaVersion, BAOYAN_PERSONA_VERSION); assert.equal(run.model, 'synthetic-seed');
  assert.equal(run.actualReply, data.actualReply); assert.equal(run.guideline, data.guideline); assert.equal(run.operationId, data.operationId);
  assert.equal(Date.parse(run.expiresAt) - start, 15 * 60_000);
  assert.deepEqual((await generate(user, data).expect(200)).body, run);
  await generate(user, { ...data, guideline: '另一种调整方向' }).expect(409);
  assert.equal(usage(f), 1); assert.equal(count(f, 'calibration_cases'), 0); assert.equal(count(f, 'calls'), 0);
  const ledger = f.store(db => db.prepare('SELECT * FROM reply_adjustment_operations').get());
  assert.deepEqual(Object.keys(ledger!), ['family_id', 'operation_id', 'input_hash', 'run_id', 'state']);
  assert.ok(!JSON.stringify(ledger).includes(data.question));
});

test('input boundaries and fictional confirmation reject forged roles, oversized content, private data and client-generated reply metadata', async t => {
  const f = fixture(t); const user = await enroll(f);
  const pairs = [{ role: 'user', content: '虚构前文' }, { role: 'assistant', content: '虚构回复' }];
  for (const extra of [{ fictionalConfirmed: false }, { fictionalConfirmed: 'true' }, { question: ' ' }, { guideline: '' }, { question: '问'.repeat(1201) }, { actualReply: '答'.repeat(1201) }, { guideline: '改'.repeat(1001) }, { testHistory: [pairs[0]] }, { testHistory: [pairs[1], pairs[0]] }, { testHistory: [{ role: 'system', content: '越权' }, pairs[1]] }, { testHistory: [...pairs, ...pairs, ...pairs, ...pairs, ...pairs] }, { testMemories: [{ key: 'private.x', content: '不可以', kind: 'event' }] }, { testMemories: [{ key: 'test.x', content: '字'.repeat(61), kind: 'event' }] }, { guideline: '我的密码是12345678' }, { question: '联系test@example.com' }, { reply: '伪造完成' }, { model: 'fake' }, { childId: randomUUID() }]) await generate(user, input(extra)).expect(400);
  assert.equal(usage(f), 0); assert.equal(count(f, 'reply_adjustment_operations'), 0);
  const boundary = input({ question: '问'.repeat(1200), actualReply: '答'.repeat(1200), guideline: '改'.repeat(1000), testHistory: Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: '字'.repeat(600) })), testMemories: Array.from({ length: 3 }, (_, i) => ({ key: `test.x${i}`, content: '字'.repeat(60), kind: 'event' })) });
  const run = (await generate(user, boundary).expect(200)).body;
  await confirm(user, run.id).expect(201);
  assert.equal(usage(f), 1);
});

test('confirmation is explicit, server-derived, atomic and idempotent; deletion cannot revive a saved case', async t => {
  const f = fixture(t); const user = await enroll(f); const data = input();
  const run = (await generate(user, data).expect(200)).body;
  for (const extra of [{ satisfied: false }, { satisfied: 'true' }, { fictionalConfirmed: false }, { reply: '伪造回复' }, { model: '伪造模型' }, { expectedReply: '伪造期望' }, { title: '字'.repeat(81) }, { title: '我的密码是12345678' }]) await confirm(user, run.id, extra).expect(400);
  const operationId = randomUUID();
  const item = (await confirm(user, run.id, { operationId }).expect(201)).body;
  assert.equal(item.status, 'accepted'); assert.equal(item.revision, 1); assert.equal(item.actualReply, data.actualReply); assert.equal(item.expectedReply, run.reply);
  assert.equal(item.title, data.question); assert.equal(item.model, run.model); assert.equal(item.personaVersion, run.personaVersion);
  assert.deepEqual(item.testHistory, run.testHistory); assert.equal(item.reviewHistory.length, 1);
  assert.deepEqual(item.rewrite, { generationId: run.id, guideline: run.guideline, model: run.model, personaVersion: run.personaVersion, elapsedMs: run.elapsedMs, generatedAt: run.createdAt, confirmedAt: new Date(start).toISOString(), actualReplySource: 'user-provided', provenance: 'server-generated' });
  const library = (await user.agent.get(`${libraryRoute}/cases`).expect(200)).body;
  assert.equal(library.workflow.formalModel, run.model); assert.equal(library.workflow.formalPersonaVersion, BAOYAN_PERSONA_VERSION);
  assert.equal(library.workflow.automaticApplication, false); assert.equal(library.workflow.applicationMode, 'reference-only');
  assert.equal(library.workflow.caseReleaseReceipt, 'not-recorded');
  assert.deepEqual((await confirm(user, run.id, { operationId }).expect(200)).body, item);
  await confirm(user, run.id, { operationId, title: '不同标题' }).expect(409);
  await confirm(user, randomUUID(), { operationId }).expect(409);
  await confirm(user, run.id).expect(409);
  assert.equal(usage(f), 1); assert.equal(count(f, 'calibration_cases'), 1);
  await user.agent.delete(`${libraryRoute}/cases/${item.id}`).set('Origin', origin).expect(200);
  await confirm(user, run.id, { operationId }).expect(410);
  assert.equal(count(f, 'calibration_cases'), 0);
});

test('a new fictional scene may omit its old reply, and confirmation records not-provided rather than invented provenance', async t => {
  const sent: any[] = []; const f = fixture(t, { fetch: (async (_url, init) => { sent.push(JSON.parse(String(init?.body))); return answer(); }) as typeof fetch }); const user = await enroll(f);
  const data = input({ actualReply: '' }); const run = (await generate(user, data).expect(200)).body;
  assert.equal(run.actualReply, ''); assert.ok(sent[0].messages.some((message: any) => message.content.includes('没有提供旧回答')));
  const saved = (await confirm(user, run.id).expect(201)).body;
  assert.equal(saved.actualReply, ''); assert.equal(saved.rewrite.actualReplySource, 'not-provided');
  assert.equal(saved.expectedReply, run.reply); assert.equal(usage(f), 1);
});

test('a different family cannot confirm or cancel another family result', async t => {
  const f = fixture(t); const first = await enroll(f); const second = await enroll(f); const data = input();
  const run = (await generate(first, data).expect(200)).body;
  await confirm(second, run.id).expect(410); await cancel(second, data.operationId).expect(200);
  await confirm(first, run.id).expect(201);
  assert.equal((await second.agent.get(`${libraryRoute}/cases`).expect(200)).body.items.length, 0);
  assert.equal(usage(f), 1);
});

test('pending duplicate/conflicting operations spend once, cancellation ignores late provider success and cannot be confirmed', async t => {
  const pending = deferred(); let calls = 0;
  const f = fixture(t, { fetch: (async () => { calls++; pending.begun(); return pending.response; }) as typeof fetch }); const user = await enroll(f); const data = input();
  const first = generate(user, data).then(value => value); await pending.started;
  assert.equal((await generate(user, data).expect(409)).body.code, 'REPLY_ADJUSTMENT_PENDING');
  await generate(user, { ...data, actualReply: '不同原回答' }).expect(409); await generate(user).expect(409);
  const id = f.store(db => (db.prepare('SELECT run_id FROM reply_adjustment_operations').get() as any).run_id);
  await cancel(user, data.operationId).expect(200); pending.resolve(answer('不应进入已取消结果的迟到回复'));
  assert.equal((await first).status, 499); await generate(user, data).expect(410); await confirm(user, id).expect(410);
  assert.equal(calls, 1); assert.equal(usage(f), 1); assert.equal(count(f, 'calibration_cases'), 0);
});

test('cancel-before-generate and late completed cancellation are durable without more model calls', async t => {
  const f = fixture(t); const user = await enroll(f); const early = input();
  await cancel(user, early.operationId).expect(200); await generate(user, early).expect(410); assert.equal(usage(f), 0);
  const data = input(); const run = (await generate(user, data).expect(200)).body;
  await cancel(user, data.operationId).expect(200); await cancel(user, data.operationId).expect(200);
  await generate(user, data).expect(410); await confirm(user, run.id).expect(410); assert.equal(usage(f), 1);
});

test('parent exit cancels pending and completed results and old runs stay unavailable after reauthorization', async t => {
  const pending = deferred(); const f = fixture(t, { fetch: (async () => { pending.begun(); return pending.response; }) as typeof fetch }); const user = await enroll(f); const data = input();
  const first = generate(user, data).then(value => value); await pending.started;
  await user.agent.post('/api/parent/lock').set('Origin', origin).send({}).expect(200);
  assert.equal((await first).status, 403); pending.resolve(answer());
  await user.agent.post('/api/parent/unlock').set('Origin', origin).send({ pin: profile.pin }).expect(200);
  await generate(user, data).expect(410); assert.equal(usage(f), 1);
});

test('switching child cancels pending results immediately and stale header cannot generate or confirm', async t => {
  const pending = deferred(); const f = fixture(t, { fetch: (async () => { pending.begun(); return pending.response; }) as typeof fetch }); const user = await enroll(f); const data = input();
  const next = (await user.agent.post('/api/parent/children').set('Origin', origin).send({ nickname: '第二位虚构体验者', ageGroup: '9-12', sessionMinutes: 10, dailyMinutes: 20 }).expect(201)).body;
  const first = generate(user, data).then(value => value); await pending.started;
  await user.agent.post(`/api/parent/children/${next.id}/select`).set('Origin', origin).send({}).expect(200);
  assert.equal((await first).status, 409); pending.resolve(answer());
  await generate(user).expect(409); await confirm(user, randomUUID()).expect(409);
  assert.equal(usage(f), 1); assert.equal(count(f, 'calibration_cases'), 0);
});

test('withdrawal cancels pending generation and removes metadata ledger and saved scenes', async t => {
  const pending = deferred(); let calls = 0;
  const f = fixture(t, { fetch: (async () => { if (!calls++) return answer(); pending.begun(); return pending.response; }) as typeof fetch }); const user = await enroll(f);
  const run = (await generate(user).expect(200)).body; await confirm(user, run.id).expect(201);
  const first = generate(user).then(value => value); await pending.started;
  await user.agent.post('/api/parent/withdraw').set('Origin', origin).send({}).expect(200);
  assert.ok([401, 403].includes((await first).status)); pending.resolve(answer());
  assert.equal(count(f, 'reply_adjustment_operations'), 0); assert.equal(count(f, 'calibration_cases'), 0);
});

test('restarting cannot repeat a generation but stable confirmed operation still returns its persisted case', async t => {
  const f = fixture(t); const user = await enroll(f); const data = input(); const unsaved = input();
  const run = (await generate(user, data).expect(200)).body; const operationId = randomUUID(); const item = (await confirm(user, run.id, { operationId, title: '积木倒了' }).expect(201)).body;
  const transient = (await generate(user, unsaved).expect(200)).body;
  f.restart(); const restored = { ...user, agent: request.agent(f.app) };
  restored.agent.jar.setCookie(user.deviceCookie);
  await restored.agent.post('/api/parent/unlock').set('Cookie', user.deviceCookie).set('Origin', origin).send({ pin: profile.pin }).expect(200);
  // Set the saved device cookie explicitly because the app address changes in Supertest.
  const restoredConfirm = (extra: Record<string, unknown> = {}) => restored.agent.post(`${route}/confirm`).set('Cookie', user.deviceCookie).set('Origin', origin).set('X-Baoyan-Child', user.childId).send({ operationId, runId: run.id, title: '积木倒了', fictionalConfirmed: true, satisfied: true, ...extra });
  assert.deepEqual((await restoredConfirm().expect(200)).body, item);
  await restoredConfirm({ title: '改了标题' }).expect(409);
  await restored.agent.post(`${route}/generate`).set('Cookie', user.deviceCookie).set('Origin', origin).set('X-Baoyan-Child', user.childId).send(unsaved).expect(410);
  await restoredConfirm({ operationId: randomUUID(), runId: transient.id }).expect(410);
  assert.equal(usage(f), 2); assert.equal(count(f, 'calibration_cases'), 1);
});

test('old library documents still round-trip; new rewrite provenance is preserved as imported-unverified and cannot be forged in normal create', async t => {
  const f = fixture(t); const user = await enroll(f); const other = await enroll(f);
  const legacy = { operationId: randomUUID(), title: '旧案例', ageGroup: '6-8', question: '我画好了。', actualReply: '再努力', expectedReply: '画好啦！', guideline: '接住分享', fictionalConfirmed: true, comparison: { runId: randomUUID(), choice: 'experiment', rated: true, baseline: { reply: '再努力', elapsedMs: 1 }, experiment: { reply: '画好啦', elapsedMs: 2 }, displayOrder: ['baseline', 'experiment'] } };
  const old = (await user.agent.post(`${libraryRoute}/cases`).set('Origin', origin).send(legacy).expect(201)).body;
  const run = (await generate(user).expect(200)).body; const item = (await confirm(user, run.id).expect(201)).body;
  await user.agent.post(`${libraryRoute}/cases`).set('Origin', origin).send({ ...legacy, operationId: randomUUID(), rewrite: item.rewrite }).expect(400);
  const document = (await user.agent.get(`${libraryRoute}/export`).expect(200)).body;
  const imported = (await other.agent.post(`${libraryRoute}/import`).set('Origin', origin).send({ operationId: randomUUID(), fictionalConfirmed: true, document }).expect(201)).body.items;
  const oldImported = imported.find((entry: any) => entry.title === '旧案例'); const newImported = imported.find((entry: any) => entry.rewrite);
  assert.deepEqual(oldImported.comparison, old.comparison); assert.equal(oldImported.rewrite, undefined);
  assert.equal(newImported.status, 'proposed'); assert.equal(newImported.importedFrom.status, 'accepted'); assert.deepEqual(newImported.importedFrom.reviewHistory, item.reviewHistory);
  assert.deepEqual(newImported.rewrite, { ...item.rewrite, provenance: 'imported-unverified' }); assert.equal(usage(f), 1);
});

test('imported rewrite model and persona metadata cannot bypass private-value rejection, and batches stay atomic', async t => {
  const f = fixture(t); const first = await enroll(f); const second = await enroll(f);
  const run = (await generate(first).expect(200)).body; const saved = (await confirm(first, run.id).expect(201)).body;
  const cases = [{ model: '我的密码是12345678' }, { model: 'synthetic@example.com' }, { personaVersion: '联系电话13800138000' }, { personaVersion: 'TOKEN=synthetic-secret-value' }];
  for (const change of cases) {
    const document = { schemaVersion: 'baoyan-calibration-v1', cases: [saved, { ...saved, id: randomUUID(), rewrite: { ...saved.rewrite, ...change } }] };
    const rejected = await second.agent.post(`${libraryRoute}/import`).set('Origin', origin).send({ operationId: randomUUID(), fictionalConfirmed: true, document }).expect(400);
    assert.equal(rejected.body.code, 'CALIBRATION_PRIVATE_DATA');
    assert.equal((await second.agent.get(`${libraryRoute}/cases`).expect(200)).body.items.length, 0);
  }
  assert.equal(count(f, 'calibration_cases'), 1); assert.equal(count(f, 'calibration_operations'), 1); assert.equal(usage(f), 1);
  // Valid metadata with a phone-shaped UUID suffix is not user text.
  const valid = { ...saved, rewrite: { ...saved.rewrite, generationId: '00000000-0000-4000-8000-012345678901' } };
  await second.agent.post(`${libraryRoute}/import`).set('Origin', origin).send({ operationId: randomUUID(), fictionalConfirmed: true, document: { schemaVersion: 'baoyan-calibration-v1', cases: [valid] } }).expect(201);
});

test('TTL, authorization expiry, trial deadline and timeout cancel runs instead of exposing late output', async t => {
  for (const reason of ['ttl', 'auth', 'trial', 'timeout'] as const) {
    const pending = deferred(); const f = fixture(t, { env: { PARENT_AUTH_MINUTES: reason === 'ttl' ? '30' : '10' }, fetch: (async () => { pending.begun(); return reason === 'ttl' || reason === 'auth' ? answer() : pending.response; }) as typeof fetch });
    if (reason === 'trial') f.setTime(end - 1000);
    const user = await enroll(f); const data = input();
    const first = generate(user, data).then(value => value); await pending.started;
    if (reason === 'ttl' || reason === 'auth') {
      const run = (await first).body; f.setTime(start + (reason === 'ttl' ? REPLY_ADJUSTMENT_LIMITS.ttlMs : 10 * 60_000)); f.app.locals.sweepExpiredState();
      const result = await confirm(user, run.id); assert.equal(result.status, reason === 'ttl' ? 410 : 403);
      assert.equal(result.body.code, reason === 'ttl' ? 'REPLY_ADJUSTMENT_EXPIRED' : 'PARENT_REQUIRED');
    } else {
      f.setTime(reason === 'trial' ? end : start + REPLY_ADJUSTMENT_LIMITS.timeoutMs); f.app.locals.sweepExpiredState();
      const result = await first; assert.equal(result.status, reason === 'trial' ? 410 : 504); assert.equal(result.body.code, reason === 'trial' ? 'TRIAL_EXPIRED' : 'REPLY_ADJUSTMENT_TIMEOUT'); pending.resolve(answer());
    }
    assert.equal(usage(f), 1); assert.equal(count(f, 'calibration_cases'), 0);
  }
});

test('exact trial deadline rejects a new request without spend while saved confirmation retries remain readable', async t => {
  const f = fixture(t); f.setTime(end - 1); const user = await enroll(f);
  const run = (await generate(user).expect(200)).body; const operationId = randomUUID(); const saved = (await confirm(user, run.id, { operationId }).expect(201)).body;
  f.setTime(end);
  assert.equal((await generate(user).expect(410)).body.code, 'TRIAL_EXPIRED');
  assert.equal((await confirm(user, run.id, { operationId }).expect(200)).body.id, saved.id); assert.equal(usage(f), 1);
});

test('parent authorization expiry takes precedence over simultaneous generation timeout during sweep and provider completion', async t => {
  for (const stage of ['sweep', 'completion'] as const) {
    const pending = deferred(); const f = fixture(t, { fetch: (async () => { pending.begun(); return pending.response; }) as typeof fetch }); const user = await enroll(f); const data = input();
    const first = generate(user, data).then(value => value); await pending.started;
    f.setTime(start + 11 * 60_000);
    if (stage === 'sweep') f.app.locals.sweepExpiredState();
    else pending.resolve(answer('授权失效后不应返回的迟到回复'));
    const result = await first; assert.equal(result.status, 403); assert.equal(result.body.code, 'PARENT_REQUIRED');
    if (stage === 'sweep') pending.resolve(answer());
    assert.equal(count(f, 'calibration_cases'), 0); assert.equal(usage(f), 1);
    await user.agent.post('/api/parent/unlock').set('Origin', origin).send({ pin: profile.pin }).expect(200);
    await generate(user, data).expect(410);
  }
});

test('family result limit is bounded and cancel releases RAM capacity; operation ledger stays bounded', async t => {
  const f = fixture(t); const user = await enroll(f); const first = input();
  await generate(user, first).expect(200); for (let i = 1; i < 5; i++) await generate(user).expect(200);
  assert.equal((await generate(user).expect(429)).body.code, 'REPLY_ADJUSTMENT_RESULT_LIMIT'); assert.equal(usage(f), 5);
  await cancel(user, first.operationId).expect(200); const next = input(); await generate(user, next).expect(200); await cancel(user, next.operationId).expect(200);
  f.store(db => { const family = (db.prepare('SELECT id FROM families').get() as any).id; const rows = Number((db.prepare('SELECT count(*) AS n FROM reply_adjustment_operations').get() as any).n); const insert = db.prepare('INSERT INTO reply_adjustment_operations VALUES(?,?,?,?,?)'); db.exec('BEGIN'); for (let i = rows; i < REPLY_ADJUSTMENT_LIMITS.operations; i++) insert.run(family, randomUUID(), 'synthetic-hash', randomUUID(), 'cancelled'); db.exec('COMMIT'); });
  assert.equal((await generate(user).expect(429)).body.code, 'REPLY_ADJUSTMENT_OPERATION_LIMIT'); assert.equal(usage(f), 6);
});

test('one family cannot exhaust the shared durable ledger and existing operation retries bypass new-operation capacity', async t => {
  const f = fixture(t); const first = await enroll(f); const second = await enroll(f);
  const data = input(); const run = (await generate(first, data).expect(200)).body; const confirmation = randomUUID(); const saved = (await confirm(first, run.id, { operationId: confirmation }).expect(201)).body;
  f.store(db => { const family = (db.prepare('SELECT family_id FROM reply_adjustment_operations WHERE operation_id=?').get(data.operationId) as any).family_id; const insert = db.prepare('INSERT INTO reply_adjustment_operations VALUES(?,?,?,?,?)'); db.exec('BEGIN'); for (let i = 1; i < REPLY_ADJUSTMENT_LIMITS.operationsPerFamily; i++) insert.run(family, randomUUID(), 'synthetic-hash', randomUUID(), 'cancelled'); db.exec('COMMIT'); });
  assert.equal((await generate(first).expect(429)).body.code, 'REPLY_ADJUSTMENT_OPERATION_LIMIT');
  assert.equal((await cancel(first, randomUUID()).expect(429)).body.code, 'REPLY_ADJUSTMENT_OPERATION_LIMIT');
  assert.deepEqual((await generate(first, data).expect(200)).body, run);
  assert.equal((await confirm(first, run.id, { operationId: confirmation }).expect(200)).body.id, saved.id);
  await cancel(first, data.operationId).expect(200); await cancel(first, data.operationId).expect(200);
  await generate(first, data).expect(410);
  await cancel(second, randomUUID()).expect(200); await generate(second).expect(200);
  assert.equal(usage(f), 2); assert.equal(count(f, 'reply_adjustment_operations'), REPLY_ADJUSTMENT_LIMITS.operationsPerFamily + 2);
});

test('unknown cancellation rate is per family, resets at the exact window and never deletes an earlier no-repeat tombstone', async t => {
  const f = fixture(t); const first = await enroll(f); const second = await enroll(f);
  const savedInput = input(); const savedRun = (await generate(first, savedInput).expect(200)).body; const confirmation = randomUUID(); await confirm(first, savedRun.id, { operationId: confirmation }).expect(201);
  const cancelledIds: string[] = [];
  for (let i = 0; i < REPLY_ADJUSTMENT_LIMITS.newCancelsPerWindow; i++) { const id = randomUUID(); cancelledIds.push(id); await cancel(first, id).expect(200); }
  assert.equal((await cancel(first, randomUUID()).expect(429)).body.code, 'REPLY_ADJUSTMENT_CANCEL_RATE_LIMIT');
  // Existing cancelled, generated and confirmed operation retries do not count.
  await cancel(first, cancelledIds[0]).expect(200); await generate(first, { ...input(), operationId: cancelledIds[0] }).expect(410);
  await generate(first, savedInput).expect(200); await confirm(first, savedRun.id, { operationId: confirmation }).expect(200); await cancel(first, savedInput.operationId).expect(200);
  await cancel(second, randomUUID()).expect(200);
  f.setTime(start + REPLY_ADJUSTMENT_LIMITS.cancelWindowMs - 1); await cancel(first, randomUUID()).expect(429);
  f.setTime(start + REPLY_ADJUSTMENT_LIMITS.cancelWindowMs); f.app.locals.sweepExpiredState(); await cancel(first, randomUUID()).expect(200);
  await generate(first, { ...input(), operationId: cancelledIds[0] }).expect(410);
  assert.equal(usage(f), 1); assert.equal(count(f, 'reply_adjustment_operations'), REPLY_ADJUSTMENT_LIMITS.newCancelsPerWindow + 3);
});

test('provider failure, incomplete or private output is never saved and supplier errors are not exposed', async t => {
  for (const kind of ['error', 'incomplete', 'empty', 'private'] as const) {
    const f = fixture(t, { fetch: (async () => kind === 'error' ? new Response('secret-provider-body', { status: 500 }) : kind === 'incomplete' ? Response.json({ choices: [{ finish_reason: 'length', message: { content: '不完整' } }] }) : answer(kind === 'empty' ? ' ' : '我的密码是12345678')) as typeof fetch });
    const user = await enroll(f); const data = input(); const result = await generate(user, data).expect(502);
    assert.ok(!JSON.stringify(result.body).includes('secret-provider-body')); assert.ok(!JSON.stringify(result.body).includes('12345678'));
    await generate(user, data).expect(410); assert.equal(usage(f), 1); assert.equal(count(f, 'calibration_cases'), 0);
  }
});

test('daily provider limit blocks the next invocation and unchanged retry is not charged again', async t => {
  const f = fixture(t, { env: { TRIAL_DAILY_PROVIDER_CALLS: '1' } }); const user = await enroll(f);
  await generate(user).expect(200); const next = input(); const second = await generate(user, next);
  // The shared transport ledger enforces its configured ceiling before fetch.
  assert.equal(second.status, 429); assert.equal(second.body.code, 'TRIAL_DAILY_LIMIT');
  await generate(user, next).expect(410); assert.equal(usage(f), 1);
});

test('shared concurrent provider limit applies across families before a second transport starts', async t => {
  const pending = deferred(); let calls = 0; const f = fixture(t, { env: { TRIAL_MAX_CONCURRENT_PROVIDER_CALLS: '1' }, fetch: (async () => { calls++; pending.begun(); return pending.response; }) as typeof fetch });
  const first = await enroll(f); const second = await enroll(f);
  const one = generate(first).then(value => value); await pending.started;
  const data = input(); const denied = await generate(second, data).expect(429); assert.equal(denied.body.code, 'TRIAL_BUSY');
  pending.resolve(answer()); assert.equal((await one).status, 200);
  await generate(second, data).expect(410); assert.equal(calls, 1); assert.equal(usage(f), 1);
});

test('storage capacity failure does not partially create an accepted case or confirmation operation', async t => {
  const f = fixture(t); const user = await enroll(f); const run = (await generate(user).expect(200)).body; const operationId = randomUUID();
  f.store(db => { const family = (db.prepare('SELECT id FROM families').get() as any).id; const insert = db.prepare('INSERT INTO calibration_cases VALUES(?,?,?,?,?,?,?)'); db.exec('BEGIN'); for (let i = 0; i < 200; i++) insert.run(randomUUID(), family, '{}', 1, 2, start, start); db.exec('COMMIT'); });
  const result = await confirm(user, run.id, { operationId }).expect(429); assert.equal(result.body.code, 'CALIBRATION_STORAGE_LIMIT');
  assert.equal(count(f, 'calibration_operations'), 0); assert.equal(count(f, 'calibration_cases'), 200);
  f.store(db => db.prepare('DELETE FROM calibration_cases WHERE id=(SELECT id FROM calibration_cases LIMIT 1)').run());
  const saved = (await confirm(user, run.id, { operationId }).expect(201)).body; assert.equal(saved.status, 'accepted'); assert.equal(count(f, 'calibration_cases'), 200); assert.equal(usage(f), 1);
});

test('disconnect cancels generation while an ignored provider abort cannot create a later confirmable result', async t => {
  const pending = deferred(); const f = fixture(t, { fetch: (async () => { pending.begun(); return pending.response; }) as typeof fetch }); const user = await enroll(f);
  const unlock = await user.agent.post('/api/parent/unlock').set('Origin', origin).send({ pin: profile.pin }).expect(200);
  const parentCookie = unlock.headers['set-cookie'].find((value: string) => value.startsWith('baoyan_parent=')).split(';')[0];
  const server = f.app.listen(0); await once(server, 'listening'); const port = (server.address() as any).port; t.after(() => server.close()); const data = input();
  const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: `${route}/generate`, headers: { Origin: origin, Cookie: `${user.deviceCookie}; ${parentCookie}`, 'X-Baoyan-Child': user.childId, 'Content-Type': 'application/json' } });
  req.on('error', () => {}); req.end(JSON.stringify(data)); await pending.started;
  const id = f.store(db => (db.prepare('SELECT run_id FROM reply_adjustment_operations').get() as any).run_id); req.destroy();
  await new Promise(resolve => setTimeout(resolve, 20)); pending.resolve(answer());
  await generate(user, data).expect(410); await confirm(user, id).expect(410); assert.equal(usage(f), 1);
  server.closeAllConnections();
});

test('server close cancels pending work without saving and a restart retains the no-repeat tombstone', async t => {
  const pending = deferred(); const f = fixture(t, { fetch: (async () => { pending.begun(); return pending.response; }) as typeof fetch }); const user = await enroll(f); const data = input();
  const first = generate(user, data).then(value => value); await pending.started; f.close();
  assert.equal((await first).status, 503); pending.resolve(answer());
  f.restart(); const restored = request.agent(f.app); await restored.post('/api/parent/unlock').set('Cookie', user.deviceCookie).set('Origin', origin).send({ pin: profile.pin }).expect(200);
  await restored.post(`${route}/generate`).set('Cookie', user.deviceCookie).set('Origin', origin).set('X-Baoyan-Child', user.childId).send(data).expect(410);
  assert.equal(count(f, 'calibration_cases'), 0); assert.equal(usage(f), 1);
});

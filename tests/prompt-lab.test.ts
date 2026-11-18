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
import { buildBaoyanPrompt } from '../apps/server/src/baoyan-persona.js';
import { PROMPT_LAB_BOUNDARY } from '../apps/server/src/prompt-lab.js';
import { REPLY_OUTPUT_LANGUAGE_TASK } from '../apps/server/src/providers.js';

const origin = 'http://localhost:5173';
const path = '/api/parent/prompt-lab';
const start = Date.parse('2026-09-30T04:00:00Z');
const live = { CHAT_PROVIDER: 'volc', CHAT_API_BASE_URL: 'https://synthetic.invalid/v3', CHAT_API_KEY: 'synthetic-only', CHAT_MODEL: 'synthetic-seed' };
const trial = { TRIAL_ENABLED: 'true', TRIAL_REQUIRE_INVITE: 'false', TRIAL_ENDS_AT: '2026-10-12T12:54:00+00:00' };
const profile = { pin: '123456', nickname: '不应发送的真实昵称', ageGroup: '3-5', sessionMinutes: 10, dailyMinutes: 20, consent: true };
const answer = (reply = '可以先试一个小步骤。') => Response.json({ choices: [{ finish_reason: 'stop', message: { content: reply } }] });
const comparison = (extra = {}) => ({ operationId: randomUUID(), ageGroup: '9-12', question: '今天我画画失败了。', experimentPrompt: '先回应感受，再给一步办法。', ...extra });
type Agent = ReturnType<typeof request.agent>;
const deviceCookies = new WeakMap<Agent, string>();
function fixture(t: TestContext, extra: AppOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'baoyan-prompt-lab-'));
  const dataPath = join(dir, 'test.sqlite');
  let clock = start;
  const env = { ...live, ...trial, ...extra.env };
  const options = { ...extra, env, dataPath, now: () => clock, fetch: extra.fetch ?? (async () => answer()) as typeof fetch };
  let app = createApp(options);
  let closed = false;
  t.after(() => { if (!closed) app.locals.close(); rmSync(dir, { recursive: true, force: true }); });
  return {
    get app() { return app; },
    setTime(time: number) { clock = time; },
    store<T>(action: (db: DatabaseSync) => T): T { const db = new DatabaseSync(dataPath); try { return action(db); } finally { db.close(); } },
    restart() { if (!closed) app.locals.close(); app = createApp(options); closed = false; },
    close() { if (!closed) app.locals.close(); closed = true; },
  };
}
async function enroll(f: ReturnType<typeof fixture>, unlock = true) {
  const agent = request.agent(f.app);
  const setup = await agent.post('/api/setup').set('Origin', origin).send(profile).expect(201);
  deviceCookies.set(agent, setup.headers['set-cookie'][0].split(';')[0]);
  if (unlock) await agent.post('/api/parent/unlock').set('Origin', origin).send({ pin: profile.pin }).expect(200);
  return agent;
}
const compare = (agent: Agent, input = comparison()) => agent.post(`${path}/compare`).set('Origin', origin).send(input);
const save = (agent: Agent, id: string, extra = {}) => agent.post(`${path}/records`).set('Origin', origin).send({ runId: id, choice: 'experiment', note: '虚构场景测试', expectedReply: '先问我是否想听办法。', ...extra });
const usage = (f: ReturnType<typeof fixture>) => f.store(db => Number((db.prepare('SELECT coalesce(sum(calls),0) AS n FROM trial_provider_usage').get() as { n: number }).n));

test('prompt lab requires parent PIN, rejects cross-origin writes and disables unconfigured models without demo answers', async t => {
  let calls = 0;
  const f = fixture(t, { env: { CHAT_API_KEY: '' }, fetch: (async () => { calls++; return answer(); }) as typeof fetch });
  await request(f.app).get(path).expect(401);
  const agent = await enroll(f, false);
  await agent.get(path).expect(403);
  await compare(agent).expect(403);
  await agent.get(`${path}/records`).expect(403);
  await agent.post('/api/parent/unlock').set('Origin', origin).send({ pin: profile.pin }).expect(200);
  const config = (await agent.get(path).expect(200)).body;
  assert.equal(config.configured, false);
  assert.equal(config.ageGroup, '6-8');
  assert.equal(JSON.stringify(config).includes('synthetic-only'), false);
  await agent.post(`${path}/compare`).set('Origin', 'https://untrusted.invalid').send(comparison()).expect(403);
  assert.equal((await compare(agent).expect(503)).body.code, 'NOT_CONFIGURED');
  assert.equal(calls, 0); assert.equal(usage(f), 0);
});

test('both variants share the fixed boundary, same synthetic age and question, and exclude household/global history and tools', async t => {
  const sent: any[] = [];
  const f = fixture(t, { fetch: (async (_url, init) => { sent.push(JSON.parse(String(init?.body))); return answer(); }) as typeof fetch });
  const agent = await enroll(f);
  f.store(db => { const familyId = (db.prepare('SELECT id FROM families').get() as { id: string }).id; db.prepare('INSERT INTO memories VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), familyId, 'private.memory', '不应发送的家庭记忆', 'event', 1, start + 86400000, 'explicit'); });
  const input = comparison();
  const result = (await compare(agent, input).expect(200)).body;
  assert.equal(sent.length, 2); assert.equal(usage(f), 2);
  assert.equal(result.baselinePrompt, buildBaoyanPrompt({ ageGroup: '9-12', speaker: 'child', memories: [] }));
  assert.equal(result.experimentPrompt, input.experimentPrompt);
  assert.equal(result.question, input.question); assert.equal(result.model, 'synthetic-seed');
  for (const body of sent) {
    assert.equal(body.messages.length, 3);
    assert.ok(body.messages[0].content.startsWith(PROMPT_LAB_BOUNDARY));
    assert.match(body.messages[0].content, /虚构测试年龄组：9-12/);
    assert.deepEqual(body.messages.map((message: {role:string}) => message.role), ['system', 'system', 'user']);
    assert.ok(body.messages[1].content.startsWith(REPLY_OUTPUT_LANGUAGE_TASK));
    assert.match(body.messages[1].content, /本轮回复语种：普通话/);
    assert.equal(body.messages[2].content, input.question);
    assert.equal(body.tools, undefined);
    assert.equal(JSON.stringify(body).includes(profile.nickname), false);
    assert.equal(JSON.stringify(body).includes('不应发送的家庭记忆'), false);
  }
  assert.equal(f.store(db => Number((db.prepare('SELECT count(*) AS n FROM calls').get() as any).n)), 0);
  assert.equal(f.store(db => Number((db.prepare('SELECT count(*) AS n FROM memories').get() as any).n)), 1);
  assert.equal(f.store(db => Number((db.prepare('SELECT count(*) AS n FROM prompt_lab_records').get() as any).n)), 0);
});

test('explicit fictional history and test memories are identical on both sides and preserve shared turn guidance without reading household memory', async t => {
  const sent: any[] = [];
  const f = fixture(t, { fetch: (async (_url, init) => { sent.push(JSON.parse(String(init?.body))); return answer('虚构测试回复。'); }) as typeof fetch });
  const agent = await enroll(f);
  f.store(db => { const familyId = (db.prepare('SELECT id FROM families').get() as { id: string }).id; db.prepare('INSERT INTO memories VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), familyId, 'private.memory', '真实家庭记忆不得进入测试', 'event', 1, start + 86400000, 'explicit'); });
  const testHistory = [{ role: 'user', content: '小猫画歪了。' }, { role: 'assistant', content: '哪里画歪了呀？' }, { role: 'user', content: '耳朵，我擦了好多次。' }, { role: 'assistant', content: '你想试哪种画法呢？' }];
  const testMemories = [{ key: 'test.drawing', content: '喜欢画小猫', kind: 'preference' }];
  const input = comparison({ testHistory, testMemories, fictionalConfirmed: true });
  const run = (await compare(agent, input).expect(200)).body;
  assert.equal(sent.length, 2); assert.equal(usage(f), 2);
  assert.deepEqual(run.testHistory, testHistory); assert.deepEqual(run.testMemories, testMemories); assert.equal(run.fictionalConfirmed, true);
  assert.ok([['baseline', 'experiment'], ['experiment', 'baseline']].some(order => JSON.stringify(order) === JSON.stringify(run.displayOrder)));
  for (const body of sent) {
    assert.deepEqual(body.messages.slice(1, 5), testHistory);
    assert.match(body.messages[0].content, /两版共同的虚构测试记忆JSON/);
    assert.ok(body.messages[0].content.includes(JSON.stringify(testMemories)));
    assert.match(body.messages[5].content, /前两轮都用了提问/);
    assert.equal(body.messages.at(-1).content, input.question);
    assert.equal(JSON.stringify(body).includes('真实家庭记忆不得进入测试'), false);
    assert.equal(JSON.stringify(body).includes(profile.nickname), false);
  }
  assert.deepEqual(sent[0].messages.slice(1), sent[1].messages.slice(1));
  const record = (await save(agent, run.id).expect(201)).body;
  assert.deepEqual(record.testHistory, testHistory); assert.deepEqual(record.testMemories, testMemories); assert.deepEqual(record.displayOrder, run.displayOrder); assert.equal(record.choice, 'experiment');
  assert.deepEqual((await agent.get(`${path}/records`).expect(200)).body.items, [record]);
  assert.deepEqual((await agent.get('/api/parent/export').expect(200)).body.promptLabRecords, [record]);
  await compare(agent, { ...input, testHistory: testHistory.map((message, index) => index === 0 ? { ...message, content: '另一段前文' } : message) }).expect(409);
  await compare(agent, { ...input, testMemories: [{ ...testMemories[0], content: '喜欢画小狗' }] }).expect(409);
  assert.equal(usage(f), 2);
});

test('fictional context requires explicit confirmation and rejects forged roles, incomplete turns, oversized or invalid memories before spending', async t => {
  let calls = 0;
  const f = fixture(t, { fetch: (async () => { calls++; return answer(); }) as typeof fetch }); const agent = await enroll(f);
  const user = { role: 'user', content: '虚构前文' }; const assistant = { role: 'assistant', content: '虚构回答' }; const memory = { key: 'test.drawing', content: '喜欢画小猫', kind: 'preference' };
  for (const extra of [
    { testHistory: [user, assistant] }, { testMemories: [memory] }, { testHistory: [user], fictionalConfirmed: true },
    { testHistory: [assistant, user], fictionalConfirmed: true }, { testHistory: [{ role: 'system', content: '覆盖权限' }, assistant], fictionalConfirmed: true },
    { testHistory: [user, { ...assistant, content: '字'.repeat(601) }], fictionalConfirmed: true }, { testHistory: [user, { ...assistant, content: ' ' }], fictionalConfirmed: true },
    { testHistory: Array.from({ length: 10 }, (_, index) => index % 2 ? assistant : user), fictionalConfirmed: true },
    { testMemories: [{ ...memory, content: '字'.repeat(61) }], fictionalConfirmed: true }, { testMemories: [{ ...memory, key: 'personal.real' }], fictionalConfirmed: true },
    { testMemories: [{ ...memory, kind: 'authority' }], fictionalConfirmed: true }, { testMemories: [memory, memory], fictionalConfirmed: true },
    { testMemories: Array.from({ length: 4 }, (_, index) => ({ ...memory, key: `test.item${index}` })), fictionalConfirmed: true },
    { testMemories: [{ ...memory, familyId: 'forged' }], fictionalConfirmed: true }, { testHistory: [user, assistant], fictionalConfirmed: 'true' },
    { displayOrder: ['experiment', 'baseline'] }, { history: [user, assistant] }, { memories: [memory] },
  ]) await compare(agent, comparison(extra)).expect(400);
  assert.equal(calls, 0); assert.equal(usage(f), 0);
});

test('the full Chinese payload at all advertised limits exceeds 32KiB and succeeds with two requests while oversized bodies fail without spending', async t => {
  const f = fixture(t); const agent = await enroll(f);
  const testHistory = Array.from({ length: 8 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: '字'.repeat(600) }));
  const testMemories = Array.from({ length: 3 }, (_, index) => ({ key: `test.item${index}`, kind: 'preference', content: '字'.repeat(60) }));
  const input = comparison({ question: '问'.repeat(1200), experimentPrompt: '提'.repeat(6000), testHistory, testMemories, fictionalConfirmed: true });
  assert.ok(Buffer.byteLength(JSON.stringify(input)) > 32 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(input)) < 64 * 1024);
  const run = (await compare(agent, input).expect(200)).body;
  assert.deepEqual(run.testHistory, testHistory); assert.deepEqual(run.testMemories, testMemories); assert.equal(usage(f), 2);
  await compare(agent, comparison({ ...input, operationId: randomUUID(), question: '问'.repeat(1201) })).expect(400);
  const oversized = await compare(agent, comparison({ ...input, operationId: randomUUID(), question: '问'.repeat(30_000) })).expect(400);
  assert.equal(oversized.body.code, 'INVALID_INPUT'); assert.match(oversized.body.error, /内容过大/);
  assert.equal(usage(f), 2);
});

test('legacy saved snapshots without context or display order remain readable and unchanged after restart', async t => {
  const f = fixture(t); const agent = await enroll(f); const input = comparison();
  const run = (await compare(agent, input).expect(200)).body;
  const record = (await save(agent, run.id).expect(201)).body;
  for (const key of ['testHistory', 'testMemories', 'fictionalConfirmed', 'displayOrder']) delete record[key];
  const serialized = JSON.stringify(record);
  f.store(db => db.prepare('UPDATE prompt_lab_records SET payload=?,size_bytes=? WHERE id=?').run(serialized, Buffer.byteLength(serialized), run.id));
  const cookie = deviceCookies.get(agent)!; f.restart();
  const unlock = await request(f.app).post('/api/parent/unlock').set('Cookie', cookie).set('Origin', origin).send({ pin: profile.pin }).expect(200);
  const cookies = `${cookie}; ${unlock.headers['set-cookie'][0].split(';')[0]}`;
  assert.deepEqual((await request(f.app).get(`${path}/records`).set('Cookie', cookies).expect(200)).body.items, [record]);
  assert.deepEqual((await request(f.app).post(`${path}/compare`).set('Cookie', cookies).set('Origin', origin).send(input).expect(200)).body, record);
  assert.equal(f.store(db => (db.prepare('SELECT payload FROM prompt_lab_records WHERE id=?').get(run.id) as { payload: string }).payload), serialized);
  assert.equal(usage(f), 2);
});

test('Chinese payloads at the advertised limits are accepted and over-limit/forged fields are rejected before spending', async t => {
  const f = fixture(t); const agent = await enroll(f);
  await compare(agent, comparison({ question: '问'.repeat(1200), experimentPrompt: '提'.repeat(6000) })).expect(200);
  assert.equal(usage(f), 2);
  for (const extra of [{ question: '问'.repeat(1201) }, { experimentPrompt: '提'.repeat(6001) }, { ageGroup: 'adult' }, { model: 'override' }, { baselinePrompt: 'forged' }]) await compare(agent, comparison(extra)).expect(400);
  assert.equal(usage(f), 2);
});

test('a failed side is safe and preserves the other side, with two charged attempts and no retry', async t => {
  let calls = 0;
  const f = fixture(t, { fetch: (async () => ++calls === 1 ? answer('成功侧回复。') : new Response('private supplier body with secret', { status: 500 })) as typeof fetch });
  const agent = await enroll(f);
  const run = (await compare(agent).expect(200)).body;
  assert.equal(run.baseline.reply, '成功侧回复。'); assert.ok(run.experiment.error);
  assert.equal(JSON.stringify(run).includes('private supplier'), false);
  assert.equal(usage(f), 2); assert.equal(calls, 2);
  const record = (await save(agent, run.id).expect(201)).body;
  assert.deepEqual(record.baseline, run.baseline); assert.deepEqual(record.experiment, run.experiment);
});

test('remaining daily budget and concurrent provider limit are enforced per side without refund or extra attempts', async t => {
  for (const env of [{ TRIAL_DAILY_PROVIDER_CALLS: '1' }, { TRIAL_MAX_CONCURRENT_PROVIDER_CALLS: '1' }]) {
    const f = fixture(t, { env }); const agent = await enroll(f);
    const run = (await compare(agent).expect(200)).body;
    assert.ok(run.baseline.reply); assert.ok(run.experiment.error); assert.equal(usage(f), 1);
  }
});

test('operation IDs deduplicate pending and completed calls, reject changed payloads, and survive a restart without recharging', async t => {
  let release!: (response: Response) => void;
  let entered!: () => void; const started = new Promise<void>(resolve => entered = resolve);
  let count = 0;
  const f = fixture(t, { fetch: (async () => { count++; if (count === 1) { entered(); return new Promise<Response>(resolve => release = resolve); } return answer(); }) as typeof fetch });
  const agent = await enroll(f); const input = comparison();
  const pending = compare(agent, input).then(r => r);
  await started;
  assert.equal((await compare(agent, input).expect(409)).body.code, 'PROMPT_LAB_PENDING');
  assert.equal((await compare(agent, { ...input, question: '另一题' }).expect(409)).body.code, 'OPERATION_CONFLICT');
  release(answer());
  const first = await pending; assert.equal(first.status, 200);
  assert.deepEqual((await compare(agent, input).expect(200)).body, first.body);
  assert.equal(count, 2); assert.equal(usage(f), 2);
  // Keep the device cookies while replacing the app; the old parent session must be unlocked again.
  const cookie = deviceCookies.get(agent)!;
  f.restart();
  const device = f.store(db => db.prepare('SELECT count(*) AS n FROM devices').get() as { n: number });
  assert.equal(device.n, 1);
  assert.equal(f.store(db => (db.prepare('SELECT state FROM prompt_lab_operations').get() as { state: string }).state), 'completed');
  const unlock = await request(f.app).post('/api/parent/unlock').set('Cookie', cookie).set('Origin', origin).send({ pin: profile.pin }).expect(200);
  const parentCookie = unlock.headers['set-cookie'][0].split(';')[0];
  await request(f.app).post(`${path}/compare`).set('Cookie', `${cookie}; ${parentCookie}`).set('Origin', origin).send(input).expect(410);
  assert.equal(count, 2); assert.equal(usage(f), 2);
});

for (const action of ['cancel', 'lock', 'reunlock', 'expire', 'withdraw', 'close', 'trial-expire'] as const) {
  test(`in-flight ${action} aborts both variants and never emits or saves late results`, async t => {
    let enter!: () => void; const started = new Promise<void>(resolve => enter = resolve);
    let calls = 0; let aborted = 0; const releases: (() => void)[] = [];
    const f = fixture(t, { fetch: (async (_url, init) => {
      calls++; if (calls === 2) enter();
      init?.signal?.addEventListener('abort', () => { aborted++; }, { once: true });
      // Deliberately ignore abort, as an upstream or transport may answer late.
      return new Promise<Response>(resolve => releases.push(() => resolve(answer('不应显示的迟到回答'))));
    }) as typeof fetch });
    const agent = await enroll(f); const input = comparison();
    const pending = compare(agent, input).then(r => r);
    await started;
    if (action === 'cancel') await agent.post(`${path}/compare/${input.operationId}/cancel`).set('Origin', origin).send({}).expect(200);
    if (action === 'lock') await agent.post('/api/parent/lock').set('Origin', origin).send({}).expect(200);
    if (action === 'reunlock') await agent.post('/api/parent/unlock').set('Origin', origin).send({ pin: profile.pin }).expect(200);
    if (action === 'expire') { f.setTime(start + 11 * 60_000); f.app.locals.sweepExpiredState(); }
    if (action === 'trial-expire') { f.setTime(Date.parse(trial.TRIAL_ENDS_AT) + 1); f.app.locals.sweepExpiredState(); }
    if (action === 'withdraw') await agent.post('/api/parent/withdraw').set('Origin', origin).send({}).expect(200);
    if (action === 'close') f.close();
    const stopped = await pending;
    assert.equal(aborted, 2); assert.ok(stopped.status >= 400); assert.equal(stopped.body.baseline, undefined);
    releases.forEach(release => release());
    await new Promise(resolve => setImmediate(resolve));
    if (action !== 'close') {
      assert.equal(usage(f), 2);
      assert.equal(f.store(db => Number((db.prepare('SELECT count(*) AS n FROM prompt_lab_records').get() as any).n)), 0);
    }
  });
}

test('HTTP disconnect aborts both requests and blocks delayed output, with usage retained', async t => {
  let entered!: () => void; const started = new Promise<void>(resolve => entered = resolve);
  let calls = 0; let aborted = 0;
  const f = fixture(t, { fetch: (async (_url, init) => {
    if (++calls === 2) entered();
    return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => { aborted++; reject(new Error('synthetic abort')); }, { once: true }));
  }) as typeof fetch });
  const server = f.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const addr = `http://127.0.0.1:${(server.address() as any).port}`;
  const setup = await request(addr).post('/api/setup').set('Origin', origin).send(profile).expect(201);
  const device = setup.headers['set-cookie'][0].split(';')[0];
  const unlocked = await request(addr).post('/api/parent/unlock').set('Cookie', device).set('Origin', origin).send({ pin: profile.pin }).expect(200);
  const parent = unlocked.headers['set-cookie'][0].split(';')[0];
  const body = JSON.stringify(comparison());
  const req = httpRequest(`${addr}${path}/compare`, { method: 'POST', headers: { Cookie: `${device}; ${parent}`, Origin: origin, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } });
  req.on('error', () => {}); req.end(body);
  await started; req.destroy();
  for (let i = 0; i < 20 && aborted < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(aborted, 2); assert.equal(usage(f), 2);
});

test('saved server results cannot be forged, are family-isolated, idempotent, exported and deleted with household withdrawal', async t => {
  const f = fixture(t); const a = await enroll(f); const b = await enroll(f);
  const input = comparison(); const run = (await compare(a, input).expect(200)).body;
  await save(b, run.id).expect(410);
  await save(a, run.id, { baseline: { reply: '伪造回复' } }).expect(400);
  const record = (await save(a, run.id).expect(201)).body;
  assert.deepEqual(record.baseline, run.baseline);
  assert.equal(Date.parse(record.expiresAt) - Date.parse(record.savedAt), 30 * 86400000);
  assert.deepEqual((await save(a, run.id).expect(200)).body, record);
  await save(a, run.id, { note: '不能覆盖' }).expect(409);
  assert.equal((await a.get(`${path}/records`).expect(200)).body.items.length, 1);
  assert.deepEqual((await b.get(`${path}/records`).expect(200)).body.items, []);
  assert.deepEqual((await a.get('/api/parent/export').expect(200)).body.promptLabRecords, [record]);
  await b.delete(`${path}/records/${run.id}`).set('Origin', origin).expect(404);
  assert.equal((await compare(a, input).expect(200)).body.id, run.id); assert.equal(usage(f), 2);
  await a.post('/api/parent/withdraw').set('Origin', origin).send({}).expect(200);
  assert.equal(f.store(db => Number((db.prepare('SELECT count(*) AS n FROM prompt_lab_records').get() as any).n)), 0);
  assert.equal(f.store(db => Number((db.prepare('SELECT count(*) AS n FROM prompt_lab_operations').get() as any).n)), 0);
});

test('unsaved results expire, saved results are readable after trial expiry, and all records expire after 30 days', async t => {
  const f = fixture(t); const agent = await enroll(f);
  const input = comparison(); const unsaved = (await compare(agent, input).expect(200)).body;
  const saved = (await compare(agent).expect(200)).body; await save(agent, saved.id).expect(201);
  f.setTime(start + 16 * 60_000); f.app.locals.sweepExpiredState();
  await agent.post('/api/parent/unlock').set('Origin', origin).send({ pin: profile.pin }).expect(200);
  await save(agent, unsaved.id).expect(410);
  await compare(agent, input).expect(410); assert.equal(usage(f), 4);
  f.setTime(Date.parse(trial.TRIAL_ENDS_AT) + 1000); f.app.locals.sweepExpiredState();
  await agent.post('/api/parent/unlock').set('Origin', origin).send({ pin: profile.pin }).expect(200);
  await compare(agent).expect(410);
  assert.equal((await agent.get(`${path}/records`).expect(200)).body.items.length, 1);
  f.setTime(start + 31 * 86400000); f.app.locals.sweepExpiredState();
  await agent.post('/api/parent/unlock').set('Origin', origin).send({ pin: profile.pin }).expect(200);
  assert.deepEqual((await agent.get(`${path}/records`).expect(200)).body.items, []);
});

test('temporary and stored capacity is bounded; save releases a temporary slot; delete cannot resurrect a saved result', async t => {
  const f = fixture(t); const agent = await enroll(f); const runs = [];
  for (let i = 0; i < 5; i++) runs.push((await compare(agent).expect(200)).body);
  assert.equal((await compare(agent).expect(429)).body.code, 'PROMPT_LAB_RESULT_LIMIT');
  await save(agent, runs[0].id).expect(201);
  await compare(agent).expect(200); assert.equal(usage(f), 12);
  await agent.delete(`${path}/records/${runs[0].id}`).set('Origin', origin).expect(200);
  await save(agent, runs[0].id).expect(410);
  f.store(db => {
    const familyId = (db.prepare('SELECT id FROM families').get() as { id: string }).id;
    const insert = db.prepare('INSERT INTO prompt_lab_records(id,family_id,payload,size_bytes,saved_at,expires_at) VALUES(?,?,?,?,?,?)');
    for (let i = 0; i < 50; i++) insert.run(randomUUID(), familyId, '{}', 2, start, start + 86400000);
  });
  assert.equal((await save(agent, runs[1].id).expect(429)).body.code, 'PROMPT_LAB_STORAGE_LIMIT');
});

test('saved results and minimal operation ledger have global count and byte bounds', async t => {
  for (const limit of ['count', 'bytes', 'operations'] as const) {
    const f = fixture(t); const agent = await enroll(f); const other = await enroll(f);
    const run = (await compare(agent).expect(200)).body;
    const otherFamily = f.store(db => {
      const families = db.prepare('SELECT id FROM families').all() as { id: string }[];
      const owner = (db.prepare('SELECT family_id FROM prompt_lab_operations').get() as { family_id: string }).family_id;
      return families.find(row => row.id !== owner)!.id;
    });
    f.store(db => {
      db.exec('BEGIN IMMEDIATE');
      if (limit === 'operations') {
        const insert = db.prepare("INSERT INTO prompt_lab_operations VALUES(?,?,?,?,'cancelled',?)");
        for (let i = 0; i < 9999; i++) insert.run(otherFamily, randomUUID(), 'synthetic-hash', randomUUID(), start + 86400000);
      } else {
        const insert = db.prepare('INSERT INTO prompt_lab_records VALUES(?,?,?,?,?,?)');
        for (let i = 0; i < (limit === 'count' ? 1000 : 1); i++) insert.run(randomUUID(), otherFamily, '{}', limit === 'bytes' ? 32 * 1024 * 1024 : 2, start, start + 86400000);
      }
      db.exec('COMMIT');
    });
    if (limit === 'operations') {
      assert.equal((await compare(agent).expect(429)).body.code, 'PROMPT_LAB_OPERATION_LIMIT');
      assert.equal(usage(f), 2);
    } else {
      assert.equal((await save(agent, run.id).expect(429)).body.code, 'PROMPT_LAB_STORAGE_LIMIT');
      assert.deepEqual((await agent.get(`${path}/records`).expect(200)).body.items, []);
    }
    assert.ok(other);
  }
});

test('restart preserves saved records and existing household values', async t => {
  const f = fixture(t); const agent = await enroll(f);
  const run = (await compare(agent).expect(200)).body;
  const record = (await save(agent, run.id).expect(201)).body;
  const before = f.store(db => db.prepare('SELECT * FROM families').all());
  const deviceCookie = deviceCookies.get(agent)!;
  f.restart();
  assert.deepEqual(f.store(db => db.prepare('SELECT * FROM families').all()), before);
  const unlocked = await request(f.app).post('/api/parent/unlock').set('Cookie', deviceCookie).set('Origin', origin).send({ pin: profile.pin }).expect(200);
  const cookies = `${deviceCookie}; ${unlocked.headers['set-cookie'][0].split(';')[0]}`;
  assert.deepEqual((await request(f.app).get(`${path}/records`).set('Cookie', cookies).expect(200)).body.items, [record]);
  assert.equal(f.store(db => (db.prepare('PRAGMA quick_check').get() as any).quick_check), 'ok');
});

test('opening a pre-lab database adds tables without changing household data', async t => {
  const f = fixture(t); const agent = await enroll(f);
  const before = f.store(db => db.prepare('SELECT * FROM families').all());
  const cookie = deviceCookies.get(agent)!;
  f.close();
  f.store(db => db.exec('DROP TABLE prompt_lab_records; DROP TABLE prompt_lab_operations;'));
  f.restart();
  assert.deepEqual(f.store(db => db.prepare('SELECT * FROM families').all()), before);
  const unlocked = await request(f.app).post('/api/parent/unlock').set('Cookie', cookie).set('Origin', origin).send({ pin: profile.pin }).expect(200);
  const cookies = `${cookie}; ${unlocked.headers['set-cookie'][0].split(';')[0]}`;
  assert.equal((await request(f.app).get(path).set('Cookie', cookies).expect(200)).body.configured, true);
  assert.deepEqual((await request(f.app).get(`${path}/records`).set('Cookie', cookies).expect(200)).body.items, []);
  assert.equal(f.store(db => (db.prepare('PRAGMA quick_check').get() as any).quick_check), 'ok');
});

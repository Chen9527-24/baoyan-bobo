import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import request from 'supertest';
import { createCalibrationLibrary, CALIBRATION_LIMITS } from '../apps/server/src/calibration-library.js';
import { ApiError } from '../apps/server/src/provider-errors.js';
import { BAOYAN_PERSONA_VERSION } from '../apps/server/src/baoyan-persona.js';

const path = '/api/parent/calibration';
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'bobo-fictional-calibration-'));
  const file = join(dir, 'synthetic.sqlite');
  let current = Date.parse('2026-10-03T04:00:00Z');
  let authorized = true;
  let db: DatabaseSync;
  let library: ReturnType<typeof createCalibrationLibrary>;
  let app: express.Express;
  function restart() {
    library?.close(); db?.close();
    db = new DatabaseSync(file); db.exec('PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS families(id TEXT PRIMARY KEY,synthetic_note TEXT NOT NULL);');
    db.prepare('INSERT OR IGNORE INTO families VALUES(?,?)').run('family-a', '虚构家庭A');
    db.prepare('INSERT OR IGNORE INTO families VALUES(?,?)').run('family-b', '虚构家庭B');
    library = createCalibrationLibrary({ db, now: () => current, formalModel: 'fixture-current-model', scope: 'family', authorize: req => {
      const familyId = req.header('x-test-family');
      if (!familyId || !authorized) throw new ApiError(401, '请重新进入家长管理', 'PARENT_REQUIRED');
      if (!['family-a', 'family-b'].includes(familyId)) throw new ApiError(401, '请重新进入家长管理', 'PARENT_REQUIRED');
      return { familyId, deviceHash: `synthetic-${familyId}` };
    } });
    app = express(); app.use(express.json({ limit: '2mb' })); app.use(path, library.router);
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (error instanceof ApiError) res.status(error.status).json({ error: error.message, code: error.code });
      else if (typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.too.large') res.status(400).json({ error: '请求内容过大', code: 'INVALID_INPUT' });
      else res.status(500).json({ error: String(error) });
    });
  }
  restart();
  t.after(() => { library.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { get app() { return app; }, get db() { return db; }, get library() { return library; }, restart, expire: () => { current += 45 * 86_400_000; }, revoke: () => { authorized = false; } };
}
const input = (extra: Record<string, unknown> = {}) => ({ operationId: randomUUID(), title: '纸盒礼物', ageGroup: '6-8', question: '我折了一个纸盒子送给你。', actualReply: '好漂亮的红盒子。', expectedReply: '谢谢你呀，心意收到啦。', guideline: '没有图片不能编颜色。', fictionalConfirmed: true, ...extra });
const create = (f: ReturnType<typeof fixture>, body = input(), family = 'family-a') => request(f.app).post(`${path}/cases`).set('x-test-family', family).send(body);

test('all library routes require active parent authorization, including templates and exports', async t => {
  const f = fixture(t);
  for (const [method, route] of [['get', '/samples'], ['get', '/cases'], ['get', '/export'], ['post', '/cases'], ['post', '/import'], ['patch', `/cases/${randomUUID()}`], ['delete', `/cases/${randomUUID()}`]] as const) {
    await request(f.app)[method](`${path}${route}`).send({}).expect(401);
  }
  const item = (await create(f).expect(201)).body; f.revoke();
  await request(f.app).get(`${path}/cases`).set('x-test-family', 'family-a').expect(401);
  await request(f.app).patch(`${path}/cases/${item.id}`).set('x-test-family', 'family-a').send({ revision: 1, status: 'accepted' }).expect(401);
  assert.equal(f.library.exportFamily('family-a')[0].revision, 1);
});

test('original child samples cover ages and natural paragraphs, with explicit examples rather than mandatory answers', async t => {
  const f = fixture(t); const result = (await request(f.app).get(`${path}/samples`).set('x-test-family', 'family-a').expect(200)).body;
  assert.equal(result.version, 'bobo-child-v1'); assert.ok(result.items.length >= 12 && result.items.length <= 16);
  assert.deepEqual(new Set(result.items.map((item: any) => item.ageGroup)), new Set(['3-5', '6-8', '9-12']));
  assert.equal(new Set(result.items.map((item: any) => item.id)).size, result.items.length);
  assert.ok(result.items.filter((item: any) => item.expectedReply.includes('\n\n')).length >= 3);
  assert.ok(result.items.some((item: any) => item.category === '自然分段'));
  assert.ok(result.items.some((item: any) => item.category === '多日记忆' && item.testMemories.length));
  assert.deepEqual(result.limits, CALIBRATION_LIMITS);
});

test('submit, review, revision conflicts and household isolation never modify formal persona', async t => {
  const f = fixture(t); const personaFile = new URL('../apps/server/src/baoyan-persona.ts', import.meta.url);
  const before = readFileSync(personaFile, 'utf8');
  const body = input({ model: 'fictional-original-model', personaVersion: 'fictional-v1', baselinePrompt: '不得索取密码、验证码、详细住址。', experimentPrompt: '简短地接住孩子。' });
  const item = (await create(f, body).expect(201)).body;
  assert.equal(item.status, 'proposed'); assert.equal(item.revision, 1); assert.equal(item.operationId, undefined); assert.equal(item.familyId, undefined);
  assert.deepEqual((await request(f.app).get(`${path}/cases`).set('x-test-family', 'family-b').expect(200)).body.items, []);
  await request(f.app).patch(`${path}/cases/${item.id}`).set('x-test-family', 'family-b').send({ revision: 1, status: 'accepted' }).expect(404);
  const accepted = (await request(f.app).patch(`${path}/cases/${item.id}`).set('x-test-family', 'family-a').send({ revision: 1, status: 'accepted', reviewNote: '认可这份接法作为后续测试参考。' }).expect(200)).body;
  assert.equal(accepted.revision, 2); assert.equal(accepted.status, 'accepted');
  assert.deepEqual(accepted.reviewHistory, [{ date: accepted.updatedAt, previousStatus: 'proposed', status: 'accepted', note: accepted.reviewNote }]);
  await request(f.app).patch(`${path}/cases/${item.id}`).set('x-test-family', 'family-a').send({ revision: 1, status: 'rejected' }).expect(409);
  const rejected = (await request(f.app).patch(`${path}/cases/${item.id}`).set('x-test-family', 'family-a').send({ revision: 2, status: 'rejected', reviewNote: '换一种接法。' }).expect(200)).body;
  assert.equal(rejected.revision, 3); assert.equal(rejected.reviewHistory.length, 2); assert.equal(rejected.reviewHistory[1].previousStatus, 'accepted');
  assert.equal(readFileSync(personaFile, 'utf8'), before);
});

test('running formal version is read-only metadata and accepting or importing a reference never claims publication', async t => {
  const f = fixture(t);
  const get = async () => (await request(f.app).get(`${path}/cases`).set('x-test-family', 'family-a').expect(200)).body;
  const expected = { scope: 'family', automaticApplication: false, formalPersonaVersion: BAOYAN_PERSONA_VERSION,
    formalModel: 'fixture-current-model', applicationMode: 'reference-only', caseReleaseReceipt: 'not-recorded' };
  const before = await get(); assert.deepEqual(before.workflow, expected); assert.deepEqual(before.items, []);
  assert.equal(before.workflow.currentApplication, undefined, 'a missing release ledger cannot assert historical non-adoption');
  const item = (await create(f, input({ personaVersion: 'old-imported-version', model: 'old-model' })).expect(201)).body;
  await request(f.app).patch(`${path}/cases/${item.id}`).set('x-test-family', 'family-a').send({ revision: 1, status: 'accepted' }).expect(200);
  const accepted = await get(); assert.equal(accepted.items[0].status, 'accepted'); assert.deepEqual(accepted.workflow, expected);
  const exported = (await request(f.app).get(`${path}/export`).set('x-test-family', 'family-a').expect(200)).body;
  assert.equal(exported.workflow, undefined); assert.equal(exported.cases[0].currentApplication, undefined);
  await create(f, input({ workflow: { currentApplication: 'applied' } })).expect(400);
  await request(f.app).patch(`${path}/cases/${item.id}`).set('x-test-family', 'family-a').send({ revision: 2, status: 'accepted', currentApplication: 'applied' }).expect(400);
  await request(f.app).post(`${path}/import`).set('x-test-family', 'family-a').send({ operationId: randomUUID(), fictionalConfirmed: true, document: { ...exported, workflow: { currentApplication: 'applied' } } }).expect(400);
  const imported = (await request(f.app).post(`${path}/import`).set('x-test-family', 'family-a').send({ operationId: randomUUID(), fictionalConfirmed: true, document: exported }).expect(201)).body;
  assert.equal(imported.items[0].status, 'proposed'); assert.deepEqual((await get()).workflow, expected);
});

test('acceptance requires a concrete expected reply or guideline while rejection still works', async t => {
  const f = fixture(t); const item = (await create(f, input({ expectedReply: '', guideline: '' })).expect(201)).body;
  await request(f.app).patch(`${path}/cases/${item.id}`).set('x-test-family', 'family-a').send({ revision: 1, status: 'accepted' }).expect(400);
  await request(f.app).patch(`${path}/cases/${item.id}`).set('x-test-family', 'family-a').send({ revision: 1, status: 'rejected' }).expect(200);
});

test('persistent operation IDs deduplicate, reject changes, isolate households and do not resurrect deletion', async t => {
  const f = fixture(t); const body = input();
  const item = (await create(f, body).expect(201)).body;
  assert.deepEqual((await create(f, body).expect(200)).body, item);
  await create(f, { ...body, actualReply: '改了现场内容' }).expect(409);
  const other = (await create(f, body, 'family-b').expect(201)).body; assert.notEqual(other.id, item.id);
  f.restart(); assert.deepEqual((await create(f, body).expect(200)).body, item);
  await request(f.app).delete(`${path}/cases/${item.id}`).set('x-test-family', 'family-b').expect(404);
  await request(f.app).delete(`${path}/cases/${item.id}`).set('x-test-family', 'family-a').expect(200);
  await create(f, body).expect(410);
  assert.deepEqual(f.library.exportFamily('family-a'), []); assert.equal(f.library.exportFamily('family-b').length, 1);
  assert.equal((f.db.prepare('SELECT input_hash FROM calibration_operations WHERE family_id=?').get('family-a') as any).input_hash.includes(body.question), false);
});

test('strict input bounds, fictional consent, history and test-memory schemas reject before writing', async t => {
  const f = fixture(t);
  const user = { role: 'user', content: '今天只听我说。' }; const assistant = { role: 'assistant', content: '好，我听着。' };
  for (const extra of [
    { fictionalConfirmed: false }, { fictionalConfirmed: 'true' }, { ageGroup: 'adult' }, { title: '' }, { title: '字'.repeat(81) }, { question: '字'.repeat(1201) }, { actualReply: '字'.repeat(1201) }, { guideline: '字'.repeat(1001) }, { experimentPrompt: '字'.repeat(6001) },
    { familyId: 'family-b' }, { status: 'accepted' }, { revision: 3 }, { testHistory: [user] }, { testHistory: [assistant, user] }, { testHistory: Array(10).fill(user) }, { testHistory: [{ ...user, content: '字'.repeat(601) }, assistant] },
    { testMemories: [{ key: 'personal.real', kind: 'event', content: '一个虚构事件' }] }, { testMemories: [{ key: 'test.a', kind: 'event', content: '字'.repeat(61) }] }, { testMemories: [{ key: 'test.a', kind: 'event', content: 'a' }, { key: 'test.a', kind: 'event', content: 'b' }] },
    { note: '不允许\u0000控制字' },
  ]) await create(f, input(extra)).expect(400);
  assert.deepEqual(f.library.exportFamily('family-a'), []);
  const full = input({ title: '字'.repeat(80), category: '字'.repeat(40), question: '字'.repeat(1200), actualReply: '字'.repeat(1200), expectedReply: '字'.repeat(1200), guideline: '字'.repeat(1000), note: '字'.repeat(1000), baselinePrompt: '字'.repeat(6000), experimentPrompt: '字'.repeat(6000), testHistory: Array.from({ length: 8 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: '字'.repeat(600) })), testMemories: Array.from({ length: 3 }, (_, index) => ({ key: `test.item${index}`, kind: 'preference', content: '字'.repeat(60) })) });
  assert.ok(Buffer.byteLength(JSON.stringify(full)) < CALIBRATION_LIMITS.bodyBytes);
  await create(f, full).expect(201);
});

test('concrete private values are rejected in all user text while boundary explanations remain allowed', async t => {
  const f = fixture(t);
  for (const value of ['我的电话是13812345678。', '座机是0755-12345678。', '我身份证号码是110101200001011234。', '邮箱是child@example.test。', '我的密码是12345678', '我的密码abc12345', '家长PIN为123456', '住址是某街18号2栋301室', 'API_KEY=not-real-secret-value', '-----BEGIN PRIVATE KEY-----']) {
    const result = await create(f, input({ note: value })).expect(400); assert.equal(result.body.code, 'CALIBRATION_PRIVATE_DATA');
  }
  await create(f, input({ baselinePrompt: '不得索取密码、验证码、PIN、电话号码和详细住址。', note: '场景不含现实密码或电话。' })).expect(201);
  await create(f, input({ testHistory: [{ role: 'user', content: '我的密码是abc12345' }, { role: 'assistant', content: '不要发送密码。' }] })).expect(400);
  const item = f.library.exportFamily('family-a')[0];
  await request(f.app).patch(`${path}/cases/${item.id}`).set('x-test-family', 'family-a').send({ revision: 1, status: 'accepted', reviewNote: '联系电话13812345678' }).expect(400);
});

test('export and import preserve reusable contexts and model provenance, reset adoption, and are idempotent', async t => {
  const f = fixture(t);
  const original = (await create(f, input({ model: 'fictional-a', personaVersion: '0.test', testHistory: [{ role: 'user', content: '只听我说。' }, { role: 'assistant', content: '好。' }], testMemories: [{ key: 'test.plan', kind: 'plan', content: '计划去公园，尚未成行' }] })).expect(201)).body;
  await request(f.app).patch(`${path}/cases/${original.id}`).set('x-test-family', 'family-a').send({ revision: 1, status: 'accepted', reviewNote: '一次内部参考' }).expect(200);
  const document = (await request(f.app).get(`${path}/export`).set('x-test-family', 'family-a').expect(200)).body;
  assert.equal(document.schemaVersion, 'baoyan-calibration-v1'); assert.equal(document.scope, 'family-fictional-calibration'); assert.equal(document.samplesVersion, 'bobo-child-v1'); assert.equal(document.familyId, undefined);
  const body = { operationId: randomUUID(), fictionalConfirmed: true, document };
  const imported = (await request(f.app).post(`${path}/import`).set('x-test-family', 'family-b').send(body).expect(201)).body;
  assert.equal(imported.imported, 1); assert.equal(imported.resetToProposed, true);
  const item = imported.items[0]; assert.notEqual(item.id, original.id); assert.equal(item.status, 'proposed'); assert.equal(item.revision, 1); assert.deepEqual(item.reviewHistory, []);
  assert.equal(item.importedFrom.status, 'accepted'); assert.equal(item.importedFrom.id, original.id); assert.equal(item.importedFrom.reviewHistory.length, 1);
  for (const key of ['question', 'actualReply', 'expectedReply', 'guideline', 'testHistory', 'testMemories', 'model', 'personaVersion', 'baselinePrompt', 'experimentPrompt']) assert.deepEqual(item[key], original[key]);
  assert.deepEqual((await request(f.app).post(`${path}/import`).set('x-test-family', 'family-b').send(body).expect(200)).body, imported);
  await request(f.app).post(`${path}/import`).set('x-test-family', 'family-b').send({ ...body, document: { ...document, cases: [{ ...document.cases[0], note: '变化' }] } }).expect(409);
});

test('invalid or private import batches commit no partial entries', async t => {
  const f = fixture(t); const row = (await create(f).expect(201)).body;
  const document = { schemaVersion: 'baoyan-calibration-v1', cases: [row, { ...row, id: randomUUID(), testMemories: [{ key: 'personal.forged', kind: 'event', content: '事件' }] }] };
  await request(f.app).post(`${path}/import`).set('x-test-family', 'family-b').send({ operationId: randomUUID(), fictionalConfirmed: true, document }).expect(400);
  document.cases[1] = { ...row, id: randomUUID(), note: '我的密码是abc12345' };
  await request(f.app).post(`${path}/import`).set('x-test-family', 'family-b').send({ operationId: randomUUID(), fictionalConfirmed: true, document }).expect(400);
  assert.deepEqual(f.library.exportFamily('family-b'), []);
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM calibration_operations WHERE family_id=?').get('family-b') as any).n, 0);
  await request(f.app).post(`${path}/import`).set('x-test-family', 'family-b').send({ operationId: randomUUID(), fictionalConfirmed: true, document: { schemaVersion: 'unknown', cases: [row] } }).expect(400);
  await request(f.app).post(`${path}/import`).set('x-test-family', 'family-b').send({ operationId: randomUUID(), fictionalConfirmed: true, document: { schemaVersion: 'baoyan-calibration-v1', cases: Array(201).fill(row) } }).expect(400);
});

test('a complete ordinary 200-case export imports intact, while over-2MiB bodies do not write', async t => {
  const f = fixture(t); const first = (await create(f).expect(201)).body;
  const insert = f.db.prepare('INSERT INTO calibration_cases VALUES(?,?,?,?,?,?,?)');
  f.db.exec('BEGIN IMMEDIATE');
  for (let index = 0; index < 199; index++) {
    const item = { ...first, id: randomUUID(), title: `虚构样本${index}` }; const payload = JSON.stringify(item);
    insert.run(item.id, 'family-a', payload, 1, Buffer.byteLength(payload), 0, 0);
  }
  f.db.exec('COMMIT');
  const document = (await request(f.app).get(`${path}/export`).set('x-test-family', 'family-a').expect(200)).body;
  assert.equal(document.cases.length, 200); assert.ok(Buffer.byteLength(JSON.stringify(document)) < CALIBRATION_LIMITS.importBytes);
  const response = await request(f.app).post(`${path}/import`).set('x-test-family', 'family-b').send({ operationId: randomUUID(), fictionalConfirmed: true, document });
  assert.equal(response.status, 201, JSON.stringify(response.body)); const imported = response.body;
  assert.equal(imported.imported, 200); assert.equal(new Set(imported.items.map((item: any) => item.id)).size, 200);
  assert.equal(imported.items.every((item: any) => item.status === 'proposed'), true);
  const tooLarge = { operationId: randomUUID(), fictionalConfirmed: true, document: { ...document, cases: document.cases.slice(0, 60).map((item: any) => ({ ...item, baselinePrompt: '字'.repeat(6000), experimentPrompt: '字'.repeat(6000) })) } };
  assert.ok(Buffer.byteLength(JSON.stringify(tooLarge)) > CALIBRATION_LIMITS.importBytes);
  await request(f.app).post(`${path}/import`).set('x-test-family', 'family-b').send(tooLarge).expect(400);
  assert.equal(f.library.exportFamily('family-b').length, 200);
});

test('repeated migration retains original adoption reasons in a bounded flat history without silently truncating', async t => {
  const f = fixture(t); const original = (await create(f).expect(201)).body;
  await request(f.app).patch(`${path}/cases/${original.id}`).set('x-test-family', 'family-a').send({ revision: 1, status: 'accepted', reviewNote: '第一轮采纳的实际理由' }).expect(200);
  let row = f.library.exportFamily('family-a')[0];
  for (let index = 0; index < 11; index++) {
    const imported = (await request(f.app).post(`${path}/import`).set('x-test-family', index % 2 ? 'family-a' : 'family-b').send({ operationId: randomUUID(), fictionalConfirmed: true, document: { schemaVersion: 'baoyan-calibration-v1', cases: [row] } }).expect(201)).body;
    row = imported.items[0];
    assert.equal(row.importHistory.length, index);
    assert.equal(JSON.stringify(row).includes('第一轮采纳的实际理由'), true);
    for (const source of row.importHistory) assert.equal(source.importedFrom, undefined);
  }
  const count = f.library.exportFamily('family-a').length;
  const rejected = await request(f.app).post(`${path}/import`).set('x-test-family', 'family-a').send({ operationId: randomUUID(), fictionalConfirmed: true, document: { schemaVersion: 'baoyan-calibration-v1', cases: [row] } }).expect(400);
  assert.equal(rejected.body.code, 'CALIBRATION_PROVENANCE_LIMIT'); assert.equal(f.library.exportFamily('family-a').length, count);
});

test('full declared A/B comparison snapshot remains reusable after review, export and import', async t => {
  const f = fixture(t);
  const comparison = { runId: '00000000-0000-4000-8000-012345678901', choice: 'baseline', rated: true, baseline: { reply: '一整圈没停，难怪这么开心。', elapsedMs: 1250 }, experiment: { error: '这一路暂时无法生成', elapsedMs: 27000 }, displayOrder: ['experiment', 'baseline'] };
  const first = (await create(f, input({ comparison })).expect(201)).body; assert.deepEqual(first.comparison, comparison);
  await request(f.app).patch(`${path}/cases/${first.id}`).set('x-test-family', 'family-a').send({ revision: 1, status: 'accepted', reviewNote: '作为虚构测试参考。' }).expect(200);
  const document = (await request(f.app).get(`${path}/export`).set('x-test-family', 'family-a').expect(200)).body;
  const second = (await request(f.app).post(`${path}/import`).set('x-test-family', 'family-b').send({ operationId: randomUUID(), fictionalConfirmed: true, document }).expect(201)).body.items[0];
  assert.deepEqual(second.comparison, comparison); assert.equal(second.status, 'proposed');
  await create(f, input({ comparison: { ...comparison, rated: false, choice: 'neither' } })).expect(201);
  for (const extra of [{ runId: 'not-uuid' }, { baseline: { reply: '字'.repeat(1201), elapsedMs: 0 } }, { baseline: { error: '字'.repeat(201), elapsedMs: 0 } }, { baseline: { reply: '正常', elapsedMs: -1 } }, { displayOrder: ['baseline', 'baseline'] }, { choice: 'forged' }, { familyId: 'family-b' }]) await create(f, input({ comparison: { ...comparison, ...extra } })).expect(400);
  await create(f, input({ comparison: { ...comparison, experiment: { reply: '我的密码是12345678', elapsedMs: 1 } } })).expect(400);
});

test('review logs are bounded, and deleting or recreating a case cannot silently erase its accepted history', async t => {
  const f = fixture(t); let item = (await create(f).expect(201)).body;
  for (let index = 0; index < 50; index++) item = (await request(f.app).patch(`${path}/cases/${item.id}`).set('x-test-family', 'family-a').send({ revision: item.revision, status: index % 2 ? 'proposed' : 'accepted', reviewNote: `第${index + 1}次参考审核` }).expect(200)).body;
  assert.equal(item.reviewHistory.length, 50); assert.equal(item.revision, 51);
  await request(f.app).patch(`${path}/cases/${item.id}`).set('x-test-family', 'family-a').send({ revision: item.revision, status: 'accepted' }).expect(429);
  assert.deepEqual(f.library.exportFamily('family-a')[0], item);
});

test('family and global case/byte limits are atomic and explicit deletion releases space', async t => {
  for (const limit of ['family', 'global', 'bytes'] as const) {
    const f = fixture(t); const own = (await create(f).expect(201)).body;
    const family = limit === 'family' ? 'family-a' : 'family-b';
    const count = limit === 'family' ? 199 : limit === 'global' ? 4999 : 1;
    f.db.exec('BEGIN IMMEDIATE');
    const insert = f.db.prepare('INSERT INTO calibration_cases VALUES(?,?,?,?,?,?,?)');
    for (let index = 0; index < count; index++) insert.run(randomUUID(), family, '{}', 1, limit === 'bytes' ? 100 * 1024 * 1024 : 2, 0, 0);
    f.db.exec('COMMIT');
    assert.equal((await create(f).expect(429)).body.code, 'CALIBRATION_STORAGE_LIMIT');
    if (limit === 'family') {
      await request(f.app).delete(`${path}/cases/${own.id}`).set('x-test-family', 'family-a').expect(200);
      await create(f).expect(201);
    }
  }
});

test('batch import cannot partially cross family capacity and operation ledger is bounded', async t => {
  const f = fixture(t); const item = (await create(f).expect(201)).body;
  const insert = f.db.prepare('INSERT INTO calibration_cases VALUES(?,?,?,?,?,?,?)');
  for (let index = 0; index < 199; index++) insert.run(randomUUID(), 'family-b', '{}', 1, 2, 0, 0);
  const doc = { schemaVersion: 'baoyan-calibration-v1', cases: [item, { ...item, id: randomUUID() }] };
  await request(f.app).post(`${path}/import`).set('x-test-family', 'family-b').send({ operationId: randomUUID(), fictionalConfirmed: true, document: doc }).expect(429);
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM calibration_cases WHERE family_id=?').get('family-b') as any).n, 199);
  const ops = f.db.prepare('INSERT INTO calibration_operations VALUES(?,?,?,?,?)');
  for (let index = 0; index < 1999; index++) ops.run('family-a', randomUUID(), 'synthetic-hash', '[]', 0);
  assert.equal((await create(f).expect(429)).body.code, 'CALIBRATION_OPERATION_LIMIT');
});

test('long-lived cases persist beyond 30 days and restart; withdrawal and family FK cascade remove records and operations', async t => {
  const f = fixture(t); const item = (await create(f).expect(201)).body;
  const families = f.db.prepare('SELECT * FROM families ORDER BY id').all();
  f.expire(); f.restart();
  assert.deepEqual(f.library.exportFamily('family-a'), [item]); assert.deepEqual(f.db.prepare('SELECT * FROM families ORDER BY id').all(), families);
  f.library.withdraw('family-a'); assert.deepEqual(f.library.exportFamily('family-a'), []);
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM calibration_operations WHERE family_id=?').get('family-a') as any).n, 0);
  await create(f, input(), 'family-b').expect(201); f.db.prepare('DELETE FROM families WHERE id=?').run('family-b');
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM calibration_cases').get() as any).n, 0); assert.equal((f.db.prepare('SELECT count(*) AS n FROM calibration_operations').get() as any).n, 0);
  assert.equal((f.db.prepare('PRAGMA quick_check').get() as any).quick_check, 'ok');
});

test('close blocks further access without deleting persisted test cases', async t => {
  const f = fixture(t); await create(f).expect(201); f.library.close();
  await request(f.app).get(`${path}/cases`).set('x-test-family', 'family-a').expect(503);
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM calibration_cases').get() as any).n, 1);
});

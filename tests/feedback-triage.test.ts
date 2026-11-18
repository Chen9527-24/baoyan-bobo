import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import request from 'supertest';
import { createApp } from '../apps/server/src/app.js';
import { createFeedback, feedbackMetadata, triageFeedback } from '../apps/server/src/feedback.js';
import { readServiceStatus } from '../ops/service-status.js';

const DAY = 86_400_000;
const origin = 'http://localhost:5173';
const profile = { pin: '123456', nickname: '合成伙伴', ageGroup: '6-8', sessionMinutes: 10, dailyMinutes: 20, consent: true };
type Agent = ReturnType<typeof request.agent>;
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'baoyan-triage-')); const path = join(directory, 'test.sqlite');
  let at = Date.now(); let closed = false;
  const app = createApp({ env: {}, dataPath: path, now: () => at });
  const close = () => { if (!closed) { app.locals.close(); closed = true; } };
  t.after(() => { close(); rmSync(directory, { recursive: true, force: true }); });
  return { app, path, directory, close, now: () => at, step: (ms: number) => { at += ms; },
    read<T>(fn: (db: DatabaseSync) => T) { const db = new DatabaseSync(path); db.exec('PRAGMA foreign_keys=ON;'); try { return fn(db); } finally { db.close(); } } };
}
async function submit(agent: Agent, text = '合成报告正文不得出现在终端') {
  await agent.get('/api/feedback/context').expect(200);
  return (await agent.post('/api/feedback').set('Origin', origin).field('operationId', randomUUID()).field('text', text)
    .field('context', JSON.stringify({ page: 'call', callState: 'processing', appVersion: '0.2.0' })).expect(201)).body as { id: string; createdAt: string };
}
const reportsCli = resolve('ops/feedback-reports.ts'); const statusCli = resolve('ops/service-status.ts');
const run = (cli: string, ...args: string[]) => execFileSync(process.execPath, ['--import', 'tsx', cli, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const fail = (cli: string, ...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], { encoding: 'utf8' });

test('submitted report defaults open; trusted triage transitions are audited, exact retries do not duplicate and status does not claim notification', async t => {
  const f = fixture(t); const report = await submit(request.agent(f.app));
  assert.deepEqual(Object.keys(report).sort(), ['createdAt', 'id']);
  f.read(db => {
    assert.equal(feedbackMetadata(db)[0]!.status, 'open');
    const first = triageFeedback(db, { id: report.id, status: 'in_progress', reviewer: '合成维护者', note: '排查合成故障' }, f.now());
    assert.equal(first.changed, true); assert.equal(first.notificationSent, false);
    assert.deepEqual(Object.keys(first).sort(), ['changed', 'id', 'notificationSent', 'status', 'updatedAt']);
    const retry = triageFeedback(db, { id: report.id, status: 'in_progress', reviewer: '合成维护者', note: '排查合成故障' }, f.now() + 1);
    assert.equal(retry.changed, false); assert.equal(retry.updatedAt, first.updatedAt);
    triageFeedback(db, { id: report.id, status: 'resolved', reviewer: '合成维护者', note: '复现检查通过' }, f.now() + 2);
    triageFeedback(db, { id: report.id, status: 'open', reviewer: '另一维护者', note: '再次出现，重新处理' }, f.now() + 3);
    const rows = db.prepare('SELECT previous_status,status,reviewer,note FROM feedback_triage_events WHERE report_id=? ORDER BY rowid').all(report.id);
    assert.deepEqual(rows.map(row => [row.previous_status, row.status]), [['open', 'in_progress'], ['in_progress', 'resolved'], ['resolved', 'open']]);
    assert.equal(rows[2]!.note, '再次出现，重新处理');
    assert.equal(feedbackMetadata(db)[0]!.updatedAt, new Date(f.now() + 3).toISOString());
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  });
});

test('triage rejects invalid UUID/status/reviewer/notes and unknown or expired reports atomically, with bounded immutable history', async t => {
  const f = fixture(t); const report = await submit(request.agent(f.app));
  f.read(db => {
    const valid = { id: report.id, status: 'in_progress' as const, reviewer: '合成维护者', note: '检查' };
    for (const input of [{ ...valid, id: 'invalid' }, { ...valid, id: randomUUID() }, { ...valid, status: 'notified' }, { ...valid, reviewer: '' },
      { ...valid, reviewer: 'x'.repeat(65) }, { ...valid, reviewer: 'line\nline' }, { ...valid, note: 'x'.repeat(2001) }, { ...valid, note: 'a\u0000b' }])
      assert.throws(() => triageFeedback(db, input as typeof valid, f.now()));
    assert.equal(db.prepare('SELECT count(*) AS n FROM feedback_triage_events').get()!.n, 0);
    assert.equal(feedbackMetadata(db)[0]!.status, 'open');
    for (let index = 0; index < 100; index++) triageFeedback(db, { ...valid, note: `合成审计 ${index}` }, f.now() + index);
    assert.throws(() => triageFeedback(db, { ...valid, note: '超限' }, f.now() + 101), /上限/);
    assert.equal(triageFeedback(db, { ...valid, note: '合成审计 99' }, f.now() + 102).changed, false);
    assert.equal(db.prepare('SELECT count(*) AS n FROM feedback_triage_events').get()!.n, 100);
    db.prepare('UPDATE feedback_reports SET expires_at=? WHERE id=?').run(f.now(), report.id);
    assert.throws(() => triageFeedback(db, valid, f.now()), /过期/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM feedback_triage_events').get()!.n, 100);
  });
});

test('operator CLI stores UTF-8 notes privately while list and triage output contain neither body, notes, audio nor household identifiers', async t => {
  const f = fixture(t); const text = '私密合成报告正文'; const note = '私密合成处理备注\n第二行';
  const report = await submit(request.agent(f.app), text); const noteFile = join(f.directory, 'note.txt'); writeFileSync(noteFile, note, { mode: 0o600 });
  const updated = run(reportsCli, 'triage', '--db', f.path, '--id', report.id, '--status', 'in_progress', '--reviewer', '测试维护', '--note-file', noteFile);
  const listing = run(reportsCli, 'list', '--db', f.path);
  for (const output of [updated, listing]) { assert.equal(output.includes(text), false); assert.equal(output.includes(note), false); assert.doesNotMatch(output, /client_hash|payload_hash|family_id|reviewer|"note"|"audio":/); }
  assert.equal(JSON.parse(updated).notificationSent, false); assert.equal(JSON.parse(listing).reports[0].status, 'in_progress');
  assert.equal(JSON.parse(listing).reports[0].context.appVersion, '0.2.0');
  f.read(db => assert.equal(db.prepare('SELECT note FROM feedback_triage WHERE report_id=?').get(report.id)!.note, note));
  const before = f.read(db => db.prepare('SELECT count(*) AS n FROM feedback_triage_events').get()!.n);
  const linked = join(f.directory, 'linked.txt'); symlinkSync(noteFile, linked);
  assert.equal(fail(reportsCli, 'triage', '--db', f.path, '--id', report.id, '--status', 'resolved', '--reviewer', '测试维护', '--note-file', linked).status, 1);
  writeFileSync(noteFile, Buffer.alloc(8193, 120));
  const oversize = fail(reportsCli, 'triage', '--db', f.path, '--id', report.id, '--status', 'resolved', '--reviewer', '测试维护', '--note-file', noteFile);
  assert.equal(oversize.status, 1); assert.equal(oversize.stderr.includes('x'.repeat(100)), false);
  writeFileSync(noteFile, Buffer.from([0xc3, 0x28]));
  assert.equal(fail(reportsCli, 'triage', '--db', f.path, '--id', report.id, '--status', 'resolved', '--reviewer', '测试维护', '--note-file', noteFile).status, 1);
  assert.equal(f.read(db => db.prepare('SELECT count(*) AS n FROM feedback_triage_events').get()!.n), before);
});

test('parent export includes only its report status and timestamp; withdrawal cascades current triage and history, preserving unrelated reports', async t => {
  const f = fixture(t); const a = request.agent(f.app); const b = request.agent(f.app);
  for (const agent of [a, b]) { await agent.post('/api/setup').set('Origin', origin).send(profile).expect(201); await agent.post('/api/parent/unlock').set('Origin', origin).send({ pin: profile.pin }).expect(200); }
  const own = await submit(a, '甲家庭合成报告'); const other = await submit(b, '乙家庭合成报告');
  f.read(db => {
    triageFeedback(db, { id: own.id, status: 'resolved', reviewer: '内部维护者', note: '内部合成备注不在家庭导出' }, f.now());
    triageFeedback(db, { id: other.id, status: 'in_progress', reviewer: '内部维护者', note: '乙的合成备注' }, f.now());
  });
  const exported = (await a.get('/api/parent/export').expect(200)).body.feedbackReports;
  assert.equal(exported.length, 1); assert.equal(exported[0].id, own.id); assert.equal(exported[0].status, 'resolved'); assert.ok(exported[0].updatedAt);
  assert.equal(exported[0].reviewer, undefined); assert.equal(exported[0].note, undefined);
  await a.post('/api/parent/withdraw').set('Origin', origin).send({}).expect(200);
  f.read(db => {
    for (const table of ['feedback_triage', 'feedback_triage_events']) {
      assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE report_id=?`).get(own.id)!.n, 0);
      assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE report_id=?`).get(other.id)!.n, 1);
    }
    assert.equal(db.prepare('SELECT count(*) AS n FROM feedback_rate_events').get()!.n, 2, 'withdrawal does not erase abuse counters');
  });
});

test('expiry sweep and explicit CLI delete cascade triage/history and never resurrect a deleted report', async t => {
  const f = fixture(t); const report = await submit(request.agent(f.app));
  f.read(db => triageFeedback(db, { id: report.id, status: 'resolved', reviewer: '维护者', note: '合成删除验证' }, f.now()));
  assert.equal(JSON.parse(run(reportsCli, 'delete', '--db', f.path, '--id', report.id)).deleted, true);
  f.read(db => { assert.equal(db.prepare('SELECT count(*) AS n FROM feedback_triage_events').get()!.n, 0); assert.equal(db.prepare('SELECT count(*) AS n FROM feedback_triage').get()!.n, 0); });
  const expired = await submit(request.agent(f.app));
  f.read(db => triageFeedback(db, { id: expired.id, status: 'in_progress', reviewer: '维护者', note: '' }, f.now()));
  f.step(30 * DAY); f.app.locals.sweepExpiredState();
  f.read(db => { for (const table of ['feedback_reports', 'feedback_triage', 'feedback_triage_events']) assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n, 0); });
});

test('existing report metadata remains readable without migrations, and startup backfills open without inventing audited handling', t => {
  const directory = mkdtempSync(join(tmpdir(), 'baoyan-triage-old-')); const path = join(directory, 'old.sqlite');
  const db = new DatabaseSync(path); t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  db.exec(`PRAGMA foreign_keys=ON;CREATE TABLE families(id TEXT PRIMARY KEY);
    CREATE TABLE feedback_reports(id TEXT PRIMARY KEY,client_hash TEXT NOT NULL,operation_id TEXT NOT NULL,payload_hash TEXT NOT NULL,
      family_id TEXT REFERENCES families(id) ON DELETE CASCADE,text TEXT NOT NULL,context_json TEXT NOT NULL,audio BLOB,audio_bytes INTEGER NOT NULL,
      total_bytes INTEGER NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER,UNIQUE(client_hash,operation_id));`);
  const id = randomUUID(); const now = Date.now();
  db.prepare('INSERT INTO feedback_reports VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id, 'synthetic', randomUUID(), 'synthetic', null, '旧合成正文', '{}', null, 0, 12, now, now + DAY);
  assert.equal(feedbackMetadata(db)[0]!.status, 'open');
  assert.throws(() => triageFeedback(db, { id, status: 'resolved', reviewer: '维护者', note: '' }, now), /初始化/);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='feedback_triage'").get(), undefined);
  createFeedback(db, () => now);
  assert.equal(db.prepare('SELECT status FROM feedback_triage WHERE report_id=?').get(id)!.status, 'open');
  assert.equal(db.prepare('SELECT count(*) AS n FROM feedback_triage_events').get()!.n, 0);
});

test('service overview aggregates recent provider stages and nearest-rank percentiles without inventing total wait or price; explicit daily budget is separate', async t => {
  const f = fixture(t); const report = await submit(request.agent(f.app), '概况不得读取的合成家庭正文'); const now = Date.parse('2026-09-30T16:00:00Z');
  f.read(db => {
    const insert = db.prepare('INSERT INTO software_service_metrics(id,stage,ok,duration_ms,created_at) VALUES(?,?,?,?,?)');
    for (const [stage, ok, duration] of [['asr', 1, 30], ['asr-speaker', 0, 80], ['chat', 1, 10], ['chat', 1, 20], ['chat', 1, 30], ['chat', 0, 40],
      ['tts', 1, 100], ['tts-stream', 1, 200], ['tts-stream', 0, 300], ['audio-understanding', 1, 600], ['provider', 1, 700],
      ['合成数据库私密字符串', 1, 800], ['client-first-audio', 1, 900]] as const) insert.run(randomUUID(), stage, ok, duration, now - 1);
    insert.run(randomUUID(), 'asr', 1, 9999, now - 7 * DAY - 1); insert.run(randomUUID(), 'chat', 1, 9999, now + 1);
    db.exec('CREATE TABLE trial_provider_usage(day TEXT PRIMARY KEY,calls INTEGER NOT NULL);');
    db.prepare('INSERT INTO trial_provider_usage VALUES(?,?)').run('2026-10-01', 12);
    db.prepare('UPDATE feedback_reports SET expires_at=? WHERE id=?').run(now + DAY, report.id);
    triageFeedback(db, { id: report.id, status: 'in_progress', reviewer: '合成维护者', note: '概况不得读取的合成备注' }, now);
    const withoutBudget = readServiceStatus(db, { now });
    assert.equal(withoutBudget.providerDayBudget.dailyBudget, null); assert.equal(withoutBudget.providerDayBudget.remaining, null);
    const summary = readServiceStatus(db, { now, dailyBudget: 20 });
    const stages = Object.fromEntries(summary.providerStages.stages.map(item => [item.stage, item]));
    assert.deepEqual(stages.asr, { stage: 'asr', attempts: 2, succeeded: 1, failed: 1, successRate: .5, p50Ms: 30, p95Ms: 80 });
    assert.deepEqual(stages.chat, { stage: 'chat', attempts: 4, succeeded: 3, failed: 1, successRate: .75, p50Ms: 20, p95Ms: 40 });
    assert.equal(stages.tts.p50Ms, 200); assert.equal(stages.tts.p95Ms, 300); assert.equal(stages.unclassified.attempts, 2);
    assert.equal(summary.clientFirstAudio.p50Ms, 900); assert.equal(summary.providerStages.measurement, 'provider_stage_duration');
    assert.equal(summary.providerDayBudget.day, '2026-10-01'); assert.equal(summary.providerDayBudget.calls, 12); assert.equal(summary.providerDayBudget.remaining, 8);
    assert.equal(summary.feedback.in_progress, 1); assert.equal(summary.cost.measured, false);
    assert.equal(readServiceStatus(db, { now, dailyBudget: 5 }).providerDayBudget.remaining, 0);
    const output = JSON.stringify(summary); assert.doesNotMatch(output, /合成数据库私密字符串|概况不得读取|family_id|reviewer|"note"|totalWait|costEstimate/);
  });
});

test('service-status CLI opens only existing ordinary DB files read-only, tolerates old schemas and emits no private fields or inferred budget', async t => {
  const f = fixture(t); await submit(request.agent(f.app), '只读概况合成报告不得输出');
  f.close(); const before = readFileSync(f.path); const modified = statSync(f.path).mtimeMs;
  const output = run(statusCli, '--db', f.path); const summary = JSON.parse(output);
  assert.equal(summary.feedback.open, 1); assert.equal(summary.providerDayBudget.available, false); assert.equal(summary.providerDayBudget.calls, null);
  assert.equal(summary.providerDayBudget.dailyBudget, null); assert.equal(summary.providerStages.stages.find((item: any) => item.stage === 'asr').p50Ms, null);
  assert.doesNotMatch(output, /只读概况合成报告|cookie_key|family_id|"text"|"audio"/);
  assert.equal(createHash('sha256').update(readFileSync(f.path)).digest('hex'), createHash('sha256').update(before).digest('hex'));
  assert.equal(statSync(f.path).mtimeMs, modified);
  const missing = join(f.directory, 'missing.sqlite'); assert.equal(fail(statusCli, '--db', missing).status, 1); assert.equal(existsSync(missing), false);
  const link = join(f.directory, 'link.sqlite'); symlinkSync(f.path, link); assert.equal(fail(statusCli, '--db', link).status, 1);
  assert.equal(fail(statusCli, '--db', f.path, '--daily-budget', '0').status, 1);
  assert.equal(fail(statusCli, '--db', f.path, '--daily-budget', '1000001').status, 1);
  assert.equal(fail(statusCli, '--db', f.path, '--env', 'secret').status, 1);
  const oldPath = join(f.directory, 'minimal.sqlite'); const old = new DatabaseSync(oldPath); old.exec('CREATE TABLE unrelated_counter(n INTEGER);'); old.close();
  const older = JSON.parse(run(statusCli, '--db', oldPath));
  assert.equal(older.providerStages.available, false); assert.equal(older.feedback.available, false); assert.equal(older.feedback.triageAvailable, false);
  assert.equal(older.providerDayBudget.available, false);
});

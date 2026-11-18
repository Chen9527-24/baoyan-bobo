import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import test, { type TestContext } from 'node:test';
import { createFeedback, triageFeedback } from '../apps/server/src/feedback.js';
import { createAdminFeedbackRouter } from '../apps/server/src/admin-feedback.js';
import { ApiError } from '../apps/server/src/provider-errors.js';

function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE families(id TEXT PRIMARY KEY);');
  let at = 1_800_000_000_000, failAudit = false;
  const feedback = createFeedback(db, () => at);
  const audits: { action: string; id: string }[] = [];
  const app = express(); app.use(cookieParser(), express.json());
  app.use('/submit', feedback.router({ cookie: { httpOnly: true }, familyId: () => undefined }));
  app.use('/admin/feedback', createAdminFeedbackRouter({ db, now: () => at,
    authorize: req => { if (req.get('test-auth') !== 'admin') throw new ApiError(401, 'Unauthorized', 'ADMIN_REQUIRED'); return { id: 'operator', username: 'operator' }; },
    audit: (_actor, action, id) => { if (failAudit) throw new Error('Synthetic audit failure'); audits.push({ action, id }); },
  }));
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof ApiError ? error.status : 500).json({ error: error.message });
  });
  t.after(() => db.close());
  async function submit(text = '合成反馈：播放声音断了') {
    const agent = request.agent(app); await agent.get('/submit/context').expect(200);
    return (await agent.post('/submit').field('operationId', randomUUID()).field('text', text).expect(201)).body.id as string;
  }
  return { db, app, submit, audits, now: () => at, expire: () => { at += 31 * 86400000; }, failAudit: () => { failAudit = true; } };
}

test('admin feedback rejects anonymous access; lists metadata and loads submitted details only after explicit open', async t => {
  const f = fixture(t); const body = '正文只在明确打开时读取'; const id = await f.submit(body);
  await request(f.app).get('/admin/feedback').expect(401);
  await request(f.app).get(`/admin/feedback/${id}`).expect(401);
  await request(f.app).get(`/admin/feedback/${id}/audio`).expect(401);
  await request(f.app).post(`/admin/feedback/${id}/status`).send({}).expect(401);
  const list = (await request(f.app).get('/admin/feedback').set('test-auth', 'admin').expect(200)).body;
  assert.equal(list.total, 1); assert.equal(list.items[0].revision, 1); assert.equal(JSON.stringify(list).includes(body), false);
  assert.equal(JSON.stringify(list).includes('client_hash'), false);
  const detail = (await request(f.app).get(`/admin/feedback/${id}`).set('test-auth', 'admin').expect(200)).body;
  assert.equal(detail.text, body); assert.deepEqual(detail.events, []);
  assert.deepEqual(f.audits, [{ action: 'feedback.view', id }]);
});

test('admin triage detects stale versions from another operator and permits reopening with an audit', async t => {
  const f = fixture(t), id = await f.submit();
  const update = (revision: number, status: string) => request(f.app).post(`/admin/feedback/${id}/status`).set('test-auth', 'admin')
    .send({ revision, status, reason: '合成处理备注', confirm: true });
  const first = await update(1, 'in_progress').expect(200); assert.equal(first.body.revision, 2); assert.equal(first.body.notificationSent, false);
  await update(1, 'resolved').expect(409);
  triageFeedback(f.db, { id, status: 'resolved', reviewer: 'terminal-operator', note: '终端已处理' }, f.now());
  await update(2, 'open').expect(409);
  await update(3, 'open').expect(200);
  const result = (await request(f.app).get(`/admin/feedback/${id}`).set('test-auth', 'admin')).body;
  assert.equal(result.status, 'open'); assert.equal(result.events.length, 3); assert.equal(result.revision, 4);
});

test('failed administrative audit rolls back feedback state and history atomically', async t => {
  const f = fixture(t), id = await f.submit(); f.failAudit();
  await request(f.app).post(`/admin/feedback/${id}/status`).set('test-auth', 'admin')
    .send({ revision: 1, status: 'resolved', reason: '合成备注', confirm: true }).expect(500);
  assert.equal(f.db.prepare('SELECT status FROM feedback_triage WHERE report_id=?').get(id)?.status, 'open');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM feedback_triage_events').get()?.n, 0);
});

test('expired feedback is inaccessible across list/detail/audio/triage without deleting existing data', async t => {
  const f = fixture(t), id = await f.submit(); f.expire();
  assert.equal((await request(f.app).get('/admin/feedback').set('test-auth', 'admin')).body.total, 0);
  await request(f.app).get(`/admin/feedback/${id}`).set('test-auth', 'admin').expect(404);
  await request(f.app).get(`/admin/feedback/${id}/audio`).set('test-auth', 'admin').expect(404);
  await request(f.app).post(`/admin/feedback/${id}/status`).set('test-auth', 'admin')
    .send({ revision: 1, status: 'open', reason: '合成备注', confirm: true }).expect(404);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM feedback_reports').get()?.n, 1);
});

test('feedback filters/pagination are bounded and arbitrary status or unconfirmed edits cannot write', async t => {
  const f = fixture(t), id = await f.submit(); await f.submit();
  const response = await request(f.app).get(`/admin/feedback?q=${id.slice(0, 8)}&limit=1&offset=0`).set('test-auth', 'admin').expect(200);
  assert.equal(response.body.items[0].id, id); assert.equal(response.body.total, 1);
  for (const query of ['limit=1000', 'offset=-1', 'q=%25', 'status=dismissed']) await request(f.app).get(`/admin/feedback?${query}`).set('test-auth', 'admin').expect(400);
  await request(f.app).post(`/admin/feedback/${id}/status`).set('test-auth', 'admin').send({ revision: 1, status: 'resolved', reason: '备注' }).expect(400);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM feedback_triage_events').get()?.n, 0);
});

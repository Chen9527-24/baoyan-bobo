import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import request from 'supertest';
import { createApp } from '../apps/server/src/app.js';
import { createAdminStore } from '../apps/server/src/admin-store.js';

const origin = 'http://localhost:5173';
async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'baoyan-admin-integration-')), path = join(directory, 'test.sqlite');
  const app = createApp({ dataPath: path, env: {} });
  const db = new DatabaseSync(path); db.exec('PRAGMA foreign_keys=ON;');
  const adminStore = createAdminStore({ db }), ticket = adminStore.createBootstrap();
  t.after(() => { adminStore.close(); db.close(); app.locals.close(); rmSync(directory, { recursive: true, force: true }); });
  const admin = request.agent(app), guest = request.agent(app);
  await admin.post('/api/admin/bootstrap').set('Origin', origin).send({ token: ticket.token, username: 'fixture_operator', password: '87654321' }).expect(200);
  await guest.post('/api/setup').set('Origin', origin).send({ pin: '123456', nickname: '虚构集成伙伴', ageGroup: '6-8', sessionMinutes: 10, dailyMinutes: 20, memoryEnabled: false, consent: true }).expect(201);
  const familyId = String(db.prepare('SELECT id FROM families LIMIT 1').get()!.id);
  return { app, db, admin, guest, familyId };
}

test('family pause closes current call, rejects visitor and parent access, preserves household and allows deliberate restoration', async t => {
  const f = await fixture(t);
  const call = (await f.guest.post('/api/calls').set('Origin', origin).send({ operationId: crypto.randomUUID() }).expect(201)).body;
  await f.admin.post(`/api/admin/families/${f.familyId}/status`).set('Origin', origin)
    .send({ revision: 0, status: 'paused', reason: '合成故障排查', confirm: true }).expect(200);
  const denied = await f.guest.get('/api/bootstrap').expect(403); assert.equal(denied.body.code, 'FAMILY_PAUSED');
  await f.guest.post(`/api/calls/${call.id}/heartbeat`).set('Origin', origin).send({}).expect(403);
  await f.guest.post('/api/parent/unlock').set('Origin', origin).send({ pin: '123456' }).expect(403);
  assert.notEqual(f.db.prepare('SELECT ended_at FROM calls WHERE id=?').get(call.id)!.ended_at, null);
  assert.equal(f.db.prepare('SELECT count(*) n FROM families').get()!.n, 1);
  // Background housekeeping must still run for paused families without throwing.
  f.app.locals.sweepExpiredState();
  await f.admin.post(`/api/admin/families/${f.familyId}/status`).set('Origin', origin)
    .send({ revision: 1, status: 'active', reason: '合成问题已排除', confirm: true }).expect(200);
  assert.equal((await f.guest.get('/api/bootstrap').expect(200)).body.configured, true);
  await f.guest.post('/api/calls').set('Origin', origin).send({ operationId: crypto.randomUUID() }).expect(201);
});

test('parent PIN and normal account never authorize operations; absent or foreign Origin cannot mutate admin state', async t => {
  const f = await fixture(t);
  await f.guest.post('/api/parent/unlock').set('Origin', origin).send({ pin: '123456' }).expect(200);
  await f.guest.post('/api/parent/account/register').set('Origin', origin).send({contactPhone:'+12025550101',childName:'虚构集成伙伴',pin:'123456', username: 'fixture_parent', password: '12345678' }).expect(201);
  for (const path of ['overview', 'accounts', 'families', 'audit', 'feedback']) await f.guest.get(`/api/admin/${path}`).expect(401);
  const account = (await f.admin.get('/api/admin/accounts').expect(200)).body.items[0];
  const payload = { revision: 0, status: 'disabled', reason: '合成测试', confirm: true };
  await f.admin.post(`/api/admin/accounts/${account.id}/status`).send(payload).expect(403);
  await f.admin.post(`/api/admin/accounts/${account.id}/status`).set('Origin', 'https://untrusted.invalid').send(payload).expect(403);
  assert.equal((await f.admin.get('/api/admin/accounts')).body.items[0].status, 'active');
  const overview = (await f.admin.get('/api/admin/overview').expect(200)).body;
  assert.equal(overview.accounts.total, 1); assert.equal(overview.service.cost.measured, false);
  assert.equal(JSON.stringify(overview).includes('fixture_parent'), false);
});

test('feedback detail and mutation use real admin authorization and the unified audit trail', async t => {
  const f = await fixture(t); await f.guest.get('/api/feedback/context').expect(200);
  const report = (await f.guest.post('/api/feedback').set('Origin', origin).field('operationId', crypto.randomUUID()).field('text', '这是虚构声音问题').expect(201)).body;
  await f.guest.get(`/api/admin/feedback/${report.id}`).expect(401);
  await f.admin.get(`/api/admin/feedback/${report.id}`).expect(200);
  const payload = { revision: 1, status: 'resolved', reason: '合成排查完成', confirm: true };
  await f.admin.post(`/api/admin/feedback/${report.id}/status`).send(payload).expect(403);
  await f.admin.post(`/api/admin/feedback/${report.id}/status`).set('Origin', origin).send(payload).expect(200);
  const audits = (await f.admin.get('/api/admin/audit').expect(200)).body.items;
  assert.ok(audits.some((item: { action: string }) => item.action === 'feedback.status'));
  assert.equal(JSON.stringify(audits).includes('这是虚构声音问题'), false);
  await f.admin.post('/api/admin/logout').set('Origin', origin).send({}).expect(200);
  await f.admin.get(`/api/admin/feedback/${report.id}`).expect(401);
});

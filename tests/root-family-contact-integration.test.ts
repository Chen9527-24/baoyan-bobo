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
const profile = { pin: '123456', nickname: '虚构小雨', ageGroup: '6-8', sessionMinutes: 10, dailyMinutes: 20, consent: true };
const phone = '+12025550101'; // Fictional 555-01xx block, never a real contact.
const secondPhone = '+12025550102';
const post = (agent: ReturnType<typeof request.agent>, path: string, body: unknown = {}) => agent.post('/api' + path).set('Origin', origin).send(['/account/register','/parent/account/register'].includes(path)?{contactPhone:'+12025550101',childName:profile.nickname,pin:profile.pin,...(body as object)}:path==='/account/guardian/unlock'?{pin:profile.pin,...(body as object)}:body);

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'baoyan-family-contact-'));
  const dataPath = join(directory, 'synthetic.sqlite');
  const app = createApp({ dataPath, env: {}, fetch: async () => { throw new Error('No providers in contact tests'); } });
  const db = new DatabaseSync(dataPath);
  db.exec('PRAGMA foreign_keys=ON');
  const store = createAdminStore({ db });
  const token = store.createBootstrap().token;
  const admin = request.agent(app);
  await post(admin, '/admin/bootstrap', { token, username: 'fictional_admin', password: '12345678' }).expect(200);
  t.after(() => { store.close(); app.locals.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });
  async function owner(username: string, nickname: string, contactPhone?: string) {
    const agent = request.agent(app);
    const registration = await post(agent, '/account/register', { username,childName:nickname, password: '12345678', ...(contactPhone ? { contactPhone } : {}) }).expect(201);
    assert.equal(JSON.stringify(registration.body).includes(contactPhone || 'UNLIKELY_CONTACT_MARKER'), false);
    await post(agent, '/setup', { ...profile, nickname }).expect(201);
    await post(agent, '/parent/unlock', { pin: profile.pin }).expect(200);
    const id = String(db.prepare('SELECT family_id FROM accounts WHERE username=?').get(username)!.family_id);
    return { agent, id };
  }
  return { app, db, admin, owner };
}

test('admin family names follow current child edits without stale duplicate names and delete removed children from search', async t => {
  const f = await fixture(t);
  const { agent, id } = await f.owner('fictional.owner', profile.nickname, phone);
  const added = (await post(agent, '/parent/children', { nickname: '虚构小夏', ageGroup: '9-12', sessionMinutes: 10, dailyMinutes: 20 }).expect(201)).body;
  await agent.patch('/api/parent/settings').set('Origin', origin).send({ nickname: '虚构新小雨' }).expect(200);
  const family = (await f.admin.get('/api/admin/families').query({ q: id }).expect(200)).body.items[0];
  assert.equal(family.displayName, '虚构新小雨的家庭');
  assert.deepEqual(new Set(family.childNames), new Set(['虚构新小雨', '虚构小夏']));
  assert.equal(JSON.stringify(family).includes('memoryEnabled'), false);
  assert.equal((await f.admin.get('/api/admin/families').query({ q: '虚构小夏' })).body.total, 1);
  await post(agent, '/parent/unlock', { pin: profile.pin }).expect(200);
  await agent.delete('/api/parent/children/' + added.id).set('Origin', origin).expect(200);
  assert.equal((await f.admin.get('/api/admin/families').query({ q: '虚构小夏' })).body.total, 0);
  assert.equal((await f.admin.get('/api/admin/families').query({ q: '%' })).body.total, 0);
});

test('contact numbers stay with their account when a guardian is detached and joins a different family', async t => {
  const f = await fixture(t);
  const a = await f.owner('fictional.first', '虚构甲', phone);
  const b = await f.owner('fictional.second', '虚构乙');
  const guardian = request.agent(f.app);
  await post(guardian, '/account/register', { username: 'fictional.guardian', password: '12345678', contactPhone: secondPhone }).expect(201);
  const link = (await post(a.agent, '/parent/guardians/link').expect(200)).body;
  await post(guardian, '/account/guardian/join', { code: link.code }).expect(201);
  const guardianId = String(f.db.prepare("SELECT id FROM accounts WHERE username='fictional.guardian'").get()!.id);
  const before = (await f.admin.get('/api/admin/families').query({ q: a.id })).body.items[0];
  assert.equal(before.contacts.find((c: { accountId: string }) => c.accountId === guardianId)?.contactPhone, secondPhone);
  await a.agent.delete('/api/parent/guardians/' + guardianId).set('Origin', origin).expect(200);
  const after = (await f.admin.get('/api/admin/families').query({ q: a.id })).body.items[0];
  assert.equal(after.contacts.some((c: { accountId: string }) => c.accountId === guardianId), false);
  await post(guardian, '/account/login', { username: 'fictional.guardian', password: '12345678' }).expect(200);
  const nextLink = (await post(b.agent, '/parent/guardians/link').expect(200)).body;
  await post(guardian, '/account/guardian/join', { code: nextLink.code }).expect(201);
  const match = (await f.admin.get('/api/admin/families').query({ q: secondPhone })).body;
  assert.equal(match.total, 1);
  assert.equal(match.items[0].id, b.id);
  assert.equal(match.items[0].contacts.find((c: { accountId: string }) => c.accountId === guardianId)?.contactPhone, secondPhone);
});

test('own contact editing does not leak to child bootstrap, other family exports or admin audit payloads', async t => {
  const f = await fixture(t);
  const a = await f.owner('fictional.first', '虚构甲', phone);
  const b = await f.owner('fictional.second', '虚构乙', secondPhone);
  const current = (await a.agent.get('/api/parent/account/contact').expect(200)).body;
  assert.equal(current.contactPhone, phone);
  await post(a.agent, '/parent/account/contact', { contactPhone: '+1 202-555-0103', revision: current.revision }).expect(200);
  const bootstrap = (await a.agent.get('/api/bootstrap').expect(200)).body;
  const exported = (await b.agent.get('/api/parent/export').expect(200)).body;
  const audit = (await f.admin.get('/api/admin/audit').expect(200)).body;
  for (const data of [bootstrap, exported, audit]) {
    const payload = JSON.stringify(data);
    assert.equal(payload.includes(phone), false);
    assert.equal(payload.includes('+12025550103'), false);
  }
  assert.equal((await b.agent.get('/api/parent/account/contact')).body.contactPhone, secondPhone);
  await a.agent.get('/api/admin/families').expect(401);
  await a.agent.get('/api/admin/accounts').expect(401);
});

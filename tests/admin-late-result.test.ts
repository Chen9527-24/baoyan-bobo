import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import request from 'supertest';
import { createApp } from '../apps/server/src/app.js';
import { createAdminStore } from '../apps/server/src/admin-store.js';

const origin = 'http://localhost:5173';
const password = '12345678';
const profile = { pin: '123456', nickname: '独立虚构审核', ageGroup: '6-8', sessionMinutes: 10, dailyMinutes: 30, consent: true };
const post = (agent: any, path: string, body: unknown = {}) => agent.post('/api' + path).set('Origin', origin).send(['/account/register','/parent/account/register'].includes(path)?{contactPhone:'+12025550101',childName:profile.nickname,pin:profile.pin,...(body as object)}:path==='/account/guardian/unlock'?{pin:profile.pin,...(body as object)}:body);
const response = (content: string) => Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }] });

async function harness(t: TestContext, hold: 'chat' | 'summary') {
  const folder = mkdtempSync(join(tmpdir(), 'baoyan-admin-late-')), dataPath = join(folder, 'test.sqlite');
  let release!: () => void, entered!: () => void, signal: AbortSignal | null | undefined;
  let providerCalls = 0;
  const held = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; });
  const app = createApp({ dataPath, env: { API_BASE_URL: 'https://fixture.invalid/v1', API_KEY: 'synthetic-only', CHAT_MODEL: 'synthetic-admin-check' },
    fetch: (async (url, init) => {
      assert.equal(String(url), 'https://fixture.invalid/v1/chat/completions'); providerCalls++;
      const body = JSON.parse(String(init?.body));
      const summary = body.messages[0].content.includes('BOBO_AUTO_MEMORY_EXTRACT_V1');
      if ((hold === 'summary') === summary) { signal = init?.signal; entered(); await held; }
      // Ignore abort deliberately: application final guards must reject this synthetic late result.
      if (summary) {
        const statements = JSON.parse(body.messages.at(-1).content).statements;
        return response(JSON.stringify({ memories: statements.map((s: { id: string; text: string }) => ({ statementId: s.id, quote: s.text, kind: 'preference' })) }));
      }
      return response('蓝色像今天的天空，我在听你说。');
    }) as typeof fetch,
  });
  const db = new DatabaseSync(dataPath); db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  const bootstrapStore = createAdminStore({ db }); const ticket = bootstrapStore.createBootstrap(); bootstrapStore.close();
  const admin = request.agent(app), child = request.agent(app);
  t.after(async () => { release(); await app.locals.waitForAutoMemory(); app.locals.close(); db.close(); rmSync(folder, { recursive: true, force: true }); });
  await post(admin, '/admin/bootstrap', { token: ticket.token, username: 'independent.admin', password }).expect(200);
  await post(child, '/setup', profile).expect(201); await post(child, '/parent/unlock', { pin: profile.pin }).expect(200);
  await post(child, '/parent/account/register', { username: 'independent.child', password }).expect(201);
  const familyId = String(db.prepare('SELECT id FROM families').get()!.id);
  const accountId = String(db.prepare('SELECT id FROM accounts').get()!.id);
  const setFamily = (status: 'paused' | 'active', revision: number) => post(admin, `/admin/families/${familyId}/status`, { status, revision, reason: '虚构安全复核', confirm: true });
  return { app, db, admin, child, familyId, accountId, setFamily, started, release, get signal() { return signal; }, get providerCalls() { return providerCalls; } };
}

test('admin pause aborts active chat and suppresses a late provider reply; restoration never restores old account cookies', async t => {
  const h = await harness(t, 'chat');
  const call = (await post(h.child, '/calls', { operationId: randomUUID() }).expect(201)).body;
  const pending = post(h.child, `/calls/${call.id}/turn`, { text: '我喜欢蓝色', operationId: randomUUID() }).then((res: any) => res);
  await h.started; await h.setFamily('paused', 0).expect(200); assert.equal(h.signal?.aborted, true);
  h.release(); const late = await pending; assert.equal(late.status, 401); assert.equal(late.body.reply, undefined);
  await h.setFamily('active', 1).expect(200);
  assert.equal((await h.child.get('/api/bootstrap').expect(200)).body.configured, false);
  await post(h.child, '/calls', { operationId: randomUUID() }).expect(401);
  const restored = await post(h.child, '/account/login', { username: 'independent.child', password }).expect(200);
  assert.equal(restored.body.configured, true); assert.equal(restored.body.parentAuthorized, false);
  assert.equal(h.db.prepare('SELECT count(*) n FROM families').get()!.n, 1); assert.equal(h.providerCalls, 1);
});

test('admin account disable cancels ended-chat memory extraction and rejects even a valid late summary', async t => {
  const h = await harness(t, 'summary');
  const call = (await post(h.child, '/calls', { operationId: randomUUID() }).expect(201)).body;
  await post(h.child, `/calls/${call.id}/turn`, { text: '我最喜欢的颜色是蓝色', operationId: randomUUID() }).expect(200);
  await post(h.child, `/calls/${call.id}/end`).expect(200); await h.started;
  await post(h.admin, `/admin/accounts/${h.accountId}/status`, { status: 'disabled', revision: 0, reason: '虚构安全复核', confirm: true }).expect(200);
  assert.equal(h.signal?.aborted, true); h.release(); await h.app.locals.waitForAutoMemory();
  assert.equal(h.db.prepare('SELECT count(*) n FROM memories').get()!.n, 0);
  assert.equal(h.db.prepare('SELECT state FROM auto_memory_status').get()!.state, 'cancelled');
  await post(h.child, '/account/login', { username: 'independent.child', password }).expect(403);
  assert.equal(h.providerCalls, 2);
});

test('ordinary parent authorization cannot access any operator data and all admin writes reject missing origin', async t => {
  const h = await harness(t, 'chat'); await post(h.child, '/parent/unlock', { pin: profile.pin }).expect(200);
  for (const path of ['/overview', '/accounts', '/families', '/audit', '/feedback', `/feedback/${randomUUID()}`, `/feedback/${randomUUID()}/audio`])
    await h.child.get('/api/admin' + path).expect(401);
  for (const path of ['/logout', '/password', `/accounts/${h.accountId}/status`, `/accounts/${h.accountId}/recovery`, `/families/${h.familyId}/status`, `/feedback/${randomUUID()}/status`])
    await post(h.child, '/admin' + path).expect(401);
  for (const path of ['/bootstrap', '/login', '/recover', '/password', `/families/${h.familyId}/status`])
    await h.admin.post('/api/admin' + path).send({}).expect(403);
  assert.equal(h.providerCalls, 0);
});

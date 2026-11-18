import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp, type AppOptions } from '../apps/server/src/app.js';
import { accountKdfStatus } from '../apps/server/src/account-store.js';

const origin = 'http://localhost:5173';
const password = 'fictional Race Passphrase 426!';
const nextPassword = 'fictional New Race Passphrase 719!';
const username = 'fictional.race.guardian';
const profile = { pin: '123456', nickname: '虚构竞态测试者', ageGroup: '6-8', sessionMinutes: 10, dailyMinutes: 20, consent: true };
const post = (agent: any, path: string, body: unknown = {}) => agent.post('/api' + path).set('Origin', origin).send(['/account/register','/parent/account/register'].includes(path)?{contactPhone:'+12025550101',childName:profile.nickname,pin:profile.pin,...(body as object)}:path==='/account/guardian/unlock'?{pin:profile.pin,...(body as object)}:body);
const bootstrap = async (agent: any) => (await agent.get('/api/bootstrap').expect(200)).body;
const unlock = async (agent: any, pin = profile.pin) => { await post(agent, '/parent/unlock', { pin }).expect(200); };
const login = async (agent: any, pass = password) => (await post(agent, '/account/login', { username, password: pass }).expect(200)).body;

function harness(t: TestContext, options: AppOptions = {}) {
  const app = createApp({ env: {}, dataPath: ':memory:', ...options });
  t.after(() => app.locals.close());
  return { app, agent: request.agent(app) };
}
async function setup(agent: any) { return (await post(agent, '/setup', profile).expect(201)).body; }
async function register(agent: any) {
  await unlock(agent);
  return (await post(agent, '/parent/account/register', { username, password }).expect(201)).body;
}
async function waitUntil(check: () => boolean, description: string) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, description + ' did not begin');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function waitForKdf() { await waitUntil(() => accountKdfStatus().running > 0, 'asynchronous password derivation'); }

test('registration cannot bind a household after its PIN authorization is locked during derivation', async t => {
  const { app, agent } = harness(t);
  const initial = await setup(agent); await unlock(agent);
  const pending = post(agent, '/parent/account/register', { username, password }).then((res: any) => res);
  await waitForKdf(); await post(agent, '/parent/lock').expect(200);
  assert.equal((await pending).status, 403);
  const after = await bootstrap(agent);
  assert.equal(after.child.id, initial.child.id);
  assert.equal(after.parentAuthorized, false);
  assert.deepEqual(after.account, { bound: false, signedIn: false });
  await post(request.agent(app), '/account/login', { username, password }).expect(401);
});

test('registration cannot resurrect a household withdrawn while derivation is pending', async t => {
  const { app, agent } = harness(t);
  await setup(agent); await unlock(agent);
  const pending = post(agent, '/parent/account/register', { username, password }).then((res: any) => res);
  await waitForKdf(); await post(agent, '/parent/withdraw').expect(200);
  assert.equal((await pending).status, 401);
  assert.equal((await bootstrap(agent)).configured, false);
  const fresh = request.agent(app);
  await post(fresh, '/account/login', { username, password }).expect(401);
  assert.equal((await bootstrap(fresh)).configured, false);
});

test('logout during old-password verification prevents a late password change and fresh session', async t => {
  const { app, agent } = harness(t);
  await setup(agent); await register(agent); await unlock(agent);
  const pending = post(agent, '/parent/account/password', { password, newPassword: nextPassword }).then((res: any) => res);
  await waitForKdf(); await post(agent, '/account/logout').expect(200);
  assert.equal((await pending).status, 401);
  assert.equal((await bootstrap(agent)).configured, false);
  const fresh = request.agent(app);
  assert.equal((await login(fresh)).child.nickname, profile.nickname);
  await post(request.agent(app), '/account/login', { username, password: nextPassword }).expect(401);
});

test('logout during PIN-password verification preserves the old PIN and does not restore authorization', async t => {
  const { app, agent } = harness(t);
  await setup(agent); await register(agent);
  const pending = post(agent, '/account/pin', { password, pin: '654321' }).then((res: any) => res);
  await waitForKdf(); await post(agent, '/account/logout').expect(200);
  assert.equal((await pending).status, 401);
  assert.equal((await bootstrap(agent)).configured, false);
  const fresh = request.agent(app);
  assert.equal((await login(fresh)).parentAuthorized, false);
  await post(fresh, '/parent/unlock', { pin: '654321' }).expect(403);
  await unlock(fresh);
});

type Statement = { id: string; text: string };
function response(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
}
function summaryHarness(t: TestContext) {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let summarySignal: AbortSignal | undefined;
  let statements: Statement[] = [];
  let summaryRequests = 0, chatRequests = 0;
  const app = createApp({ dataPath: ':memory:',
    env: { API_BASE_URL: 'https://fixture.invalid/v1', API_KEY: 'fixture-only-not-a-key', CHAT_MODEL: 'fictional-race-model' },
    fetch: (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.messages[0].content.includes('BOBO_AUTO_MEMORY_EXTRACT_V1')) {
        summaryRequests++; summarySignal = init?.signal ?? undefined;
        statements = JSON.parse(body.messages.at(-1).content).statements;
        // Deliberately ignore abort while pending: the application's final write guard must still reject this output.
        await held;
        return response(JSON.stringify({ memories: statements.map(s => ({ statementId: s.id, quote: s.text, kind: 'preference' })) }));
      }
      chatRequests++;
      return response('蓝色像晴朗的天空，我在听你说。');
    }) as typeof fetch,
  });
  t.after(async () => { release(); await app.locals.waitForAutoMemory(); app.locals.close(); });
  return { app, agent: request.agent(app), release,
    get summarySignal() { return summarySignal; },
    get summaryRequests() { return summaryRequests; },
    get chatRequests() { return chatRequests; },
    get statements() { return statements; },
  };
}
async function beginHeldSummary(h: ReturnType<typeof summaryHarness>) {
  await setup(h.agent); const registered = await register(h.agent);
  const call = (await post(h.agent, '/calls', { operationId: randomUUID() }).expect(201)).body;
  await post(h.agent, `/calls/${call.id}/turn`, { text: '我最喜欢的颜色是蓝色', operationId: randomUUID() }).expect(200);
  await post(h.agent, `/calls/${call.id}/end`).expect(200);
  await waitUntil(() => h.summaryRequests === 1, 'deferred local summary');
  assert.deepEqual(h.statements.map(s => s.text), ['我最喜欢的颜色是蓝色']);
  return registered;
}
async function assertNoLateMemory(h: ReturnType<typeof summaryHarness>, pass = password) {
  h.release(); await h.app.locals.waitForAutoMemory();
  await login(h.agent, pass); await unlock(h.agent);
  const result = (await h.agent.get('/api/parent/memories').expect(200)).body;
  assert.deepEqual(result.items, []);
  assert.equal(result.autoSummary.state, 'cancelled');
  assert.equal(result.autoSummary.savedCount, 0);
  assert.equal(h.chatRequests, 1); assert.equal(h.summaryRequests, 1);
}

test('logout aborts a pending summary and ignores a provider output returned after cancellation', async t => {
  const h = summaryHarness(t); await beginHeldSummary(h);
  await post(h.agent, '/account/logout').expect(200);
  assert.equal(h.summarySignal?.aborted, true);
  assert.equal((await bootstrap(h.agent)).configured, false);
  await assertNoLateMemory(h);
});

test('account recovery aborts a pending summary and cannot write its late output into the restored household', async t => {
  const h = summaryHarness(t); const registered = await beginHeldSummary(h);
  const recoverer = request.agent(h.app);
  const result = (await post(recoverer, '/account/recover', { username, recoveryCode: registered.recoveryCode, newPassword: nextPassword }).expect(200)).body;
  assert.deepEqual(result, { ok: true });
  assert.equal((await bootstrap(recoverer)).configured, false);
  assert.equal(h.summarySignal?.aborted, true);
  assert.equal((await bootstrap(h.agent)).configured, false);
  await assertNoLateMemory(h, nextPassword);
});

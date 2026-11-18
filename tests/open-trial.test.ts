import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import request from 'supertest';
import { createApp, type AppOptions } from '../apps/server/src/app.js';
import { createTrialAccess, readTrialConfig } from '../apps/server/src/trial-access.js';

const origin = 'https://trial.fixture.testing';
const initialTime = Date.parse('2026-09-28T08:00:00Z');
const openEnv = { NODE_ENV: 'test', TRIAL_ENABLED: 'true', TRIAL_REQUIRE_INVITE: 'false', TRIAL_ENDS_AT: '2026-10-12T08:00:00Z', ALLOWED_ORIGINS: origin };
const profile = { pin: '123456', nickname: '虚构体验者', ageGroup: '6-8', sessionMinutes: 10, dailyMinutes: 20, consent: true };
const providerEnv = { API_BASE_URL: 'https://synthetic.invalid/v1', API_KEY: 'synthetic-test-key', CHAT_MODEL: 'mock-chat' };

function fixture(t: TestContext, extraEnv: Record<string, string | undefined> = {}, options: AppOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'baoyan-open-trial-'));
  const dataPath = join(directory, 'test.sqlite');
  const env = { ...openEnv, ...extraEnv };
  let clock = initialTime;
  let app = createApp({ ...options, env, dataPath, now: () => clock });
  let closed = false;
  const withStore = <T>(action: (access: ReturnType<typeof createTrialAccess>, db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(dataPath);
    try { return action(createTrialAccess(db, readTrialConfig(env), () => clock), db); }
    finally { db.close(); }
  };
  t.after(() => { if (!closed) app.locals.close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    get app() { return app; }, env, dataPath, withStore,
    setTime(value: number) { clock = value; },
    close() { if (!closed) { app.locals.close(); closed = true; } },
    restart(nextEnv: Record<string, string | undefined> = {}) {
      if (!closed) app.locals.close();
      closed = true;
      Object.assign(env, nextEnv);
      app = createApp({ ...options, env, dataPath, now: () => clock });
      closed = false;
    },
  };
}
async function enroll(f: ReturnType<typeof fixture>, inviteCode?: string) {
  const agent = request.agent(f.app);
  const response = await agent.post('/api/setup').set('Origin', origin).send({ ...profile, ...(inviteCode ? { inviteCode } : {}) }).expect(201);
  const cookie = (response.headers['set-cookie'] as unknown as string[]).map(value => value.split(';')[0]).join('; ');
  return { agent, cookie };
}
async function startCall(agent: ReturnType<typeof request.agent>) {
  return (await agent.post('/api/calls').set('Origin', origin).send({ operationId: randomUUID() }).expect(201)).body;
}
const answer = () => Response.json({ choices: [{ message: { content: '我们一起画一颗星星。' } }] });
const turn = (agent: ReturnType<typeof request.agent>, id: string) => agent.post(`/api/calls/${id}/turn`).set('Origin', origin).send({ text: '一起画星星吧', operationId: randomUUID() });

test('the invitation switch is explicit and validated; the backward-compatible default still requires invites', () => {
  assert.equal(readTrialConfig({ ...openEnv, TRIAL_REQUIRE_INVITE: undefined })?.requireInvite, true);
  assert.equal(readTrialConfig({ ...openEnv, TRIAL_REQUIRE_INVITE: 'true' })?.requireInvite, true);
  assert.equal(readTrialConfig(openEnv)?.requireInvite, false);
  for (const value of ['', '0', '1', 'False', 'yes'])
    assert.throws(() => readTrialConfig({ ...openEnv, TRIAL_REQUIRE_INVITE: value }), /TRIAL_REQUIRE_INVITE/);
  const config = readTrialConfig(openEnv)!;
  assert.equal(config.maxSessionMinutes, 10);
  assert.equal(config.maxDailyMinutes, 20);
  assert.equal(config.dailyProviderCalls, 300);
  assert.equal(config.maxConcurrentProviderCalls, 2);
});

test('open trial admits more than the former five slots without creating or spending invites, and survives restart', async t => {
  const f = fixture(t);
  assert.equal((await request(f.app).get('/api/bootstrap').expect(200)).body.trial.requiresInvite, false);
  const invite = f.withStore(access => access.createInvite());
  const devices: string[] = [];
  for (let index = 0; index < 7; index++) devices.push((await enroll(f, index === 0 ? invite.inviteCode : undefined)).cookie);
  const stored = f.withStore((access, db) => ({ invites: access.listInvites(), admissions: db.prepare('SELECT * FROM trial_admissions').all(), families: db.prepare('SELECT id FROM families').all() }));
  assert.equal(stored.invites.length, 1);
  assert.equal(stored.invites[0].state, 'available');
  assert.equal(stored.admissions.length, 7);
  assert.ok(stored.admissions.every(row => row.source === 'open'));
  assert.ok(stored.families.every(row => !JSON.stringify(stored.admissions).includes(String(row.id))));
  f.restart();
  for (const cookie of devices) {
    const result = await request(f.app).get('/api/bootstrap').set('Cookie', cookie).expect(200);
    assert.equal(result.body.configured, true);
    assert.equal(result.body.trial.requiresInvite, false);
  }
  await enroll(f);
});

test('failed open signup rolls its admission back with the household transaction', async t => {
  const f = fixture(t);
  f.withStore((_access, db) => db.exec("CREATE TRIGGER synthetic_failure BEFORE INSERT ON families BEGIN SELECT RAISE(ABORT,'synthetic failure'); END"));
  await request(f.app).post('/api/setup').set('Origin', origin).send(profile).expect(500);
  assert.equal(f.withStore((_access, db) => db.prepare('SELECT count(*) AS n FROM trial_admissions').get()?.n), 0);
  f.withStore((_access, db) => db.exec('DROP TRIGGER synthetic_failure'));
  await enroll(f);
});

test('legacy invitations migrate to admissions; switching either direction retains existing household access', async t => {
  const f = fixture(t, { TRIAL_REQUIRE_INVITE: 'true' });
  const invite = f.withStore(access => access.createInvite());
  const invited = await enroll(f, invite.inviteCode);
  f.withStore((_access, db) => db.exec('DROP TABLE trial_admissions'));
  f.restart({ TRIAL_REQUIRE_INVITE: 'false' });
  assert.equal((await request(f.app).get('/api/bootstrap').set('Cookie', invited.cookie)).body.configured, true);
  const open = await enroll(f);
  f.restart({ TRIAL_REQUIRE_INVITE: 'true' });
  for (const cookie of [invited.cookie, open.cookie]) {
    const value = (await request(f.app).get('/api/bootstrap').set('Cookie', cookie).expect(200)).body;
    assert.equal(value.configured, true);
    assert.equal(value.trial.requiresInvite, false);
  }
  assert.equal((await request(f.app).get('/api/bootstrap')).body.trial.requiresInvite, true);
  await request(f.app).post('/api/setup').set('Origin', origin).send(profile).expect(403);
  assert.equal(f.withStore(access => access.listInvites()).length, 1);
});

test('open access does not silently expose an old local household database', async t => {
  const f = fixture(t, { TRIAL_ENABLED: 'false' });
  await enroll(f);
  f.close();
  assert.throws(() => createApp({ env: openEnv, dataPath: f.dataPath, now: () => initialTime }), /独立数据库/);
});

test('open signup, calls and changes retain the deadline and 10/20 minute caps; withdrawal remains available', async t => {
  const end = initialTime + 20_000;
  const f = fixture(t, { TRIAL_ENDS_AT: new Date(end).toISOString() });
  for (const excessive of [{ sessionMinutes: 11 }, { dailyMinutes: 21 }]) {
    const denied = await request(f.app).post('/api/setup').set('Origin', origin).send({ ...profile, ...excessive }).expect(400);
    assert.equal(denied.body.code, 'TRIAL_TIME_LIMIT');
  }
  const { agent } = await enroll(f);
  const active = await startCall(agent);
  assert.equal(active.remainingSeconds, 20);
  await agent.post('/api/parent/unlock').set('Origin', origin).send({ pin: profile.pin }).expect(200);
  assert.equal((await agent.patch('/api/parent/settings').set('Origin', origin).send({ dailyMinutes: 21 }).expect(400)).body.code, 'TRIAL_TIME_LIMIT');
  f.setTime(end);
  assert.equal((await request(f.app).post('/api/setup').set('Origin', origin).send(profile).expect(410)).body.code, 'TRIAL_EXPIRED');
  assert.equal((await agent.post('/api/calls').set('Origin', origin).send({ operationId: randomUUID() }).expect(410)).body.code, 'TRIAL_EXPIRED');
  await agent.get('/api/parent/export').expect(200);
  await agent.post('/api/parent/withdraw').set('Origin', origin).send({}).expect(200);
  f.restart();
  assert.equal((await request(f.app).get('/api/bootstrap')).body.configured, false);
});

test('open trial preserves the persistent provider attempt cap across restart', async t => {
  let actual = 0;
  const f = fixture(t, { ...providerEnv, TRIAL_DAILY_PROVIDER_CALLS: '1' }, { fetch: async () => { actual++; return answer(); } });
  const first = (await enroll(f)).agent;
  const active = await startCall(first);
  await turn(first, active.id).expect(200);
  assert.equal((await turn(first, active.id).expect(429)).body.code, 'TRIAL_DAILY_LIMIT');
  f.restart();
  const next = (await enroll(f)).agent;
  const nextCall = await startCall(next);
  assert.equal((await turn(next, nextCall.id).expect(429)).body.code, 'TRIAL_DAILY_LIMIT');
  assert.equal(actual, 1);
});

test('open trial keeps the concurrent provider gate and frees capacity after cancellation', async t => {
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  let actual = 0;
  const f = fixture(t, { ...providerEnv, TRIAL_MAX_CONCURRENT_PROVIDER_CALLS: '1' }, { fetch: async (_url, init) => {
    actual++;
    if (actual > 1) return answer();
    began();
    return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('synthetic cancelled')), { once: true }));
  } });
  const a = (await enroll(f)).agent;
  const b = (await enroll(f)).agent;
  const firstCall = await startCall(a); const secondCall = await startCall(b);
  const pending = turn(a, firstCall.id).then(response => response);
  await started;
  assert.equal((await turn(b, secondCall.id).expect(429)).body.code, 'TRIAL_BUSY');
  assert.equal(actual, 1);
  await a.post(`/api/calls/${firstCall.id}/cancel`).set('Origin', origin).send({}).expect(200);
  assert.equal((await pending).status, 409);
  await turn(b, secondCall.id).expect(200);
  assert.equal(actual, 2);
});

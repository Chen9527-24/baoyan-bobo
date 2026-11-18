import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import request from 'supertest';
import { createApp, type AppOptions } from '../apps/server/src/app.js';
import { createTrialAccess, readTrialConfig, validateProductionOrigins } from '../apps/server/src/trial-access.js';

const origin = 'https://trial.fixture.testing';
const initialTime = Date.parse('2026-09-28T08:00:00Z');
const baseEnv = { NODE_ENV: 'test', TRIAL_ENABLED: 'true', TRIAL_ENDS_AT: '2026-10-05T08:00:00Z', ALLOWED_ORIGINS: origin };
const profile = { pin: '123456', nickname: '体验朋友', ageGroup: '6-8', sessionMinutes: 10, dailyMinutes: 20, consent: true };
const providerEnv = { API_BASE_URL: 'https://synthetic.invalid/v1', API_KEY: 'synthetic-test-key', CHAT_MODEL: 'mock-chat', ASR_MODEL: 'mock-asr', TTS_MODEL: 'mock-tts' };
type Agent = ReturnType<typeof request.agent>;

function fixture(t: TestContext, extraEnv: Record<string, string | undefined> = {}, options: AppOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'baoyan-trial-'));
  const dataPath = join(directory, 'test.sqlite');
  const env = { ...baseEnv, ...extraEnv };
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
    invite(expiresAt?: number) { return withStore(access => access.createInvite(expiresAt)); },
    close() { if (!closed) { app.locals.close(); closed = true; } },
    restart() { if (!closed) app.locals.close(); app = createApp({ ...options, env, dataPath, now: () => clock }); closed = false; },
  };
}
async function enroll(f: ReturnType<typeof fixture>, inviteCode = f.invite().inviteCode) {
  const agent = request.agent(f.app);
  const result = await agent.post('/api/setup').set('Origin', origin).send({ ...profile, inviteCode }).expect(201);
  assert.equal(result.body.trial.requiresInvite, false);
  return agent;
}
async function call(agent: Agent) {
  return (await agent.post('/api/calls').set('Origin', origin).send({ operationId: randomUUID() }).expect(201)).body;
}
const answer = () => Response.json({ choices: [{ message: { content: '我们一起画一颗星星。' } }] });
const turn = (agent: Agent, id: string) => agent.post(`/api/calls/${id}/turn`).set('Origin', origin).send({ text: '一起画星星吧', operationId: randomUUID() });

test('trial settings fail closed in production and enforce explicit valid deadlines, positive limits and HTTPS origins', () => {
  assert.equal(readTrialConfig({}), undefined);
  assert.throws(() => readTrialConfig({ NODE_ENV: 'production' }), /内测保护/);
  for (const value of [undefined, '', 'tomorrow', '2026-09-30', '2026-02-30T10:00:00Z', '2026-09-30T24:00:00Z'])
    assert.throws(() => readTrialConfig({ ...baseEnv, TRIAL_ENDS_AT: value }));
  for (const key of ['TRIAL_MAX_FAMILIES', 'TRIAL_MAX_SESSION_MINUTES', 'TRIAL_MAX_DAILY_MINUTES', 'TRIAL_DAILY_PROVIDER_CALLS', 'TRIAL_MAX_CONCURRENT_PROVIDER_CALLS'])
    for (const value of ['0', '-1', '1.5', '', 'Infinity', '9007199254740992']) assert.throws(() => readTrialConfig({ ...baseEnv, [key]: value }));
  assert.throws(() => readTrialConfig({ ...baseEnv, TRIAL_MAX_DAILY_MINUTES: '5' }));
  assert.equal(readTrialConfig(baseEnv)?.dailyProviderCalls, 300);
  const production = { ...baseEnv, NODE_ENV: 'production' };
  for (const invalid of [[], ['*'], ['null'], ['http://trial.fixture.testing'], ['https://localhost'], ['https://127.0.0.1'], ['https://[::1]'], ['https://demo.example.com'], ['https://trial.fixture.testing/path'], ['https://u:p@trial.fixture.testing']])
    assert.throws(() => validateProductionOrigins(production, invalid));
  assert.doesNotThrow(() => validateProductionOrigins(production, [origin]));
  assert.throws(() => createApp({ env: production, dataPath: ':memory:', allowedOrigins: [] }));
});

test('only a fresh one-time invite admits a family; bootstrap/list never disclose invite hashes or private setup data', async t => {
  const f = fixture(t);
  const bootstrap = (await request(f.app).get('/api/bootstrap').expect(200)).body;
  assert.deepEqual(bootstrap.trial, { enabled: true, requiresInvite: true, expiresAt: baseEnv.TRIAL_ENDS_AT.replace('Z', '.000Z'), maxSessionMinutes: 10, maxDailyMinutes: 20 });
  assert.equal(bootstrap.child, null);
  const invite = f.invite();
  await request(f.app).post('/api/setup').set('Origin', origin).send(profile).expect(403);
  await request(f.app).post('/api/setup').set('Origin', origin).send({ ...profile, inviteCode: 'invalid' }).expect(403);
  await request(f.app).post('/api/setup').set('Origin', 'https://another.fixture.testing').send({ ...profile, inviteCode: invite.inviteCode }).expect(403);
  const agent = await enroll(f, invite.inviteCode);
  const retry = await agent.post('/api/setup').set('Origin', origin).send({ ...profile, inviteCode: invite.inviteCode }).expect(409);
  assert.equal(retry.body.code, 'ALREADY_CONFIGURED');
  await request(f.app).post('/api/setup').set('Origin', origin).send({ ...profile, inviteCode: invite.inviteCode }).expect(403);
  const stored = f.withStore((access, db) => ({ rows: db.prepare('SELECT * FROM trial_invites').all(), list: access.listInvites() }));
  assert.equal(stored.list[0].state, 'used');
  assert.equal(JSON.stringify(stored).includes(invite.inviteCode), false);
  assert.equal('code_hash' in stored.list[0], false);
  assert.equal((await agent.get('/api/bootstrap')).body.child.nickname, profile.nickname);
  assert.equal((await request(f.app).get('/api/bootstrap')).body.child, null);
});

test('invalid limits and a failed household transaction do not burn the invite', async t => {
  const f = fixture(t); const invite = f.invite();
  await request(f.app).post('/api/setup').set('Origin', origin).send({ ...profile, sessionMinutes: 11, inviteCode: invite.inviteCode }).expect(400);
  f.withStore((_access, db) => db.exec("CREATE TRIGGER synthetic_failure BEFORE INSERT ON families BEGIN SELECT RAISE(ABORT,'synthetic failure'); END"));
  await request(f.app).post('/api/setup').set('Origin', origin).send({ ...profile, inviteCode: invite.inviteCode }).expect(500);
  assert.equal(f.withStore(access => access.listInvites())[0].state, 'available');
  f.withStore((_access, db) => db.exec('DROP TRIGGER synthetic_failure'));
  await enroll(f, invite.inviteCode);
});

test('revoked and expired invitations cannot admit a family and invalid setup is globally throttled', async t => {
  const f = fixture(t); const revoked = f.invite(); const expired = f.invite(initialTime + 1000);
  f.withStore(access => access.revokeInvite(revoked.id));
  f.setTime(initialTime + 2000);
  for (const invite of [revoked, expired]) await request(f.app).post('/api/setup').set('Origin', origin).send({ ...profile, inviteCode: invite.inviteCode }).expect(403);
  for (let index = 0; index < 28; index++) await request(f.app).post('/api/setup').set('Origin', origin).send(profile).expect(403);
  const denied = await request(f.app).post('/api/setup').set('Origin', origin).send(profile).expect(429);
  assert.equal(denied.body.code, 'TRIAL_SETUP_BUSY');
  f.setTime(initialTime + 60_000);
  await enroll(f);
});

test('withdrawal and restart never return consumed invitation capacity', async t => {
  const f = fixture(t, { TRIAL_MAX_FAMILIES: '2' });
  const first = await enroll(f);
  await first.post('/api/parent/unlock').set('Origin', origin).send({ pin: profile.pin }).expect(200);
  await first.post('/api/parent/withdraw').set('Origin', origin).send({}).expect(200);
  await enroll(f);
  const third = f.invite();
  f.restart();
  const denied = await request(f.app).post('/api/setup').set('Origin', origin).send({ ...profile, inviteCode: third.inviteCode }).expect(403);
  assert.equal(denied.body.code, 'TRIAL_FAMILY_LIMIT');
  assert.equal(f.withStore(access => access.listInvites()).filter(item => item.state === 'used').length, 2);
});

test('an uninvited local database cannot become a public trial by changing environment alone', async t => {
  const f = fixture(t, { TRIAL_ENABLED: 'false' });
  await request(f.app).post('/api/setup').set('Origin', origin).send(profile).expect(201);
  f.close();
  assert.throws(() => createApp({ env: baseEnv, dataPath: f.dataPath, now: () => initialTime }), /独立数据库/);
});

test('trial families remain isolated and parent settings cannot raise the trial duration caps', async t => {
  const f = fixture(t); const a = await enroll(f); const b = await enroll(f);
  const active = await call(a);
  await turn(b, active.id).expect(404);
  await a.post('/api/parent/unlock').set('Origin', origin).send({ pin: profile.pin }).expect(200);
  await a.patch('/api/parent/settings').set('Origin', origin).send({ sessionMinutes: 11 }).expect(400);
  await a.patch('/api/parent/settings').set('Origin', origin).send({ dailyMinutes: 21 }).expect(400);
  await a.patch('/api/parent/settings').set('Origin', origin).send({ nickname: '已修改' }).expect(200);
  assert.equal((await b.get('/api/bootstrap')).body.child.nickname, profile.nickname);
});

test('production issues Secure HttpOnly strict cookies and still requires device identity after Origin passes', async t => {
  const f = fixture(t, { NODE_ENV: 'production' }); const invite = f.invite();
  const result = await request(f.app).post('/api/setup').set('Origin', origin).send({ ...profile, inviteCode: invite.inviteCode }).expect(201);
  const cookies = result.headers['set-cookie'] as unknown as string[];
  assert.match(cookies[0], /; Secure/); assert.match(cookies[0], /; HttpOnly/); assert.match(cookies[0], /; SameSite=Strict/);
  await request(f.app).post('/api/calls').set('Origin', origin).send({ operationId: randomUUID() }).expect(401);
  const cookie = cookies.map(value => value.split(';')[0]).join('; ');
  assert.equal((await request(f.app).get('/api/bootstrap').set('Cookie', cookie)).body.configured, true);
  await request(f.app).post('/api/calls').set('Origin', origin).set('Cookie', cookie).send({ operationId: randomUUID() }).expect(201);
});

test('deadline blocks all new model work and starts, while ending/export/withdrawal remain available', async t => {
  let calls = 0;
  const end = initialTime + 20_000;
  const f = fixture(t, { ...providerEnv, TRIAL_ENDS_AT: new Date(end).toISOString() }, { fetch: async () => { calls++; return answer(); } });
  const agent = await enroll(f); const active = await call(agent);
  assert.equal(active.remainingSeconds, 20);
  const reply = (await turn(agent, active.id).expect(200)).body;
  f.setTime(end);
  assert.equal((await turn(agent, active.id).expect(410)).body.code, 'TRIAL_EXPIRED');
  await agent.post(`/api/calls/${active.id}/audio`).set('Origin', origin).field('operationId', randomUUID()).attach('audio', Buffer.from('synthetic'), { filename: 'test.webm', contentType: 'audio/webm' }).expect(410);
  await agent.post(`/api/calls/${active.id}/speech`).set('Origin', origin).send({ replyId: reply.replyId }).expect(410);
  await agent.post('/api/calls').set('Origin', origin).send({ operationId: randomUUID() }).expect(410);
  assert.equal(calls, 1);
  await agent.post(`/api/calls/${active.id}/end`).set('Origin', origin).send({}).expect(200);
  await agent.post('/api/parent/unlock').set('Origin', origin).send({ pin: profile.pin }).expect(200);
  await agent.get('/api/parent/export').expect(200);
  await agent.post('/api/parent/withdraw').set('Origin', origin).send({}).expect(200);
  f.restart();
  await request(f.app).get('/api/bootstrap').expect(200);
});

test('ASR, chat and TTS share a persistent daily attempt cap; restart does not reset it, next Shanghai day does', async t => {
  const actual: string[] = [];
  const f = fixture(t, { ...providerEnv, TRIAL_DAILY_PROVIDER_CALLS: '3' }, { fetch: async url => {
    actual.push(String(url));
    if (String(url).endsWith('/audio/transcriptions')) return Response.json({ text: '今天想画星星' });
    if (String(url).endsWith('/audio/speech')) return new Response('ID3', { headers: { 'content-type': 'audio/mpeg' } });
    return answer();
  } });
  const agent = await enroll(f); const active = await call(agent);
  const reply = (await agent.post(`/api/calls/${active.id}/audio`).set('Origin', origin).field('operationId', randomUUID()).attach('audio', Buffer.from('synthetic audio'), { filename: 'test.webm', contentType: 'audio/webm' }).expect(200)).body;
  await agent.post(`/api/calls/${active.id}/speech`).set('Origin', origin).send({ replyId: reply.replyId }).expect(200);
  assert.equal(actual.length, 3);
  assert.equal((await turn(agent, active.id).expect(429)).body.code, 'TRIAL_DAILY_LIMIT');
  assert.equal(actual.length, 3);
  f.restart();
  const nextAgent = await enroll(f); const nextCall = await call(nextAgent);
  await turn(nextAgent, nextCall.id).expect(429); assert.equal(actual.length, 3);
  f.setTime(Date.parse('2026-09-28T16:00:00Z'));
  const nextDayCall = await call(nextAgent);
  await turn(nextAgent, nextDayCall.id).expect(200); assert.equal(actual.length, 4);
});

test('Volc ASR counts only an actual socket attempt; local WAV rejection costs no call and quota error survives adapter sanitization', async t => {
  let connections = 0;
  const f = fixture(t, { ASR_PROVIDER: 'volc', VOLC_SPEECH_API_KEY: 'synthetic-key', VOLC_ASR_URL: 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream', VOLC_ASR_RESOURCE_ID: 'volc.seedasr.sauc.duration', TRIAL_DAILY_PROVIDER_CALLS: '1' }, {
    volcAsrConnect: () => { connections++; throw new Error('synthetic socket failure'); },
  });
  const agent = await enroll(f); const active = await call(agent);
  const upload = (bytes: Buffer) => agent.post(`/api/calls/${active.id}/audio`).set('Origin', origin).field('operationId', randomUUID()).attach('audio', bytes, { filename: 'test.wav', contentType: 'audio/wav' });
  await upload(Buffer.from('invalid wav')).expect(400); assert.equal(connections, 0);
  const wav = Buffer.alloc(46); wav.write('RIFF'); wav.writeUInt32LE(38, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(2, 40);
  await upload(wav).expect(502); assert.equal(connections, 1);
  assert.equal((await upload(wav).expect(429)).body.code, 'TRIAL_DAILY_LIMIT'); assert.equal(connections, 1);
});

test('small concurrency gate rejects before transport and releases the slot when a pending call is cancelled', async t => {
  let began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
  let actual = 0;
  const f = fixture(t, { ...providerEnv, TRIAL_MAX_CONCURRENT_PROVIDER_CALLS: '1' }, { fetch: async (_url, init) => {
    actual++;
    if (actual > 1) return answer();
    began();
    return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('synthetic cancelled')), { once: true }));
  } });
  const a = await enroll(f); const b = await enroll(f); const aCall = await call(a); const bCall = await call(b);
  const pending = turn(a, aCall.id).then(result => result); await started;
  assert.equal((await turn(b, bCall.id).expect(429)).body.code, 'TRIAL_BUSY'); assert.equal(actual, 1);
  await a.post(`/api/calls/${aCall.id}/cancel`).set('Origin', origin).send({}).expect(200);
  assert.equal((await pending).status, 409);
  await turn(b, bCall.id).expect(200); assert.equal(actual, 2);
});

test('shutdown of a pending provider releases quota state without touching a closed database', async t => {
  let began!: () => void; let complete!: (response: Response) => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const f = fixture(t, providerEnv, { fetch: async () => { began(); return new Promise<Response>(resolve => { complete = resolve; }); } });
  const agent = await enroll(f); const active = await call(agent);
  const pending = turn(agent, active.id).then(result => result); await started;
  f.close(); complete(answer());
  assert.equal((await pending).body.code, 'SERVICE_STOPPED');
});

test('CLI prints the new code only on explicit create, stores only its hash, and list/revoke omit it', async t => {
  const f = fixture(t, { TRIAL_ENDS_AT: new Date(Date.now() + 86400000).toISOString() });
  const run = (args: string[]) => execFileSync(process.execPath, ['--import', 'tsx', 'ops/trial-invites.ts', ...args, '--db', f.dataPath], {
    cwd: process.cwd(), env: { TRIAL_ENABLED: 'true', TRIAL_ENDS_AT: f.env.TRIAL_ENDS_AT }, encoding: 'utf8',
  });
  const created = JSON.parse(run(['create']));
  assert.match(created.inviteCode, /^[A-Za-z0-9_-]{32}$/);
  const listed = run(['list']); assert.equal(listed.includes(created.inviteCode), false); assert.equal(listed.includes('code_hash'), false);
  assert.equal(run(['revoke', '--id', created.id]).includes(created.inviteCode), false);
  assert.equal(JSON.parse(run(['list'])).invites[0].state, 'revoked');
});

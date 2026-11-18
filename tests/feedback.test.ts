import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import request from 'supertest';
import { createApp } from '../apps/server/src/app.js';

const origin = 'http://localhost:5173';
const profile = { pin: '123456', nickname: '测试伙伴', ageGroup: '6-8', sessionMinutes: 10, dailyMinutes: 20, consent: true };
type Agent = ReturnType<typeof request.agent>;
const context = { page: 'call', callState: 'processing', appVersion: '0.1.1' };
function wav(seconds = 1): Buffer {
  const b = Buffer.alloc(44 + 32000 * seconds);
  b.write('RIFF', 0); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(b.length - 44, 40); return b;
}
function fixture(t: TestContext, env: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'baoyan-feedback-'));
  const path = join(directory, 'test.sqlite'); let time = Date.parse('2026-09-28T12:00:00Z');
  let app = createApp({ env, dataPath: path, now: () => time });
  t.after(() => { app.locals.close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    get app() { return app; }, path, directory,
    step(ms: number) { time += ms; },
    read<T>(fn: (db: DatabaseSync) => T) { const db = new DatabaseSync(path); try { return fn(db); } finally { db.close(); } },
    restart() { app.locals.close(); app = createApp({ env, dataPath: path, now: () => time }); },
  };
}
async function ready(agent: Agent) { return agent.get('/api/feedback/context').expect(200); }
function post(agent: Agent, text = '听不到声音', operationId = randomUUID(), extraContext = context) {
  return agent.post('/api/feedback').set('Origin', origin).field('operationId', operationId).field('text', text).field('context', JSON.stringify(extraContext));
}

test('anonymous text and raw WAV are explicitly submitted and no provider or public report route is involved', async t => {
  const f = fixture(t); const agent = request.agent(f.app);
  const cookie = (await ready(agent)).headers['set-cookie'][0];
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/); assert.doesNotMatch(cookie, /Max-Age|Expires/);
  assert.equal((await ready(agent)).headers['set-cookie'], undefined, 'context reads reuse the existing signed identity');
  const text = (await post(agent).expect(201)).body;
  assert.deepEqual(Object.keys(text).sort(), ['createdAt', 'id']);
  const audio = wav();
  const voice = (await post(agent, '').attach('audio', audio, { filename: 'feedback.wav', contentType: 'audio/wav' }).expect(201)).body;
  f.read(db => {
    const rows = db.prepare('SELECT * FROM feedback_reports ORDER BY created_at,id').all(); assert.equal(rows.length, 2);
    const row = db.prepare('SELECT * FROM feedback_reports WHERE id=?').get(voice.id)!;
    assert.deepEqual(Buffer.from(row.audio as Uint8Array), audio); assert.equal(row.family_id, null);
    assert.equal(Number(row.expires_at) - Number(row.created_at), 30 * 86400000);
    assert.equal(String(row.client_hash).includes(cookie.split('=')[1]!.split(';')[0]!), false);
  });
  await agent.get('/api/feedback').expect(404);
  await agent.get(`/api/feedback/${text.id}`).expect(404);
  await agent.get(`/api/feedback/${voice.id}/audio`).expect(404);
});

test('same-origin, valid context cookie and bounded strict fields are mandatory; a stale device can report anonymously', async t => {
  const f = fixture(t); const agent = request.agent(f.app);
  await post(agent).expect(428);
  await ready(agent);
  await agent.post('/api/feedback').set('Origin', 'https://evil.invalid').field('operationId', randomUUID()).field('text', 'hello').expect(403);
  await agent.post('/api/feedback').field('operationId', randomUUID()).field('text', 'hello').expect(403);
  await agent.post('/api/feedback').set('Origin', origin).send({ text: 'hello', operationId: randomUUID() }).expect(400);
  await post(agent, '').expect(400);
  await post(agent, 'x'.repeat(2001)).expect(400);
  await post(agent, 'hello', 'bad-id').expect(400);
  await post(agent).field('logs', 'secret').expect(413);
  for (const bad of [{ ...context, token: 'no' }, { ...context, page: 'https://example.com/?secret=no' }, { ...context, appVersion: '9.9.9' }, { ...context, callState: 'user utterance' }]) {
    await post(agent, 'hello', randomUUID(), bad as typeof context).expect(400);
  }
  await request(f.app).post('/api/feedback').set('Origin', origin).set('Cookie', 'baoyan_device=expired-device').field('text', 'hello').field('operationId', randomUUID()).expect(428);
  const signedCookie = (await ready(request.agent(f.app))).headers['set-cookie'][0].split(';')[0];
  await request(f.app).post('/api/feedback').set('Origin', origin).set('Cookie', `${signedCookie}; baoyan_device=expired-device`).field('operationId', randomUUID()).field('text', '设置失败').expect(201);
});

test('WAV MIME, PCM header, size and 30 second limit are checked before any storage', async t => {
  const f = fixture(t); const agent = request.agent(f.app); await ready(agent);
  await post(agent, '').attach('audio', wav(), { filename: 'x.webm', contentType: 'audio/webm' }).expect(400);
  await post(agent, '').attach('audio', Buffer.from('not audio'), { filename: 'x.wav', contentType: 'audio/wav' }).expect(400);
  const stereo = wav(); stereo.writeUInt16LE(2, 22);
  await post(agent, '').attach('audio', stereo, { filename: 'x.wav', contentType: 'audio/wav' }).expect(400);
  await post(agent, '').attach('audio', wav(31), { filename: 'x.wav', contentType: 'audio/wav' }).expect(413);
  await post(agent, '').attach('audio', wav(30), { filename: 'x.wav', contentType: 'audio/wav' }).expect(201);
  assert.equal(f.read(db => Number(db.prepare('SELECT count(*) AS n FROM feedback_reports').get()!.n)), 1);
});

test('idempotent retries persist across restart; conflicts and other clients never expose or overwrite an existing report', async t => {
  const f = fixture(t); let agent = request.agent(f.app);
  const cookie = (await ready(agent)).headers['set-cookie'][0].split(';')[0];
  const operationId = randomUUID(); const first = (await post(agent, '第一份', operationId).expect(201)).body;
  assert.deepEqual((await post(agent, '第一份', operationId).expect(200)).body, first);
  await post(agent, 'changed', operationId).expect(409);
  const other = request.agent(f.app); await ready(other);
  const second = (await post(other, '另一位的内容', operationId).expect(201)).body;
  assert.notEqual(second.id, first.id);
  f.restart(); agent = request.agent(f.app);
  assert.deepEqual((await post(agent, '第一份', operationId).set('Cookie', cookie).expect(200)).body, first);
  assert.equal(f.read(db => Number(db.prepare('SELECT count(*) AS n FROM feedback_reports').get()!.n)), 2);
});

test('per-client and global limits persist across restart and report deletion does not reclaim submissions', async t => {
  const f = fixture(t); const agent = request.agent(f.app);
  const cookie = (await ready(agent)).headers['set-cookie'][0].split(';')[0];
  for (let i = 0; i < 10; i++) await post(agent).expect(201);
  await post(agent).expect(429);
  f.read(db => db.prepare('DELETE FROM feedback_reports').run());
  f.restart();
  await post(request.agent(f.app)).set('Cookie', cookie).expect(429);
  f.step(3600001); await post(request.agent(f.app)).set('Cookie', cookie).expect(201);
  f.read(db => {
    const row = db.prepare('SELECT client_hash,created_at FROM feedback_rate_events ORDER BY created_at DESC LIMIT 1').get()!;
    const insert = db.prepare('INSERT INTO feedback_rate_events(id,client_hash,created_at) VALUES(?,?,?)');
    for (let i = 0; i < 189; i++) insert.run(randomUUID(), `other${i}`, row.created_at);
  });
  const fresh = request.agent(f.app); await ready(fresh); await post(fresh).expect(429);
  f.step(86400001); await post(fresh).expect(201);
});

test('storage count and byte caps reject safely without dropping older reports', async t => {
  const f = fixture(t); const agent = request.agent(f.app); await ready(agent);
  const first = (await post(agent).expect(201)).body;
  f.read(db => db.prepare('UPDATE feedback_reports SET total_bytes=? WHERE id=?').run(100 * 1024 * 1024, first.id));
  const full = await post(agent).expect(503); assert.equal(full.body.code, 'FEEDBACK_STORAGE_FULL');
  f.read(db => {
    db.prepare('UPDATE feedback_reports SET total_bytes=1 WHERE id=?').run(first.id);
    const insert = db.prepare(`INSERT INTO feedback_reports SELECT ?,client_hash,?,payload_hash,family_id,text,context_json,audio,audio_bytes,total_bytes,created_at,expires_at FROM feedback_reports WHERE id=?`);
    for (let i = 0; i < 999; i++) insert.run(randomUUID(), randomUUID(), first.id);
  });
  await post(agent).expect(503);
  assert.equal(f.read(db => Number(db.prepare('SELECT count(*) AS n FROM feedback_reports').get()!.n)), 1000);
});

test('family export contains only its own submitted reports and withdrawal cascades text plus audio', async t => {
  const f = fixture(t); const a = request.agent(f.app); const b = request.agent(f.app);
  for (const agent of [a, b]) {
    await agent.post('/api/setup').set('Origin', origin).send(profile).expect(201);
    await ready(agent);
    await agent.post('/api/parent/unlock').set('Origin', origin).send({ pin: profile.pin }).expect(200);
  }
  const own = (await post(a, '家庭一').attach('audio', wav(), { filename: 'x.wav', contentType: 'audio/wav' }).expect(201)).body;
  await post(b, '家庭二').expect(201);
  const exported = (await a.get('/api/parent/export').expect(200)).body.feedbackReports;
  assert.equal(exported.length, 1); assert.equal(exported[0].id, own.id); assert.equal(exported[0].text, '家庭一');
  assert.equal(exported[0].hasAudio, true); assert.equal(exported[0].audio, undefined);
  assert.equal(Date.parse(exported[0].expiresAt) - Date.parse(exported[0].createdAt), 30 * 86400000);
  assert.equal(exported[0].client_hash, undefined);
  await a.post('/api/parent/withdraw').set('Origin', origin).send({}).expect(200);
  assert.equal(f.read(db => Number(db.prepare('SELECT count(*) AS n FROM feedback_reports').get()!.n)), 1);
  assert.equal(f.read(db => db.prepare('SELECT id FROM feedback_reports WHERE id=?').get(own.id)), undefined);
  assert.equal(f.read(db => Number(db.prepare('SELECT count(*) AS n FROM feedback_rate_events').get()!.n)), 2);
  f.step(30 * 86400000); f.app.locals.sweepExpiredState();
  assert.equal(f.read(db => Number(db.prepare('SELECT count(*) AS n FROM feedback_reports').get()!.n)), 0);
});

test('an upload that was started by a household cannot become anonymous and survive household withdrawal', { timeout: 10000 }, async t => {
  const f = fixture(t); const agent = request.agent(f.app);
  const setup = await agent.post('/api/setup').set('Origin', origin).send(profile).expect(201);
  const deviceCookie = setup.headers['set-cookie'][0].split(';')[0];
  const feedbackCookie = (await ready(agent)).headers['set-cookie'][0].split(';')[0];
  await agent.post('/api/parent/unlock').set('Origin', origin).send({ pin: profile.pin }).expect(200);
  const server = f.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  server.once('request', req => { req.once('data', entered); });
  const boundary = 'test-feedback-boundary';
  const prefix = `--${boundary}\r\nContent-Disposition: form-data; name="operationId"\r\n\r\n${randomUUID()}\r\n--${boundary}\r\nContent-Disposition: form-data; name="text"\r\n\r\n`;
  const suffix = `pending report\r\n--${boundary}--\r\n`;
  let upload!: ReturnType<typeof httpRequest>;
  const result = new Promise<{ status: number; body: any }>((resolve, reject) => {
    upload = httpRequest(`http://127.0.0.1:${address.port}/api/feedback`, {
      method: 'POST', headers: { Origin: origin, Cookie: `${deviceCookie}; ${feedbackCookie}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': Buffer.byteLength(prefix + suffix) },
    }, response => { let body = ''; response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode!, body: JSON.parse(body) })); });
    upload.on('error', reject); upload.write(prefix);
  });
  await started;
  await agent.post('/api/parent/withdraw').set('Origin', origin).send({}).expect(200);
  upload.end(suffix);
  const response = await result;
  assert.equal(response.status, 409); assert.equal(response.body.code, 'FEEDBACK_SESSION_CHANGED');
  assert.equal(f.read(db => Number(db.prepare('SELECT count(*) AS n FROM feedback_reports').get()!.n)), 0);
});

test('expired trial still accepts feedback and anonymous reports expire after 30 days', async t => {
  const f = fixture(t, { TRIAL_ENABLED: 'true', TRIAL_ENDS_AT: '2026-09-27T00:00:00Z' });
  const agent = request.agent(f.app); await ready(agent); await post(agent).expect(201);
  f.step(30 * 86400000); f.app.locals.sweepExpiredState();
  assert.equal(f.read(db => Number(db.prepare('SELECT count(*) AS n FROM feedback_reports').get()!.n)), 0);
});

test('production feedback cookie is Secure and invalid signed cookie is replaced', async t => {
  const f = fixture(t, { NODE_ENV: 'production', TRIAL_ENABLED: 'true', TRIAL_ENDS_AT: '2026-10-20T00:00:00Z', ALLOWED_ORIGINS: 'https://baoyan.fixture.testing' });
  const response = await request(f.app).get('/api/feedback/context').set('Cookie', `baoyan_feedback=${'a'.repeat(43)}.${'b'.repeat(43)}`).expect(200);
  assert.match(response.headers['set-cookie'][0], /Secure/);
  await request(f.app).post('/api/feedback').set('Origin', 'https://baoyan.fixture.testing').set('Cookie', `baoyan_feedback=${'a'.repeat(43)}.${'b'.repeat(43)}`).field('operationId', randomUUID()).field('text', 'hello').expect(428);
});

test('operator CLI lists only metadata and exports private WAV/JSON without overwriting or leaking content to stdout', async t => {
  const f = fixture(t); const agent = request.agent(f.app); await ready(agent);
  const secret = '主动提交的私密反馈正文';
  const result = (await post(agent, secret).attach('audio', wav(), { filename: 'x.wav', contentType: 'audio/wav' }).expect(201)).body;
  const cli = resolve('ops/feedback-reports.ts');
  const run = (...args: string[]) => execFileSync(process.execPath, ['--import', 'tsx', cli, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const listing = run('list', '--db', f.path); assert.equal(listing.includes(secret), false); assert.equal(JSON.parse(listing).reports[0].id, result.id);
  const out = join(f.directory, 'private');
  const exported = run('export', '--db', f.path, '--id', result.id, '--out', out); assert.equal(exported.includes(secret), false);
  const jsonPath = join(out, `${result.id}.json`); const audioPath = join(out, `${result.id}.wav`);
  assert.equal(JSON.parse(readFileSync(jsonPath, 'utf8')).text, secret); assert.deepEqual(readFileSync(audioPath), wav());
  assert.equal(statSync(jsonPath).mode & 0o777, 0o600); assert.equal(statSync(audioPath).mode & 0o777, 0o600); assert.equal(statSync(out).mode & 0o777, 0o700);
  assert.throws(() => run('export', '--db', f.path, '--id', result.id, '--out', out));
  assert.equal(JSON.parse(readFileSync(jsonPath, 'utf8')).text, secret);
  const unsafe = join(f.directory, 'unsafe'); mkdirSync(unsafe, { mode: 0o755 });
  assert.throws(() => run('export', '--db', f.path, '--id', result.id, '--out', unsafe));
  const absent = join(f.directory, 'missing.sqlite');
  const failed = spawnSync(process.execPath, ['--import', 'tsx', cli, 'list', '--db', absent], { encoding: 'utf8' });
  assert.equal(failed.status, 1); assert.equal(existsSync(absent), false);
  assert.throws(() => run('list', '--db', 'relative.sqlite'));
  assert.equal(JSON.parse(run('delete', '--db', f.path, '--id', result.id)).deleted, true);
  assert.equal(JSON.parse(run('list', '--db', f.path)).reports.length, 0);
  assert.equal(f.read(db => Number(db.prepare('SELECT count(*) AS n FROM feedback_rate_events').get()!.n)), 1);
});

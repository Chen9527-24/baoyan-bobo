import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, scryptSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import request from 'supertest';
import { createApp, type AppOptions } from '../apps/server/src/app.js';
import { DEBUG_ROOM_LIMITS } from '../apps/server/src/debug-room.js';

const origin = 'http://localhost:5173';
const syntheticPass = 'fictional-room-pass';
const salt = Buffer.alloc(16, 7);
const syntheticHash = `${salt.toString('hex')}:${scryptSync(syntheticPass, salt, 64).toString('hex')}`;
const start = Date.parse('2026-10-12T01:00:00Z');
const base = { DEBUG_PASSWORD_HASH: syntheticHash, CHAT_PROVIDER: 'volc', CHAT_API_BASE_URL: 'https://synthetic.invalid/v3', CHAT_API_KEY: 'synthetic-only', CHAT_MODEL: 'synthetic-seed',
  ASR_PROVIDER: 'openai', ASR_API_BASE_URL: 'https://synthetic.invalid/v1', ASR_API_KEY: 'synthetic-only', ASR_MODEL: 'synthetic-asr',
  TTS_PROVIDER: 'openai', TTS_API_BASE_URL: 'https://synthetic.invalid/v1', TTS_API_KEY: 'synthetic-only', TTS_MODEL: 'synthetic-tts',
  TRIAL_ENABLED: 'true', TRIAL_REQUIRE_INVITE: 'false', TRIAL_ENDS_AT: '2026-10-26T12:54:09Z' };
const answer = (reply = '搭了那么久又倒了，确实有点扫兴呀。') => Response.json({ choices: [{ finish_reason: 'stop', message: { content: reply } }] });
function fixture(t: TestContext, extra: AppOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bobo-debug-')); const dataPath = join(dir, 'ordinary.sqlite'); let clock = start;
  const calls: { url: string; body: unknown }[] = [];
  const fetcher = extra.fetch ?? (async (url, init) => {
    calls.push({ url: String(url), body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body });
    if (String(url).endsWith('/audio/transcriptions')) return Response.json({ text: '虚构的积木倒了' });
    if (String(url).endsWith('/audio/speech')) return new Response(Uint8Array.from([1, 2, 3, 4]), { headers: { 'Content-Type': 'audio/mpeg' } });
    return answer();
  }) as typeof fetch;
  const settings = { ...extra, dataPath, env: { ...base, ...extra.env }, fetch: fetcher, now: () => clock };
  let app = createApp(settings), closed = false;
  t.after(() => { if (!closed) app.locals.close(); rmSync(dir, { force: true, recursive: true }); });
  const read = <T>(file: string, fn: (db: DatabaseSync) => T) => { const db = new DatabaseSync(join(dir, file)); try { return fn(db); } finally { db.close(); } };
  return { get app() { return app; }, calls, dir, read, setTime(value: number) { clock = value; app.locals.sweepExpiredState(); },
    restart() { app.locals.close(); app = createApp(settings); closed = false; },
  };
}
type Agent = ReturnType<typeof request.agent>;
const post = (agent: Agent, path: string, body: unknown = {}) => agent.post(`/api/debug${path}`).set('Origin', origin).send(body);
async function enter(f: ReturnType<typeof fixture>) { const agent = request.agent(f.app); const result = await post(agent, '/unlock', { password: syntheticPass }).expect(200); return { agent, status: result.body, cookie: result.headers['set-cookie'][0].split(';')[0] as string }; }
const turn = (agent: Agent, text = '积木又倒了。', operationId = randomUUID(), ageGroup = '6-8') => post(agent, '/turn', { operationId, text, ageGroup });
const adjustment = (agent: Agent, child: string, body: Record<string, unknown> = {}) => agent.post('/api/debug/reply-adjustment/generate').set('Origin', origin).set('X-Baoyan-Child', child).send({ operationId: randomUUID(), ageGroup: '6-8', question: '虚构的积木倒了。', actualReply: '不要放弃。', guideline: '先接住失落，少说教。', fictionalConfirmed: true, ...body });

test('debug is independently gated and never grants ordinary device or parent access', async t => {
  const f = fixture(t); const anonymous = request.agent(f.app);
  const initial = (await anonymous.get('/api/debug/status').expect(200)).body;
  assert.equal(initial.enabled, true); assert.equal(initial.authorized, false);
  await turn(anonymous).expect(401);
  await anonymous.get('/api/debug/calibration/cases').expect(401);
  await request(f.app).get('/api/debug/status').set('Cookie', `baoyan_debug=${'x'.repeat(43)}`).expect(401);
  await anonymous.post('/api/debug/unlock').send({ password: syntheticPass }).expect(403);
  const user = await enter(f);
  assert.equal(user.status.ttlMs, 30 * 60_000); assert.equal(user.status.mode, 'chat');
  assert.equal((await user.agent.get('/api/bootstrap').expect(200)).body.configured, false);
  await user.agent.get('/api/parent/calibration/cases').expect(401);
  await user.agent.post('/api/calls').set('Origin', origin).send({ operationId: randomUUID() }).expect(401);
  await turn(user.agent, '积木倒了。').send({ familyId: randomUUID() }).expect(400);
  assert.equal(f.read('ordinary.sqlite', db => (db.prepare('SELECT count(*) AS n FROM families').get() as {n:number}).n), 0);
  const cookies = (await post(user.agent, '/unlock', { password: syntheticPass }).expect(200)).headers['set-cookie'];
  assert.equal(cookies.length, 1); assert.match(cookies[0], /HttpOnly/); assert.match(cookies[0], /SameSite=Strict/); assert.match(cookies[0], /Path=\/api\/debug/);
});

test('password failures are rate limited and disabled/malformed configuration has no fallback password', async t => {
  const f = fixture(t); const agent = request.agent(f.app);
  for (let i = 0; i < DEBUG_ROOM_LIMITS.attempts; i++) await post(agent, '/unlock', { password: 'wrong-fictional-pass' }).expect(403);
  await post(agent, '/unlock', { password: syntheticPass }).expect(429);
  f.setTime(start + 60_001); await post(agent, '/unlock', { password: syntheticPass }).expect(200);
  const off = fixture(t, { env: { DEBUG_PASSWORD_HASH: '' } });
  assert.equal((await request(off.app).get('/api/debug/status').expect(200)).body.enabled, false);
  await request(off.app).post('/api/debug/unlock').set('Origin', origin).send({ password: syntheticPass }).expect(503);
  assert.throws(() => createApp({ dataPath: ':memory:', env: { DEBUG_PASSWORD_HASH: 'invalid' } }), /格式无效/);
});

test('sessions have private four-round history, correct provenance, age reset and replay without another model call', async t => {
  const f = fixture(t); const one = await enter(f), two = await enter(f); const op = randomUUID();
  const first = (await turn(one.agent, '虚构的绿城堡倒了', op).expect(200)).body;
  assert.equal(first.question, '虚构的绿城堡倒了'); assert.equal(first.model, 'synthetic-seed'); assert.ok(first.personaVersion); assert.deepEqual(first.testHistory, []);
  assert.deepEqual((await turn(one.agent, '虚构的绿城堡倒了', op).expect(200)).body, first); assert.equal(f.calls.length, 1);
  await turn(one.agent, '更改内容', op).expect(409);
  const independent = (await turn(two.agent, '今天是新的虚构测试').expect(200)).body; assert.deepEqual(independent.testHistory, []);
  assert.ok(!JSON.stringify(f.calls.at(-1)).includes('绿城堡'));
  for (let i = 0; i < 5; i++) await turn(one.agent, `虚构连续聊天第${i}轮`).expect(200);
  const later = (await turn(one.agent, '检查有限前文').expect(200)).body;
  assert.equal(later.testHistory.length, 8); assert.ok(!JSON.stringify(later.testHistory).includes('绿城堡'));
  const older = (await turn(one.agent, '换一个模拟年龄', randomUUID(), '9-12').expect(200)).body; assert.deepEqual(older.testHistory, []);
  const debugTables = f.read('debug.sqlite', db => db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  assert.deepEqual(debugTables.sort(), ['calibration_cases', 'calibration_operations', 'families', 'reply_adjustment_operations', 'scene_adoption_directions', 'scene_adoption_operations', 'scene_adoption_reports', 'scene_adoption_retests', 'scene_adoption_states'].sort());
  assert.ok(!readFileSync(join(f.dir, 'debug.sqlite')).includes(Buffer.from('绿城堡')));
});

test('audio and blob speech share the same provider gate and reject foreign/stale reply ids', async t => {
  const f = fixture(t); const one = await enter(f), two = await enter(f);
  const value = (await one.agent.post('/api/debug/turn').set('Origin', origin).field('operationId', randomUUID()).field('ageGroup', '6-8').attach('audio', Buffer.from('fictional-audio'), { filename: 'fictional.webm', contentType: 'audio/webm' }).expect(200)).body;
  assert.equal(value.question, '虚构的积木倒了'); assert.equal(f.calls.length, 2);
  await post(two.agent, `/speech/${value.replyId}`, { replyId: value.replyId }).expect(409);
  await post(one.agent, `/speech/${value.replyId}`, { replyId: randomUUID() }).expect(400);
  const audio = await one.agent.post(`/api/debug/speech/${value.replyId}`).set('Origin', origin).set('Accept', 'audio/*').send({ replyId: value.replyId }).expect(200);
  assert.match(audio.headers['content-type'], /audio\/mpeg/); assert.equal(f.calls.length, 3);
  const count = f.read('ordinary.sqlite', db => (db.prepare('SELECT calls FROM trial_provider_usage').get() as { calls: number }).calls); assert.equal(count, 3);
  await turn(one.agent, '下一轮虚构问题').expect(200); await post(one.agent, `/speech/${value.replyId}`).expect(409);
});

test('cancel before arrival tombstones an operation and logout cancels a delayed provider without late history', async t => {
  let began!: () => void, release!: (value: Response) => void; const started = new Promise<void>(done => { began = done; });
  const f = fixture(t, { fetch: (async () => { began(); return new Promise<Response>(done => { release = done; }); }) as typeof fetch });
  const user = await enter(f), op = randomUUID(); await post(user.agent, '/cancel', { operationId: op }).expect(200);
  await turn(user.agent, '已取消的虚构问题', op).expect(499);
  const pending = turn(user.agent, '退出前虚构问题').then(result => result);
  await started; await post(user.agent, '/lock').expect(200);
  assert.equal((await pending).status, 401); release(answer('不能迟到显示'));
  await user.agent.get('/api/debug/status').expect(200).then(result => assert.equal(result.body.authorized, false));
  const next = await enter(f); assert.equal(next.status.authorized, true);
});

test('session expiry revokes pending calibration and old cookie without deleting saved project scenes', async t => {
  const f = fixture(t); const one = await enter(f), two = await enter(f);
  const generated = (await adjustment(one.agent, one.status.scopeChildId).expect(200)).body;
  await two.agent.post('/api/debug/reply-adjustment/confirm').set('Origin', origin).set('X-Baoyan-Child', one.status.scopeChildId).send({ operationId: randomUUID(), runId: generated.id, satisfied: true, fictionalConfirmed: true }).expect(403);
  const confirmation = { operationId: randomUUID(), runId: generated.id, satisfied: true, fictionalConfirmed: true, title: '虚构积木失落' };
  const saved = await one.agent.post('/api/debug/reply-adjustment/confirm').set('Origin', origin).set('X-Baoyan-Child', one.status.scopeChildId).send(confirmation).expect(201);
  assert.equal(saved.body.status, 'accepted'); assert.equal(saved.body.rewrite.provenance, 'server-generated');
  const libraryState = (await one.agent.get('/api/debug/calibration/cases').expect(200)).body;
  assert.equal(libraryState.workflow.scope, 'debug'); assert.equal(libraryState.workflow.formalModel, generated.model);
  assert.equal(libraryState.workflow.formalPersonaVersion, generated.personaVersion);
  assert.equal(libraryState.workflow.applicationMode, 'reference-only'); assert.equal(libraryState.workflow.automaticApplication, false);
  f.setTime(start + DEBUG_ROOM_LIMITS.ttlMs + 1);
  await request(f.app).get('/api/debug/status').set('Cookie', one.cookie).expect(401);
  f.restart(); const fresh = await enter(f);
  const exported = (await fresh.agent.get('/api/debug/calibration/export').expect(200)).body;
  assert.equal(exported.schemaVersion, 'baoyan-calibration-v1'); assert.equal(exported.cases.length, 1); assert.equal(exported.cases[0].id, saved.body.id);
  assert.equal(f.read('ordinary.sqlite', db => (db.prepare('SELECT count(*) AS n FROM calibration_cases').get() as {n:number}).n), 0);
});

test('debug input and replies use existing safety and bounded presence policy without writing ordinary memory', async t => {
  const f = fixture(t, { fetch: (async () => answer('我永远陪着你。')) as typeof fetch }); const user = await enter(f);
  const bounded = (await turn(user.agent, '我只跟你聊，你能永远陪我吗？').expect(200)).body;
  assert.ok(!bounded.reply.includes('我永远陪着你')); assert.match(bounded.reply, /不能保证永远在线/);
  const privateValue = (await turn(user.agent, '我的密码是fictional-secret').expect(200)).body; assert.match(privateValue.reply, /私人信息/);
  const danger = (await turn(user.agent, '我想伤害自己').expect(200)).body; assert.match(danger.reply, /可信任的大人/); assert.equal(danger.emotion, 'calm');
  assert.equal(f.read('ordinary.sqlite', db => (db.prepare('SELECT count(*) AS n FROM memories').get() as {n:number}).n), 0);
});

test('debug uses the existing global supplier quota and original trial deadline', async t => {
  const f = fixture(t, { env: { TRIAL_DAILY_PROVIDER_CALLS: '1' } }); const user = await enter(f);
  await turn(user.agent).expect(200);
  const denied = await turn(user.agent, '超出额度的虚构问题').expect(429); assert.equal(denied.body.code, 'TRIAL_DAILY_LIMIT'); assert.equal(f.calls.length, 1);
  f.setTime(Date.parse(base.TRIAL_ENDS_AT));
  assert.equal((await turn((await enter(f)).agent).expect(410)).body.code, 'TRIAL_EXPIRED');
  const regularTables = f.read('ordinary.sqlite', db => db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  assert.ok(!regularTables.some(name => String(name).startsWith('debug_')));
});

test('existing household and debug authorization coexist without leaking household memory into prompts', async t => {
  const f = fixture(t); const agent = request.agent(f.app);
  await agent.post('/api/setup').set('Origin', origin).send({ pin: '234567', nickname: '虚构家庭', ageGroup: '6-8', sessionMinutes: 10, dailyMinutes: 20, consent: true }).expect(201);
  f.read('ordinary.sqlite', db => { const family = db.prepare('SELECT id FROM families').get() as {id:string}; db.prepare('INSERT INTO memories VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), family.id, 'private.synthetic', '这是一条只属原家庭的虚构资料', 'event', 1, start + 86400000, 'explicit'); });
  const before = (await agent.get('/api/bootstrap').expect(200)).body;
  await post(agent, '/unlock', { password: syntheticPass }).expect(200); await turn(agent).expect(200);
  assert.ok(!JSON.stringify(f.calls).includes('只属原家庭')); assert.ok(!JSON.stringify(f.calls).includes('虚构家庭'));
  await agent.get('/api/parent/memories').expect(403);
  await post(agent, '/lock').expect(200);
  const after = (await agent.get('/api/bootstrap').expect(200)).body;
  assert.equal(after.child.id, before.child.id); assert.equal(after.memoryCount, 1); assert.equal(after.parentAuthorized, false);
});

test('PCM speech uses the original format/audio/done protocol and bounded expression', async t => {
  let sent: any;
  const streamEnv = { TTS_PROVIDER: 'volc', VOLC_SPEECH_API_KEY: 'synthetic-only', VOLC_TTS_URL: 'https://synthetic.invalid/api/v3/tts/unidirectional/sse', VOLC_TTS_VOICE_ID: 'synthetic_voice', VOLC_TTS_RESOURCE_ID: 'seed-tts-2.0' };
  const f = fixture(t, { env: streamEnv, fetch: (async (url, init) => {
    if (String(url).includes('/tts/')) { sent = JSON.parse(String(init?.body)); return new Response(`event: 352\ndata: ${JSON.stringify({code:0,data:Buffer.from([1,2,3,4]).toString('base64')})}\n\nevent: 152\ndata: ${JSON.stringify({code:20000000,data:null})}\n\n`, {headers:{'content-type':'text/event-stream'}}); }
    return answer();
  }) as typeof fetch });
  const user = await enter(f); assert.equal(user.status.capabilities.ttsStreaming, true);
  const result = (await turn(user.agent, '我有点伤心，积木又倒了。').expect(200)).body;
  const speech = await user.agent.post(`/api/debug/speech/${result.replyId}`).set('Origin', origin).set('Accept', 'application/x-ndjson').send({replyId:result.replyId}).expect(200);
  const frames = speech.text.trim().split('\n').map((line:string)=>JSON.parse(line));
  assert.deepEqual(frames.map((frame:any)=>frame.type), ['format','audio','done']); assert.equal(frames[0].sampleRate,24000); assert.equal(frames[1].data,Buffer.from([1,2,3,4]).toString('base64'));
  assert.ok(JSON.stringify(sent).includes('柔和'));
});

test('only the owning live adjustment can be spoken and cancelling it aborts pending TTS', async t => {
  let began!:()=>void, release!:(value:Response)=>void;
  const started = new Promise<void>(done=>{began=done;});
  const f=fixture(t,{fetch:(async(url)=>{if(String(url).endsWith('/audio/speech')){began();return new Promise<Response>(done=>{release=done;});}return answer();}) as typeof fetch});
  const owner=await enter(f),other=await enter(f);
  const run=(await adjustment(owner.agent,owner.status.scopeChildId).expect(200)).body;
  await post(other.agent,`/speech/${run.id}`,{replyId:run.id}).expect(403);
  const speaking=post(owner.agent,`/speech/${run.id}`,{replyId:run.id}).then(value=>value);
  await started;
  await owner.agent.post(`/api/debug/reply-adjustment/generate/${run.operationId}/cancel`).set('Origin',origin).set('X-Baoyan-Child',owner.status.scopeChildId).send({}).expect(200);
  assert.equal((await speaking).status,499); release(new Response(Uint8Array.from([1,2,3,4]),{headers:{'content-type':'audio/mpeg'}}));
  await post(owner.agent,`/speech/${run.id}`,{replyId:run.id}).expect(409);
});

test('late cancellation of a previous turn cannot invalidate a newer answer or its speech', async t => {
  const f=fixture(t), user=await enter(f), previous=randomUUID();
  await turn(user.agent,'第一轮虚构问题',previous).expect(200);
  const next=(await turn(user.agent,'第二轮虚构问题').expect(200)).body;
  await post(user.agent,'/cancel',{operationId:previous}).expect(200);
  await post(user.agent,`/speech/${next.replyId}`,{replyId:next.replyId}).expect(200);
  await turn(user.agent,'第一轮虚构问题',previous).expect(499);
});

test('debug plans share the main reply contract and speak only registered segment text and delivery', async t => {
  const segments = [{ text: '剪了一下午却压扁了，真扫兴。', expression: 'gentle' }, { text: '不想重做，就先不重做。', expression: 'natural' }];
  const sent: Record<string, unknown>[] = [];
  const f = fixture(t, { fetch: (async (url, init) => {
    const body = JSON.parse(String(init?.body)); sent.push(body);
    if (String(url).endsWith('/audio/speech')) return new Response(Uint8Array.from([1, 2, 3, 4]), { headers: { 'Content-Type': 'audio/mpeg' } });
    return answer(JSON.stringify({ action: 'reply', segments }));
  }) as typeof fetch });
  const owner = await enter(f), other = await enter(f);
  const value = (await turn(owner.agent, '纸花压扁了，不想重新剪。').expect(200)).body;
  assert.deepEqual(value.replySegments, segments); assert.equal(value.reply, segments.map(segment => segment.text).join('\n\n'));
  assert.equal(value.replyPlanVersion, '4'); assert.equal(value.replyPlanAction, 'reply'); assert.equal(value.emotion, 'calm');
  assert.equal(sent.length, 1); assert.match(JSON.stringify(sent[0]), /接话计划/);
  await post(other.agent, `/speech/${value.replyId}`, { replyId: value.replyId, segmentIndex: 0 }).expect(409);
  await post(owner.agent, `/speech/${value.replyId}`, { replyId: value.replyId, segmentIndex: 0, text: '任意其他正文' }).expect(400);
  await post(owner.agent, `/speech/${value.replyId}`, { replyId: value.replyId, segmentIndex: 0, expression: 'bright' }).expect(400);
  for (const segmentIndex of [-1, 3, 0.5, '0']) await post(owner.agent, `/speech/${value.replyId}`, { replyId: value.replyId, segmentIndex }).expect(400);
  await post(owner.agent, `/speech/${value.replyId}`, { replyId: value.replyId, segmentIndex: 2 }).expect(409);
  assert.equal(sent.length, 1, 'invalid or foreign segment requests must not spend supplier calls');
  await post(owner.agent, `/speech/${value.replyId}`, { replyId: value.replyId, segmentIndex: 0 }).expect(200);
  assert.equal(sent.at(-1)!.input, segments[0].text);
  await post(owner.agent, `/speech/${value.replyId}`, { replyId: value.replyId, segmentIndex: 1 }).expect(200);
  assert.equal(sent.at(-1)!.input, segments[1].text);
  await post(owner.agent, `/speech/${value.replyId}`, { replyId: value.replyId }).expect(200);
  assert.equal(sent.at(-1)!.input, value.reply, 'a legacy full reply remains available without a client-supplied plan');
  await turn(owner.agent, '新的虚构分享').expect(200);
  const before = sent.length;
  await post(owner.agent, `/speech/${value.replyId}`, { replyId: value.replyId, segmentIndex: 1 }).expect(409);
  assert.equal(sent.length, before, 'a stale plan must not speak its later segment');
});

test('malformed plan data is never registered, spoken or added to debug history', async t => {
  let count = 0;
  const f = fixture(t, { fetch: (async () => answer(++count === 1
    ? '{"action":"reply","segments":[{"text":"不可朗读的计划","expression":"arbitrary-voice"}]}'
    : '{"action":"reply","segments":[{"text":"这次重新接话。","expression":"natural"}]}')) as typeof fetch });
  const user = await enter(f);
  const invalid = await turn(user.agent, '第一条虚构问题').expect(502);
  assert.equal(invalid.body.code, 'PROVIDER_PLAN_INVALID'); assert.equal(invalid.body.replyId, undefined);
  const valid = (await turn(user.agent, '第二条虚构问题').expect(200)).body;
  assert.deepEqual(valid.testHistory, []); assert.equal(valid.reply, '这次重新接话。');
});

test('source and safety overrides rebuild segments instead of replaying stale model content or expression', async t => {
  const f = fixture(t, { fetch: (async () => answer(JSON.stringify({ action: 'reply', segments: [{ text: '我永远陪着你。', expression: 'bright' }] }))) as typeof fetch });
  const user = await enter(f);
  const value = (await turn(user.agent, '我只跟你聊，你能永远陪我吗？').expect(200)).body;
  assert.match(value.reply, /不能保证永远在线/);
  assert.equal(value.replySegments.map((part: {text:string}) => part.text).join('\n\n'), value.reply);
  assert.ok(!JSON.stringify(value.replySegments).includes('我永远陪着你'));
  assert.notEqual(value.replySegments[0].expression, 'bright');
  const danger = (await turn(user.agent, '我想伤害自己').expect(200)).body;
  assert.equal(danger.replySegments.map((part: {text:string}) => part.text).join('\n\n'), danger.reply);
  assert.ok(danger.replySegments.every((part: {expression:string}) => part.expression === 'gentle'));
  assert.match(danger.reply, /可信任的大人/);
});

test('segment speech preserves bounded TTS direction and adjustment previews stay whole without a fabricated plan', async t => {
  const segments = [{ text: '这件事真让人扫兴。', expression: 'gentle' }, { text: '现在不用急着解决。', expression: 'natural' }];
  const sent: any[] = [];
  const f = fixture(t, { env: { TTS_PROVIDER: 'volc', VOLC_SPEECH_API_KEY: 'synthetic-only', VOLC_TTS_URL: 'https://synthetic.invalid/api/v3/tts/unidirectional/sse', VOLC_TTS_VOICE_ID: 'synthetic_voice', VOLC_TTS_RESOURCE_ID: 'seed-tts-2.0' }, fetch: (async (url, init) => {
    if (String(url).includes('/tts/')) { sent.push(JSON.parse(String(init?.body))); return new Response(`event: 352\ndata: ${JSON.stringify({code:0,data:Buffer.from([1,2,3,4]).toString('base64')})}\n\nevent: 152\ndata: ${JSON.stringify({code:20000000,data:null})}\n\n`, {headers:{'content-type':'text/event-stream'}}); }
    const content = JSON.parse(String(init?.body)).messages.some((message: {content:string}) => message.content.includes('接话计划')) ? JSON.stringify({ action: 'reply', segments }) : '先听你说，不急着给办法。';
    return answer(content);
  }) as typeof fetch });
  const user = await enter(f);
  const value = (await turn(user.agent, '我不想听建议。').expect(200)).body;
  await post(user.agent, `/speech/${value.replyId}`, { replyId: value.replyId, segmentIndex: 0 }).set('Accept', 'application/x-ndjson').expect(200);
  assert.equal(sent.at(-1).req_params.text, segments[0].text); assert.match(JSON.stringify(sent.at(-1)), /柔和/);
  await post(user.agent, `/speech/${value.replyId}`, { replyId: value.replyId, segmentIndex: 1 }).set('Accept', 'application/x-ndjson').expect(200);
  assert.equal(sent.at(-1).req_params.text, segments[1].text); assert.match(JSON.stringify(sent.at(-1)), /友善、自然/);
  const run = (await adjustment(user.agent, user.status.scopeChildId).expect(200)).body;
  const before = sent.length;
  await post(user.agent, `/speech/${run.id}`, { replyId: run.id, segmentIndex: 0 }).expect(409);
  assert.equal(sent.length, before);
  await post(user.agent, `/speech/${run.id}`, { replyId: run.id }).set('Accept', 'application/x-ndjson').expect(200);
  assert.equal(sent.at(-1).req_params.text, run.reply);
});

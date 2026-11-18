import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp, type AppOptions } from '../apps/server/src/app.js';
const origin = 'http://localhost:5173';
const profile = { pin: '123456', nickname: '小满', ageGroup: '6-8', sessionMinutes: 10, dailyMinutes: 30, consent: true };
function harness(t: TestContext, options: AppOptions = {}) { const app = createApp({ dataPath: ':memory:', env: {}, ...options }); t.after(() => app.locals.close()); return { app, agent: request.agent(app) }; }
async function setup(agent: any, extra = {}) {
    const result=await agent.post('/api/setup').set('Origin', origin).send({...profile,...extra}).expect(201);
    await unlock(agent);
    await agent.patch('/api/parent/settings').set('Origin',origin).send({memoryEnabled:true}).expect(200);
    await lock(agent);
    return result;
}
async function unlock(agent: any) { return agent.post('/api/parent/unlock').set('Origin', origin).send({ pin: profile.pin }).expect(200); }
async function lock(agent: any) { return agent.post('/api/parent/lock').set('Origin', origin).send({}).expect(200); }
async function call(agent: any, op: string = crypto.randomUUID()) { return (await agent.post('/api/calls').set('Origin', origin).send({ operationId: op }).expect(201)).body; }
function turn(agent: any, id: string, text: string, extra = {}) { return agent.post(`/api/calls/${id}/turn`).set('Origin', origin).send({ text, operationId: crypto.randomUUID(), ...extra }); }
async function remember(agent: any, id: string, text = '帮我记住小屋叫星星屋') { const candidate = (await turn(agent, id, text).expect(200)).body.candidate; assert.ok(candidate); return (await agent.post(`/api/calls/${id}/memory/confirm`).set('Origin', origin).send({ candidateId: candidate.id, operationId: crypto.randomUUID() }).expect(200)).body.memory; }
test('anonymous bootstrap never inherits a family; private data and ids are isolated across device families', async (t) => {
    const { app, agent: a } = harness(t);
    const b = request.agent(app);
    await setup(a);
    const c = await call(a);
    const memory = await remember(a, c.id);
    await unlock(a);
    const member = (await a.post('/api/parent/members').set('Origin', origin).send({ name: '妈妈', relation: '妈妈', consent: true }).expect(201)).body;
    const anonymous = (await request(app).get('/api/bootstrap').expect(200)).body;
    assert.equal(anonymous.configured, false);
    assert.equal(anonymous.child, null);
    assert.equal(anonymous.memoryCount, 0);
    await setup(b, { nickname: '另一位' });
    const boot = (await b.get('/api/bootstrap')).body;
    assert.equal(boot.child.nickname, '另一位');
    assert.equal(boot.memoryCount, 0);
    await b.get('/api/parent/memories').expect(403);
    await unlock(b);
    assert.deepEqual((await b.get('/api/parent/memories')).body.items, []);
    assert.deepEqual((await b.get('/api/parent/members')).body.items, []);
    await b.patch(`/api/parent/memories/${memory.id}`).set('Origin', origin).send({ content: '我喜欢画画' }).expect(404);
    await b.delete(`/api/parent/memories/${memory.id}`).set('Origin', origin).expect(404);
    await b.delete(`/api/parent/members/${member.id}`).set('Origin', origin).expect(404);
    await b.post(`/api/calls/${c.id}/end`).set('Origin', origin).send({}).expect(404);
    assert.equal((await a.get('/api/parent/memories')).body.items.length, 1);
});
test('strict Origin, PIN gate, rate limit, short authorization and protected preference fields', async (t) => {
    let time = Date.UTC(2026, 8, 27);
    const { agent } = harness(t, { now: () => time });
    await agent.post('/api/setup').send(profile).expect(403);
    await agent.post('/api/setup').set('Origin', 'https://attacker.example').send(profile).expect(403);
    const result = await setup(agent);
    assert.ok(result.headers['set-cookie'][0].includes('HttpOnly'));
    assert.ok(result.headers['set-cookie'][0].includes('SameSite=Strict'));
    await agent.patch('/api/preferences').set('Origin', origin).send({ dailyMinutes: 180 }).expect(400);
    for (let i = 0; i < 5; i++)
        await agent.post('/api/parent/unlock').set('Origin', origin).send({ pin: '000000' }).expect(403);
    await agent.post('/api/parent/unlock').set('Origin', origin).send({ pin: profile.pin }).expect(429);
    time += 15 * 60000 + 1;
    await unlock(agent);
    await agent.get('/api/parent/members').expect(200);
    time += 10 * 60000 + 1;
    await agent.get('/api/parent/members').expect(403);
});
test('only explicit requests create candidates; save is atomic and repeated confirmation is idempotent', async (t) => {
    const { agent } = harness(t);
    await setup(agent);
    const c = await call(agent);
    const casual = (await turn(agent, c.id, '我喜欢蓝色').expect(200)).body;
    assert.equal(casual.candidate, undefined);
    const reply = (await turn(agent, c.id, '帮我记住我喜欢蓝色').expect(200)).body;
    assert.match(reply.reply, /还没有保存/);
    const payload = { candidateId: reply.candidate.id, operationId: 'confirm-same' };
    const results = await Promise.all([agent.post(`/api/calls/${c.id}/memory/confirm`).set('Origin', origin).send(payload), agent.post(`/api/calls/${c.id}/memory/confirm`).set('Origin', origin).send(payload)]);
    assert.deepEqual(results.map(r => r.status), [200, 200]);
    assert.equal(results[0].body.saved, true);
    assert.equal(results[1].body.saved, true);
    await agent.post(`/api/calls/${c.id}/memory/confirm`).set('Origin', origin).send({ ...payload, operationId: 'confirm-other' }).expect(409);
    await unlock(agent);
    const items = (await agent.get('/api/parent/memories')).body.items;
    assert.equal(items.length, 1);
    assert.equal(items[0].content, '我喜欢蓝色');
    assert.equal(new Date(items[0].expiresAt).getTime() > Date.now(), true);
});
test('personal key overrides global; deleting it invalidates the old call and restores the global value', async (t) => {
    const { agent } = harness(t);
    await setup(agent);
    const c = await call(agent);
    const memory = await remember(agent, c.id);
    const answer = (await turn(agent, c.id, '我们的小屋叫什么').expect(200)).body;
    assert.match(answer.reply, /星星屋/);
    assert.doesNotMatch(answer.reply, /云朵小屋/);
    const originalGlobal = (await agent.get('/api/bootstrap')).body.globalMemories.find((m: any) => m.key === 'world.home.name');
    assert.match(originalGlobal.content, /云朵小屋/);
    await unlock(agent);
    await agent.delete(`/api/parent/memories/${memory.id}`).set('Origin', origin).expect(200);
    await agent.post(`/api/calls/${c.id}/speech`).set('Origin', origin).send({ replyId: answer.replyId }).expect(410);
    await lock(agent);
    const next = await call(agent);
    const fresh = (await turn(agent, next.id, '小屋叫什么').expect(200)).body;
    assert.match(fresh.reply, /云朵小屋/);
    assert.ok(fresh.memoryRevision > answer.memoryRevision);
});
test('memory off retains stored entries but prevents retrieval and new candidates; expired entries are purged', async (t) => {
    let time = Date.UTC(2026, 8, 27);
    const { agent } = harness(t, { now: () => time });
    await setup(agent);
    const c = await call(agent);
    await remember(agent, c.id);
    await unlock(agent);
    await agent.patch('/api/parent/settings').set('Origin', origin).send({ memoryEnabled: false }).expect(200);
    assert.equal((await agent.get('/api/parent/memories')).body.items.length, 1);
    await lock(agent);
    const c2 = await call(agent);
    assert.match((await turn(agent, c2.id, '小屋叫什么').expect(200)).body.reply, /云朵小屋/);
    assert.equal((await turn(agent, c2.id, '帮我记住我喜欢小猫').expect(200)).body.candidate, undefined);
    time += 31 * 86400000;
    await unlock(agent);
    assert.deepEqual((await agent.get('/api/parent/memories')).body.items, []);
});
test('simulated adults cannot confirm child memory or gain parent rights; unknown identity persists until retry', async (t) => {
    const { agent } = harness(t);
    await setup(agent);
    await unlock(agent);
    await agent.patch('/api/parent/settings').set('Origin', origin).send({ voiceEnabled: true }).expect(200);
    const mom = (await agent.post('/api/parent/members').set('Origin', origin).send({ name: '妈妈', relation: '妈妈', consent: true }).expect(201)).body;
    await agent.post(`/api/parent/members/${mom.id}/enroll`).set('Origin', origin).send({ demo: false, consent: true }).expect(503);
    const enrolled = (await agent.post(`/api/parent/members/${mom.id}/enroll`).set('Origin', origin).send({ demo: true, consent: true }).expect(200)).body;
    assert.equal(enrolled.status, 'demo');
    await lock(agent);
    const c = await call(agent);
    const candidate = (await turn(agent, c.id, '帮我记住我喜欢猫', { demoSpeaker: 'child' }).expect(200)).body.candidate;
    const adult = (await turn(agent, c.id, '你好', { demoSpeaker: mom.id }).expect(200)).body;
    assert.match(adult.reply, /模拟识人/);
    await agent.post(`/api/calls/${c.id}/memory/confirm`).set('Origin', origin).send({ candidateId: candidate.id, operationId: 'adult-confirm' }).expect(409);
    assert.equal((await turn(agent, c.id, '帮我记住我喜欢猫', { demoSpeaker: mom.id }).expect(200)).body.candidate, undefined);
    await agent.get('/api/parent/memories').expect(403);
    await turn(agent, c.id, '你好', { demoSpeaker: 'unknown' }).expect(200);
    const unknown = (await turn(agent, c.id, '帮我记住我喜欢猫', { demoSpeaker: 'child' }).expect(200)).body;
    assert.equal(unknown.speaker.status, 'unknown');
    assert.equal(unknown.candidate, undefined);
    await agent.post(`/api/calls/${c.id}/speaker/retry`).set('Origin', origin).send({}).expect(200);
    assert.ok((await turn(agent, c.id, '帮我记住我喜欢猫', { demoSpeaker: 'child' }).expect(200)).body.candidate);
    assert.equal((await agent.get('/api/bootstrap')).body.capabilities.voiceprint, false);
});
test('lease expiry counts wall-clock time; heartbeat renews lease but never session or daily limit', async (t) => {
    let time = Date.UTC(2026, 8, 27);
    const { agent } = harness(t, { now: () => time });
    await setup(agent, { sessionMinutes: 1, dailyMinutes: 1 });
    const c = await call(agent, 'start-a');
    const repeated = await agent.post('/api/calls').set('Origin', origin).send({ operationId: 'start-a' }).expect(200);
    assert.equal(repeated.body.id, c.id);
    await agent.post('/api/calls').set('Origin', origin).send({ operationId: 'start-b' }).expect(409);
    await agent.patch('/api/preferences').set('Origin', origin).send({ outfit: 'peach' }).expect(409);
    time += 20000;
    let beat = (await agent.post(`/api/calls/${c.id}/heartbeat`).set('Origin', origin).send({}).expect(200)).body;
    assert.equal(beat.remainingSeconds, 40);
    time += 20000;
    beat = (await agent.post(`/api/calls/${c.id}/heartbeat`).set('Origin', origin).send({}).expect(200)).body;
    assert.equal(beat.remainingSeconds, 20);
    time += 20000;
    await turn(agent, c.id, '还在吗').expect(410);
    await agent.post('/api/calls').set('Origin', origin).send({ operationId: 'start-c' }).expect(429);
    assert.equal((await agent.get('/api/bootstrap')).body.remainingDailySeconds, 0);
    await agent.post(`/api/calls/${c.id}/end`).set('Origin', origin).send({ reason: 'again' }).expect(200);
    time += 86400000;
    assert.equal((await agent.get('/api/bootstrap')).body.remainingDailySeconds, 60);
    const tomorrow = await call(agent);
    assert.equal(tomorrow.remainingSeconds, 60);
});
test('abandoned lease bills 45 seconds and cannot be revived after expiry', async (t) => {
    let time = Date.UTC(2026, 8, 27);
    const { agent } = harness(t, { now: () => time });
    await setup(agent, { sessionMinutes: 1, dailyMinutes: 1 });
    const c = await call(agent);
    time += 46000;
    await agent.post(`/api/calls/${c.id}/heartbeat`).set('Origin', origin).send({}).expect(410);
    assert.equal((await agent.get('/api/bootstrap')).body.remainingDailySeconds, 15);
    const next = await call(agent);
    assert.equal(next.remainingSeconds, 15);
});
test('cancel is repeatable, leaves call active and invalidates pending memory', async (t) => {
    const { agent } = harness(t);
    await setup(agent);
    const c = await call(agent);
    const candidate = (await turn(agent, c.id, '帮我记住我喜欢蓝色').expect(200)).body.candidate;
    for (let i = 0; i < 2; i++)
        await agent.post(`/api/calls/${c.id}/cancel`).set('Origin', origin).send({}).expect(200);
    await agent.post(`/api/calls/${c.id}/memory/confirm`).set('Origin', origin).send({ candidateId: candidate.id, operationId: 'cancelled' }).expect(409);
    await turn(agent, c.id, '你好').expect(200);
});
test('late remote chat response after cancel returns context conflict and cannot produce a candidate', async (t) => {
    let resolve!: (response: Response) => void;
    let started!: () => void;
    const entered = new Promise<void>(r => started = r);
    const remote = new Promise<Response>(r => resolve = r);
    let requested = 0;
    const { agent } = harness(t, { env: { API_BASE_URL: 'https://provider.example/v1', API_KEY: 'secret', CHAT_MODEL: 'test' }, fetch: (async () => { requested++; started(); return remote; }) as typeof fetch });
    await setup(agent);
    const c = await call(agent);
    const pending = turn(agent, c.id, '聊聊种花').then((r: any) => r);
    await entered;
    await agent.post(`/api/calls/${c.id}/cancel`).set('Origin', origin).send({}).expect(200);
    resolve(new Response(JSON.stringify({ choices: [{ message: { content: '我们先挑一粒花种。' } }] }), { headers: { 'content-type': 'application/json' } }));
    const result = await pending;
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'CONTEXT_CHANGED');
    assert.equal(result.body.reply, undefined);
    assert.equal(requested, 1);
    assert.equal((await agent.get('/api/bootstrap')).body.memoryCount, 0);
});
test('TTS only accepts current server-held replies and discards audio when cancelled during synthesis', async (t) => {
    const inputs: string[] = [];
    let resolve!: (r: Response) => void;
    let started!: () => void;
    const entered = new Promise<void>(r => started = r);
    const { agent } = harness(t, { env: { API_BASE_URL: 'https://provider.example/v1', API_KEY: 'secret', TTS_MODEL: 'test' }, fetch: (async (_url, init) => { inputs.push(JSON.parse(String(init?.body)).input); started(); return new Promise<Response>(r => resolve = r); }) as typeof fetch });
    await setup(agent);
    const c = await call(agent);
    const reply = (await turn(agent, c.id, '我做到了').expect(200)).body;
    await agent.post(`/api/calls/${c.id}/speech`).set('Origin', origin).send({ text: '任意未审核内容' }).expect(400);
    await agent.post(`/api/calls/${c.id}/speech`).set('Origin', origin).send({ replyId: crypto.randomUUID() }).expect(409);
    const pending = agent.post(`/api/calls/${c.id}/speech`).set('Origin', origin).send({ replyId: reply.replyId }).then(r => r);
    await entered;
    await agent.post(`/api/calls/${c.id}/cancel`).set('Origin', origin).send({}).expect(200);
    resolve(new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } }));
    assert.equal((await pending).status, 409);
    assert.deepEqual(inputs, [reply.reply]);
});
test('no adapter means real audio rejects; privacy and danger do not create memories or pretend to notify', async (t) => {
    const { agent } = harness(t);
    await setup(agent);
    const c = await call(agent);
    await agent.post(`/api/calls/${c.id}/audio`).set('Origin', origin).field('operationId', 'a').attach('audio', Buffer.from('sample'), { filename: 'sample.webm', contentType: 'audio/webm' }).expect(503);
    const danger = (await turn(agent, c.id, '我想自杀').expect(200)).body;
    assert.equal(danger.endCall, true);
    assert.equal(danger.candidate, undefined);
    assert.match(danger.reply, /没有通知任何人/);
    await turn(agent,c.id,'继续聊天').expect(410);
    const afterDanger=await call(agent);
    const secret = (await turn(agent, afterDanger.id, '帮我记住我的密码是abc123').expect(200)).body;
    assert.equal(secret.candidate, undefined);
    assert.match(secret.reply, /私人信息/);
});
test('ordinary chat remains ephemeral without PIN or provider key; explicit calibration export is separate', async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'baoyan-test-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'data.sqlite');
    const app = createApp({ dataPath: path, env: { API_KEY: 'provider-key-do-not-store' } });
    const agent = request.agent(app);
    await setup(agent);
    const c = await call(agent);
    const raw = '原始聊天绝不保存特征字符串ZXQ987';
    await turn(agent, c.id, raw).expect(200);
    await remember(agent, c.id);
    await unlock(agent);
    const exported = (await agent.get('/api/parent/export').expect(200)).body;
    assert.deepEqual(Object.keys(exported).sort(), ['calibrationCases', 'child', 'children', 'dailyChatSummaries', 'devices', 'exportedAt', 'feedbackReports', 'members', 'memories', 'phoneExperienceRecords', 'promptLabRecords', 'usage', 'voiceprints']);
    assert.ok(Array.isArray(exported.dailyChatSummaries));
    assert.doesNotMatch(JSON.stringify(exported.dailyChatSummaries), /原始聊天绝不保存特征字符串ZXQ987/);
    assert.deepEqual(exported.calibrationCases, []);
    assert.deepEqual(exported.promptLabRecords, []);
    assert.equal(exported.memories.length, 1);
    app.locals.close();
    const content = readFileSync(path).toString('utf8');
    assert.equal(content.includes(raw), false);
    assert.equal(content.includes('provider-key-do-not-store'), false);
    const db = new DatabaseSync(path, { readOnly: true });
    const family = db.prepare('SELECT * FROM families').get() as any;
    assert.notEqual(family.pin_hash, profile.pin);
    assert.equal(family.pin_hash.length, 128);
    assert.equal(JSON.stringify(family).includes(profile.pin), false);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name);
    assert.deepEqual(tables.sort(), ['account_identity_sessions','guardian_members','guardian_links','accounts','account_sessions','account_attempts','auto_memory_blocks','auto_memory_status','calibration_cases','calibration_operations','calls','devices','families','feedback_config','feedback_rate_events','feedback_reports','global_memory_head','global_memory_releases','members','memories','memory_operations','phone_experience_records','prompt_lab_operations','prompt_lab_records','reply_adjustment_operations','scene_adoption_directions', 'scene_adoption_operations','scene_adoption_reports','scene_adoption_retests', 'scene_adoption_states',
      'account_contacts','account_profiles','admin_account_states','admin_family_states','admin_operators','admin_sessions','admin_bootstrap','admin_attempts','admin_recovery_tickets','admin_audit',
      'feedback_triage','feedback_triage_events','daily_chat_summaries','software_profiles','software_profile_memories','software_device_info','software_device_links','software_usage','software_service_metrics','memory_continuity','voiceprint_groups','voiceprint_templates','voiceprint_enrollments','voiceprint_cleanup','voiceprint_consents','content_catalog_head','content_catalog_releases','content_story_drafts','content_catalog_audit','sqlite_sequence'].sort());
    assert.equal(exported.children.length,1);assert.equal(exported.children[0].memories.length,1);
    assert.equal(JSON.stringify(exported).includes('token_hash'),false);assert.equal(JSON.stringify(exported).includes('pin_hash'),false);
    db.close();
});
test('withdraw ends calls, deletes persistent family data and invalidates device authorization', async (t) => {
    const { agent } = harness(t);
    await setup(agent);
    const c = await call(agent);
    await remember(agent, c.id);
    await unlock(agent);
    await agent.post('/api/parent/withdraw').set('Origin', origin).send({}).expect(200);
    assert.equal((await agent.get('/api/bootstrap')).body.configured, false);
    await agent.get('/api/parent/export').expect(401);
    await agent.post(`/api/calls/${c.id}/end`).set('Origin', origin).send({}).expect(401);
});

test('explicit setup memory opt-out cannot create a candidate until a parent enables it', async t => {
    const {agent}=harness(t);const boot=(await agent.post('/api/setup').set('Origin',origin).send({...profile,memoryEnabled:false}).expect(201)).body;
    assert.equal(boot.child.memoryEnabled,false);const c=await call(agent);const reply=(await turn(agent,c.id,'帮我记住小屋叫星星屋').expect(200)).body;
    assert.equal(reply.candidate,undefined);assert.match(reply.reply,/关闭专属记忆/);assert.equal((await agent.get('/api/bootstrap')).body.memoryCount,0);
});

test('unrelated preferences remain separate, while a named color property is updated by key', async t => {
    const {agent}=harness(t);await setup(agent);const c=await call(agent);const blue=await remember(agent,c.id,'帮我记住我喜欢蓝色');const paint=await remember(agent,c.id,'帮我记住我喜欢画画');assert.notEqual(blue.key,paint.key);
    const color1=await remember(agent,c.id,'帮我记住我最喜欢的颜色是红色');const color2=await remember(agent,c.id,'帮我记住我最喜欢的颜色是黄色');assert.equal(color1.id,color2.id);assert.equal(color2.key,'preference.favorite.color');
    await unlock(agent);const memories=(await agent.get('/api/parent/memories')).body.items;assert.equal(memories.length,3);assert.ok(memories.some((m:any)=>m.content==='我喜欢蓝色'));assert.ok(memories.some((m:any)=>m.content==='我喜欢画画'));
});

test('candidate expires after two minutes even when the call lease is regularly renewed', async t => {
    let time=Date.UTC(2026,8,27);const {agent}=harness(t,{now:()=>time});await setup(agent);const c=await call(agent);const candidate=(await turn(agent,c.id,'帮我记住我喜欢画画').expect(200)).body.candidate;
    for(let i=0;i<6;i++){time+=20_000;await agent.post(`/api/calls/${c.id}/heartbeat`).set('Origin',origin).send({}).expect(200);}
    const result=await agent.post(`/api/calls/${c.id}/memory/confirm`).set('Origin',origin).send({candidateId:candidate.id,operationId:'too-late'}).expect(409);assert.equal(result.body.code,'CANDIDATE_EXPIRED');assert.equal((await agent.get('/api/bootstrap')).body.memoryCount,0);
});

test('outdated turn idempotency keys cannot revive a candidate after a later turn or cancel', async t => {
    const {agent}=harness(t);await setup(agent);const c=await call(agent);const first=(await turn(agent,c.id,'帮我记住我喜欢猫',{operationId:'old-turn'}).expect(200)).body;const same=(await turn(agent,c.id,'帮我记住我喜欢猫',{operationId:'old-turn'}).expect(200)).body;
    assert.equal(first.replyId,same.replyId);assert.equal(first.candidate.id,same.candidate.id);await turn(agent,c.id,'我今天画画了').expect(200);await turn(agent,c.id,'帮我记住我喜欢猫',{operationId:'old-turn'}).expect(409);await agent.post(`/api/calls/${c.id}/cancel`).set('Origin',origin).send({}).expect(200);await turn(agent,c.id,'帮我记住我喜欢猫',{operationId:'old-turn'}).expect(409);await agent.post(`/api/calls/${c.id}/memory/confirm`).set('Origin',origin).send({candidateId:first.candidate.id,operationId:'old-save'}).expect(409);
});

test('saying goodbye closes the call and leaves no reply that can be spoken later', async t => {
    const {agent}=harness(t);await setup(agent);const c=await call(agent);const reply=(await turn(agent,c.id,'再见').expect(200)).body;assert.equal(reply.endCall,true);await turn(agent,c.id,'继续聊天').expect(410);await agent.post(`/api/calls/${c.id}/speech`).set('Origin',origin).send({replyId:reply.replyId}).expect(410);await agent.post(`/api/calls/${c.id}/end`).set('Origin',origin).send({reason:'ui-ended'}).expect(200);
});

test('blocked private text is never forwarded as history on the next real chat request', async t => {
    const bodies:any[]=[];const {agent}=harness(t,{env:{API_BASE_URL:'https://provider.example/v1',API_KEY:'secret',CHAT_MODEL:'test'},fetch:(async(_url,init)=>{bodies.push(JSON.parse(String(init?.body)));return new Response(JSON.stringify({choices:[{message:{content:'我们来给花园画一朵花。'}}]}));}) as typeof fetch});await setup(agent);const c=await call(agent);await turn(agent,c.id,'我的密码是abc123').expect(200);assert.equal(bodies.length,0);await turn(agent,c.id,'我们聊聊花园').expect(200);assert.equal(bodies.length,1);assert.equal(JSON.stringify(bodies).includes('abc123'),false);assert.equal(JSON.stringify(bodies).includes('我的密码'),false);
});

test('late ASR after cancel cannot create or save a memory candidate', async t => {
    let resolve!:(r:Response)=>void;let started!:()=>void;const entered=new Promise<void>(r=>started=r);const {agent}=harness(t,{env:{API_BASE_URL:'https://provider.example/v1',API_KEY:'secret',ASR_MODEL:'test'},fetch:(async()=>{started();return new Promise<Response>(r=>resolve=r);}) as typeof fetch});await setup(agent);const c=await call(agent);const pending=agent.post(`/api/calls/${c.id}/audio`).set('Origin',origin).field('operationId','late-asr').attach('audio',Buffer.from('sample'),{filename:'sample.webm',contentType:'audio/webm'}).then(r=>r);await entered;await agent.post(`/api/calls/${c.id}/cancel`).set('Origin',origin).send({}).expect(200);resolve(new Response(JSON.stringify({text:'帮我记住我喜欢画画'})));const result=await pending;assert.equal(result.status,409);assert.equal(result.body.candidate,undefined);assert.equal((await agent.get('/api/bootstrap')).body.memoryCount,0);
});

test('demo speaker choices expose only consented simulated adult ids and relations, never names', async t => {
    const {agent}=harness(t);await setup(agent);await unlock(agent);const member=(await agent.post('/api/parent/members').set('Origin',origin).send({name:'私密姓名',relation:'爸爸',consent:true}).expect(201)).body;assert.deepEqual((await agent.get('/api/bootstrap')).body.demoSpeakers,[]);await agent.post(`/api/parent/members/${member.id}/enroll`).set('Origin',origin).send({demo:true,consent:true}).expect(200);assert.deepEqual((await agent.get('/api/bootstrap')).body.demoSpeakers,[{id:member.id,relation:'爸爸'}]);await agent.patch(`/api/parent/members/${member.id}`).set('Origin',origin).send({disabled:true}).expect(200);assert.deepEqual((await agent.get('/api/bootstrap')).body.demoSpeakers,[]);
});

test('periodic lease sweep closes abandoned calls without waiting for another API request', async t => {
    const directory=mkdtempSync(join(tmpdir(),'baoyan-sweep-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));const path=join(directory,'data.sqlite');let time=Date.UTC(2026,8,27);const {app,agent}=harness(t,{dataPath:path,now:()=>time});await setup(agent);const c=await call(agent);const reader=new DatabaseSync(path,{readOnly:true});t.after(()=>reader.close());const familyId=(reader.prepare('SELECT family_id FROM calls WHERE id=?').get(c.id) as any).family_id;time+=46_000;await new Promise(resolve=>setTimeout(resolve,1150));const row=reader.prepare('SELECT * FROM calls WHERE id=?').get(c.id) as any;assert.equal(row.ended_at,row.started_at+45_000);assert.throws(()=>app.locals.mergeMemories(familyId,c.id));
});

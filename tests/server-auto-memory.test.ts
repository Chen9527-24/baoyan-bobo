import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp, type AppOptions } from '../apps/server/src/app.js';

const origin = 'http://localhost:5173';
const profile = { pin: '123456', nickname: '虚构体验者', ageGroup: '6-8', sessionMinutes: 10, dailyMinutes: 20, consent: true };
type Statement = { id: string; text: string };
function output(statements: Statement[]) {
  return JSON.stringify({ memories: statements.slice(-3).map(s => ({ statementId: s.id, quote: s.text, kind: /小屋/.test(s.text) ? 'imaginary' : /喜欢|爱好/.test(s.text) ? 'preference' : /明天|下次|计划/.test(s.text) ? 'plan' : 'event' })) });
}
function response(content: string) { return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] })); }
function harness(t: TestContext, settings: { summary?: (statements: Statement[], daily: Statement[]) => Promise<string> | string; options?: AppOptions } = {}) {
  const prompts: Statement[][] = []; const chatPrompts:string[]=[];
  const app = createApp({ dataPath: ':memory:', env: { API_BASE_URL: 'https://fixture.example/v1', API_KEY: 'fixture-only', CHAT_MODEL: 'fixture' }, ...settings.options,
    fetch: (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.messages[0].content.includes('BOBO_AUTO_MEMORY_EXTRACT_V1')) {
        const payload = JSON.parse(body.messages.at(-1).content);
        const statements: Statement[] = payload.statements; prompts.push(statements);
        return response(await (settings.summary?.(statements, payload.dailyStatements ?? []) ?? output(statements)));
      }
      chatPrompts.push(body.messages[0].content);return response('我在听，你愿意再聊一点吗？');
    }) as typeof fetch,
  });
  t.after(() => app.locals.close());
  return { app, agent: request.agent(app), prompts,chatPrompts };
}
const post = (a: any, path: string, body: unknown = {}) => a.post('/api' + path).set('Origin', origin).send(body);
async function unlock(a: any) { await post(a, '/parent/unlock', { pin: profile.pin }).expect(200); }
async function lock(a: any) { await post(a, '/parent/lock').expect(200); }
async function setup(a: any, enabled = true) {
  await post(a, '/setup', {...profile,memoryEnabled:enabled}).expect(201); await unlock(a);
  if (enabled) await a.patch('/api/parent/settings').set('Origin', origin).send({ memoryEnabled: true }).expect(200);
  await lock(a);
}
async function call(a: any) { return (await post(a, '/calls', { operationId: crypto.randomUUID() }).expect(201)).body.id as string; }
async function turn(a: any, id: string, text: string) { return (await post(a, `/calls/${id}/turn`, { text, operationId: crypto.randomUUID() }).expect(200)).body; }
async function finish(h: ReturnType<typeof harness>, id: string) { await post(h.agent, `/calls/${id}/end`).expect(200); await h.app.locals.waitForAutoMemory(); }
async function memories(a: any) { await unlock(a); return (await a.get('/api/parent/memories').expect(200)).body; }

test('ordinary conversation is summarized once after end, without commands or confirmation, and survives restart', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'bobo-auto-')); t.after(() => rmSync(dir, { recursive: true, force: true })); const path = join(dir, 'fixture.sqlite');
  const h = harness(t, { options: { dataPath: path } }); await setup(h.agent); const id = await call(h.agent);
  await turn(h.agent, id, '我喜欢画画'); await turn(h.agent, id, '我今天画了小猫'); assert.equal(h.prompts.length, 0);
  await finish(h, id); const result = await memories(h.agent); assert.equal(result.items.length, 2); assert.equal(result.autoSummary.state, 'saved'); assert.equal(result.autoSummary.savedCount, 2);
  assert.ok(result.items.every((m: any) => m.source.startsWith('聊天自动整理（'))); assert.equal(h.prompts.length, 1);
  assert.deepEqual(h.prompts[0].map(s => s.text), ['我喜欢画画', '我今天画了小猫']);
  await post(h.agent, `/calls/${id}/end`).expect(200); await h.app.locals.waitForAutoMemory(); assert.equal(h.prompts.length, 1);
  h.app.locals.close(); const fresh = createApp({ dataPath: path, env: {} }); fresh.locals.close();
  const db = new DatabaseSync(path); assert.equal(Number((db.prepare('SELECT count(*) n FROM memories').get() as any).n), 2);
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'auto_memory_%'").all() as any[]).map(r => r.name);
  assert.deepEqual(tables.sort(), ['auto_memory_blocks', 'auto_memory_status']); assert.equal(JSON.stringify(db.prepare('SELECT * FROM auto_memory_status').all()).includes('小猫'), false); db.close();
});

test('explicitly disabled, questions, third-party, sensitive or opted-out statements do not invoke a summary', async t => {
  const h = harness(t); await setup(h.agent, false); let id = await call(h.agent); await turn(h.agent, id, '我喜欢画画'); await finish(h, id); assert.equal(h.prompts.length, 0);
  await unlock(h.agent); await h.agent.patch('/api/parent/settings').set('Origin', origin).send({ memoryEnabled: true }); await lock(h.agent);
  id = await call(h.agent); for (const text of ['我喜欢蓝色吗？', '妈妈说她喜欢画画', '我住在某条路', '不要记住我喜欢画画', '如果我喜欢猫怎么办？']) await turn(h.agent, id, text);
  await finish(h, id); assert.equal(h.prompts.length, 0); assert.equal((await memories(h.agent)).items.length, 0);
});

test('a long conversation preserves up to 20 eligible user statements beyond the reply history window', async t => {
  const h = harness(t, { summary: () => '{"memories":[]}' }); await setup(h.agent); const id = await call(h.agent);
  for (let i = 1; i <= 23; i++) await turn(h.agent, id, `我今天画了第${i}朵花`);
  await finish(h, id); assert.equal(h.prompts[0].length, 20); assert.equal(h.prompts[0][0].text, '我今天画了第4朵花'); assert.equal((await memories(h.agent)).autoSummary.state, 'empty');
});

test('corrected text replaces the incorrect evidence before automatic extraction', async t => {
  const h = harness(t); await setup(h.agent); const id = await call(h.agent); const old = await turn(h.agent, id, '我喜欢蓝色');
  await post(h.agent, `/calls/${id}/correct`, { replyId: old.replyId, text: '我喜欢红色', operationId: crypto.randomUUID() }).expect(200);
  await finish(h, id); assert.deepEqual(h.prompts[0].map(s => s.text), ['我喜欢红色']); assert.equal((await memories(h.agent)).items[0].content, '我喜欢红色');
});

test('re-say retracts immediately and is idempotent, even when ending without a new recording', async t => {
  const h = harness(t); await setup(h.agent); const id = await call(h.agent); await turn(h.agent, id, '我喜欢画画'); const old = await turn(h.agent, id, '我喜欢蓝色');
  for (let i = 0; i < 2; i++) await post(h.agent, `/calls/${id}/retract`, { replyId: old.replyId }).expect(200);
  await finish(h, id); assert.deepEqual(h.prompts[0].map(s => s.text), ['我喜欢画画']); assert.equal((await memories(h.agent)).items[0].content, '我喜欢画画');
});

test('cancelled current reply is excluded from the summary input', async t => {
  const h = harness(t); await setup(h.agent); const id = await call(h.agent); await turn(h.agent, id, '我喜欢画画'); await turn(h.agent, id, '我喜欢蓝色');
  await post(h.agent, `/calls/${id}/cancel`).expect(200); await finish(h, id); assert.deepEqual(h.prompts[0].map(s => s.text), ['我喜欢画画']);
});

test('a pending summary does not delay end; disabling memory cancels its late output', async t => {
  let done!: (s: string) => void; const h = harness(t, { summary: () => new Promise(r => done = r) }); await setup(h.agent); const id = await call(h.agent); await turn(h.agent, id, '我喜欢画画');
  await post(h.agent, `/calls/${id}/end`).expect(200); assert.equal(h.prompts.length, 1); await unlock(h.agent);
  await h.agent.patch('/api/parent/settings').set('Origin', origin).send({ memoryEnabled: false }).expect(200); done(output(h.prompts[0])); await h.app.locals.waitForAutoMemory();
  const result = (await h.agent.get('/api/parent/memories')).body; assert.equal(result.items.length, 0); assert.equal(result.autoSummary.state, 'cancelled');
});

test('starting a new call cancels an earlier pending summary without clearing the new conversation', async t => {
  let done!: (s: string) => void; const h = harness(t, { summary: () => new Promise(r => done = r) }); await setup(h.agent); const id = await call(h.agent); await turn(h.agent, id, '我喜欢画画');
  await post(h.agent, `/calls/${id}/end`).expect(200); const next = await call(h.agent); await turn(h.agent, next, '我今天画了小鸟'); done(output(h.prompts[0])); await h.app.locals.waitForAutoMemory(); assert.equal((await h.agent.get('/api/bootstrap')).body.memoryCount, 0);
  await post(h.agent, `/calls/${next}/retract`, { replyId: (await turn(h.agent, next, '我喜欢唱歌')).replyId }).expect(200);
});

test('switching children cannot deposit late memories into another profile', async t => {
  let done!: (s: string) => void; const h = harness(t, { summary: () => new Promise(r => done = r) }); await setup(h.agent); const id = await call(h.agent); await turn(h.agent, id, '我喜欢画画'); await post(h.agent, `/calls/${id}/end`).expect(200);
  await unlock(h.agent); const other = (await post(h.agent, '/parent/children', { nickname: '另一位虚构体验者', ageGroup: '6-8', sessionMinutes: 10, dailyMinutes: 20 }).expect(201)).body;
  await post(h.agent, `/parent/children/${other.id}/select`).expect(200); done(output(h.prompts[0])); await h.app.locals.waitForAutoMemory(); assert.equal((await h.agent.get('/api/parent/memories')).body.items.length, 0);
});

test('unknown identity never creates child summary evidence', async t => {
  const h = harness(t); await setup(h.agent); await unlock(h.agent); await h.agent.patch('/api/parent/settings').set('Origin', origin).send({ voiceEnabled: true }).expect(200); await lock(h.agent);
  const id = await call(h.agent); await turn(h.agent, id, '我喜欢画画'); await finish(h, id); assert.equal(h.prompts.length, 0); assert.equal((await memories(h.agent)).items.length, 0);
});

test('parent edits are marked and protected against automatic overwrite', async t => {
  const h = harness(t); await setup(h.agent); let id = await call(h.agent); await turn(h.agent, id, '我喜欢蓝色'); await finish(h, id); let result = await memories(h.agent);
  const memory = result.items[0]; await h.agent.patch(`/api/parent/memories/${memory.id}`).set('Origin', origin).send({ content: '我喜欢紫色' }).expect(200); await lock(h.agent);
  id = await call(h.agent); await turn(h.agent, id, '我喜欢红色'); await finish(h, id); result = await memories(h.agent); assert.equal(result.items[0].content, '我喜欢紫色'); assert.equal(result.items[0].source, '家长修订');
});

test('deleting a summary prevents automatic resurrection; explicit confirmed re-save is still available', async t => {
  const h = harness(t); await setup(h.agent); let id = await call(h.agent); await turn(h.agent, id, '我喜欢蓝色'); await finish(h, id); const first = await memories(h.agent);
  await h.agent.delete(`/api/parent/memories/${first.items[0].id}`).set('Origin', origin).expect(200); await lock(h.agent); id = await call(h.agent); await turn(h.agent, id, '我喜欢蓝色'); await finish(h, id); assert.equal((await memories(h.agent)).items.length, 0);
  await lock(h.agent); id = await call(h.agent); const saved = await turn(h.agent, id, '帮我记住我最喜欢的颜色是蓝色'); await post(h.agent, `/calls/${id}/memory/confirm`, { candidateId: saved.candidate.id, operationId: crypto.randomUUID() }).expect(200); assert.equal((await memories(h.agent)).items.length, 1);
});

test('deletion invalidates an already running summary even when its result ignores abort', async t => {
  let delayed = false, done!: (s: string) => void; const h = harness(t, { summary: s => delayed ? new Promise(r => done = r) : output(s) }); await setup(h.agent);
  let id = await call(h.agent); await turn(h.agent, id, '我喜欢蓝色'); await finish(h, id); const first = await memories(h.agent); await lock(h.agent);
  delayed = true; id = await call(h.agent); await turn(h.agent, id, '我喜欢红色'); await post(h.agent, `/calls/${id}/end`).expect(200); await unlock(h.agent); await h.agent.delete(`/api/parent/memories/${first.items[0].id}`).set('Origin', origin).expect(200);
  done(output(h.prompts.at(-1)!)); await h.app.locals.waitForAutoMemory(); assert.equal((await h.agent.get('/api/parent/memories')).body.items.length, 0);
});

test('family withdrawal and server shutdown safely discard outstanding outputs', async t => {
  for (const shutdown of [false, true]) {
    let done!: (s: string) => void; const h = harness(t, { summary: () => new Promise(r => done = r) }); await setup(h.agent); const id = await call(h.agent); await turn(h.agent, id, '我喜欢画画'); await post(h.agent, `/calls/${id}/end`).expect(200);
    if (shutdown) h.app.locals.close(); else { await unlock(h.agent); await post(h.agent, '/parent/withdraw').expect(200); }
    done(output(h.prompts[0])); await h.app.locals.waitForAutoMemory(); if (!shutdown) await h.agent.get('/api/bootstrap').expect(200).then((r: any) => assert.equal(r.body.configured, false));
  }
});

test('invalid, ungrounded, incomplete and provider-error summaries leave no partial memories or automatic retry', async t => {
  for (const value of ['not-json', '{"memories":[{"statementId":"fake","quote":"我喜欢蓝色","kind":"preference"}]}', 'ERROR']) {
    const h = harness(t, { summary: () => { if (value === 'ERROR') throw Error('synthetic upstream failure'); return value; } }); await setup(h.agent); const id = await call(h.agent); await turn(h.agent, id, '我喜欢画画'); await finish(h, id);
    const result = await memories(h.agent); assert.equal(result.items.length, 0); assert.equal(result.autoSummary.state, 'failed'); assert.equal(h.prompts.length, 1);
  }
});

test('automatic personal home name takes precedence over global defaults without changing shared memory', async t => {
  const h = harness(t); await setup(h.agent); let id = await call(h.agent); await turn(h.agent, id, '我的小屋叫星星屋'); await finish(h, id);
  const result = await memories(h.agent); assert.equal(result.items[0].key, 'world.home.name'); const before = (await h.agent.get('/api/bootstrap')).body.globalMemories; await lock(h.agent); id = await call(h.agent);
  await turn(h.agent,id,'你记得我的小屋吗？');assert.ok(h.chatPrompts.at(-1)!.includes('星星屋'));
  assert.equal((await h.agent.get('/api/bootstrap')).body.globalMemories[0].content, before[0].content);
});

test('known themes in legacy confirmed memories also receive parent edit and deletion protection', async t => {
  const h=harness(t);await setup(h.agent);let id=await call(h.agent);
  const manual=await turn(h.agent,id,'帮我记住我喜欢画画');await post(h.agent,`/calls/${id}/memory/confirm`,{candidateId:manual.candidate.id,operationId:crypto.randomUUID()}).expect(200);
  let result=await memories(h.agent);assert.ok(result.items[0].key.startsWith('personal.'));
  await h.agent.patch(`/api/parent/memories/${result.items[0].id}`).set('Origin',origin).send({content:'我不喜欢画画'}).expect(200);await lock(h.agent);
  id=await call(h.agent);await turn(h.agent,id,'我现在喜欢画画');await finish(h,id);result=await memories(h.agent);assert.equal(result.items.length,1);assert.equal(result.items[0].content,'我不喜欢画画');
  await h.agent.delete(`/api/parent/memories/${result.items[0].id}`).set('Origin',origin).expect(200);await lock(h.agent);id=await call(h.agent);await turn(h.agent,id,'我特别喜欢画画');await finish(h,id);assert.equal((await memories(h.agent)).items.length,0);
});

test('full memory capacity retains existing confirmed facts without automatic eviction',async t=>{
  const h=harness(t);await setup(h.agent);const id=await call(h.agent);
  for(let i=1;i<=20;i++){const m=await turn(h.agent,id,`帮我记住我有第${i}张画`);await post(h.agent,`/calls/${id}/memory/confirm`,{candidateId:m.candidate.id,operationId:crypto.randomUUID()}).expect(200);}
  await turn(h.agent,id,'我喜欢画画');await finish(h,id);const r=await memories(h.agent);assert.equal(r.items.length,20);assert.ok(r.items.every((m:any)=>m.source.startsWith('孩子明确')));assert.equal(r.autoSummary.state,'skipped');
});

test('automatically extracted memory expires after 30 days',async t=>{
  let now=Date.UTC(2026,8,30);const h=harness(t,{options:{now:()=>now}});await setup(h.agent);const id=await call(h.agent);await turn(h.agent,id,'我喜欢画画');await finish(h,id);
  const r=await memories(h.agent);assert.equal(Date.parse(r.items[0].expiresAt),now+30*86400000);now+=30*86400000+1;h.app.locals.sweepExpiredState();assert.equal((await h.agent.get('/api/bootstrap')).body.memoryCount,0);
});

test('summary respects supplier daily budget and does not issue an extra request after it is exhausted',async t=>{
  const h=harness(t,{options:{env:{API_BASE_URL:'https://fixture.example/v1',API_KEY:'fixture-only',CHAT_MODEL:'fixture',TRIAL_ENABLED:'true',TRIAL_REQUIRE_INVITE:'false',TRIAL_ENDS_AT:'2026-10-12T12:54:09Z',TRIAL_DAILY_PROVIDER_CALLS:'1'},now:()=>Date.UTC(2026,8,30)}});
  await setup(h.agent);const id=await call(h.agent);await turn(h.agent,id,'我喜欢画画');await finish(h,id);const r=await memories(h.agent);assert.equal(h.prompts.length,0);assert.equal(r.items.length,0);assert.equal(r.autoSummary.state,'failed');
});

test('summary shares concurrency gate and releases it on invalid output',async t=>{
  let done!:(s:string)=>void;const h=harness(t,{summary:()=>new Promise(r=>done=r),options:{env:{API_BASE_URL:'https://fixture.example/v1',API_KEY:'fixture-only',CHAT_MODEL:'fixture',TRIAL_ENABLED:'true',TRIAL_REQUIRE_INVITE:'false',TRIAL_ENDS_AT:'2026-10-12T12:54:09Z',TRIAL_MAX_CONCURRENT_PROVIDER_CALLS:'1'},now:()=>Date.UTC(2026,8,30)}});
  await setup(h.agent);const b=request.agent(h.app);await setup(b);const id=await call(h.agent);const other=await call(b);await turn(h.agent,id,'我喜欢画画');await post(h.agent,`/calls/${id}/end`).expect(200);
  await post(b,`/calls/${other}/turn`,{text:'我喜欢唱歌',operationId:crypto.randomUUID()}).expect(429);done('not-json');await h.app.locals.waitForAutoMemory();await turn(b,other,'我喜欢唱歌');
});

test('story and learning answers do not become autobiographical facts',async t=>{
  const h=harness(t);await setup(h.agent);const id=await call(h.agent);const catalog=(await h.agent.get('/api/software/catalog')).body;
  await post(h.agent,`/calls/${id}/task`,{kind:'story',storyId:catalog.stories[0].id,operationId:crypto.randomUUID()}).expect(200);await turn(h.agent,id,'我喜欢小兔子');await post(h.agent,`/calls/${id}/task`,{kind:'chat',operationId:crypto.randomUUID()}).expect(200);
  await post(h.agent,`/calls/${id}/task`,{kind:'learning',topic:catalog.learningTopics[0].id,operationId:crypto.randomUUID()}).expect(200);await turn(h.agent,id,'我今天画了小猫');await finish(h,id);assert.deepEqual(h.prompts,[[]]);assert.equal((await memories(h.agent)).items.length,0);
});

test('pure dialect translation does not enter personal memory',async t=>{
  const h=harness(t,{options:{env:{CHAT_PROVIDER:'volc',CHAT_API_BASE_URL:'https://fixture.example/v3',CHAT_API_KEY:'fixture-only',CHAT_MODEL:'doubao-seed-2-1-lite-260915'}}});await setup(h.agent);const id=await call(h.agent);
  await post(h.agent,`/calls/${id}/mode`,{mode:'dialect',dialect:'chaoshan',behavior:'translate'}).expect(200);await turn(h.agent,id,'我喜欢画画');await finish(h,id);assert.equal(h.prompts.length,0);
});

test('opting out clears previous evidence and suppresses the rest of this conversation',async t=>{
  const h=harness(t);await setup(h.agent);const id=await call(h.agent);await turn(h.agent,id,'我喜欢画画');const result=await turn(h.agent,id,'不要记录');assert.match(result.reply,/不会自动整理/);await turn(h.agent,id,'我喜欢唱歌');await finish(h,id);assert.equal(h.prompts.length,0);assert.equal((await memories(h.agent)).items.length,0);
});

test('ordinary privacy replies cannot bypass the refusal to remember earlier conversation',async t=>{
  for(const text of ['不要记录我的电话号码','不要自动记录这次聊天']){
    const h=harness(t,{options:{env:{CHAT_PROVIDER:'volc',CHAT_API_BASE_URL:'https://fixture.example/v3',CHAT_API_KEY:'fixture-only',CHAT_MODEL:'doubao-seed-2-1-lite-260915'}}});await setup(h.agent);const id=await call(h.agent);await turn(h.agent,id,'我喜欢画画');
    const old=await turn(h.agent,id,'你好');
    await post(h.agent,`/calls/${id}/correct`,{replyId:old.replyId,text,operationId:crypto.randomUUID()}).expect(200);await finish(h,id);assert.equal(h.prompts.length,0);
  }
});

test('parent changing an event to a preference updates its category and retains precedence',async t=>{
  const h=harness(t);await setup(h.agent);let id=await call(h.agent);await turn(h.agent,id,'我今天画了小猫');await finish(h,id);let r=await memories(h.agent);
  const edited=(await h.agent.patch(`/api/parent/memories/${r.items[0].id}`).set('Origin',origin).send({content:'我最喜欢的颜色是紫色'}).expect(200)).body;assert.equal(edited.kind,'preference');await lock(h.agent);
  id=await call(h.agent);await turn(h.agent,id,'我最喜欢的颜色是蓝色');await finish(h,id);r=await memories(h.agent);assert.equal(r.items.length,1);assert.equal(r.items[0].content,'我最喜欢的颜色是紫色');
});


test('an ended empty or entirely retracted call refreshes summary status without invoking the model',async t=>{
 const h=harness(t);await setup(h.agent);let id=await call(h.agent);await turn(h.agent,id,'我喜欢画画');await finish(h,id);await memories(h.agent);await lock(h.agent);id=await call(h.agent);const old=await turn(h.agent,id,'我喜欢蓝色');await post(h.agent,`/calls/${id}/retract`,{replyId:old.replyId}).expect(200);await finish(h,id);const r=await memories(h.agent);assert.equal(r.items.length,1);assert.equal(r.autoSummary.state,'empty');assert.equal(r.autoSummary.savedCount,0);assert.equal(h.prompts.length,1);
});

test('one end-of-chat request refines the notebook and saves an evidence-backed craft memory together', async t => {
  const h = harness(t, { summary: (statements, daily) => {
    assert.equal(statements.length, 1); assert.equal(daily.length, 2);
    const craft = daily.find(s => s.text.includes('纸飞机'))!, mood = daily.find(s => s.text.includes('开心'))!;
    return JSON.stringify({ memories: [{ statementId: craft.id, quote: craft.text, kind: 'event' }], daily: { topics: [{ statementId: craft.id, quote: '纸飞机', topic: '纸飞机' }], concerns: [], moods: [{ statementId: mood.id, quote: mood.text, mood: '开心' }] } });
  } });
  await setup(h.agent); const id = await call(h.agent);
  await turn(h.agent, id, '我折了一架纸飞机'); await turn(h.agent, id, '我开心'); assert.equal(h.prompts.length, 0);
  await finish(h, id); const result = await memories(h.agent);
  assert.equal(h.prompts.length, 1); assert.equal(result.items.length, 1); assert.equal(result.items[0].kind, 'event');
  assert.equal(result.dailySummaries.records[0].detailLevel, 'semantic'); assert.deepEqual(result.dailySummaries.records[0].moods, ['开心']);
  assert.ok(result.dailySummaries.records[0].topics.includes('纸飞机'));
});

test('a question-only chat can receive a useful notebook review without creating a long-term preference', async t => {
  const h = harness(t, { summary: (statements, daily) => {
    assert.deepEqual(statements, []);
    return JSON.stringify({ memories: [], daily: { topics: [{ statementId: daily[0].id, quote: '纸飞机', topic: '纸飞机' }], concerns: [], moods: [] } });
  } });
  await setup(h.agent); const id = await call(h.agent); await turn(h.agent, id, '纸飞机怎么飞得远？'); await finish(h, id);
  const result = await memories(h.agent); assert.equal(result.items.length, 0); assert.equal(result.autoSummary.state, 'empty');
  assert.deepEqual(result.dailySummaries.records[0].topics, ['纸飞机']); assert.equal(result.dailySummaries.records[0].detailLevel, 'semantic');
  assert.equal(h.prompts.length, 1);
});

test('malformed or unsupported joint extraction retains the immediate basic notebook without retry', async t => {
  for (const summary of ['{"memories":[],"daily":', JSON.stringify({ memories: [], daily: { topics: [], concerns: [], moods: [{ statementId: 'invented', quote: '我很难过', mood: '难过' }] } })]) {
    const h = harness(t, { summary: () => summary }); await setup(h.agent); const id = await call(h.agent);
    await turn(h.agent, id, '我今天画了彩虹'); await finish(h, id); const result = await memories(h.agent);
    assert.equal(result.autoSummary.state, 'failed'); assert.equal(result.items.length, 0); assert.equal(h.prompts.length, 1);
    assert.equal(result.dailySummaries.records[0].detailLevel, 'basic'); assert.ok(result.dailySummaries.records[0].topics.includes('科学问题'));
    assert.deepEqual(result.dailySummaries.records[0].moods, []);
  }
});

test('deleting a daily review while joint extraction is pending blocks its late refinement', async t => {
  let release!: () => void;
  const h = harness(t, { summary: async (_statements, daily) => {
    await new Promise<void>(resolve => { release = resolve; });
    return JSON.stringify({ memories: [], daily: { topics: [{ statementId: daily[0].id, quote: '纸飞机', topic: '纸飞机' }], concerns: [], moods: [] } });
  } });
  await setup(h.agent); const id = await call(h.agent); await turn(h.agent, id, '纸飞机怎么飞得远？');
  await post(h.agent, `/calls/${id}/end`).expect(200); const before = await memories(h.agent);
  assert.equal(before.autoSummary.state, 'pending'); const boot = (await h.agent.get('/api/bootstrap').expect(200)).body;
  await h.agent.delete(`/api/parent/chat-summaries/${before.dailySummaries.today}`).set('Origin', origin).set('X-Baoyan-Child', boot.child.id).expect(200);
  release(); await h.app.locals.waitForAutoMemory(); const result = await memories(h.agent);
  assert.deepEqual(result.dailySummaries.records, []); assert.equal(result.items.length, 0);
});

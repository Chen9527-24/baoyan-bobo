import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { gunzipSync, gzipSync } from 'node:zlib';
import WebSocket, { WebSocketServer } from 'ws';
import { createApp } from '../apps/server/src/app.js';

const origin = 'http://localhost:5173';
const baseEnv = { CHAT_PROVIDER: 'volc', CHAT_API_BASE_URL: 'http://127.0.0.1:9999/v3', CHAT_API_KEY: 'synthetic-chat', CHAT_MODEL: 'doubao-seed-2-1-lite-260915',
  ASR_PROVIDER: 'volc', VOLC_SPEECH_API_KEY: 'synthetic-asr', VOLC_ASR_RESOURCE_ID: 'volc.seedasr.sauc.duration',
  VOLC_ASR_URL: 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream',
  VOLC_VOICEPRINT_ENABLED: 'true', VOLC_VOICEPRINT_API_KEY: 'synthetic-voiceprint', VOLC_VOICEPRINT_AUDIO_ORIGIN: 'https://baoyan.fixture.testing' };
const profile = { pin: '123456', nickname: '虚构小雨', ageGroup: '6-8', sessionMinutes: 10, dailyMinutes: 30, consent: true };
function post(agent: any, url: string, body: any = {}) { return agent.post(url).set('Origin', origin).send(body); }
async function unlock(agent: any) { await post(agent, '/api/parent/unlock', { pin: profile.pin }).expect(200); }
async function lock(agent: any) { await post(agent, '/api/parent/lock').expect(200); }
function wav(seconds = 6) {
  const bytes = Buffer.alloc(44 + seconds * 32000); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40); for (let i = 44; i < bytes.length; i += 2) bytes.writeInt16LE(1000, i); return bytes;
}
function packet(payload: unknown, terminal = false) {
  const bytes = gzipSync(Buffer.from(JSON.stringify(payload))); const prefix = Buffer.alloc(12);
  prefix.set([0x11, terminal ? 0x93 : 0x91, 0x11, 0]); prefix.writeInt32BE(terminal ? -1 : 1, 4); prefix.writeUInt32BE(bytes.length, 8);
  return Buffer.concat([prefix, bytes]);
}
function enrollment(agent: any, memberId: string, operationId = randomUUID(), guardian = false) {
  let upload = agent.post(`/api/parent/members/${memberId}/enroll`).set('Origin', origin).field('operationId', operationId)
    .field('consent', 'true').field('participantConfirmed', 'true');
  if (guardian) upload = upload.field('guardianConsent', 'true');
  return upload.attach('audio', wav(), { filename: 'synthetic-enrollment.wav', contentType: 'audio/wav' });
}
async function harness(t: TestContext, env = baseEnv, now?: () => number) {
  const peer = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(peer, 'listening');
  const address = peer.address(); assert.ok(address && typeof address !== 'string');
  let app!: ReturnType<typeof createApp>;
  let matching: 'known' | 'unknown' = 'known'; let knownToken = ''; let speakerCalls = 0; let plainCalls = 0; let audioChecks = 0;
  const captured: { id: string; speakerId: string; groupId: string; audioUrl: string }[] = [];
  const removed: string[] = [], modelMessages: any[] = [];
  let held: { entered: () => void; gate: Promise<void> } | undefined;
  peer.on('connection', socket => {
    let params: any;
    socket.on('message', raw => {
      const bytes = Buffer.from(raw as Buffer); const type = bytes[1] >> 4; const final = (bytes[1] & 15) === 3;
      if (type === 1) {
        params = JSON.parse(gunzipSync(bytes.subarray(12)).toString());
        if (params.request.voiceprints) speakerCalls++; else plainCalls++;
        socket.send(packet({ result: { text: '' } }));
      } else if (final) socket.send(packet({ result: { text: '你好宝妍', additions: { lid_lang: 'speech_mand' }, utterances: [{ text: '你好宝妍', additions: { speaker_id: matching === 'known' ? knownToken : '0' } }] } }, true));
    });
  });
  app = createApp({ dataPath: ':memory:', env, now,
    volcAsrConnect(url, options) { assert.ok(url === baseEnv.VOLC_ASR_URL || url === 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async'); return new WebSocket(`ws://127.0.0.1:${address.port}`, options); },
    fetch: (async (url, init) => {
      const target = new URL(String(url)); const body = JSON.parse(String(init?.body));
      if (target.hostname === 'openspeech.bytedance.com') {
        const action = target.searchParams.get('Action');
        if (action === 'CreateVoiceprintGroup') return Response.json({ Result: { Code: 1000, GroupId: randomUUID() } });
        if (action === 'UpdateVoiceprint' && body.Action === 0) {
          const audioUrl = new URL(body.AudioUrl);
          const accessible = await request(app).get(`${audioUrl.pathname}${audioUrl.search}`).expect(200);
          assert.equal(accessible.headers['cache-control'], 'no-store'); assert.equal(accessible.headers['referrer-policy'], 'no-referrer');
          assert.equal(accessible.body.length, wav().length); audioChecks++;
          const invalid = new URL(audioUrl); invalid.searchParams.set('signature', '0'.repeat(64));
          await request(app).get(`${invalid.pathname}${invalid.search}`).expect(404);
          const id = randomUUID(); captured.push({ id, speakerId: body.SpeakerName, groupId: body.GroupId, audioUrl: body.AudioUrl }); knownToken = body.SpeakerName;
          if (held) { held.entered(); await held.gate; }
          return Response.json({ Result: { Code: 1000, SpeakId: id } });
        }
        if (action === 'UpdateVoiceprint' && body.Action === 2) { removed.push(body.SpeakId); return Response.json({ Result: { Code: 1000 } }); }
        if (action === 'ListVoiceprint') return Response.json({ Result: { Code: 1000, AudioEmbedding: captured.filter(item => item.groupId === body.GroupId).map(item => ({ SpeakId: item.id, SpeakerName: item.speakerId, Status: removed.includes(item.id) ? 2 : 1 })) } });
        throw new Error('unexpected synthetic voiceprint action');
      }
      modelMessages.push(body.messages); return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '你好，我们慢慢聊。' } }] });
    }) as typeof fetch });
  t.after(async () => { app.locals.close(); for (const client of peer.clients) client.terminate(); await new Promise<void>(resolve => peer.close(() => resolve())); });
  const agent = request.agent(app);
  await post(agent, '/api/setup', profile).expect(201); await unlock(agent);
  return { app, agent, captured, removed, modelMessages, audioChecks: () => audioChecks, speakerCalls: () => speakerCalls,
    plainCalls: () => plainCalls, unknown() { matching = 'unknown'; }, known() { matching = 'known'; }, setToken(token: string) { knownToken = token; },
    holdRegistration() {
      let entered!: () => void, release!: () => void;
      const began = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
      held = { entered, gate }; return { began, release };
    } };
}
async function member(agent: any, relation = '爸爸') { return (await post(agent, '/api/parent/members', { name: '虚构家人', relation, consent: true }).expect(201)).body; }
function audio(agent: any, id: string) { return agent.post(`/api/calls/${id}/audio`).set('Origin', origin).field('operationId', randomUUID()).attach('audio', wav(0.2), { filename: 'synthetic.wav', contentType: 'audio/wav' }); }

test('voiceprint integration remains disabled without explicit service switch or supported ASR adapter', async t => {
  for (const override of [ { VOLC_VOICEPRINT_ENABLED: 'false' }, { ASR_PROVIDER: 'openai', ASR_API_BASE_URL: 'http://127.0.0.1:9999', ASR_API_KEY: 'synthetic-generic', ASR_MODEL: 'synthetic-model' } ]) {
    const f = await harness(t, { ...baseEnv, ...override });
    assert.equal((await f.agent.get('/api/bootstrap')).body.capabilities.voiceprint, false);
    const who = await member(f.agent); await enrollment(f.agent, who.id).expect(503); assert.equal(f.captured.length, 0);
  }
});

test('real enrollment route verifies consent, serves short-lived signed audio and reports enrolled member safely', async t => {
  const f = await harness(t); const who = await member(f.agent);
  const result = (await enrollment(f.agent, who.id).expect(200)).body;
  assert.equal(result.member.status, 'enrolled'); assert.equal(result.voiceprint.status, 'enrolled'); assert.equal(f.audioChecks(), 1);
  assert.equal(JSON.stringify(result).includes(f.captured[0].id), false); assert.equal(JSON.stringify(result).includes('signature='), false);
  const url = new URL(f.captured[0].audioUrl); await request(f.app).get(`${url.pathname}${url.search}`).expect(404);
  const statuses = (await f.agent.get('/api/parent/voiceprints').expect(200)).body;
  assert.equal(statuses.items[0].memberId, who.id); assert.equal(statuses.retentionDays, 90);
});

test('foreign member enrollment is rejected; children require guardian declaration and bind selected child', async t => {
  const f = await harness(t); const child = await member(f.agent, '孩子');
  await enrollment(f.agent, child.id).expect(400);
  const result = (await enrollment(f.agent, child.id, randomUUID(), true).expect(200)).body;
  assert.equal(result.voiceprint.childId, (await f.agent.get('/api/bootstrap')).body.child.id);
  const b = request.agent(f.app); await post(b, '/api/setup', { ...profile, nickname: '虚构另一家' }).expect(201); await unlock(b);
  await enrollment(b, child.id).expect(404);
  assert.equal(f.captured.length, 1);
});

test('adult voice recognition grants polite identity but no parent or child-memory permission', async t => {
  const f = await harness(t); const father = await member(f.agent); await enrollment(f.agent, father.id).expect(200);
  await f.agent.patch('/api/parent/settings').set('Origin', origin).send({ voiceEnabled: true, memoryEnabled: true }).expect(200); await lock(f.agent);
  const c = (await post(f.agent, '/api/calls', { operationId: randomUUID(), voiceprintParticipation: true }).expect(201)).body;
  const reply = (await audio(f.agent, c.id).expect(200)).body;
  assert.equal(reply.speaker.status, 'known'); assert.equal(reply.speaker.name, '虚构家人'); assert.equal(f.speakerCalls(), 1);
  await f.agent.get('/api/parent/memories').expect(403); await f.agent.get('/api/parent/members').expect(403);
  const memory = (await post(f.agent, `/api/calls/${c.id}/turn`, { text: '帮我记住我喜欢画画', operationId: randomUUID() }).expect(200)).body;
  assert.equal(memory.candidate, undefined); assert.equal((await f.agent.get('/api/bootstrap')).body.memoryCount, 0);
});

test('unknown voice pauses matching until explicit retry; subsequent rounds use plain ASR', async t => {
  const f = await harness(t); const father = await member(f.agent); await enrollment(f.agent, father.id).expect(200);
  await f.agent.patch('/api/parent/settings').set('Origin', origin).send({ voiceEnabled: true }).expect(200); await lock(f.agent);
  const c = (await post(f.agent, '/api/calls', { operationId: randomUUID(), voiceprintParticipation: true }).expect(201)).body;
  f.unknown(); const unknown = (await audio(f.agent, c.id).expect(200)).body;
  assert.equal(unknown.speaker.status, 'unknown'); assert.equal(f.speakerCalls(), 1);
  f.known(); const paused = (await audio(f.agent, c.id).expect(200)).body;
  assert.equal(paused.speaker.status, 'unknown'); assert.equal(f.speakerCalls(), 1); assert.equal(f.plainCalls(), 1);
  await post(f.agent, `/api/calls/${c.id}/speaker/retry`).expect(200);
  const retried = (await audio(f.agent, c.id).expect(200)).body;
  assert.equal(retried.speaker.status, 'known'); assert.equal(f.speakerCalls(), 2);
});

test('known child identity retry removes private context and expires old speech until a new audio round verifies identity', async t => {
  const f = await harness(t, { ...baseEnv, TTS_PROVIDER: 'openai', TTS_API_BASE_URL: 'http://127.0.0.1:9999/v1', TTS_API_KEY: 'synthetic-tts', TTS_MODEL: 'synthetic-tts-model' });
  const who = await member(f.agent, '孩子'); await enrollment(f.agent, who.id, randomUUID(), true).expect(200);
  await f.agent.patch('/api/parent/settings').set('Origin', origin).send({ voiceEnabled: true, memoryEnabled: true }).expect(200); await lock(f.agent);
  const call = (await post(f.agent, '/api/calls', { operationId: randomUUID(), voiceprintParticipation: true }).expect(201)).body;
  const identity = (await audio(f.agent, call.id).expect(200)).body; assert.equal(identity.speaker.status, 'known');
  const secret = '我喜欢回归蓝鲸手工';
  const pending = (await post(f.agent, `/api/calls/${call.id}/turn`, { text: `帮我记住${secret}`, operationId: randomUUID() }).expect(200)).body;
  assert.ok(pending.candidate);
  await post(f.agent, `/api/calls/${call.id}/memory/confirm`, { candidateId: pending.candidate.id, operationId: randomUUID() }).expect(200);
  const question = '你还记得我之前说的手工爱好吗？';
  const previous = (await post(f.agent, `/api/calls/${call.id}/turn`, { text: question, operationId: randomUUID() }).expect(200)).body;
  assert.ok(JSON.stringify(f.modelMessages.at(-1)).includes(secret), 'known child can use the confirmed private memory');
  const previousRevision = previous.speakerRevision;
  await post(f.agent, `/api/calls/${call.id}/speaker/retry`).expect(200);
  const unknown = (await post(f.agent, `/api/calls/${call.id}/turn`, { text: question, operationId: randomUUID() }).expect(200)).body;
  assert.equal(unknown.speaker.status, 'unknown'); assert.ok(unknown.speakerRevision > previousRevision);
  assert.equal(JSON.stringify(f.modelMessages.at(-1)).includes(secret), false, 'private memory and earlier private history are withheld');
  assert.equal(f.speakerCalls(), 1, 'plain text cannot reverify a speaker');
  const expired = (await post(f.agent, `/api/calls/${call.id}/speech`, { replyId: previous.replyId }).expect(409)).body;
  assert.equal(expired.code, 'REPLY_EXPIRED');
  const denied = (await f.agent.get('/api/parent/memories').expect(403)).body; assert.equal(denied.code, 'PARENT_REQUIRED');
  const verified = (await audio(f.agent, call.id).expect(200)).body;
  assert.equal(verified.speaker.status, 'known'); assert.equal(f.speakerCalls(), 2);
  await post(f.agent, `/api/calls/${call.id}/turn`, { text: question, operationId: randomUUID() }).expect(200);
  assert.ok(JSON.stringify(f.modelMessages.at(-1)).includes(secret), 'only a new audio verification restores child memory access');
  await f.agent.get('/api/parent/memories').expect(403);
});

test('voice identity is not inferred without participant declaration; disabling/deleting removes active recognition', async t => {
  const f = await harness(t); const father = await member(f.agent); await enrollment(f.agent, father.id).expect(200);
  await f.agent.patch('/api/parent/settings').set('Origin', origin).send({ voiceEnabled: true }).expect(200); await lock(f.agent);
  const c = (await post(f.agent, '/api/calls', { operationId: randomUUID() }).expect(201)).body;
  const noParticipation = (await audio(f.agent, c.id).expect(200)).body;
  assert.equal(noParticipation.speaker.status, 'unknown'); assert.equal(f.speakerCalls(), 0); assert.equal(f.plainCalls(), 1);
  await unlock(f.agent); await f.agent.patch(`/api/parent/members/${father.id}`).set('Origin', origin).send({ disabled: true }).expect(200);
  assert.equal((await f.agent.get('/api/parent/voiceprints')).body.items[0].status, 'disabled');
  await f.agent.delete(`/api/parent/members/${father.id}`).set('Origin', origin).expect(200);
  assert.equal((await f.agent.get('/api/parent/voiceprints')).body.items[0].status, 'deleted');
});

test('parent cancellation invalidates registration audio and late vendor creation cannot activate member', async t => {
  const f = await harness(t); const who = await member(f.agent); const operationId = randomUUID(); const held = f.holdRegistration();
  const registration = enrollment(f.agent, who.id, operationId).then((result: any) => result); await held.began;
  await post(f.agent, '/api/parent/voiceprints/cancel', { operationId }).expect(200);
  const cancelled = await registration; assert.equal(cancelled.status, 499);
  const url = new URL(f.captured[0].audioUrl); await request(f.app).get(`${url.pathname}${url.search}`).expect(404);
  held.release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.agent.get('/api/parent/voiceprints')).body.items.length, 0);
  assert.equal((await f.agent.get('/api/parent/members')).body.items[0].status, 'not_enrolled');
});

test('expired parent authorization prevents activation and signed-audio access during delayed registration', async t => {
  let time = Date.parse('2026-09-30T00:00:00Z'); const f = await harness(t, baseEnv, () => time);
  const who = await member(f.agent); const held = f.holdRegistration();
  const registration = enrollment(f.agent, who.id).then((result: any) => result); await held.began;
  time += 10 * 60_000 + 1;
  const url = new URL(f.captured[0].audioUrl); await request(f.app).get(`${url.pathname}${url.search}`).expect(404);
  held.release(); const result = await registration; assert.ok([403, 410, 499].includes(result.status));
  await unlock(f.agent); assert.deepEqual((await f.agent.get('/api/parent/voiceprints')).body.items, []);
});

test('recognizing another child cannot restore selected child memory; deleting that profile disables its template', async t => {
  const f = await harness(t); const initial = (await f.agent.get('/api/bootstrap')).body.child;
  const who = await member(f.agent, '孩子'); await enrollment(f.agent, who.id, randomUUID(), true).expect(200);
  const second = (await post(f.agent, '/api/parent/children', { nickname: '虚构小夏', ageGroup: '9-12', sessionMinutes: 10, dailyMinutes: 30 }).expect(201)).body;
  await post(f.agent, `/api/parent/children/${second.id}/select`).expect(200);
  await f.agent.patch('/api/parent/settings').set('Origin', origin).send({ voiceEnabled: true, memoryEnabled: true }).expect(200); await lock(f.agent);
  const c = (await post(f.agent, '/api/calls', { operationId: randomUUID(), voiceprintParticipation: true }).expect(201)).body;
  const mistaken = (await audio(f.agent, c.id).expect(200)).body; assert.equal(mistaken.speaker.status, 'unknown');
  const attempted = (await post(f.agent, `/api/calls/${c.id}/turn`, { text: '帮我记住我喜欢画画', operationId: randomUUID() }).expect(200)).body;
  assert.equal(attempted.candidate, undefined);
  await unlock(f.agent); await f.agent.delete(`/api/parent/children/${initial.id}`).set('Origin', origin).expect(200);
  const status = (await f.agent.get('/api/parent/voiceprints')).body.items[0]; assert.ok(status.status !== 'enrolled');
});

test('deleting one child profile preserves father and mother templates and their recognition under another selected child', async t => {
  const f = await harness(t); const initial = (await f.agent.get('/api/bootstrap')).body.child;
  const father = await member(f.agent, '爸爸'); const mother = await member(f.agent, '妈妈');
  for (const who of [father, mother]) {
    const enrolled = (await enrollment(f.agent, who.id).expect(200)).body;
    assert.equal(enrolled.voiceprint.childId, undefined, 'adult enrollment never binds the selected child');
  }
  const next = (await post(f.agent, '/api/parent/children', { nickname: '虚构小夏', ageGroup: '9-12', sessionMinutes: 10, dailyMinutes: 30 }).expect(201)).body;
  await post(f.agent, `/api/parent/children/${next.id}/select`).expect(200);
  await f.agent.delete(`/api/parent/children/${initial.id}`).set('Origin', origin).expect(200);
  const statuses = (await f.agent.get('/api/parent/voiceprints').expect(200)).body.items;
  assert.equal(statuses.length, 2);
  for (const who of [father, mother]) {
    const status = statuses.find((item: any) => item.memberId === who.id);
    assert.equal(status.status, 'enrolled'); assert.equal(status.supplierDeletion, 'not_requested');
  }
  await f.agent.patch('/api/parent/settings').set('Origin', origin).send({ voiceEnabled: true }).expect(200); await lock(f.agent);
  const call = (await post(f.agent, '/api/calls', { operationId: randomUUID(), voiceprintParticipation: true }).expect(201)).body;
  const recognized = (await audio(f.agent, call.id).expect(200)).body;
  assert.equal(recognized.speaker.status, 'known'); assert.equal(f.speakerCalls(), 1);
  const denied = (await f.agent.get('/api/parent/members').expect(403)).body;
  assert.equal(denied.code, 'PARENT_REQUIRED', 'recognized parent voice still does not unlock management');
});

test('speaker change discards earlier utterance fragments as well as recent chat history', async t => {
  const f = await harness(t); const father = await member(f.agent); await enrollment(f.agent, father.id).expect(200);
  await f.agent.patch('/api/parent/settings').set('Origin', origin).send({ voiceEnabled: true }).expect(200); await lock(f.agent);
  const c = (await post(f.agent, '/api/calls', { operationId: randomUUID(), voiceprintParticipation: true }).expect(201)).body;
  for (let i = 0; i < 8; i++) await post(f.agent, `/api/calls/${c.id}/turn`, { text: `旧说话者原话标记第${i}轮`, operationId: randomUUID() }).expect(200);
  assert.ok(JSON.stringify(f.modelMessages.at(-1)).includes('旧说话者原话标记'));
  await audio(f.agent, c.id).expect(200);
  assert.equal(JSON.stringify(f.modelMessages.at(-1)).includes('旧说话者原话标记'), false);
});

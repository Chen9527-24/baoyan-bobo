import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import request from 'supertest';
import WebSocket, { WebSocketServer } from 'ws';
import { createApp } from '../apps/server/src/app.js';
import { readAudioTurnStream } from '../apps/web/src/lib/audioTurnStream.js';

const origin = 'http://localhost:5173';
const officialAsr = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream';
const lite = 'doubao-seed-2-1-lite-260915', pro = 'doubao-seed-2-1-pro-260915';
const profile = { pin: '123456', nickname: '虚构自动语言', ageGroup: '6-8', sessionMinutes: 10, dailyMinutes: 30, consent: true };
const env = {
  CHAT_PROVIDER: 'volc', CHAT_API_BASE_URL: 'https://synthetic-language.invalid/api/v3', CHAT_API_KEY: 'synthetic-only',
  CHAT_MODEL: lite, VOLC_TEXT_CHAT_MODEL: pro, ASR_PROVIDER: 'volc', VOLC_SPEECH_API_KEY: 'synthetic-asr-only',
  VOLC_ASR_RESOURCE_ID: 'volc.seedasr.sauc.duration', VOLC_ASR_URL: officialAsr,
};
const mandarin = '小猫把纸球推到床底了，我够不到。';
const meaning = '我准备吃完饭洗碗，再和朋友出去玩。';
const wrongText = '帮我记住我喜欢错误轨道玩具';
const completion = (text: string) => Response.json({ choices: [{ finish_reason: 'stop', message: { content: text } }] });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function wav(seconds = 0.1) {
  const bytes = Buffer.alloc(44 + seconds * 32000);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  for (let index = 44; index < bytes.length; index += 2) bytes.writeInt16LE(1000, index);
  return bytes;
}
// Independent official binary response peer; only the transport connects to localhost.
function packet(payload: unknown, final = false) {
  const body = gzipSync(Buffer.from(JSON.stringify(payload))), head = Buffer.alloc(12);
  head.set([0x11, final ? 0x93 : 0x91, 0x11, 0]);
  head.writeInt32BE(final ? -1 : 1, 4); head.writeUInt32BE(body.length, 8);
  return Buffer.concat([head, body]);
}
const result = (label: string, text = mandarin) => ({ result: { text, additions: { lid_lang: label } } });

async function harness(t: TestContext, overrides: Record<string, string | undefined> = {}, now:()=>number = Date.now) {
  const peer = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(peer, 'listening');
  const address = peer.address(); assert.ok(address && typeof address !== 'string');
  const asrRequests: any[] = [], models: any[] = [], pcm: Buffer[] = [];
  let payload: unknown = result('speech_mand');
  let audioMeaning = meaning;
  let inference: unknown = { status: 'uncertain', language: 'unknown', text: '' };
  let enrolledSpeaker = '';
  const voiceprintTemplates: { templateId: string; speakerId: string; groupId: string }[] = [];
  let held: { model: string; began: ReturnType<typeof deferred<void>>; response: ReturnType<typeof deferred<Response>> } | undefined;
  let heldAsr: { began: ReturnType<typeof deferred<void>>; response: ReturnType<typeof deferred<void>> } | undefined;
  const releases: Array<() => void> = [];
  peer.on('connection', socket => {
    let reply: unknown;
    socket.on('message', raw => {
      const bytes = Buffer.from(raw as Buffer);
      assert.equal(bytes[0], 0x11); assert.equal(bytes.readUInt32BE(8), bytes.length - 12);
      const type = bytes[1]! >> 4, final = (bytes[1]! & 15) === 3;
      const body = gunzipSync(bytes.subarray(12));
      if (type === 1) { asrRequests.push(JSON.parse(body.toString())); reply = payload; socket.send(packet({})); }
      else { assert.equal(type, 2); pcm.push(body); if (final) {
        if(heldAsr){const gate=heldAsr;heldAsr=undefined;gate.began.resolve();void gate.response.promise.then(()=>{if(socket.readyState===WebSocket.OPEN)socket.send(packet(reply,true));});}
        else socket.send(packet(reply, true));
      } }
    });
  });
  const app = createApp({ dataPath: ':memory:', now, env: { ...env, ...overrides },
    volcAsrConnect(url, options) {
      assert.ok(url === officialAsr || (overrides.VOLC_VOICEPRINT_ENABLED === 'true' && url === 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async'));
      assert.equal(options.followRedirects, false);
      return new WebSocket(`ws://127.0.0.1:${address.port}`, options);
    },
    fetch: (async (url, init) => {
      const target = new URL(String(url));
      if (overrides.VOLC_VOICEPRINT_ENABLED === 'true' && target.hostname === 'openspeech.bytedance.com') {
        const body = JSON.parse(String(init?.body)), action = target.searchParams.get('Action');
        assert.equal(target.pathname, '/api/proxy/invoke/');
        if (action === 'CreateVoiceprintGroup') return Response.json({ Result: { Code: 1000, GroupId: randomUUID() } });
        if (action === 'UpdateVoiceprint' && body.Action === 0) {
          const templateId = randomUUID(); enrolledSpeaker = body.SpeakerName;
          voiceprintTemplates.push({ templateId, speakerId: body.SpeakerName, groupId: body.GroupId });
          return Response.json({ Result: { Code: 1000, SpeakId: templateId } });
        }
        if (action === 'UpdateVoiceprint' && body.Action === 2) return Response.json({ Result: { Code: 1000 } });
        if (action === 'ListVoiceprint') return Response.json({ Result: { Code: 1000, AudioEmbedding: voiceprintTemplates.filter(value => value.groupId === body.GroupId).map(value => ({ SpeakId: value.templateId, SpeakerName: value.speakerId, Status: 1 })) } });
        throw new Error('unexpected synthetic voiceprint action');
      }
      assert.equal(new URL(String(url)).hostname, 'synthetic-language.invalid', 'no network provider may be used');
      assert.match(String(url), /\/chat\/completions$/);
      const body = JSON.parse(String(init?.body)); models.push(body);
      if (held?.model === body.model) { const gate = held; held = undefined; gate.began.resolve(); return gate.response.promise; }
      if (body.model === lite) {
        const system = body.messages.filter((message: any) => message.role === 'system').map((message: any) => message.content).join('\n');
        if (system.includes('自动语种判断')) return completion(JSON.stringify(inference));
        if (system.includes('BOBO_AUTO_MEMORY_EXTRACT_V1')) {
          const statements = JSON.parse(body.messages.at(-1).content).statements;
          return completion(JSON.stringify({ memories: statements.map((statement: any) => ({ statementId: statement.id, quote: statement.text, kind: 'preference' })) }));
        }
        return completion(JSON.stringify(system.includes('唯一字段meaning') ? { meaning: audioMeaning } : { meaning: audioMeaning, reply: audioMeaning }));
      }
      assert.equal(body.model, pro);
      return completion('可以先用长尺子轻轻拨出来，别把手伸得太深。');
    }) as typeof fetch,
  });
  let server: ReturnType<typeof app.listen> | undefined;
  t.after(async () => {
    for (const release of releases) release();
    app.locals.close();
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
    for (const socket of peer.clients) socket.terminate();
    await new Promise<void>(resolve => peer.close(() => resolve()));
  });
  const agent = request.agent(app), post = (path: string, body: object = {}) => agent.post(path).set('Origin', origin).send(body);
  const setup = await post('/api/setup', profile).expect(201);
  const cookie = (setup.headers['set-cookie'] as unknown as string[]).map(value => value.split(';')[0]).join('; ');
  const call = (await post('/api/calls', { operationId: randomUUID() }).expect(201)).body;
  const audio = () => agent.post(`/api/calls/${call.id}/audio`).set('Origin', origin).field('operationId', randomUUID())
    .attach('audio', wav(), { filename: 'synthetic-language.wav', contentType: 'audio/wav' });
  return { app, agent, post, call, audio, asrRequests, models, pcm,
    mode: (mode: object) => post(`/api/calls/${call.id}/mode`, mode),
    setResult(value: unknown) { payload = value; }, setMeaning(value: string) { audioMeaning = value; },
    setInference(value: unknown) { inference = value; },
    get enrolledSpeaker() { return enrolledSpeaker; },
    holdAsr() { const began=deferred<void>(),response=deferred<void>();heldAsr={began,response};const release=()=>response.resolve();releases.push(release);return {began:began.promise,release}; },
    hold(model: string, content?: object) {
      const began = deferred<void>(), response = deferred<Response>(); held = { model, began, response };
      const release = () => response.resolve(completion(model === lite ? JSON.stringify(content ?? { meaning: audioMeaning }) : '我们可以一起试试这个小办法。'));
      releases.push(release); return { began: began.promise, release };
    },
    async streamedAudio() {
      if (!server) { server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); }
      const target = server.address(); assert.ok(target && typeof target !== 'string');
      const form = new FormData(); form.set('operationId', randomUUID());
      form.set('audio', new Blob([wav()], { type: 'audio/wav' }), 'synthetic-language.wav');
      return fetch(`http://127.0.0.1:${target.port}/api/calls/${call.id}/audio`, {
        method: 'POST', headers: { Origin: origin, Cookie: cookie, Accept: 'application/x-ndjson' }, body: form,
      });
    },
  };
}

test('automatic selection requires the configured Byte ASR and original-audio understanding together', async t => {
  for (const override of [{ ASR_PROVIDER: 'openai' }, { CHAT_PROVIDER: 'openai' }, { CHAT_MODEL: '' }, { VOLC_ASR_RESOURCE_ID: '' }]) {
    const h = await harness(t, override);
    await h.mode({ mode: 'auto' }).expect(503);
    assert.equal(h.asrRequests.length, 0); assert.equal(h.models.length, 0);
  }
});

for (const language of ['mandarin', 'english', 'chaoshan', 'hakka'] as const) {
  test(`missing ASR language metadata is resolved from original audio as ${language} before Pro`, async t => {
    const h = await harness(t), understood = language === 'english' ? 'My paper boat is beside the window.' : '蓝色纸船刚才漂到窗边了。';
    h.setResult({ result: { text: wrongText } });
    h.setInference({ status: 'understood', language, text: understood });
    const turn = (await h.audio().expect(200)).body;
    assert.equal(turn.languageClarification, undefined); assert.equal(turn.detectedLanguage, language);
    assert.equal(turn.inputSource, 'interpretation'); assert.equal(turn.transcript, understood); assert.equal(turn.interpretedText, understood);
    assert.deepEqual(turn.conversationMode, { mode: 'auto' });
    assert.equal(h.asrRequests.length, 1); assert.equal(h.asrRequests[0].request.enable_lid, true); assert.equal(h.asrRequests[0].request.show_utterances, true);
    assert.deepEqual(h.models.map(body => body.model), [lite, pro], 'same inference supplies meaning without a second dialect-model call');
    const input = h.models[0].messages.at(-1).content;
    assert.deepEqual(Buffer.from(input.find((part: any) => part.type === 'input_audio').input_audio.data, 'base64'), wav());
    assert.equal(h.models[1].messages.at(-1).content, understood);
    assert.equal(JSON.stringify(h.models).includes(wrongText), false);
    assert.ok(turn.audioReview, 'one-time correction remains available for this successful automatic voice turn');
  });
}

test('two consecutive no-LID Mandarin utterances reply normally, and later English and dialect audio still switch automatically', async t => {
  const h = await harness(t); h.setResult({ result: { text: wrongText } });
  for (const [language, text] of [
    ['mandarin', '我的纸飞机飞到柜子上啦。'],
    ['mandarin', '现在它又掉到椅子下面了。'],
    ['english', 'I found my paper plane.'],
    ['hakka', '我拿到纸飞机，准备再试一次。'],
    ['chaoshan', '这次飞得更远了。'],
  ] as const) {
    h.setInference({ status: 'understood', language, text });
    const before = h.models.length, turn = (await h.audio().expect(200)).body;
    assert.equal(turn.languageClarification, undefined); assert.equal(turn.detectedLanguage, language); assert.equal(turn.transcript, text);
    assert.deepEqual(turn.conversationMode, { mode: 'auto' });
    assert.deepEqual(h.models.slice(before).map(body => body.model), [lite, pro]);
  }
  assert.equal(h.asrRequests.length, 5); assert.ok(h.asrRequests.every(value => value.request.enable_lid === true));
  assert.equal(JSON.stringify(h.models).includes(wrongText), false);
});

test('original-audio inference has no prior conversation or memory hint but Pro retains authorized history', async t => {
  const h = await harness(t), earlier = '上次我折了一只绿色的纸青蛙。';
  await h.post(`/api/calls/${h.call.id}/turn`, { text: earlier, operationId: randomUUID() }).expect(200);
  h.models.length = 0; h.setResult({ result: { text: wrongText } });
  h.setInference({ status: 'understood', language: 'mandarin', text: '今天我想折一条纸鱼。' });
  await h.audio().expect(200);
  assert.deepEqual(h.models.map(body => body.model), [lite, pro]);
  assert.equal(JSON.stringify(h.models[0]).includes(earlier), false);
  assert.ok(h.models[1].messages.some((message: any) => message.role === 'user' && message.content === earlier));
});

test('an uncertain original-audio judgment asks the language without passing its ASR text into history', async t => {
  const h = await harness(t); h.setResult({ result: { text: wrongText } });
  h.setInference({ status: 'uncertain', language: 'unknown', text: '' });
  const turn = (await h.audio().expect(200)).body;
  assert.ok(turn.languageClarification); assert.equal(turn.transcript, undefined); assert.equal(turn.inputSource, undefined);
  assert.equal(turn.reply, '你刚才说的是什么语言？'); assert.deepEqual(h.models.map(body => body.model), [lite]);
  assert.equal(JSON.stringify(h.models).includes(wrongText), false);
});

test('inaudible original audio requests a new recording instead of asking its language', async t => {
  const h = await harness(t); h.setResult({ result: { text: wrongText } });
  h.setInference({ status: 'inaudible', language: 'unknown', text: '' });
  const response = await h.audio().expect(422);
  assert.equal(response.body.code, 'ASR_EMPTY'); assert.match(response.body.error, /重新说|再说/);
  assert.equal(response.body.languageClarification, undefined); assert.equal(response.body.reply, undefined);
  assert.deepEqual(h.models.map(body => body.model), [lite]);
  await h.post(`/api/calls/${h.call.id}/end`).expect(200); await h.app.locals.waitForAutoMemory();
  assert.equal(h.models.length, 1);
});

test('ASR_EMPTY alone allows one raw-audio inference rescue with no second recognition', async t => {
  const h = await harness(t); h.setResult({});
  h.setInference({ status: 'understood', language: 'hakka', text: '纸船已经漂到岸边。' });
  const turn = (await h.audio().expect(200)).body;
  assert.equal(turn.transcript, '纸船已经漂到岸边。'); assert.equal(turn.detectedLanguage, 'hakka'); assert.equal(turn.inputSource, 'interpretation');
  assert.equal(h.asrRequests.length, 1); assert.deepEqual(h.models.map(body => body.model), [lite, pro]);
});

test('confirming Mandarin after ASR_EMPTY and an uncertain inference re-listens to the original recording', async t => {
  const h = await harness(t); h.setResult({});
  h.setInference({ status: 'uncertain', language: 'unknown', text: '' });
  const asked = (await h.audio().expect(200)).body;
  assert.ok(asked.languageClarification); assert.equal(asked.transcript, undefined);
  const actual = '我把蓝色纸船放到窗台上了。';
  h.setResult({ result: { text: actual } });
  const resolved = (await h.post(`/api/calls/${h.call.id}/language`, { clarificationId: asked.languageClarification.id, language: 'mandarin' }).expect(200)).body;
  assert.equal(resolved.transcript, actual); assert.equal(resolved.detectedLanguage, 'mandarin'); assert.equal(resolved.inputSource, 'transcript');
  assert.equal(resolved.languageClarification, undefined); assert.equal(resolved.audioReview, undefined);
  assert.deepEqual(resolved.conversationMode, { mode: 'auto' });
  assert.equal(h.asrRequests.length, 2); assert.equal(h.asrRequests[0].request.enable_lid, true); assert.equal(h.asrRequests[1].request.enable_lid, undefined);
  assert.deepEqual(Buffer.concat(h.pcm), Buffer.concat([wav().subarray(44), wav().subarray(44)]));
  assert.deepEqual(h.models.map(body => body.model), [lite, pro]);
  assert.equal(h.models[1].messages.at(-1).content, actual);
  const userMessages = h.models[1].messages.filter((message: any) => message.role === 'user').map((message: any) => message.content);
  assert.deepEqual(userMessages, [actual]);
  assert.equal(JSON.stringify(h.models[1]).includes('你刚才说的是什么语言'), false);
  assert.equal(JSON.stringify(h.models[1]).includes(wrongText), false);
});

test('a confirmed ordinary-language recording still empty on re-listen asks to re-record without Pro or stale pending audio', async t => {
  const h = await harness(t); h.setResult({});
  h.setInference({ status: 'uncertain', language: 'unknown', text: '' });
  const asked = (await h.audio().expect(200)).body;
  const failed = await h.post(`/api/calls/${h.call.id}/language`, { clarificationId: asked.languageClarification.id, language: 'mandarin' }).expect(422);
  assert.equal(failed.body.code, 'ASR_EMPTY'); assert.equal(failed.body.reply, undefined); assert.equal(failed.body.languageClarification, undefined);
  assert.equal(h.asrRequests.length, 2); assert.equal(h.asrRequests[0].request.enable_lid, true); assert.equal(h.asrRequests[1].request.enable_lid, undefined);
  assert.deepEqual(h.models.map(body => body.model), [lite]);
  await h.post(`/api/calls/${h.call.id}/language`, { clarificationId: asked.languageClarification.id, language: 'mandarin' }).expect(409);
  await h.post(`/api/calls/${h.call.id}/end`).expect(200); await h.app.locals.waitForAutoMemory();
  assert.deepEqual(h.models.map(body => body.model), [lite]);
});

test('ASR_EMPTY without a speaker payload clears the previously verified child before raw-audio fallback and private-memory use', async t => {
  const h = await harness(t, { VOLC_VOICEPRINT_ENABLED: 'true', VOLC_VOICEPRINT_API_KEY: 'synthetic-voiceprint-only', VOLC_VOICEPRINT_AUDIO_ORIGIN: 'https://baoyan.fixture.testing' });
  await h.post(`/api/calls/${h.call.id}/end`).expect(200);
  await h.post('/api/parent/unlock', { pin: profile.pin }).expect(200);
  const member = (await h.post('/api/parent/members', { name: '虚构声音孩子', relation: '孩子', consent: true }).expect(201)).body;
  await h.agent.post(`/api/parent/members/${member.id}/enroll`).set('Origin', origin).field('operationId', randomUUID())
    .field('consent', 'true').field('participantConfirmed', 'true').field('guardianConsent', 'true')
    .attach('audio', wav(6), { filename: 'synthetic-voice-enrollment.wav', contentType: 'audio/wav' }).expect(200);
  assert.ok(h.enrolledSpeaker);
  await h.agent.patch('/api/parent/settings').set('Origin', origin).send({ voiceEnabled: true, memoryEnabled: true }).expect(200);
  await h.post('/api/parent/lock').expect(200);
  Object.assign(h.call, (await h.post('/api/calls', { operationId: randomUUID(), voiceprintParticipation: true }).expect(201)).body);
  h.setResult({ result: { text: mandarin, additions: { lid_lang: 'speech_mand' }, utterances: [{ text: mandarin, additions: { speaker_id: h.enrolledSpeaker } }] } });
  const identified = (await h.audio().expect(200)).body;
  assert.equal(identified.speaker.status, 'known'); assert.equal(identified.speaker.name, '虚构声音孩子');
  assert.ok(h.asrRequests.at(-1).request.voiceprints);
  const secret = '我喜欢紫鲸纸艺';
  const memory = (await h.post(`/api/calls/${h.call.id}/turn`, { text: `帮我记住${secret}`, operationId: randomUUID() }).expect(200)).body;
  assert.ok(memory.candidate);
  await h.post(`/api/calls/${h.call.id}/memory/confirm`, { candidateId: memory.candidate.id, operationId: randomUUID() }).expect(200);
  const remembered = (await h.post(`/api/calls/${h.call.id}/turn`, { text: '你记得我喜欢什么纸艺吗？', operationId: randomUUID() }).expect(200)).body;
  assert.ok(JSON.stringify(h.models.at(-1).messages).includes(secret), 'verified child first has access to the personal memory');
  h.models.length = 0;
  const unverifiedStatement = '我喜欢橙色拼图';
  h.setResult({}); h.setInference({ status: 'understood', language: 'mandarin', text: unverifiedStatement });
  const fallback = (await h.audio().expect(200)).body;
  assert.equal(fallback.speaker.status, 'unknown'); assert.equal(fallback.speaker.name, undefined);
  assert.ok(fallback.speakerRevision > remembered.speakerRevision); assert.equal(fallback.candidate, undefined);
  assert.equal(fallback.transcript, unverifiedStatement); assert.deepEqual(h.models.map(body => body.model), [lite, pro]);
  assert.equal(JSON.stringify(h.models).includes(secret), false, 'raw-audio judgment and reply cannot inherit old private memory or history');
  h.setResult(result('speech_mand', '纸船现在漂过来啦。'));
  const paused = (await h.audio().expect(200)).body;
  assert.equal(paused.speaker.status, 'unknown'); assert.equal(h.asrRequests.at(-1).request.voiceprints, undefined, 'matching stays paused until an explicit retry');
  await h.post(`/api/calls/${h.call.id}/end`).expect(200); await h.app.locals.waitForAutoMemory();
  await h.post('/api/parent/unlock', { pin: profile.pin }).expect(200);
  const book = (await h.agent.get('/api/parent/memories').expect(200)).body;
  assert.ok(book.items.some((item: any) => item.content === secret));
  assert.equal(JSON.stringify(book).includes(unverifiedStatement), false, 'unverified input cannot enter automatic memories or daily summaries');
});

for (const [code, status, expectedCode] of [[55000031, 503, 'ASR_BUSY'], [45000081, 504, 'ASR_TIMEOUT'], [45000151, 400, 'ASR_AUDIO_INVALID']] as const) {
  test(`ASR error ${expectedCode} is not swallowed as an uncertain language or retried by Lite`, async t => {
    const h = await harness(t); h.setResult({ code });
    h.setInference({ status: 'understood', language: 'mandarin', text: mandarin });
    const response = await h.audio().expect(status);
    assert.equal(response.body.code, expectedCode); assert.equal(response.body.reply, undefined); assert.equal(response.body.languageClarification, undefined);
    assert.equal(h.models.length, 0); assert.equal(h.asrRequests.length, 1);
  });
}

for (const action of ['cancel', 'mode', 'end'] as const) {
  test(`a late automatic raw-audio result cannot publish after ${action}`, { timeout: 5000 }, async t => {
    const h = await harness(t); h.setResult({ result: { text: wrongText } });
    const gate = h.hold(lite, { status: 'understood', language: 'mandarin', text: mandarin });
    const pending = h.audio().then(value => value); await gate.began;
    if (action === 'mode') await h.mode({ mode: 'chat' }).expect(200);
    else await h.post(`/api/calls/${h.call.id}/${action}`).expect(200);
    gate.release(); const response = await pending;
    assert.ok([409, 410].includes(response.status)); assert.equal(response.body.reply, undefined); assert.equal(response.body.transcript, undefined);
    assert.deepEqual(h.models.map(body => body.model), [lite]);
  });
}

test('a slow automatic raw-audio judgment cannot extend the sixty-second clarification deadline', { timeout: 5000 }, async t => {
  let at = Date.now(); const h = await harness(t, {}, () => at); h.setResult({ result: { text: wrongText } });
  const gate = h.hold(lite, { status: 'uncertain', language: 'unknown', text: '' });
  const pending = h.audio().then(value => value); await gate.began;
  at += 30000; await h.post(`/api/calls/${h.call.id}/heartbeat`).expect(200); at += 30001;
  gate.release(); const response = await pending;
  assert.equal(response.status, 409); assert.equal(response.body.code, 'LANGUAGE_CLARIFICATION_EXPIRED');
  assert.equal(response.body.reply, undefined); assert.equal(response.body.languageClarification, undefined); assert.deepEqual(h.models.map(body => body.model), [lite]);
});

for (const [code, language] of [['speech_mand', 'mandarin'], ['speech_dia_chao', 'chaoshan'], ['speech_dia_hak', 'hakka']] as const) {
  test(`automatic ${language} selects one input route and preserves auto mode`, async t => {
    const h = await harness(t); h.setResult(result(code, language === 'mandarin' ? mandarin : wrongText));
    const selected = (await h.mode({ mode: 'auto' }).expect(200)).body; assert.equal(selected.mode, 'auto');
    const turn = (await h.audio().expect(200)).body;
    assert.equal(h.asrRequests.length, 1); assert.equal(h.asrRequests[0].request.enable_lid, true);
    assert.deepEqual(Buffer.concat(h.pcm), wav().subarray(44));
    assert.equal(turn.conversationMode.mode, 'auto'); assert.equal(turn.detectedLanguage, language);
    assert.equal(turn.inputSource, language === 'mandarin' ? 'transcript' : 'interpretation');
    assert.equal(turn.transcript, language === 'mandarin' ? mandarin : meaning);
    assert.deepEqual(h.models.map(body => body.model), language === 'mandarin' ? [pro] : [lite, pro]);
    assert.equal(h.models.at(-1).messages.at(-1).content, turn.transcript);
    if (language !== 'mandarin') {
      assert.equal(turn.interpretedText, meaning);
      const audio = h.models[0].messages.at(-1).content.find((part: any) => part.type === 'input_audio');
      assert.equal(audio.input_audio.format, 'wav'); assert.deepEqual(Buffer.from(audio.input_audio.data, 'base64'), wav());
      const instructions = h.models[0].messages.filter((message: any) => message.role === 'system').map((message: any) => message.content).join('\n');
      assert.match(instructions, /meaning/); assert.match(instructions, /不要.{0,12}(?:回答|回复|陪聊)|只.{0,12}(?:意思|含义|译意)/);
      assert.equal(JSON.stringify(h.models).includes(wrongText), false, 'misleading ASR text is not an understanding or reply input');
    }
  });
}

test('a documented dialect tag without any transcript still routes the original audio to Lite', async t => {
  const h = await harness(t); h.setResult({ result: { additions: { lid_lang: 'speech_dia_hak' } } });
  await h.mode({ mode: 'auto' }).expect(200); const turn = (await h.audio().expect(200)).body;
  assert.equal(turn.transcript, meaning); assert.equal(turn.detectedLanguage, 'hakka'); assert.equal(turn.inputSource, 'interpretation');
  assert.deepEqual(h.models.map(body => body.model), [lite, pro]);
});

test('Lite meaning extraction receives only the current recording while Pro retains authorized conversation context', async t => {
  const h = await harness(t), previous = '紫色纸船刚才被风吹到窗台上了。';
  await h.post(`/api/calls/${h.call.id}/turn`, { text: previous, operationId: randomUUID() }).expect(200);
  h.models.length = 0; h.setResult(result('speech_dia_chao', wrongText)); await h.mode({ mode: 'auto' }).expect(200);
  await h.audio().expect(200); assert.deepEqual(h.models.map(body => body.model), [lite, pro]);
  assert.equal(JSON.stringify(h.models[0].messages).includes(previous), false);
  assert.ok(h.models[1].messages.some((message: any) => message.role === 'user' && message.content === previous));
});

test('automatic input metadata is available in the first NDJSON frame before Pro finishes', { timeout: 5000 }, async t => {
  const h = await harness(t); h.setResult(result('speech_dia_chao', wrongText)); await h.mode({ mode: 'auto' }).expect(200);
  const gate = h.hold(pro), pending = h.streamedAudio(); await gate.began;
  const response = await pending; assert.equal(response.status, 200); assert.match(response.headers.get('content-type')!, /application\/x-ndjson/);
  const reader = response.body!.getReader(); const first = await reader.read(); assert.equal(first.done, false);
  const frame = JSON.parse(new TextDecoder().decode(first.value).trim());
  assert.equal(frame.type, 'transcript'); assert.equal(frame.text, meaning);
  assert.equal(frame.inputSource, 'interpretation'); assert.equal(frame.detectedLanguage, 'chaoshan');
  gate.release(); let remaining = ''; const decoder = new TextDecoder();
  for (;;) { const part = await reader.read(); if (part.done) break; remaining += decoder.decode(part.value, { stream: true }); }
  reader.releaseLock(); const terminal = JSON.parse(remaining.trim());
  assert.equal(terminal.type, 'turn'); assert.equal(terminal.turn.inputSource, 'interpretation');
  assert.equal(terminal.turn.detectedLanguage, 'chaoshan'); assert.equal(terminal.turn.conversationMode.mode, 'auto');
});

for (const [label, payload] of [
  ['absent', { result: { text: wrongText } }],
  ['unknown', result('invented_chaoyang', wrongText)],
  ['other dialect', result('speech_dia_nan', wrongText)],
  ['other language', result('speech_fr', wrongText)],
  ['conflicting', { result: { text: wrongText, additions: { lid_lang: 'speech_dia_hak' }, utterances: [{ additions: { lid_lang: 'speech_mand' } }] } }],
] as const) {
  test(`automatic ${label} asks only after one original-audio model cannot determine the language`, async t => {
    const h = await harness(t); h.setResult(payload); await h.mode({ mode: 'auto' }).expect(200);
    const response = await h.audio().set('Accept', 'application/x-ndjson').expect(200);
    assert.match(response.headers['content-type'], /application\/x-ndjson/);
    const frames = response.text.trim().split('\n').map((line: string) => JSON.parse(line));
    assert.equal(frames.length, 1); assert.equal(frames[0].type, 'turn');
    assert.equal(frames[0].turn.reply, '你刚才说的是什么语言？');
    assert.ok(frames[0].turn.languageClarification?.id);
    assert.equal(frames[0].turn.transcript, undefined);
    assert.equal(response.text.includes(wrongText), false); assert.deepEqual(h.models.map(body => body.model), [lite]);
    assert.equal(JSON.stringify(h.models).includes(wrongText), false);
    await h.post(`/api/calls/${h.call.id}/end`).expect(200); await h.app.locals.waitForAutoMemory();
    assert.equal(h.models.length, 1, 'uncertain input must not reach Pro or the memory summarizer');
    await h.post('/api/parent/unlock', { pin: profile.pin }).expect(200);
    const memories = (await h.agent.get('/api/parent/memories').expect(200)).body;
    assert.deepEqual(memories.items, []); assert.equal(JSON.stringify(memories).includes(wrongText), false);
  });
}

test('uncertain input cannot pollute later successful reply history', async t => {
  const h = await harness(t); await h.mode({ mode: 'auto' }).expect(200);
  h.setResult(result('speech_dia_nan', wrongText)); await h.audio().expect(200);
  await h.post(`/api/calls/${h.call.id}/cancel`).expect(200);
  h.setResult(result('speech_mand', mandarin)); await h.audio().expect(200);
  assert.deepEqual(h.models.map(body => body.model), [lite, pro]);
  assert.equal(JSON.stringify(h.models).includes(wrongText), false); assert.ok(JSON.stringify(h.models).includes(mandarin));
});

for (const action of ['cancel', 'mode'] as const) {
  test(`automatic dialect rejects an uncooperative late Lite result after ${action}`, { timeout: 5000 }, async t => {
    const h = await harness(t); h.setResult(result('speech_dia_hak', wrongText)); await h.mode({ mode: 'auto' }).expect(200);
    const gate = h.hold(lite), pending = h.audio().then(response => response); await gate.began;
    if (action === 'cancel') await h.post(`/api/calls/${h.call.id}/cancel`).expect(200);
    else await h.mode({ mode: 'chat' }).expect(200);
    gate.release(); const late = await pending;
    assert.equal(late.status, 409); assert.equal(late.body.code, 'CONTEXT_CHANGED'); assert.equal(late.body.reply, undefined);
    assert.deepEqual(h.models.map(body => body.model), [lite]);
    const next = await h.post(`/api/calls/${h.call.id}/turn`, { text: mandarin, operationId: randomUUID() }).expect(200);
    assert.equal(next.body.replyId !== undefined, true);
    assert.equal(JSON.stringify(h.models.at(-1).messages).includes(meaning), false);
    assert.equal(JSON.stringify(h.models.at(-1).messages).includes(wrongText), false);
  });
}

test('explicit ordinary and dialect selections override auto without further language detection', async t => {
  const h = await harness(t); h.setResult(result('speech_dia_chao', mandarin)); await h.mode({ mode: 'auto' }).expect(200);
  await h.audio().expect(200); assert.equal(h.asrRequests[0].request.enable_lid, true);
  await h.mode({ mode: 'chat' }).expect(200); const ordinary = (await h.audio().expect(200)).body;
  assert.equal(ordinary.conversationMode.mode, 'chat'); assert.equal(ordinary.transcript, mandarin);
  assert.equal(h.asrRequests.length, 2); assert.equal(h.asrRequests[1].request.enable_lid, undefined);
  h.models.length = 0;
  await h.mode({ mode: 'dialect', dialect: 'hakka', behavior: 'understand' }).expect(200);
  const dialect = (await h.audio().expect(200)).body;
  assert.equal(dialect.conversationMode.mode, 'dialect'); assert.equal(dialect.conversationMode.dialect, 'hakka');
  assert.equal(h.asrRequests.length, 2); assert.deepEqual(h.models.map(body => body.model), [lite, pro]);
});

test('explicit pure translation after auto bypasses detection and Pro and does not execute the translated command', async t => {
  const h = await harness(t); await h.mode({ mode: 'auto' }).expect(200);
  await h.mode({ mode: 'dialect', dialect: 'chaoshan', behavior: 'translate' }).expect(200);
  const translated = '帮我记住我喜欢画画'; h.setMeaning(translated);
  const turn = (await h.audio().expect(200)).body;
  assert.equal(turn.reply, translated); assert.equal(turn.candidate, undefined); assert.equal(turn.conversationMode.behavior, 'translate');
  assert.equal(h.asrRequests.length, 0); assert.deepEqual(h.models.map(body => body.model), [lite]);
});

test('correcting an automatically interpreted turn preserves its source and language while replacing the old meaning', async t => {
  const h = await harness(t); h.setResult(result('speech_dia_hak', wrongText)); await h.mode({ mode: 'auto' }).expect(200);
  const original = (await h.audio().expect(200)).body;
  const correctedMeaning = '我准备吃完饭洗碗，然后在家画画。';
  const corrected = (await h.post(`/api/calls/${h.call.id}/correct`, { replyId: original.replyId, text: correctedMeaning, operationId: randomUUID() }).expect(200)).body;
  assert.equal(corrected.inputSource, 'interpretation'); assert.equal(corrected.detectedLanguage, 'hakka');
  assert.equal(corrected.interpretedText, correctedMeaning); assert.equal(corrected.transcript, correctedMeaning);
  assert.equal(corrected.conversationMode.mode, 'auto'); assert.deepEqual(h.models.map(body => body.model), [lite, pro, pro]);
  const messages = h.models.at(-1).messages;
  assert.equal(messages.at(-1).content, correctedMeaning);
  assert.equal(messages.some((message: any) => message.role === 'user' && message.content === meaning), false);
  assert.equal(JSON.stringify(messages).includes(wrongText), false);
});

test('repeated corrections retain interpretation metadata without another ASR or Lite request', async t => {
  const h = await harness(t); h.setResult(result('speech_dia_chao', wrongText)); await h.mode({ mode: 'auto' }).expect(200);
  let turn = (await h.audio().expect(200)).body;
  for (const text of ['我准备洗完碗去公园。', '我准备洗完碗在家搭积木。']) {
    turn = (await h.post(`/api/calls/${h.call.id}/correct`, { replyId: turn.replyId, text, operationId: randomUUID() }).expect(200)).body;
    assert.equal(turn.inputSource, 'interpretation'); assert.equal(turn.detectedLanguage, 'chaoshan');
    assert.equal(turn.interpretedText, text); assert.equal(turn.conversationMode.mode, 'auto');
  }
  assert.equal(h.asrRequests.length, 1); assert.deepEqual(h.models.map(body => body.model), [lite, pro, pro, pro]);
});

test('a Mandarin label with empty text uses original-audio inference and inaudible input never reaches Pro', async t => {
  const h = await harness(t); await h.mode({ mode: 'auto' }).expect(200);
  h.setInference({ status: 'inaudible', language: 'unknown', text: '' });
  for (const text of ['', '   ']) {
    h.setResult(result('speech_mand', text)); const failure = await h.audio().expect(422);
    assert.equal(failure.body.code, 'ASR_EMPTY'); assert.equal(failure.body.reply, undefined);
  }
  assert.deepEqual(h.models.map(body => body.model), [lite, lite]);
});

test('the actual automatic HTTP stream passes the frontend decoder with matching source and canonical mode', async t => {
  const h = await harness(t); h.setResult(result('speech_dia_chao', wrongText));
  const selected = (await h.mode({ mode: 'auto' }).expect(200)).body; assert.deepEqual(selected, { mode: 'auto' });
  const seen: unknown[] = [];
  const turn = await readAudioTurnStream(await h.streamedAudio(), (text, metadata) => seen.push({ text, metadata }));
  assert.deepEqual(seen, [{ text: meaning, metadata: { inputSource: 'interpretation', detectedLanguage: 'chaoshan' } }]);
  assert.deepEqual(turn.conversationMode, { mode: 'auto' });
  assert.equal(turn.inputSource, 'interpretation'); assert.equal(turn.detectedLanguage, 'chaoshan');
  assert.equal(turn.transcript, meaning); assert.ok(turn.replyId);
});

test('changing language mode invalidates correction of the previous reply', async t => {
  const h = await harness(t); h.setResult(result('speech_dia_chao', wrongText)); await h.mode({ mode: 'auto' }).expect(200);
  const original = (await h.audio().expect(200)).body;
  await h.mode({ mode: 'chat' }).expect(200); const callsBefore = h.models.length;
  const stale = await h.post(`/api/calls/${h.call.id}/correct`, { replyId: original.replyId, text: '纠正后的普通话意思', operationId: randomUUID() }).expect(409);
  assert.equal(stale.body.code, 'CORRECTION_EXPIRED'); assert.equal(stale.body.reply, undefined);
  assert.equal(h.models.length, callsBefore);
});

test('a pure translation of do-not-record leaves earlier real-chat memory and daily-summary work intact', async t => {
  const h = await harness(t), preference = '我喜欢画画';
  await h.post(`/api/calls/${h.call.id}/turn`, { text: preference, operationId: randomUUID() }).expect(200);
  await h.mode({ mode: 'dialect', dialect: 'hakka', behavior: 'translate' }).expect(200);
  h.setMeaning('不要记录'); const translated = (await h.audio().expect(200)).body;
  assert.equal(translated.reply, '不要记录'); assert.equal(translated.candidate, undefined);
  await h.mode({ mode: 'chat' }).expect(200); await h.post(`/api/calls/${h.call.id}/end`).expect(200);
  await h.app.locals.waitForAutoMemory(); await h.post('/api/parent/unlock', { pin: profile.pin }).expect(200);
  const smallBook = (await h.agent.get('/api/parent/memories').expect(200)).body;
  assert.ok(smallBook.items.some((item: any) => item.content === preference));
  assert.equal(smallBook.dailySummaries.records.length, 1);
  assert.equal(smallBook.dailySummaries.records[0].turns, 1);
  assert.ok(smallBook.dailySummaries.records[0].topics.includes('画画与手工'));
  assert.equal(JSON.stringify(smallBook).includes('不要记录'), false);
  const summary = h.models.find(body => body.messages.some((message: any) => typeof message.content === 'string' && message.content.includes('BOBO_AUTO_MEMORY_EXTRACT_V1')));
  assert.ok(summary); assert.ok(summary.messages.at(-1).content.includes(preference));
  assert.equal(summary.messages.at(-1).content.includes('不要记录'), false);
});

test('later text replies retain the limits of earlier dialect meaning instead of treating it as exact audio evidence', async t => {
  const h = await harness(t); h.setResult(result('speech_dia_chao', wrongText)); await h.mode({ mode: 'auto' }).expect(200);
  const original = (await h.audio().expect(200)).body;
  assert.equal(original.inputSource, 'interpretation'); assert.equal(original.detectedLanguage, 'chaoshan');
  const currentInstructions = h.models.at(-1).messages.filter((message: any) => message.role === 'system').map((message: any) => message.content).join('\n');
  assert.match(currentInstructions, /译意/); assert.match(currentInstructions, /不.{0,15}逐字/); assert.match(currentInstructions, /不从.{0,25}原声语气/);
  for (let index = 0; index < 6; index++) {
    await h.post(`/api/calls/${h.call.id}/turn`, { text: `纸球旁边的第${index + 1}块积木怎么摆？`, operationId: randomUUID() }).expect(200);
    const instructions = h.models.at(-1).messages.filter((message: any) => message.role === 'system').map((message: any) => message.content).join('\n');
    assert.match(instructions, /历史.{0,30}(?:转写|译意)/);
    assert.match(instructions, /不.{0,15}逐字/); assert.match(instructions, /不从.{0,30}原声语气/);
  }
  const laterInstructions = h.models.at(-1).messages.filter((message: any) => message.role === 'system').map((message: any) => message.content).join('\n');
  assert.ok(laterInstructions.includes(meaning), 'the older meaning remains a bounded text clue even after leaving recent history');
  assert.equal(JSON.stringify(h.models.at(-1)).includes(wrongText), false);
});

test('a mistaken auto-language label can reuse original audio once and retract its mistaken meaning', async t => {
  const h = await harness(t); h.setResult(result('speech_mand', '我喜欢紫色轨道玩具。'));
  const original = (await h.audio().expect(200)).body;
  assert.equal(original.audioReview.replyId, original.replyId);
  assert.ok(Date.parse(original.audioReview.expiresAt) > Date.now());
  const retried = (await h.post(`/api/calls/${h.call.id}/audio-language`, {replyId:original.replyId,language:'chaoshan',operationId:randomUUID()}).expect(200)).body;
  assert.equal(retried.detectedLanguage,'chaoshan'); assert.equal(retried.inputSource,'interpretation');
  assert.equal(retried.transcript,meaning); assert.equal(retried.conversationMode.mode,'auto');
  assert.equal(retried.audioReview,undefined); assert.equal(h.asrRequests.length,1);
  assert.deepEqual(h.models.map(body=>body.model),[pro,lite,pro]);
  const audio=h.models[1].messages.at(-1).content.find((part:any)=>part.type==='input_audio');
  assert.deepEqual(Buffer.from(audio.input_audio.data,'base64'),wav());
  assert.equal(JSON.stringify(h.models.at(-1)).includes('我喜欢紫色轨道玩具。'),false);
  await h.post(`/api/calls/${h.call.id}/audio-language`, {replyId:original.replyId,language:'hakka',operationId:randomUUID()}).expect(409);
  h.setResult(result('speech_mand',mandarin));
  const next=(await h.audio().expect(200)).body;
  assert.equal(next.detectedLanguage,'mandarin'); assert.equal(h.asrRequests.length,2);
});

test('rechecking as English or Mandarin uses ASR again instead of relabelling a dialect meaning', async t=>{
  for(const language of ['mandarin','english'] as const){
    const h=await harness(t);h.setResult(result('speech_dia_hak',wrongText));
    const original=(await h.audio().expect(200)).body; const actual=language==='english'?'My paper plane is on the cupboard.':mandarin;
    h.setResult(result(language==='english'?'speech_en':'speech_mand',actual));
    const retried=(await h.post(`/api/calls/${h.call.id}/audio-language`,{replyId:original.replyId,language,operationId:randomUUID()}).expect(200)).body;
    assert.equal(retried.transcript,actual);assert.equal(retried.inputSource,'transcript');assert.equal(retried.detectedLanguage,language);
    assert.equal(h.asrRequests.length,2);assert.deepEqual(h.models.map(body=>body.model),[lite,pro,pro]);
    assert.equal(JSON.stringify(h.models.at(-1)).includes(meaning),false);
  }
});

for(const action of ['cancel','new-turn','correct','end','mode'] as const){
  test(`audio review is unavailable after ${action}, with no new supplier calls`,async t=>{
    const h=await harness(t);const original=(await h.audio().expect(200)).body;
    if(action==='new-turn')await h.post(`/api/calls/${h.call.id}/turn`,{text:'现在聊纸船',operationId:randomUUID()}).expect(200);
    else if(action==='correct')await h.post(`/api/calls/${h.call.id}/correct`,{replyId:original.replyId,text:'我画了纸船',operationId:randomUUID()}).expect(200);
    else if(action==='mode')await h.mode({mode:'auto'}).expect(200);
    else await h.post(`/api/calls/${h.call.id}/${action}`).expect(200);
    const count=h.models.length,asr=h.asrRequests.length;
    const retry=await h.post(`/api/calls/${h.call.id}/audio-language`,{replyId:original.replyId,language:'chaoshan',operationId:randomUUID()});
    assert.equal(retry.status,action==='end'?410:409);assert.equal(h.models.length,count);assert.equal(h.asrRequests.length,asr);
  });
}

test('audio review fixed TTL and current reply binding reject stale requests before a model call',async t=>{
  let at=Date.now();const h=await harness(t,{},()=>at);const original=(await h.audio().expect(200)).body;
  await h.post(`/api/calls/${h.call.id}/audio-language`,{replyId:randomUUID(),language:'chaoshan',operationId:randomUUID()}).expect(409);
  at+=30000;await h.post(`/api/calls/${h.call.id}/heartbeat`).expect(200);at+=30000;
  await h.post(`/api/calls/${h.call.id}/audio-language`,{replyId:original.replyId,language:'chaoshan',operationId:randomUUID()}).expect(409);
  assert.equal(h.models.length,1);assert.equal(h.asrRequests.length,1);
});

test('a language retry that is cancelled cannot return an old reply or restore wrong history',async t=>{
  const h=await harness(t);h.setResult(result('speech_mand',wrongText));const original=(await h.audio().expect(200)).body;
  const gate=h.hold(lite);
  const pending=h.post(`/api/calls/${h.call.id}/audio-language`,{replyId:original.replyId,language:'chaoshan',operationId:randomUUID()}).then(value=>value);
  await gate.began;await h.post(`/api/calls/${h.call.id}/cancel`).expect(200);gate.release();
  assert.equal((await pending).status,409);
  await h.post(`/api/calls/${h.call.id}/turn`,{text:'我们聊纸船吧',operationId:randomUUID()}).expect(200);
  assert.equal(JSON.stringify(h.models.at(-1)).includes(wrongText),false);
});

test('unknown-language clarification keeps the input deadline across slow ASR and never creates a second review window',async t=>{
  let at=Date.now();const started=at,h=await harness(t,{},()=>at);h.setResult(result('unknown',wrongText));
  const gate=h.holdAsr(),pending=h.audio().then(value=>value);await gate.began;
  at+=20000;gate.release();const asked=await pending;assert.equal(asked.status,200);
  assert.equal(Date.parse(asked.body.languageClarification.expiresAt),started+60000);
  const answered=(await h.post(`/api/calls/${h.call.id}/language`,{clarificationId:asked.body.languageClarification.id,language:'chaoshan'}).expect(200)).body;
  assert.equal(answered.transcript,meaning);assert.equal(answered.audioReview,undefined);
  const count=h.models.length;
  await h.post(`/api/calls/${h.call.id}/audio-language`,{replyId:answered.replyId,language:'hakka',operationId:randomUUID()}).expect(409);
  assert.equal(h.models.length,count);
});

test('an unknown-language ASR finishing beyond the input deadline asks for a new recording instead of retaining stale audio',async t=>{
  let at=Date.now();const h=await harness(t,{},()=>at);h.setResult(result('unknown',wrongText));
  const gate=h.holdAsr(),pending=h.audio().then(value=>value);await gate.began;
  at+=30000;await h.post(`/api/calls/${h.call.id}/heartbeat`).expect(200);at+=31000;gate.release();
  const response=await pending;assert.equal(response.status,409);assert.equal(response.body.code,'LANGUAGE_CLARIFICATION_EXPIRED');
  assert.equal(response.body.languageClarification,undefined);assert.equal(h.models.length,0);
});

test('a slow ordinary reply cannot reset the original audio review deadline',async t=>{
  let at=Date.now();const h=await harness(t,{},()=>at);h.setResult(result('speech_mand',mandarin));
  const gate=h.hold(pro),pending=h.audio().then(value=>value);await gate.began;
  at+=30000;await h.post(`/api/calls/${h.call.id}/heartbeat`).expect(200);at+=31000;gate.release();
  const response=await pending;assert.equal(response.status,200);assert.equal(response.body.audioReview,undefined);
  await h.post(`/api/calls/${h.call.id}/audio-language`,{replyId:response.body.replyId,language:'chaoshan',operationId:randomUUID()}).expect(409);
  assert.equal(h.models.length,1);
});

test('language recheck retracts mistaken memory and today topics before end-of-chat summaries',async t=>{
  const h=await harness(t);h.setResult(result('speech_mand','我喜欢游泳，今天准备去游泳。'));h.setMeaning('我喜欢画画，今天准备画纸船。');
  const original=(await h.audio().expect(200)).body;
  await h.post(`/api/calls/${h.call.id}/audio-language`,{replyId:original.replyId,language:'chaoshan',operationId:randomUUID()}).expect(200);
  await h.post(`/api/calls/${h.call.id}/end`).expect(200);await h.app.locals.waitForAutoMemory();await h.post('/api/parent/unlock',{pin:profile.pin}).expect(200);
  const book=(await h.agent.get('/api/parent/memories').expect(200)).body;
  assert.equal(JSON.stringify(book).includes('游泳'),false);assert.ok(JSON.stringify(book).includes('画画'));
  assert.equal(book.dailySummaries.records.length,1);assert.equal(book.dailySummaries.records[0].turns,1);
});

test('memory permission changes invalidate original audio review before another supplier call',async t=>{
  const h=await harness(t);const original=(await h.audio().expect(200)).body;
  await h.post('/api/parent/unlock',{pin:profile.pin}).expect(200);
  await h.agent.patch('/api/parent/settings').set('Origin',origin).send({memoryEnabled:false}).expect(200);
  const count=h.models.length,asr=h.asrRequests.length;
  await h.post(`/api/calls/${h.call.id}/audio-language`,{replyId:original.replyId,language:'chaoshan',operationId:randomUUID()}).expect(410);
  assert.equal(h.models.length,count);assert.equal(h.asrRequests.length,asr);
});

test('another family cannot use or consume a retained original utterance',async t=>{
  const h=await harness(t),original=(await h.audio().expect(200)).body,other=request.agent(h.app);
  await other.post('/api/setup').set('Origin',origin).send(profile).expect(201);
  const count=h.models.length,asr=h.asrRequests.length;
  await other.post(`/api/calls/${h.call.id}/audio-language`).set('Origin',origin).send({replyId:original.replyId,language:'chaoshan',operationId:randomUUID()}).expect(404);
  assert.equal(h.models.length,count);assert.equal(h.asrRequests.length,asr);
  await h.post(`/api/calls/${h.call.id}/audio-language`,{replyId:original.replyId,language:'chaoshan',operationId:randomUUID()}).expect(200);
});

test('a newer turn wins over an uncooperative old recheck without restoring mistaken history',async t=>{
  const h=await harness(t);h.setResult(result('speech_mand',wrongText));const original=(await h.audio().expect(200)).body;
  const gate=h.hold(lite),pending=h.post(`/api/calls/${h.call.id}/audio-language`,{replyId:original.replyId,language:'chaoshan',operationId:randomUUID()}).then(value=>value);
  await gate.began;await h.post(`/api/calls/${h.call.id}/turn`,{text:'我想聊刚折好的纸船',operationId:randomUUID()}).expect(200);gate.release();
  assert.equal((await pending).status,409);
  const last=h.models.at(-1);assert.equal(last.model,pro);assert.equal(last.messages.at(-1).content,'我想聊刚折好的纸船');
  assert.equal(JSON.stringify(last).includes(wrongText),false);assert.equal(JSON.stringify(last).includes(meaning),false);
});

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync, deflateSync } from 'node:zlib';
import request from 'supertest';
import WebSocket, { WebSocketServer } from 'ws';
import { createApp } from '../apps/server/src/app.js';
import { readAudioTurnStream } from '../apps/web/src/lib/audioTurnStream.js';

const origin = 'http://localhost:5173', officialAsr = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream';
const lite = 'doubao-seed-2-1-lite-260915', pro = 'doubao-seed-2-1-pro-260915';
const env = {
  CHAT_PROVIDER: 'volc', CHAT_API_BASE_URL: 'https://synthetic-clarification.invalid/api/v3', CHAT_API_KEY: 'synthetic-only', CHAT_MODEL: lite,
  VOLC_TEXT_CHAT_MODEL: pro, ASR_PROVIDER: 'volc', VOLC_SPEECH_API_KEY: 'synthetic-only', VOLC_ASR_RESOURCE_ID: 'volc.seedasr.sauc.duration', VOLC_ASR_URL: officialAsr,
  TTS_PROVIDER: 'openai', TTS_API_BASE_URL: 'https://synthetic-clarification.invalid/v1', TTS_API_KEY: 'synthetic-only', TTS_MODEL: 'synthetic-voice',
};
const profile = { pin: '123456', nickname: '虚构澄清测试', ageGroup: '6-8', sessionMinutes: 10, dailyMinutes: 30, consent: true };
const wrongText = '帮我记住我喜欢错误小火车';
const meaning = '我喜欢画画';
const normalText = '小猫把纸球推到桌子下面了。';
const answer = (content: string) => Response.json({ choices: [{ finish_reason: 'stop', message: { content } }] });
const result = (code: string, text = normalText) => ({ result: { text, additions: { lid_lang: code } } });
const unknownResult = () => ({ result: { text: wrongText } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function wav(marker = 1234) {
  const bytes = Buffer.alloc(3244); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(3200, 40);
  for (let offset = 44; offset < bytes.length; offset += 2) bytes.writeInt16LE(marker, offset); return bytes;
}
function packet(payload: unknown, final = false) {
  const body = gzipSync(Buffer.from(JSON.stringify(payload))), header = Buffer.alloc(12);
  header.set([0x11, final ? 0x93 : 0x91, 0x11, 0]); header.writeInt32BE(final ? -1 : 1, 4); header.writeUInt32BE(body.length, 8);
  return Buffer.concat([header, body]);
}
function crc32(bytes: Buffer) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
function pngChunk(type: string, data = Buffer.alloc(0)) { const chunk = Buffer.alloc(data.length + 12); chunk.writeUInt32BE(data.length); chunk.write(type, 4); data.copy(chunk, 8); chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4); return chunk; }
function photo() { const header = Buffer.alloc(13); header.writeUInt32BE(16); header.writeUInt32BE(16, 4); header[8] = 8; header[9] = 2; return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(Buffer.alloc(16 * 49))), pngChunk('IEND')]); }

async function harness(t: TestContext) {
  const peer = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(peer, 'listening');
  const address = peer.address(); assert.ok(address && typeof address !== 'string');
  let time = Date.parse('2026-10-12T08:00:00Z'), payload: unknown = unknownResult(), interpreted = meaning;
  const asrRequests: any[] = [], models: any[] = [], speech: any[] = [];
  let held: { began: ReturnType<typeof deferred<void>>; response: ReturnType<typeof deferred<Response>> } | undefined;
  const releases: Array<() => void> = [];
  peer.on('connection', socket => { let current: unknown; socket.on('message', raw => {
    const bytes = Buffer.from(raw as Buffer); assert.equal(bytes[0], 0x11); assert.equal(bytes.readUInt32BE(8), bytes.length - 12);
    const body = gunzipSync(bytes.subarray(12)), type = bytes[1]! >> 4;
    if (type === 1) { asrRequests.push(JSON.parse(body.toString())); current = payload; socket.send(packet({})); }
    else if ((bytes[1]! & 15) === 3) socket.send(packet(current, true));
  }); });
  const app = createApp({ dataPath: ':memory:', env, now: () => time,
    volcAsrConnect(url, options) { assert.equal(url, officialAsr); return new WebSocket(`ws://127.0.0.1:${address.port}`, options); },
    fetch: (async (url, init) => {
      const target = new URL(String(url)); assert.equal(target.hostname, 'synthetic-clarification.invalid');
      const body = JSON.parse(String(init?.body));
      if (target.pathname.endsWith('/audio/speech')) { speech.push(body); return new Response(wav(0), { headers: { 'Content-Type': 'audio/wav' } }); }
      assert.match(target.pathname, /\/chat\/completions$/); models.push(body);
      if (body.model === pro) return answer('我们可以慢慢把这件小事做好。');
      assert.equal(body.model, lite);
      const system = body.messages.filter((message: any) => message.role === 'system').map((message: any) => message.content).join('\n');
      if (system.includes('自动语种判断')) return answer(JSON.stringify({ status: 'uncertain', language: 'unknown', text: '' }));
      if (system.includes('BOBO_AUTO_MEMORY_EXTRACT_V1')) {
        const statements = JSON.parse(body.messages.at(-1).content).statements;
        return answer(JSON.stringify({ memories: statements.map((statement: any) => ({ statementId: statement.id, quote: statement.text, kind: 'preference' })) }));
      }
      const content = body.messages.at(-1).content;
      if (Array.isArray(content) && content.some((part: any) => part.type === 'image_url')) return answer(JSON.stringify({facts:'画面里是一幅简单的图。',uncertainties:''}));
      if (held) { const gate = held; held = undefined; gate.began.resolve(); return gate.response.promise; }
      return answer(JSON.stringify({ meaning: interpreted }));
    }) as typeof fetch,
  });
  let server: ReturnType<typeof app.listen> | undefined;
  t.after(async () => {
    for (const release of releases) release(); app.locals.close();
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
    for (const socket of peer.clients) socket.terminate(); await new Promise<void>(resolve => peer.close(() => resolve()));
  });
  const agent = request.agent(app), post = (path: string, body: object = {}) => agent.post(path).set('Origin', origin).send(body);
  const setup = await post('/api/setup', profile).expect(201), cookie = (setup.headers['set-cookie'] as unknown as string[]).map(value => value.split(';')[0]).join('; ');
  const call = (await post('/api/calls', { operationId: randomUUID() }).expect(201)).body;
  const audio = (marker = 1234, clarificationId?: string) => {
    const upload = agent.post(`/api/calls/${call.id}/audio`).set('Origin', origin).field('operationId', randomUUID());
    if (clarificationId) upload.field('clarificationId', clarificationId);
    return upload.attach('audio', wav(marker), { filename: 'synthetic.wav', contentType: 'audio/wav' });
  };
  const text = (value: string, clarificationId?: string) => post(`/api/calls/${call.id}/turn`, { text: value, operationId: randomUUID(), ...(clarificationId ? { clarificationId } : {}) });
  return { app, agent, post, call, audio, text, models, speech, asrRequests,
    get now() { return time; }, advance(ms: number) { time += ms; }, setResult(value: unknown) { payload = value; }, setMeaning(value: string) { interpreted = value; },
    confirm: (id: string, language: string) => post(`/api/calls/${call.id}/language`, { clarificationId: id, language }),
    async ask() { payload = unknownResult(); const response = await audio().expect(200); assert.ok(response.body.languageClarification); return response.body; },
    holdLite() { const began = deferred<void>(), response = deferred<Response>(); held = { began, response }; const release = () => response.resolve(answer(JSON.stringify({ meaning: interpreted }))); releases.push(release); return { began: began.promise, release }; },
    async stream() {
      if (!server) { server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); }
      const target = server.address(); assert.ok(target && typeof target !== 'string');
      const body = new FormData(); body.set('operationId', randomUUID()); body.set('audio', new Blob([wav()], { type: 'audio/wav' }), 'synthetic.wav');
      return fetch(`http://127.0.0.1:${target.port}/api/calls/${call.id}/audio`, { method: 'POST', headers: { Origin: origin, Cookie: cookie, Accept: 'application/x-ndjson' }, body });
    },
  };
}
function clarification(turn: any, now: number) {
  assert.ok(turn.replyId); assert.equal(turn.mode, 'live'); assert.deepEqual(turn.conversationMode, { mode: 'auto' });
  assert.match(turn.languageClarification.id, /^[0-9a-f-]{36}$/); assert.equal(Date.parse(turn.languageClarification.expiresAt) - now, 60000);
  assert.equal(turn.transcript, undefined); assert.equal(turn.inputSource, undefined); assert.equal(turn.detectedLanguage, undefined);
  assert.equal(turn.reply, '你刚才说的是什么语言？'); assert.equal(turn.candidate, undefined);
}

test('configured normal calls automatically detect their first Mandarin recording without a mode request', async t => {
  const h = await harness(t); h.setResult(result('speech_mand')); const turn = (await h.audio().expect(200)).body;
  assert.equal(h.asrRequests[0].request.enable_lid, true); assert.deepEqual(turn.conversationMode, { mode: 'auto' });
  assert.equal(turn.detectedLanguage, 'mandarin'); assert.deepEqual(h.models.map(body => body.model), [pro]);
});

test('a confirmed English label uses its transcript and never substitutes a dialect or Lite interpretation', async t => {
  const h = await harness(t), english = 'I made a blue paper boat today.'; h.setResult(result('speech_en', english));
  const turn = (await h.audio().expect(200)).body;
  assert.equal(turn.detectedLanguage, 'english'); assert.equal(turn.inputSource, 'transcript'); assert.equal(turn.transcript, english);
  assert.deepEqual(h.models.map(body => body.model), [pro]); assert.equal(h.models[0].messages.at(-1).content, english);
});

for (const label of ['speech_ja', 'speech_dia_nan', 'invented_english']) {
  test(`unsupported ${label} asks which language instead of treating it as English`, async t => {
    const h = await harness(t); h.setResult(result(label, wrongText)); const turn = (await h.audio().expect(200)).body;
    clarification(turn, h.now); assert.equal(h.models.length, 1); assert.equal(JSON.stringify(turn).includes(wrongText), false);
  });
}

test('an unknown recording creates a speakable clarification only after one original-audio inference attempt', async t => {
  const h = await harness(t), turn = await h.ask(); clarification(turn, h.now); assert.equal(h.models.length, 1);
  await h.post(`/api/calls/${h.call.id}/speech`, { replyId: turn.replyId }).expect(200);
  assert.equal(h.speech.length, 1); assert.equal(h.speech[0].input, turn.reply);
});

test('an unknown NDJSON request may start with the terminal clarification Turn and passes the normal decoder', async t => {
  const h = await harness(t), response = await h.stream(), transcriptEvents: unknown[] = [];
  const turn = await readAudioTurnStream(response, (value, metadata) => transcriptEvents.push({ value, metadata }));
  clarification(turn, h.now); assert.deepEqual(transcriptEvents, []); assert.equal(h.models.length, 1);
});

for (const language of ['chaoshan', 'hakka'] as const) {
  test(`confirming ${language} reuses the retained original recording rather than doing ASR again`, async t => {
    const h = await harness(t), ask = await h.ask(); const turn = (await h.confirm(ask.languageClarification.id, language).expect(200)).body;
    assert.equal(turn.languageClarification, undefined); assert.equal(turn.detectedLanguage, language); assert.equal(turn.inputSource, 'interpretation');
    assert.equal(turn.transcript, meaning); assert.deepEqual(turn.conversationMode, { mode: 'auto' });
    assert.equal(h.asrRequests.length, 1); assert.deepEqual(h.models.map(body => body.model), [lite, lite, pro]);
    const audio = h.models[1].messages.at(-1).content.find((part: any) => part.type === 'input_audio');
    assert.deepEqual(Buffer.from(audio.input_audio.data, 'base64'), wav());
    assert.equal(JSON.stringify(h.models).includes(wrongText), false);
  });
}

for (const language of ['mandarin', 'english'] as const) {
  test(`explicit ${language} confirmation uses the original ASR text with no second recognition or Lite`, async t => {
    const h = await harness(t); h.setResult({ result: { text: normalText } });
    const ask = (await h.audio().expect(200)).body, turn = (await h.confirm(ask.languageClarification.id, language).expect(200)).body;
    assert.equal(turn.transcript, normalText); assert.equal(turn.detectedLanguage, language); assert.equal(turn.inputSource, 'transcript');
    assert.equal(h.asrRequests.length, 1); assert.deepEqual(h.models.map(body => body.model), [lite, pro]);
    assert.equal(h.models[1].messages.at(-1).content, normalText);
  });
}

for (const language of ['mandarin', 'english'] as const) {
  test(`confirming ${language} cannot turn an empty original transcript into guessed content`, async t => {
    const h = await harness(t); h.setResult(result('speech_ja', '   '));
    const ask = (await h.audio().expect(200)).body;
    const response = await h.confirm(ask.languageClarification.id, language).expect(422);
    assert.equal(response.body.code, 'ASR_EMPTY'); assert.equal(h.asrRequests.length, 2); assert.equal(h.models.length, 1);
    assert.equal(h.asrRequests[1].request.enable_lid, undefined);
    await h.confirm(ask.languageClarification.id, language).expect(409);
  });
}

for (const phrase of ['我说的是潮汕话', '我说的是英语', 'English']) {
  test(`a short text language answer '${phrase}' resolves the old recording without adding confirmation to history`, async t => {
    const h = await harness(t), ask = await h.ask(); const turn = (await h.text(phrase, ask.languageClarification.id).expect(200)).body;
    assert.equal(turn.languageClarification, undefined); assert.equal(turn.detectedLanguage, phrase.includes('潮汕') ? 'chaoshan' : 'english');
    assert.equal(h.asrRequests.length, 1);
    assert.equal(JSON.stringify(h.models).includes(phrase), false);
    await h.text('纸球在桌子下面怎么办？').expect(200);
    assert.equal(h.models.at(-1).messages.some((message: any) => message.role === 'user' && message.content === phrase), false);
  });
}

test('a spoken language answer is recognized once then the earlier recording is interpreted, not the confirmation recording', async t => {
  const h = await harness(t), ask = await h.ask(); const phrase = '我说的是客家话'; h.setResult(result('speech_mand', phrase));
  const turn = (await h.audio(2345, ask.languageClarification.id).expect(200)).body;
  assert.equal(turn.detectedLanguage, 'hakka'); assert.equal(h.asrRequests.length, 2); assert.deepEqual(h.models.map(body => body.model), [lite, lite, pro]);
  const audio = h.models[1].messages.at(-1).content.find((part: any) => part.type === 'input_audio');
  assert.deepEqual(Buffer.from(audio.input_audio.data, 'base64'), wav(1234));
  assert.notDeepEqual(Buffer.from(audio.input_audio.data, 'base64'), wav(2345));
  assert.equal(JSON.stringify(h.models).includes(phrase), false);
});

test('non-language or unsupported answers ask again without extending the original retention deadline or calling Pro', async t => {
  const h = await harness(t), original = await h.ask(); h.advance(5000);
  for (const phrase of ['我说的是法语', '帮我记住我喜欢错误小火车']) {
    const again = (await h.text(phrase).expect(200)).body;
    assert.equal(again.languageClarification.id, original.languageClarification.id);
    assert.equal(again.languageClarification.expiresAt, original.languageClarification.expiresAt);
    assert.equal(again.transcript, undefined); assert.equal(again.candidate, undefined);
  }
  assert.equal(h.models.length, 1); await h.post(`/api/calls/${h.call.id}/end`).expect(200); await h.app.locals.waitForAutoMemory();
  await h.post('/api/parent/unlock', { pin: profile.pin }).expect(200);
  const book = (await h.agent.get('/api/parent/memories').expect(200)).body;
  assert.deepEqual(book.items, []); assert.deepEqual(book.dailySummaries.records, []); assert.equal(h.models.length, 1);
});

test('clarification and confirmation are excluded while only the finally understood personal statement can enter memory and the daily summary', async t => {
  const h = await harness(t); await h.ask(); const turn = (await h.text('我说的是潮汕话').expect(200)).body;
  assert.equal(turn.transcript, meaning); await h.post(`/api/calls/${h.call.id}/end`).expect(200); await h.app.locals.waitForAutoMemory();
  await h.post('/api/parent/unlock', { pin: profile.pin }).expect(200);
  const book = (await h.agent.get('/api/parent/memories').expect(200)).body;
  assert.ok(book.items.some((item: any) => item.content === meaning)); assert.equal(book.dailySummaries.records[0].turns, 1);
  assert.equal(JSON.stringify(book).includes(wrongText), false); assert.equal(JSON.stringify(book).includes('我说的是潮汕话'), false);
});

test('a language confirmation only covers the retained recording and subsequent audio remains automatic', async t => {
  const h = await harness(t), ask = await h.ask(); await h.confirm(ask.languageClarification.id, 'chaoshan').expect(200);
  h.setResult(result('speech_en', 'Where is the little paper boat?')); h.models.length = 0;
  const next = (await h.audio().expect(200)).body;
  assert.equal(next.detectedLanguage, 'english'); assert.deepEqual(next.conversationMode, { mode: 'auto' });
  assert.equal(h.asrRequests[1].request.enable_lid, true); assert.deepEqual(h.models.map(body => body.model), [pro]);
});

test('other families and anonymous clients cannot resolve a retained recording', async t => {
  const h = await harness(t), ask = await h.ask(), stranger = request.agent(h.app);
  await stranger.post('/api/setup').set('Origin', origin).send({ ...profile, nickname: '虚构另一家庭' }).expect(201);
  const body = { clarificationId: ask.languageClarification.id, language: 'chaoshan' };
  await stranger.post(`/api/calls/${h.call.id}/language`).set('Origin', origin).send(body).expect(404);
  await request(h.app).post(`/api/calls/${h.call.id}/language`).set('Origin', origin).send(body).expect(401);
  await h.confirm(ask.languageClarification.id, 'french').expect(400); assert.equal(h.models.length, 1);
  await h.confirm(ask.languageClarification.id, 'chaoshan').expect(200);
});

test('an incorrect clarification id does not discard the valid retained recording', async t => {
  const h = await harness(t), ask = await h.ask();
  const stale = await h.confirm(randomUUID(), 'chaoshan').expect(409);
  assert.equal(stale.body.code, 'LANGUAGE_CLARIFICATION_EXPIRED'); assert.equal(h.models.length, 1);
  await h.confirm(ask.languageClarification.id, 'chaoshan').expect(200);
  assert.deepEqual(h.models.map(body => body.model), [lite, lite, pro]);
  await h.confirm(ask.languageClarification.id, 'chaoshan').expect(409);
  assert.deepEqual(h.models.map(body => body.model), [lite, lite, pro]);
});

test('concurrent confirmations only consume the retained recording once and cannot clear the first request buffer', { timeout: 5000 }, async t => {
  const h = await harness(t), ask = await h.ask(), gate = h.holdLite();
  const first = h.confirm(ask.languageClarification.id, 'chaoshan').then(response => response); await gate.began;
  const concurrent = await h.confirm(ask.languageClarification.id, 'hakka').expect(409);
  assert.equal(concurrent.body.code, 'LANGUAGE_CLARIFICATION_IN_PROGRESS'); assert.deepEqual(h.models.map(body => body.model), [lite, lite]);
  gate.release(); const resolved = await first;
  assert.equal(resolved.status, 200); assert.equal(resolved.body.transcript, meaning); assert.equal(resolved.body.detectedLanguage, 'chaoshan');
  const audio = h.models[1].messages.at(-1).content.find((part: any) => part.type === 'input_audio');
  assert.deepEqual(Buffer.from(audio.input_audio.data, 'base64'), wav()); assert.deepEqual(h.models.map(body => body.model), [lite, lite, pro]);
  await h.confirm(ask.languageClarification.id, 'chaoshan').expect(409); assert.deepEqual(h.models.map(body => body.model), [lite, lite, pro]);
});

test('an unsupported spoken answer keeps the original audio and deadline instead of replacing it with the answer recording', async t => {
  const h = await harness(t), ask = await h.ask(); h.advance(5000); h.setResult(result('speech_mand', '我说的是法语'));
  const repeated = (await h.audio(2345).expect(200)).body;
  assert.equal(repeated.languageClarification.id, ask.languageClarification.id);
  assert.equal(repeated.languageClarification.expiresAt, ask.languageClarification.expiresAt);
  assert.equal(repeated.transcript, undefined); assert.equal(h.models.length, 1);
  await h.confirm(ask.languageClarification.id, 'hakka').expect(200);
  const audio = h.models[1].messages.at(-1).content.find((part: any) => part.type === 'input_audio');
  assert.deepEqual(Buffer.from(audio.input_audio.data, 'base64'), wav(1234));
  assert.equal(JSON.stringify(h.models).includes('我说的是法语'), false);
});

test('asking again replaces only the speakable question and invalidates the older TTS reply id', async t => {
  const h = await harness(t), ask = await h.ask(), again = (await h.text('我说的是法语').expect(200)).body;
  assert.notEqual(again.replyId, ask.replyId); assert.deepEqual(again.languageClarification, ask.languageClarification);
  await h.post(`/api/calls/${h.call.id}/speech`, { replyId: ask.replyId }).expect(409);
  await h.post(`/api/calls/${h.call.id}/speech`, { replyId: again.replyId }).expect(200);
  assert.equal(h.speech.length, 1); assert.equal(h.speech[0].input, '你刚才说的是什么语言？');
});

test('switching the selected child prevents the pending original from resolving into another profile', async t => {
  const h = await harness(t), ask = await h.ask();
  await h.post('/api/parent/unlock', { pin: profile.pin }).expect(200);
  const next = (await h.post('/api/parent/children', { nickname: '虚构另一资料', ageGroup: '6-8', sessionMinutes: 10, dailyMinutes: 30 }).expect(201)).body;
  await h.post(`/api/parent/children/${next.id}/select`).expect(200);
  const stale = await h.confirm(ask.languageClarification.id, 'chaoshan');
  assert.ok([404, 409, 410].includes(stale.status)); assert.equal(stale.body.reply, undefined); assert.equal(h.models.length, 1);
  await h.app.locals.waitForAutoMemory();
  const book = (await h.agent.get('/api/parent/memories').expect(200)).body;
  assert.deepEqual(book.items, []); assert.deepEqual(book.dailySummaries.records, []);
});

for (const action of ['cancel', 'mode', 'end', 'image'] as const) {
  test(`${action} discards the pending original recording and prevents its later confirmation`, async t => {
    const h = await harness(t), ask = await h.ask();
    if (action === 'mode') await h.post(`/api/calls/${h.call.id}/mode`, { mode: 'chat' }).expect(200);
    else if (action === 'image') {
      const turn=(await h.agent.post(`/api/calls/${h.call.id}/image`).set('Origin', origin).field('operationId', randomUUID()).field('question', '看看这幅图')
        .attach('image', photo(), { filename: 'synthetic.png', contentType: 'image/png' }).expect(200)).body;
      assert.equal(turn.inputKind,'image');assert.deepEqual(h.models.map(body=>body.model),[lite,lite,pro]);
      assert.equal(h.models[1].messages.at(-1).content[0].type,'image_url');
      assert.equal(h.models[2].messages.at(-1).content.includes('imageObservation'),true);
    }
    else await h.post(`/api/calls/${h.call.id}/${action}`).expect(200);
    const callsBefore = h.models.length, stale = await h.confirm(ask.languageClarification.id, 'chaoshan');
    assert.ok([409, 410].includes(stale.status)); assert.equal(stale.body.reply, undefined); assert.equal(h.models.length, callsBefore);
  });
}

test('retained audio expires after sixty seconds even while the call lease is renewed', async t => {
  const h = await harness(t), ask = await h.ask(); h.advance(30000); await h.post(`/api/calls/${h.call.id}/heartbeat`).expect(200);
  h.advance(30001); const stale = await h.confirm(ask.languageClarification.id, 'chaoshan');
  assert.ok([409, 410].includes(stale.status)); assert.equal(stale.body.reply, undefined); assert.equal(h.models.length, 1);
});

for (const invalidation of ['ttl', 'cancel'] as const) {
  for (const channel of ['text', 'audio'] as const) {
    test(`${invalidation} cannot turn a ${channel} answer carrying the old clarification id into a new chat`, async t => {
      const h = await harness(t), ask = await h.ask();
      if (invalidation === 'cancel') await h.post(`/api/calls/${h.call.id}/cancel`).expect(200);
      else { h.advance(30000); await h.post(`/api/calls/${h.call.id}/heartbeat`).expect(200); h.advance(30001); h.app.locals.sweepExpiredState(); }
      h.setResult(result('speech_mand', '我说的是英语'));
      const asrBefore = h.asrRequests.length;
      const stale = channel === 'text'
        ? await h.text('我说的是英语', ask.languageClarification.id).expect(409)
        : await h.audio(2345, ask.languageClarification.id).expect(409);
      assert.equal(stale.body.code, 'LANGUAGE_CLARIFICATION_EXPIRED'); assert.equal(stale.body.reply, undefined);
      assert.equal(h.asrRequests.length, asrBefore); assert.equal(h.models.length, 1);
      await h.post(`/api/calls/${h.call.id}/end`).expect(200); await h.app.locals.waitForAutoMemory();
      await h.post('/api/parent/unlock', { pin: profile.pin }).expect(200);
      const book = (await h.agent.get('/api/parent/memories').expect(200)).body;
      assert.deepEqual(book.items, []); assert.deepEqual(book.dailySummaries.records, []); assert.equal(h.models.length, 1);
    });
  }
}

for (const action of ['cancel', 'ttl'] as const) {
  test(`a ${action} during confirmed Lite understanding blocks its uncooperative late reply`, { timeout: 5000 }, async t => {
    const h = await harness(t), ask = await h.ask(), gate = h.holdLite();
    const pending = h.confirm(ask.languageClarification.id, 'chaoshan').then(response => response); await gate.began;
    if (action === 'cancel') await h.post(`/api/calls/${h.call.id}/cancel`).expect(200);
    else { h.advance(30000); await h.post(`/api/calls/${h.call.id}/heartbeat`).expect(200); h.advance(30001); h.app.locals.sweepExpiredState(); }
    gate.release(); const late = await pending; assert.ok([409, 410, 499].includes(late.status)); assert.equal(late.body.reply, undefined);
    assert.deepEqual(h.models.map(body => body.model), [lite, lite]);
  });
}

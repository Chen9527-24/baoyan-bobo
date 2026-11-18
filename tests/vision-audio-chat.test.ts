import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { deflateSync, gunzipSync } from 'node:zlib';
import request from 'supertest';
import WebSocket from 'ws';
import { createApp, type AppOptions } from '../apps/server/src/app.js';
import { MAX_VISION_IMAGE_BYTES } from '../apps/server/src/vision.js';
import { IMAGE_FACTS_TASK } from '../apps/server/src/providers.js';

const origin = 'http://localhost:5173';
const transcript = '这张画里的蓝色部分是什么？';
const profile = { pin: '123456', nickname: '虚构图片语音', ageGroup: '6-8', sessionMinutes: 10, dailyMinutes: 20, consent: true };
const env = {
  CHAT_PROVIDER: 'volc', CHAT_API_BASE_URL: 'https://synthetic-vision.invalid/api/v3', CHAT_API_KEY: 'synthetic-only', CHAT_MODEL: 'doubao-seed-2-1-lite-260915', VOLC_TEXT_CHAT_MODEL: 'doubao-seed-2-1-pro-260915',
  ASR_PROVIDER: 'openai', ASR_API_BASE_URL: 'https://synthetic-asr.invalid/v1', ASR_API_KEY: 'synthetic-only', ASR_MODEL: 'synthetic-asr',
};
const volcEnv = { ASR_PROVIDER: 'volc', VOLC_ASR_URL: 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream', VOLC_ASR_RESOURCE_ID: 'volc.seedasr.sauc.duration', VOLC_SPEECH_API_KEY: 'synthetic-only' };
const completion = (content: string) => Response.json({ choices: [{ finish_reason: 'stop', message: { content } }] });
const factsCompletion = () => completion(JSON.stringify({ facts: '画面有一片蓝色区域，像水面。', uncertainties: '' }));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function crc32(data: Buffer) { let crc = 0xffffffff; for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
function chunk(kind: string, data = Buffer.alloc(0)) { const result = Buffer.alloc(data.length + 12); result.writeUInt32BE(data.length); result.write(kind, 4, 'ascii'); data.copy(result, 8); result.writeUInt32BE(crc32(result.subarray(4, result.length - 4)), result.length - 4); return result; }
function photo() {
  const header = Buffer.alloc(13); header.writeUInt32BE(32); header.writeUInt32BE(24, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc(24 * (1 + 32 * 3)))), chunk('IEND')]);
}
function wav() {
  const result = Buffer.alloc(44 + 1600 * 2); result.write('RIFF'); result.writeUInt32LE(result.length - 8, 4); result.write('WAVEfmt ', 8);
  result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20); result.writeUInt16LE(1, 22); result.writeUInt32LE(16000, 24); result.writeUInt32LE(32000, 28);
  result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34); result.write('data', 36); result.writeUInt32LE(result.length - 44, 40); return result;
}
function rawAsrResult(payload: unknown, requests: any[]) {
  const packet = (final: boolean) => {
    const data = Buffer.from(JSON.stringify(final ? payload : {})), prefix = Buffer.alloc(8);
    prefix.set([0x11, final ? 0x92 : 0x90, 0x10, 0]); prefix.writeUInt32BE(data.length, 4); return Buffer.concat([prefix, data]);
  };
  class ResultSocket extends EventEmitter {
    readyState = WebSocket.OPEN;
    constructor() { super(); queueMicrotask(() => this.emit('open')); }
    send(data: Buffer, done: (error?: Error) => void) {
      const type = data[1]! >> 4;
      if (type === 1) requests.push(JSON.parse(gunzipSync(data.subarray(12)).toString()));
      done(); queueMicrotask(() => this.emit('message', packet(type === 2), true));
    }
    terminate() { this.readyState = WebSocket.CLOSED as typeof WebSocket.OPEN; }
  }
  return () => new ResultSocket() as unknown as WebSocket;
}
function harness(t: TestContext, options: { fetch?: typeof fetch; env?: Record<string, string | undefined>; volcAsrConnect?: AppOptions['volcAsrConnect'] } = {}) {
  const stages: string[] = [], bodies: any[] = [];
  let cookie = '';
  const app = createApp({ dataPath: ':memory:', env: { ...env, ...options.env }, volcAsrConnect: options.volcAsrConnect, fetch: async (url, init) => {
    if (String(url).endsWith('/audio/transcriptions')) stages.push('asr');
    else { const body = JSON.parse(String(init?.body)); bodies.push(body); const content = body.messages.at(-1).content; stages.push(Array.isArray(content) ? content.some((part: any) => part.type === 'input_audio') ? 'audio-language' : 'vision' : 'chat'); }
    if (options.fetch) return options.fetch(url, init);
    if (String(url).endsWith('/audio/transcriptions')) return Response.json({ text: transcript });
    return JSON.parse(String(init?.body)).messages[0].content === IMAGE_FACTS_TASK ? factsCompletion() : completion('蓝色这一块像一片小湖。');
  } });
  t.after(() => app.locals.close());
  const agent = request.agent(app), post = (path: string, body: object = {}) => agent.post(path).set('Origin', origin).send(body);
  const start = async () => { const setup = await post('/api/setup', profile).expect(201); cookie = String(setup.headers['set-cookie'][0]).split(';')[0]!; return (await post('/api/calls', { operationId: crypto.randomUUID() }).expect(201)).body.id as string; };
  const image = (id: string, settings: { audio?: Buffer; mime?: string; question?: string; image?: Buffer; imageMime?: string; operationId?: string; agent?: typeof agent } = {}) => {
    const call = (settings.agent ?? agent).post(`/api/calls/${id}/image`).set('Origin', origin).field('operationId', settings.operationId ?? crypto.randomUUID());
    if (settings.question !== undefined) call.field('question', settings.question);
    call.attach('image', settings.image ?? photo(), { filename: 'virtual.png', contentType: settings.imageMime ?? 'image/png' });
    if (settings.audio !== undefined) call.attach('audio', settings.audio, { filename: 'virtual.webm', contentType: settings.mime ?? 'audio/webm' });
    return call;
  };
  return { app, agent, post, start, image, stages, bodies, get cookie() { return cookie; } };
}

test('one image request transcribes its question then extracts facts before one unified main reply', async t => {
  const h = harness(t), id = await h.start();
  const result = (await h.image(id, { audio: Buffer.from('synthetic voice') }).expect(200)).body;
  assert.deepEqual(h.stages, ['asr', 'vision', 'chat']); assert.equal(result.transcript, transcript); assert.equal(result.inputKind, 'image'); assert.ok(result.replyId);
  const parts = h.bodies[0].messages.at(-1).content;
  assert.equal(parts[0].type, 'image_url'); assert.deepEqual(parts[1], { type: 'text', text: transcript });
  assert.equal(h.bodies[0].model, env.CHAT_MODEL); assert.equal(h.bodies[0].messages.length, 2);
  assert.equal(h.bodies[1].model, env.VOLC_TEXT_CHAT_MODEL);
  assert.equal(JSON.parse(h.bodies[1].messages.at(-1).content).question, transcript);
  assert.doesNotMatch(JSON.stringify(h.bodies), /synthetic voice|input_audio/);
  await h.post(`/api/calls/${id}/turn`, { text: '换个话题', operationId: crypto.randomUUID() }).expect(200);
  const history = h.bodies[2].messages;
  assert.equal(history.filter((m: any) => m.role === 'user' && m.content === transcript).length, 1);
  assert.equal(history.filter((m: any) => m.role === 'assistant' && m.content === result.reply).length, 1);
});

test('image plus no-LID audio first understands the original question and then extracts image facts before Pro', async t => {
  const requests: any[] = [], understood = '画上这条蓝色的弯弯是什么？', misleading = '帮我记住我喜欢错误小火车';
  const h = harness(t, { env: volcEnv, volcAsrConnect: rawAsrResult({ result: { text: misleading } }, requests),
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)), system = body.messages.filter((message: any) => message.role === 'system').map((message: any) => message.content).join('\n');
      if (system.includes('自动语种判断')) return completion(JSON.stringify({ status: 'understood', language: 'chaoshan', text: understood }));
      return body.messages[0].content === IMAGE_FACTS_TASK ? factsCompletion() : completion('这条蓝色的弯弯看起来像一条小河。');
    },
  }), id = await h.start();
  const turn = (await h.image(id, { audio: wav(), mime: 'audio/wav' }).expect(200)).body;
  assert.equal(turn.inputKind, 'image'); assert.equal(turn.detectedLanguage, 'chaoshan'); assert.equal(turn.inputSource, 'interpretation');
  assert.equal(turn.transcript, understood); assert.equal(turn.interpretedText, understood); assert.equal(turn.languageClarification, undefined);
  assert.deepEqual(h.stages, ['audio-language', 'vision', 'chat']);
  assert.equal(requests.length, 1); assert.equal(requests[0].request.enable_lid, true); assert.equal(requests[0].request.show_utterances, true);
  assert.deepEqual(h.bodies.map(body => body.model), [env.CHAT_MODEL, env.CHAT_MODEL, env.VOLC_TEXT_CHAT_MODEL]);
  const raw = h.bodies[0].messages.at(-1).content;
  assert.ok(raw.every((part: any) => part.type !== 'image_url'), 'audio judgment never sees the photo as evidence for language');
  assert.deepEqual(Buffer.from(raw.find((part: any) => part.type === 'input_audio').input_audio.data, 'base64'), wav());
  assert.equal(h.bodies[1].messages.at(-1).content.find((part: any) => part.type === 'text').text, understood);
  assert.equal(JSON.parse(h.bodies[2].messages.at(-1).content).question, understood);
  assert.equal(JSON.stringify(h.bodies).includes(misleading), false);
  assert.equal(turn.audioReview, undefined, 'image audio has no standalone retained review copy');
});

test('image plus genuinely uncertain original audio asks only after one raw-audio judgment and can resume with its original photo', async t => {
  const requests: any[] = [], misleading = '帮我记住这张图是我家的房间';
  const h = harness(t, { env: volcEnv, volcAsrConnect: rawAsrResult({ result: { text: misleading } }, requests),
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)), system = body.messages.filter((message: any) => message.role === 'system').map((message: any) => message.content).join('\n');
      if (system.includes('自动语种判断')) return completion(JSON.stringify({ status: 'uncertain', language: 'unknown', text: '' }));
      if (body.messages[0].content === IMAGE_FACTS_TASK) return factsCompletion();
      if (body.model === env.CHAT_MODEL) return completion(JSON.stringify({ meaning: transcript }));
      return completion('蓝色的地方像一片小湖。');
    },
  }), id = await h.start();
  const ask = (await h.image(id, { audio: wav(), mime: 'audio/wav' }).expect(200)).body;
  assert.ok(ask.languageClarification); assert.equal(ask.transcript, undefined); assert.deepEqual(h.stages, ['audio-language']);
  const resolved = (await h.post(`/api/calls/${id}/language`, { clarificationId: ask.languageClarification.id, language: 'hakka' }).expect(200)).body;
  assert.equal(resolved.inputKind, 'image'); assert.equal(resolved.transcript, transcript); assert.equal(resolved.detectedLanguage, 'hakka');
  assert.deepEqual(h.stages, ['audio-language', 'audio-language', 'vision', 'chat']); assert.equal(requests.length, 1);
  assert.equal(JSON.stringify(h.bodies).includes(misleading), false);
});

test('image plus inaudible audio asks for a new recording instead of a language and does not inspect the photo', async t => {
  const requests: any[] = [];
  const h = harness(t, { env: volcEnv, volcAsrConnect: rawAsrResult({}, requests),
    fetch: async () => completion(JSON.stringify({ status: 'inaudible', language: 'unknown', text: '' })),
  }), id = await h.start();
  const response = await h.image(id, { audio: wav(), mime: 'audio/wav' }).expect(422);
  assert.ok(['ASR_EMPTY', 'AUDIO_EMPTY'].includes(response.body.code)); assert.match(response.body.error, /重新说|再说/);
  assert.equal(response.body.reply, undefined); assert.equal(response.body.languageClarification, undefined);
  assert.deepEqual(h.stages, ['audio-language']); assert.equal(requests.length, 1);
});
test('audio accepts an omitted or blank text question while two nonempty questions are rejected', async t => {
  const h = harness(t), id = await h.start();
  await h.image(id, { audio: Buffer.from('synthetic'), question: '   ' }).expect(200);
  const count = h.stages.length;
  const conflict = await h.image(id, { audio: Buffer.from('synthetic'), question: '另一句问题' }).expect(400);
  assert.equal(conflict.body.code, 'IMAGE_QUESTION_CONFLICT'); assert.equal(h.stages.length, count);
  const onlyImage = (await h.image(id).expect(200)).body;
  assert.equal(onlyImage.transcript, undefined); assert.equal(onlyImage.inputKind, 'image'); assert.equal(h.stages.length, count + 2);
  assert.equal(JSON.parse(h.bodies.at(-1).messages.at(-1).content).questionSource, 'system-default');
});
test('original text image path and operation replay remain available without ASR', async t => {
  const h = harness(t, { env: { ASR_API_KEY: '' } }), id = await h.start(), operationId = crypto.randomUUID();
  const first = (await h.image(id, { question: '看看这一块', operationId }).expect(200)).body;
  const repeat = (await h.image(id, { question: '看看这一块', operationId }).expect(200)).body;
  assert.equal(first.transcript, '看看这一块'); assert.equal(repeat.replyId, first.replyId); assert.deepEqual(h.stages, ['vision', 'chat']);
  const unavailable = await h.image(id, { audio: Buffer.from('synthetic') }).expect(503);
  assert.equal(unavailable.body.code, 'ASR_NOT_CONFIGURED'); assert.deepEqual(h.stages, ['vision', 'chat']);
});
test('empty audio, mismatched image MIME, unsupported audio and repeated audio fail before ASR', async t => {
  const h = harness(t), id = await h.start();
  const empty = await h.image(id, { audio: Buffer.alloc(0) }).expect(422); assert.equal(empty.body.code, 'AUDIO_EMPTY');
  await h.image(id, { audio: Buffer.from('synthetic'), imageMime: 'image/jpeg' }).expect(400);
  const format = await h.image(id, { audio: Buffer.from('synthetic'), mime: 'text/plain' }).expect(415); assert.equal(format.body.code, 'AUDIO_TYPE');
  await h.image(id, { audio: Buffer.from('synthetic') }).attach('audio', Buffer.from('second'), { filename: 'second.webm', contentType: 'audio/webm' }).expect(413);
  assert.equal(h.stages.length, 0);
});
test('production WAV contract rejects malformed bytes and unsupported containers before connecting', async t => {
  let connections = 0;
  const h = harness(t, { env: volcEnv, volcAsrConnect: () => { connections++; throw new Error('must not connect'); } }), id = await h.start();
  for (const setting of [{ audio: Buffer.from('not wav'), mime: 'audio/wav' }, { audio: wav(), mime: 'audio/webm' }]) {
    const result = await h.image(id, setting).expect(400); assert.equal(result.body.code, 'ASR_AUDIO_INVALID');
  }
  assert.equal(connections, 0); assert.equal(h.stages.length, 0);
});
test('a valid recording with no recognized speech returns a retryable error without vision', async t => {
  let connections = 0;
  const packet = (final: boolean) => { const data = Buffer.from('{}'), prefix = Buffer.alloc(8); prefix.set([0x11, final ? 0x92 : 0x90, 0x10, 0]); prefix.writeUInt32BE(data.length, 4); return Buffer.concat([prefix, data]); };
  class EmptySocket extends EventEmitter {
    readyState = WebSocket.OPEN;
    constructor() { super(); queueMicrotask(() => this.emit('open')); }
    send(data: Buffer, done: (error?: Error) => void) { done(); queueMicrotask(() => this.emit('message', packet((data[1]! >> 4) === 2), true)); }
    terminate() { this.readyState = WebSocket.CLOSED as typeof WebSocket.OPEN; }
  }
  const h = harness(t, { env: volcEnv, volcAsrConnect: () => { connections++; return new EmptySocket() as unknown as WebSocket; } }), id = await h.start();
  await h.post(`/api/calls/${id}/mode`, { mode: 'chat' }).expect(200);
  const result = await h.image(id, { audio: wav(), mime: 'audio/wav' }).expect(422);
  assert.equal(result.body.code, 'AUDIO_EMPTY'); assert.match(result.body.error, /重新说/); assert.equal(connections, 1); assert.equal(h.stages.length, 0);
});
test('an empty or overlong ASR result never becomes an image question or fallback chat', async t => {
  for (const text of ['   ', '字'.repeat(601)]) {
    const h = harness(t, { fetch: async () => Response.json({ text }) }), id = await h.start();
    const result = await h.image(id, { audio: Buffer.from('synthetic') });
    assert.equal(result.status, text.trim() ? 400 : 502); assert.equal(result.body.reply, undefined); assert.deepEqual(h.stages, ['asr']);
  }
});
test('image and audio retain independent bounded sizes and oversized text is rejected', async t => {
  const h = harness(t), id = await h.start();
  const audio = await h.image(id, { audio: Buffer.alloc(8 * 1024 * 1024 + 1) }).expect(413); assert.equal(audio.body.code, 'AUDIO_LIMIT');
  const image = await h.image(id, { image: Buffer.alloc(MAX_VISION_IMAGE_BYTES + 1), audio: Buffer.from('synthetic') }).expect(413); assert.equal(image.body.code, 'IMAGE_LIMIT');
  await h.image(id, { question: '字'.repeat(601) }).expect(400); assert.equal(h.stages.length, 0);
});
test('combined image audio preserves anonymous, origin and family authorization boundaries', async t => {
  const h = harness(t), id = await h.start();
  await request(h.app).post(`/api/calls/${id}/image`).set('Origin', origin).field('operationId', crypto.randomUUID()).attach('image', photo(), { filename: 'v.png', contentType: 'image/png' }).attach('audio', Buffer.from('synthetic'), { filename: 'v.webm', contentType: 'audio/webm' }).expect(401);
  await h.image(id, { audio: Buffer.from('synthetic') }).set('Origin', 'https://untrusted.invalid').expect(403);
  const other = request.agent(h.app); await other.post('/api/setup').set('Origin', origin).send({ ...profile, nickname: '虚构另一家庭' }).expect(201);
  await h.image(id, { audio: Buffer.from('synthetic'), agent: other }).expect(404); assert.equal(h.stages.length, 0);
});
test('combined upload cannot use dialect mode or silently replace an active content task', async t => {
  const h = harness(t), id = await h.start();
  await h.post(`/api/calls/${id}/mode`, { mode: 'dialect', dialect: 'hakka', behavior: 'understand' }).expect(200);
  const dialect = await h.image(id, { audio: Buffer.from('synthetic') }).expect(409); assert.equal(dialect.body.code, 'VISION_CHAT_ONLY');
  await h.post(`/api/calls/${id}/mode`, { mode: 'chat' }).expect(200);
  const catalog = (await h.agent.get('/api/software/catalog').expect(200)).body;
  await h.post(`/api/calls/${id}/task`, { kind: 'story', storyId: catalog.stories[0].id, operationId: crypto.randomUUID() }).expect(200);
  await h.image(id, { audio: Buffer.from('synthetic') }).expect(409); assert.equal(h.stages.length, 0);
});
test('cancel during ASR rejects an uncooperative late transcript before any image reply', { timeout: 5000 }, async t => {
  const entered = deferred<void>(), delayed = deferred<Response>(); t.after(() => delayed.resolve(Response.json({ text: transcript })));
  const h = harness(t, { fetch: async (url) => { if (String(url).endsWith('/audio/transcriptions')) { entered.resolve(); return delayed.promise; } return completion('新回复'); } }), id = await h.start();
  const pending = h.image(id, { audio: Buffer.from('synthetic') }).then(r => r); await entered.promise;
  await h.post(`/api/calls/${id}/cancel`).expect(200); delayed.resolve(Response.json({ text: transcript }));
  const late = await pending; assert.equal(late.status, 409); assert.equal(late.body.code, 'CONTEXT_CHANGED'); assert.equal(late.body.reply, undefined); assert.deepEqual(h.stages, ['asr']);
  await h.post(`/api/calls/${id}/turn`, { text: '新话题', operationId: crypto.randomUUID() }).expect(200);
  assert.ok(!h.bodies[0].messages.some((m: any) => m.content === transcript));
});
test('cancel during vision rejects the late image reply after ASR without registering it', { timeout: 5000 }, async t => {
  const entered = deferred<void>(), delayed = deferred<Response>(); t.after(() => delayed.resolve(completion('迟到回复')));
  const h = harness(t, { fetch: async (url) => { if (String(url).endsWith('/audio/transcriptions')) return Response.json({ text: transcript }); entered.resolve(); return delayed.promise; } }), id = await h.start();
  const pending = h.image(id, { audio: Buffer.from('synthetic') }).then(r => r); await entered.promise;
  await h.post(`/api/calls/${id}/cancel`).expect(200); delayed.resolve(completion('迟到回复'));
  const late = await pending; assert.equal(late.status, 409); assert.equal(late.body.reply, undefined); assert.equal(late.body.replyId, undefined); assert.deepEqual(h.stages, ['asr', 'vision']);
});
test('a newer ordinary turn invalidates the old image ASR instead of generating a second reply', { timeout: 5000 }, async t => {
  const entered = deferred<void>(), delayed = deferred<Response>(); t.after(() => delayed.resolve(Response.json({ text: transcript })));
  const h = harness(t, { fetch: async url => { if (String(url).endsWith('/audio/transcriptions')) { entered.resolve(); return delayed.promise; } return completion('先聊现在这件事'); } }), id = await h.start();
  const pending = h.image(id, { audio: Buffer.from('synthetic') }).then(r => r); await entered.promise;
  await h.post(`/api/calls/${id}/turn`, { text: '先聊现在这件事', operationId: crypto.randomUUID() }).expect(200); delayed.resolve(Response.json({ text: transcript }));
  const late = await pending; assert.equal(late.status, 409); assert.equal(late.body.reply, undefined); assert.deepEqual(h.stages, ['asr', 'chat']);
});
test('selecting another child while ASR is pending closes the old image turn', { timeout: 5000 }, async t => {
  const entered = deferred<void>(), delayed = deferred<Response>(); t.after(() => delayed.resolve(Response.json({ text: transcript })));
  const h = harness(t, { fetch: async () => { entered.resolve(); return delayed.promise; } }), id = await h.start();
  const pending = h.image(id, { audio: Buffer.from('synthetic') }).then(r => r); await entered.promise;
  await h.post('/api/parent/unlock', { pin: profile.pin }).expect(200);
  const child = (await h.post('/api/parent/children', { nickname: '虚构第二资料', ageGroup: '6-8', sessionMinutes: 10, dailyMinutes: 30 }).expect(201)).body;
  await h.post(`/api/parent/children/${child.id}/select`).expect(200); delayed.resolve(Response.json({ text: transcript }));
  const late = await pending; assert.equal(late.status, 410); assert.equal(late.body.reply, undefined); assert.deepEqual(h.stages, ['asr']);
});
test('canceling an unfinished multipart upload prevents ASR from starting after its final bytes arrive', { timeout: 5000 }, async t => {
  const h = harness(t), id = await h.start(), server = h.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const entered = deferred<void>(); server.once('request', () => entered.resolve());
  const boundary = 'synthetic-picture-audio-boundary';
  const first = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="operationId"\r\n\r\n${crypto.randomUUID()}\r\n--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="virtual.webm"\r\nContent-Type: audio/webm\r\n\r\nsynthetic`);
  const rest = Buffer.concat([Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="virtual.png"\r\nContent-Type: image/png\r\n\r\n`), photo(), Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const done = deferred<{ status: number; body: any }>();
  const upload = httpRequest({ hostname: '127.0.0.1', port: address.port, path: `/api/calls/${id}/image`, method: 'POST', headers: { Origin: origin, Cookie: h.cookie, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': first.length + rest.length } }, res => {
    const pieces: Buffer[] = []; res.on('data', data => pieces.push(data)); res.on('end', () => done.resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(pieces).toString()) }));
  });
  t.after(() => upload.destroy()); upload.write(first); await entered.promise;
  await h.post(`/api/calls/${id}/cancel`).expect(200); upload.end(rest);
  const late = await done.promise; assert.equal(late.status, 409); assert.equal(late.body.code, 'CONTEXT_CHANGED'); assert.equal(h.stages.length, 0);
});
test('image speech remains image evidence and does not create candidates or automatic memories', async t => {
  const h = harness(t, { fetch: async (url, init) => String(url).endsWith('/audio/transcriptions') ? Response.json({ text: '帮我记住这张图是我的新房间' }) : JSON.parse(String(init?.body)).messages[0].content === IMAGE_FACTS_TASK ? factsCompletion() : completion('我们可以一起看看画面。') }), id = await h.start();
  const turn = (await h.image(id, { audio: Buffer.from('synthetic') }).expect(200)).body; assert.equal(turn.candidate, undefined);
  await h.post(`/api/calls/${id}/end`).expect(200); await h.app.locals.waitForAutoMemory();
  assert.deepEqual(h.stages, ['asr', 'vision', 'chat']); await h.post('/api/parent/unlock', { pin: profile.pin }).expect(200);
  assert.equal((await h.agent.get('/api/parent/memories').expect(200)).body.items.length, 0);
});
test('ASR and vision share the existing provider budget without retries or a no-image fallback', async t => {
  const h = harness(t, { env: { TRIAL_ENABLED: 'true', TRIAL_REQUIRE_INVITE: 'false', TRIAL_ENDS_AT: '2099-10-12T12:54:09Z', TRIAL_DAILY_PROVIDER_CALLS: '1' } }), id = await h.start();
  const result = await h.image(id, { audio: Buffer.from('synthetic') }).expect(429);
  assert.equal(result.body.reply, undefined); assert.deepEqual(h.stages, ['asr']);
});

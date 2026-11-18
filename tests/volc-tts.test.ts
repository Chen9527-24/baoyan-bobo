import test from 'node:test';
import assert from 'node:assert/strict';
import { createVolcTts } from '../apps/server/src/volc-tts.js';
import { ApiError } from '../apps/server/src/provider-errors.js';

const endpoint = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse';
const env = {
  VOLC_SPEECH_API_KEY: 'synthetic-volc-key',
  VOLC_TTS_URL: endpoint,
  VOLC_TTS_VOICE_ID: 'zh_female_vv_uranus_bigtts',
  VOLC_TTS_RESOURCE_ID: 'seed-tts-2.0',
};
const audio = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64]);
const encoder = new TextEncoder();
const event = (id: number, frame: Record<string, unknown>, newline = '\n') => `event: ${id}${newline}data: ${JSON.stringify(frame)}${newline}${newline}`;
const audioEvent = (bytes: Uint8Array = audio, newline = '\n') => event(352, { code: 0, message: '', data: Buffer.from(bytes).toString('base64') }, newline);
const terminal = () => event(152, { code: 20000000, message: 'OK', data: null, usage: { text_words: 5 } });
const response = (text = audioEvent() + terminal()) => new Response(text, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
const providerError = (error: unknown) => error instanceof ApiError && error.status === 502 && error.code === 'PROVIDER_ERROR';

test('TTS requires an explicit SSE URL and dedicated speech credentials and voice', async () => {
  let calls = 0;
  const fetcher = (async () => { calls++; return response(); }) as typeof fetch;
  for (const incomplete of [
    {},
    { API_BASE_URL: endpoint, API_KEY: 'generic', ARK_API_KEY: 'ark', VOLC_TTS_VOICE_ID: env.VOLC_TTS_VOICE_ID },
    { ...env, VOLC_TTS_URL: '' },
    { ...env, VOLC_SPEECH_API_KEY: '' },
    { ...env, VOLC_TTS_VOICE_ID: '' },
    { ...env, VOLC_TTS_URL: endpoint.replace('/sse', '') },
  ]) {
    const p = createVolcTts({ env: incomplete, fetch: fetcher });
    assert.equal(p.configured, false);
    await assert.rejects(p.speech('已审核短回复'), (error: unknown) => error instanceof ApiError && error.status === 503);
  }
  assert.equal(calls, 0);
});

test('configuration rejects unsafe URLs, unsupported resources, header injection and invalid rates', () => {
  for (const override of [
    { VOLC_TTS_URL: 'http://remote.example/api/v3/tts/unidirectional/sse' },
    { VOLC_TTS_URL: 'https://user:secret@openspeech.bytedance.com/api/v3/tts/unidirectional/sse' },
    { VOLC_TTS_URL: `${endpoint}?credential=bad` },
    { VOLC_TTS_URL: `${endpoint}#fragment` },
    { VOLC_TTS_RESOURCE_ID: 'seed-icl-2.0' },
    { VOLC_SPEECH_API_KEY: 'bad\r\nInjected: value' },
    { VOLC_TTS_VOICE_ID: 'bad voice' },
    { VOLC_TTS_SPEECH_RATE: 'NaN' },
    { VOLC_TTS_SPEECH_RATE: '0.5' },
    { VOLC_TTS_SPEECH_RATE: '101' },
    { VOLC_TTS_SPEECH_RATE: '-51' },
  ]) assert.equal(createVolcTts({ env: { ...env, ...override } }).configured, false);
  assert.equal(createVolcTts({ env: { ...env, VOLC_TTS_URL: 'http://127.0.0.1:3456/api/v3/tts/unidirectional/sse' } }).configured, true);
});

test('new authentication does not mix legacy or Ark credentials; request fixes MP3 and natural delivery', async () => {
  let sent: RequestInit | undefined; let target = '';
  const p = createVolcTts({ env: { ...env, VOLC_SPEECH_APP_ID: 'legacy-app', VOLC_SPEECH_ACCESS_TOKEN: 'legacy-token', ARK_API_KEY: 'ark-secret', VOLC_TTS_SPEECH_RATE: '-10' }, fetch: (async (url, init) => { target = String(url); sent = init; return response(); }) as typeof fetch });
  const result = await p.speech('我们可以慢慢来。');
  assert.equal(target, endpoint); assert.equal(sent?.redirect, 'manual'); assert.ok(sent?.signal instanceof AbortSignal);
  const headers = new Headers(sent?.headers);
  assert.equal(headers.get('X-Api-Key'), 'synthetic-volc-key'); assert.equal(headers.get('X-Api-App-Id'), null); assert.equal(headers.get('X-Api-Access-Key'), null); assert.equal(headers.get('Authorization'), null);
  assert.equal(headers.get('X-Api-Resource-Id'), 'seed-tts-2.0'); assert.match(headers.get('X-Api-Request-Id')!, /^[\da-f-]{36}$/);
  const body = JSON.parse(String(sent?.body));
  assert.equal(body.req_params.text, '我们可以慢慢来。'); assert.equal(body.req_params.audio_params.format, 'mp3'); assert.equal(body.req_params.audio_params.sample_rate, 24000); assert.equal(body.req_params.audio_params.speech_rate, -10);
  const additions = JSON.parse(body.req_params.additions);
  assert.match(additions.context_texts[0], /友善、自然、清晰/); assert.equal(additions.cache_config.use_cache, false); assert.equal(additions.section_id, undefined); assert.equal(body.req_params.audio_params.emotion, undefined);
  assert.equal(result.contentType, 'audio/mpeg'); assert.deepEqual(result.bytes, audio);
});

test('documented legacy App ID and Access Token headers are supported only as a complete pair', async () => {
  let headers = new Headers();
  const legacy = { ...env, VOLC_SPEECH_API_KEY: '', VOLC_SPEECH_APP_ID: 'app-123', VOLC_SPEECH_ACCESS_TOKEN: 'synthetic-token' };
  const p = createVolcTts({ env: legacy, fetch: (async (_url, init) => { headers = new Headers(init?.headers); return response(); }) as typeof fetch });
  assert.equal(p.configured, true); await p.speech('你好。');
  assert.equal(headers.get('X-Api-App-Id'), 'app-123'); assert.equal(headers.get('X-Api-Access-Key'), 'synthetic-token'); assert.equal(headers.get('X-Api-Key'), null);
  assert.equal(createVolcTts({ env: { ...legacy, VOLC_SPEECH_APP_ID: '' } }).configured, false);
});

test('SSE parsing survives every-byte boundaries, CRLF boundaries, metadata and UTF-8 splits', async () => {
  const first = audio.slice(0, 6); const second = audio.slice(6);
  const text = ': keepalive\r\n\r\n' + audioEvent(first, '\r\n') + event(351, { code: 0, message: '句子完成', data: null, sentence: { text: '你好' } }, '\r\n') + audioEvent(second) + terminal();
  const bytes = encoder.encode(text); let offset = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { if (offset === bytes.length) controller.close(); else controller.enqueue(bytes.slice(offset, ++offset)); } });
  const p = createVolcTts({ env, fetch: (async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch });
  assert.deepEqual((await p.speech('你好')).bytes, audio);
});

test('multiline SSE data is parsed per event and terminal usage is not mistaken for audio', async () => {
  const text = `event: 352\ndata: {"code":0,\ndata: "data":"${Buffer.from(audio).toString('base64')}"}\n\n` + terminal();
  const p = createVolcTts({ env, fetch: (async () => response(text)) as typeof fetch });
  assert.deepEqual((await p.speech('你好')).bytes, audio);
});

test('audio is not returned until the explicit terminal event and EOF are both received', async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>; let settled = false;
  const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; controller.enqueue(encoder.encode(audioEvent())); } });
  const p = createVolcTts({ env, fetch: (async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch });
  const pending = p.speech('你好').then(value => { settled = true; return value; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  stream.enqueue(encoder.encode(terminal())); await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  stream.close(); assert.deepEqual((await pending).bytes, audio);
});

test('missing terminal, truncated final event, invalid terminal code, empty audio and trailing frames are rejected', async () => {
  for (const body of [
    audioEvent(),
    audioEvent() + terminal().trimEnd(),
    audioEvent() + event(152, { code: 0, data: null }),
    audioEvent() + event(352, { code: 20000000, data: null }),
    terminal(),
    audioEvent() + terminal() + audioEvent(),
    audioEvent() + terminal() + terminal(),
  ]) await assert.rejects(createVolcTts({ env, fetch: (async () => response(body)) as typeof fetch }).speech('你好'), providerError);
});

test('SSE cancellation, failure and business errors never return partial audio or provider secrets', async () => {
  for (const failure of [event(151, { code: 0, data: null }), event(153, { code: 0, data: null }), event(352, { code: 45000000, message: 'SECRET_PROVIDER_TRACE', data: null })]) {
    await assert.rejects(createVolcTts({ env, fetch: (async () => response(audioEvent() + failure)) as typeof fetch }).speech('你好'), (error: unknown) => providerError(error) && !(error as Error).message.includes('SECRET_PROVIDER_TRACE'));
  }
});

test('malformed JSON, noncanonical base64, missing code and invalid UTF-8 fail closed', async () => {
  for (const frame of ['event: 352\ndata: {broken}\n\n', event(352, { data: 'SUQz' }), event(352, { code: 0, data: '***=' }), event(352, { code: 0, data: 'AB==' }), event(352, { code: 0, data: '' }), event(352, { code: 0, data: { invalid: true } })]) {
    await assert.rejects(createVolcTts({ env, fetch: (async () => response(frame + terminal())) as typeof fetch }).speech('你好'), providerError);
  }
  await assert.rejects(createVolcTts({ env, fetch: (async () => new Response(new Uint8Array([255]), { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch }).speech('你好'), providerError);
});

test('HTML, HTTP errors and redirected responses are rejected without retrying or following Location', async () => {
  for (const factory of [
    () => new Response('SECRET_FAILURE', { status: 401 }),
    () => new Response('SECRET_FAILURE', { headers: { 'content-type': 'text/html' } }),
    () => new Response('', { status: 307, headers: { location: 'https://attacker.example/collect' } }),
    () => { const result = response(); Object.defineProperty(result, 'redirected', { value: true }); return result; },
  ]) {
    let calls = 0;
    const p = createVolcTts({ env, fetch: (async (_url, init) => { calls++; assert.equal(init?.redirect, 'manual'); return factory(); }) as typeof fetch });
    await assert.rejects(p.speech('你好'), (error: unknown) => providerError(error) && !(error as Error).message.includes('SECRET_FAILURE')); assert.equal(calls, 1);
  }
});

test('decoded audio and wire-body limits are enforced independently and cancel the source', async () => {
  const block = new Uint8Array(1024 * 1024);
  let pulls = 0; let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(encoder.encode(audioEvent(block))); }, cancel() { cancelled = true; } });
  const p = createVolcTts({ env, fetch: (async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch });
  await assert.rejects(p.speech('你好'), providerError); assert.equal(cancelled, true); assert.ok(pulls <= 11);
  const oversized = response(); oversized.headers.set('content-length', String(12 * 1024 * 1024 + 1));
  await assert.rejects(createVolcTts({ env, fetch: (async () => oversized) as typeof fetch }).speech('你好'), providerError);
  let commentsCancelled = false;
  const comments = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(encoder.encode(':' + 'x'.repeat(1024 * 1024) + '\n')); }, cancel() { commentsCancelled = true; } });
  await assert.rejects(createVolcTts({ env, fetch: (async () => new Response(comments, { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch }).speech('你好'), providerError); assert.equal(commentsCancelled, true);
});

test('external cancellation aborts the request and releases a blocked response reader', async () => {
  const external = new AbortController(); let requestSignal: AbortSignal | undefined; let sourceCancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(audioEvent())); }, cancel() { sourceCancelled = true; } });
  const p = createVolcTts({ env, fetch: (async (_url, init) => { requestSignal = init?.signal as AbortSignal; return new Response(body, { headers: { 'content-type': 'text/event-stream' } }); }) as typeof fetch });
  const pending = p.speech('你好', external.signal);
  await new Promise(resolve => setImmediate(resolve)); external.abort(new Error('SECRET_ABORT_REASON'));
  await assert.rejects(pending, (error: unknown) => error instanceof ApiError && error.code === 'REQUEST_ABORTED' && !error.message.includes('SECRET'));
  assert.equal(requestSignal?.aborted, true); assert.equal(sourceCancelled, true); assert.equal(body.locked, false);
});

test('already cancelled calls never send credentials; late fetch resolution is cancelled', async () => {
  const external = new AbortController(); external.abort(); let calls = 0;
  const p = createVolcTts({ env, fetch: (async () => { calls++; return response(); }) as typeof fetch });
  await assert.rejects(p.speech('你好', external.signal), (error: unknown) => error instanceof ApiError && error.code === 'REQUEST_ABORTED'); assert.equal(calls, 0);
  let resolve!: (response: Response) => void; let cancelled = false;
  const later = new AbortController();
  const lateProvider = createVolcTts({ env, fetch: (() => new Promise<Response>(r => { resolve = r; })) as typeof fetch });
  const pending = lateProvider.speech('你好', later.signal); later.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof ApiError && error.code === 'REQUEST_ABORTED');
  resolve(new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } }));
  await new Promise(done => setImmediate(done)); assert.equal(cancelled, true);
});

test('the 25 second deadline covers stream completion and does not wait for stalled cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal: AbortSignal | undefined; let sourceCancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(audioEvent())); }, cancel() { sourceCancelled = true; return new Promise<void>(() => {}); } });
  const p = createVolcTts({ env, fetch: (async (_url, init) => { signal = init?.signal as AbortSignal; return new Response(body, { headers: { 'content-type': 'text/event-stream' } }); }) as typeof fetch });
  const pending = p.speech('你好');
  await new Promise(resolve => setImmediate(resolve)); t.mock.timers.tick(25_000);
  await assert.rejects(pending, (error: unknown) => error instanceof ApiError && error.status === 504 && error.code === 'PROVIDER_TIMEOUT');
  assert.equal(signal?.aborted, true); assert.equal(sourceCancelled, true);
});

test('empty or overlong text is rejected before any synthesis request', async () => {
  let calls = 0;
  const p = createVolcTts({ env, fetch: (async () => { calls++; return response(); }) as typeof fetch });
  for (const text of ['', '   ', '字'.repeat(601)]) await assert.rejects(p.speech(text), (error: unknown) => error instanceof ApiError && error.status === 400);
  assert.equal(calls, 0);
});

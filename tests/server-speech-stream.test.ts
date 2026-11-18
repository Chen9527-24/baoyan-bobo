import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../apps/server/src/app.js';
import { createGlobalMemoryStore } from '../apps/server/src/global-memory-store.js';

const origin = 'http://localhost:5173';
const endpoint = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse';
const approvedReply = '我们一起慢慢搭起来吧。';
const pcm = new Uint8Array([0, 0, 1, 0, 255, 127, 0, 128]);
const mp3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64]);
const encoder = new TextEncoder();
const sse = (id: number, data: Record<string, unknown>) => `event: ${id}\ndata: ${JSON.stringify(data)}\n\n`;
const audioEvent = (bytes = pcm) => sse(352, { code: 0, data: Buffer.from(bytes).toString('base64') });
const terminal = () => sse(152, { code: 20_000_000, data: null });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

/** Real loopback HTTP, synthetic family, controlled provider SSE; no external calls. */
async function harness(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'baoyan-speech-stream-'));
  const dataPath = join(directory, 'test.sqlite');
  const entered = deferred<void>(), aborted = deferred<void>(), cancelled = deferred<void>();
  const requests: { text: string; format: string }[] = [];
  let chatRequests = 0;
  let upstream!: ReadableStreamDefaultController<Uint8Array>;
  let upstreamClosed = false, upstreamCancelled = false;
  let signal: AbortSignal | null | undefined;
  const app = createApp({
    dataPath,
    env: {
      API_BASE_URL: 'https://synthetic.invalid/v1', API_KEY: 'synthetic-test-only', CHAT_MODEL: 'synthetic-chat',
      TTS_PROVIDER: 'volc', VOLC_TTS_URL: endpoint, VOLC_SPEECH_API_KEY: 'synthetic-tts-only',
      VOLC_TTS_VOICE_ID: 'zh_female_vv_uranus_bigtts', VOLC_TTS_RESOURCE_ID: 'seed-tts-2.0',
    },
    fetch: (async (url, init) => {
      if (String(url).endsWith('/chat/completions')) {
        chatRequests++;
        return Response.json({ choices: [{ message: { content: approvedReply } }] });
      }
      assert.equal(String(url), endpoint, 'unknown transports must never reach the network');
      const body = JSON.parse(String(init?.body));
      requests.push({ text: body.req_params.text, format: body.req_params.audio_params.format });
      assert.equal(body.req_params.audio_params.sample_rate, 24_000);
      signal = init?.signal;
      signal?.addEventListener('abort', () => aborted.resolve(), { once: true });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { upstream = controller; },
        cancel() { upstreamCancelled = true; cancelled.resolve(); },
      });
      entered.resolve();
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
    }) as typeof fetch,
  });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    app.locals.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const cookies = new Map<string, string>();
  async function request(path: string, body: unknown = {}, method = 'POST', accept?: string, externalSignal?: AbortSignal, cookieOverride?: string) {
    const response = await fetch(`${base}/api${path}`, {
      method,
      // Keep a child cookie context separate from the authorized parent context.
      // This exercises memory edits while a child's already-open HTTP stream exists.
      headers: { Origin: origin, Cookie: cookieOverride ?? (path.startsWith('/calls') ? cookies.get('baoyan_device')! : [...cookies.values()].join('; ')), 'Content-Type': 'application/json', ...(accept ? { Accept: accept } : {}) },
      body: JSON.stringify(body), signal: externalSignal,
    });
    if (cookieOverride === undefined) for (const item of response.headers.getSetCookie()) {
      const cookie = item.split(';')[0]!; cookies.set(cookie.split('=')[0]!, cookie);
    }
    return response;
  }
  const profile = { pin: '845729', nickname: '虚构测试伙伴', ageGroup: '6-8', sessionMinutes: 10, dailyMinutes: 30, consent: true };
  const setup = await request('/setup', profile); assert.equal(setup.status, 201); await setup.arrayBuffer();
  const unlocked = await request('/parent/unlock', { pin: profile.pin }); assert.equal(unlocked.status, 200); await unlocked.arrayBuffer();
  const enabled = await request('/parent/settings', { memoryEnabled: true }, 'PATCH'); assert.equal(enabled.status, 200); await enabled.arrayBuffer();
  const started = await request('/calls', { operationId: crypto.randomUUID() });
  assert.equal(started.status, 201); const call = await started.json() as { id: string };
  const turn = async (text = '积木倒了，我有点难过。') => {
    const response = await request(`/calls/${call.id}/turn`, { text, operationId: crypto.randomUUID() });
    assert.equal(response.status, 200);
    return response.json() as Promise<{ reply: string; replyId: string; candidate?: { id: string } }>;
  };
  const speech = (replyId: string, accept: string | undefined = 'application/x-ndjson', externalSignal?: AbortSignal) =>
    request(`/calls/${call.id}/speech`, { replyId }, 'POST', accept, externalSignal);
  return {
    app, dataPath, base, call, request, turn, speech, entered, aborted, cancelled, requests,
    push(text: string) { assert.equal(upstreamCancelled, false); assert.equal(upstreamClosed, false); upstream.enqueue(encoder.encode(text)); },
    close() { upstreamClosed = true; upstream.close(); },
    get signal() { return signal; }, get chatRequests() { return chatRequests; }, get upstreamCancelled() { return upstreamCancelled; },
    async foreignCookie() {
      const response = await request('/setup', { ...profile, nickname: '另一个虚构家庭' }, 'POST', undefined, undefined, '');
      assert.equal(response.status, 201); await response.arrayBuffer(); return response.headers.get('set-cookie')!.split(';')[0]!;
    },
    async remember() {
      const remembered = await turn('帮我记住小屋叫星星屋'); assert.ok(remembered.candidate);
      const response = await request(`/calls/${call.id}/memory/confirm`, { candidateId: remembered.candidate.id, operationId: crypto.randomUUID() });
      assert.equal(response.status, 200); return (await response.json() as { memory: { id: string } }).memory;
    },
  };
}

type Frame = { type: string; data?: string; code?: string; status?: number; [key: string]: unknown };
function frames(response: Response) {
  const reader = response.body!.getReader(); const decoder = new TextDecoder();
  let pending = '', ended = false;
  async function next(): Promise<Frame | null> {
    while (true) {
      const newline = pending.indexOf('\n');
      if (newline >= 0) { const line = pending.slice(0, newline); pending = pending.slice(newline + 1); if (line) return JSON.parse(line); continue; }
      if (ended) { assert.equal(pending, '', 'all NDJSON frames must end in newline'); return null; }
      const part = await reader.read();
      if (part.done) { pending += decoder.decode(); ended = true; }
      else pending += decoder.decode(part.value, { stream: true });
    }
  }
  return { next, async all() { const result: Frame[] = []; let frame: Frame | null; while ((frame = await next()) !== null) result.push(frame); reader.releaseLock(); return result; },
    async cancel() { await reader.cancel().catch(() => {}); reader.releaseLock(); } };
}
async function firstAudio(response: Response) {
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type')!, /^application\/x-ndjson/);
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  const stream = frames(response);
  assert.deepEqual(await stream.next(), { type: 'format', format: 'pcm_s16le', sampleRate: 24_000, channels: 1 });
  assert.deepEqual(await stream.next(), { type: 'audio', data: Buffer.from(pcm).toString('base64') });
  return stream;
}
function publish(h: Awaited<ReturnType<typeof harness>>) {
  const db = new DatabaseSync(h.dataPath); const store = createGlobalMemoryStore(db); const before = store.snapshot();
  store.publish({ reviewed: true, audience: 'all', validity: 'until-replaced', items: before.items.map(item => ({
    key: item.key, kind: item.kind as 'imaginary' | 'plan', content: item.key === 'world.home.name' ? '小屋叫月亮小屋' : item.content,
  })) }, { expectedRevision: before.revision, reviewer: 'synthetic-reviewer', note: '仅本地验证语音流失效' });
  db.close(); h.app.locals.sweepExpiredState();
}

test('HTTP speech emits the first PCM chunk before provider terminal or EOF and completes only after both', { timeout: 7000 }, async t => {
  const h = await harness(t); const reply = await h.turn(); const pending = h.speech(reply.replyId);
  await h.entered.promise; h.push(audioEvent());
  const stream = await firstAudio(await pending);
  assert.equal(h.signal?.aborted, false, 'flushed headers must not be interpreted as a disconnect');
  assert.deepEqual(h.requests, [{ text: reply.reply, format: 'pcm' }]); assert.equal(h.chatRequests, 1);
  let completed = false;
  const ending = stream.next().then(value => { completed = true; return value; });
  h.push(terminal()); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(completed, false, 'a terminal provider event alone is not a completed stream');
  h.close(); assert.deepEqual(await ending, { type: 'done' }); assert.deepEqual(await stream.all(), []);
  assert.equal(h.requests.length, 1, 'streaming adds no extra TTS request');
});

for (const accept of [undefined, '*/*', 'application/x-ndjson;q=0, audio/mpeg']) {
  test(`speech preserves full MP3 for Accept ${accept ?? '(default)'}`, { timeout: 7000 }, async t => {
    const h = await harness(t); const reply = await h.turn(); let settled = false;
    // Passing undefined explicitly avoids the speech helper's streaming default.
    const pending = h.request(`/calls/${h.call.id}/speech`, { replyId: reply.replyId }, 'POST', accept).then(response => { settled = true; return response; });
    await h.entered.promise; h.push(audioEvent(mp3)); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, false); h.push(terminal()); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(settled, false);
    h.close(); const response = await pending; assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type')!, /^audio\/mpeg/); assert.deepEqual(new Uint8Array(await response.arrayBuffer()), mp3);
    assert.deepEqual(h.requests, [{ text: reply.reply, format: 'mp3' }]);
  });
}

test('speech rejects arbitrary text, unknown replies, foreign families and an expired reply before any TTS call', { timeout: 7000 }, async t => {
  const h = await harness(t); const reply = await h.turn(); const path = `/calls/${h.call.id}/speech`;
  for (const payload of [{ text: '任意未审核输入' }, { replyId: reply.replyId, text: '不能覆盖已审核回复' }]) {
    const response = await h.request(path, payload, 'POST', 'application/x-ndjson'); assert.equal(response.status, 400); await response.arrayBuffer();
  }
  const unknown = await h.speech(crypto.randomUUID()); assert.equal(unknown.status, 409); await unknown.arrayBuffer();
  const foreign = await h.request(path, { replyId: reply.replyId }, 'POST', 'application/x-ndjson', undefined, await h.foreignCookie());
  assert.equal(foreign.status, 404); await foreign.arrayBuffer();
  await h.turn('我们来画圆圈吧'); const stale = await h.speech(reply.replyId);
  assert.equal(stale.status, 409); assert.equal((await stale.json() as { code: string }).code, 'REPLY_EXPIRED');
  assert.equal(h.requests.length, 0);
});

for (const action of ['cancel', 'new-turn', 'end', 'memory-edit', 'global-publish'] as const) {
  test(`ongoing speech aborts upstream and cannot emit more audio after ${action}`, { timeout: 7000 }, async t => {
    const h = await harness(t); const memory = action === 'memory-edit' ? await h.remember() : undefined;
    const reply = await h.turn(); const pending = h.speech(reply.replyId);
    await h.entered.promise; h.push(audioEvent()); const stream = await firstAudio(await pending);
    if (action === 'global-publish') publish(h);
    else if (action === 'new-turn') await h.turn('我们来画画吧');
    else {
      const response = action === 'memory-edit'
        ? await h.request(`/parent/memories/${memory!.id}`, { content: '小屋叫月亮小屋' }, 'PATCH')
        : await h.request(`/calls/${h.call.id}/${action}`);
      assert.equal(response.status, 200); await response.arrayBuffer();
    }
    await h.aborted.promise; await h.cancelled.promise;
    assert.equal(h.signal?.aborted, true); assert.equal(h.upstreamCancelled, true);
    const remaining = await stream.all(); assert.equal(remaining.length, 1);
    assert.equal(remaining[0]!.type, 'error'); assert.equal(remaining[0]!.code, action === 'end' ? 'CALL_EXPIRED' : 'CONTEXT_CHANGED');
    assert.equal(remaining[0]!.status, action === 'end' ? 410 : 409);
    assert.equal(remaining.some(frame => frame.type === 'audio' || frame.type === 'done'), false);
    assert.equal(JSON.stringify(remaining).includes(reply.reply), false, 'terminal errors do not repeat private reply text');
    assert.equal(h.requests.length, 1, 'invalidation must never retry synthesis');
  });
}

test('provider failure after the first speech segment ends with a sanitized error and no success or retry', { timeout: 7000 }, async t => {
  const h = await harness(t); const reply = await h.turn(); const pending = h.speech(reply.replyId);
  await h.entered.promise; h.push(audioEvent()); const stream = await firstAudio(await pending);
  h.push(sse(153, { code: 500, message: 'SYNTHETIC_PRIVATE_VENDOR_DEBUG', data: null }));
  const remaining = await stream.all(); assert.equal(remaining.length, 1); assert.equal(remaining[0]!.type, 'error');
  assert.equal(remaining[0]!.code, 'PROVIDER_ERROR'); assert.equal(remaining[0]!.status, 502);
  assert.equal(JSON.stringify(remaining).includes('SYNTHETIC_PRIVATE'), false); assert.equal(h.requests.length, 1);
  await h.cancelled.promise; assert.equal(h.signal?.aborted, true);
});

test('failure before any segment uses safe ordinary JSON and does not expose an incomplete audio stream', { timeout: 7000 }, async t => {
  const h = await harness(t); const reply = await h.turn(); const pending = h.speech(reply.replyId);
  await h.entered.promise; h.push(sse(153, { code: 500, message: 'SYNTHETIC_PRIVATE_VENDOR_DEBUG', data: null }));
  const response = await pending; assert.equal(response.status, 502); assert.match(response.headers.get('content-type')!, /^application\/json/);
  const error = await response.json() as { code: string }; assert.equal(error.code, 'PROVIDER_ERROR');
  assert.equal(JSON.stringify(error).includes('SYNTHETIC_PRIVATE'), false); assert.equal(h.requests.length, 1);
});

test('disconnect after a speech segment aborts provider reading and never starts another synthesis', { timeout: 7000 }, async t => {
  const h = await harness(t); const reply = await h.turn(); const controller = new AbortController();
  const pending = h.speech(reply.replyId, 'application/x-ndjson', controller.signal);
  await h.entered.promise; h.push(audioEvent()); const stream = await firstAudio(await pending);
  controller.abort(); await h.aborted.promise; await h.cancelled.promise; await stream.cancel();
  assert.equal(h.signal?.aborted, true); assert.equal(h.upstreamCancelled, true); assert.equal(h.requests.length, 1);
  const next = await h.turn('我们继续画画吧'); assert.ok(next.replyId); assert.equal(h.chatRequests, 2);
  assert.equal(h.requests.length, 1, 'reconnecting or a later turn must not resume the cancelled TTS');
});

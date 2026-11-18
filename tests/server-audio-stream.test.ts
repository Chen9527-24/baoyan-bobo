import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../apps/server/src/app.js';
import { createGlobalMemoryStore } from '../apps/server/src/global-memory-store.js';
import { readAudioTurnStream } from '../apps/web/src/lib/audioTurnStream.js';

const origin = 'http://localhost:5173';
const transcript = '积木倒了，我有点难过。';
const answer = { choices: [{ message: { content: '我们一起慢慢搭起来吧。' } }] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

async function harness(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'baoyan-audio-stream-'));
  const dataPath = join(directory, 'test.sqlite');
  const asr = deferred<Response>(), chat = deferred<Response>();
  const asrEntered = deferred<void>(), chatEntered = deferred<void>(), chatAborted = deferred<void>();
  const events: unknown[] = [];
  let asrSignal: AbortSignal | null | undefined;
  let chatSignal: AbortSignal | null | undefined;
  const prompts: { role: string; content: string }[][] = [];
  const app = createApp({
    dataPath,
    env: { API_BASE_URL: 'https://mock.invalid/v1', API_KEY: 'synthetic-test-only', ASR_MODEL: 'mock-asr', CHAT_MODEL: 'mock-chat' },
    onEvent: (_familyId, event, payload) => events.push({ event, payload }),
    fetch: (async (url, init) => {
      if (String(url).endsWith('/audio/transcriptions')) {
        asrSignal = init?.signal; asrEntered.resolve();
        return asr.promise; // Deliberately ignores cancellation; stamps must still reject late results.
      }
      assert.ok(String(url).endsWith('/chat/completions'));
      prompts.push(JSON.parse(String(init?.body)).messages);
      if (prompts.length > 1) return Response.json(answer);
      chatSignal = init?.signal;
      chatSignal?.addEventListener('abort', () => chatAborted.resolve(), { once: true });
      chatEntered.resolve();
      return chat.promise;
    }) as typeof fetch,
  });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    app.locals.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const setup = await fetch(`${base}/api/setup`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: '123456', nickname: '测试伙伴', ageGroup: '6-8', sessionMinutes: 10, dailyMinutes: 30, consent: true }),
  });
  assert.equal(setup.status, 201); await setup.arrayBuffer();
  const cookie = setup.headers.get('set-cookie')!.split(';')[0]!;
  const post = (path: string, body: unknown = {}) => fetch(`${base}/api${path}`, {
    method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const started = await post('/calls', { operationId: crypto.randomUUID() });
  assert.equal(started.status, 201); const call = await started.json() as { id: string };
  const audio = (accept?: string, signal?: AbortSignal) => {
    const body = new FormData(); body.set('operationId', crypto.randomUUID());
    body.set('audio', new Blob(['synthetic audio bytes'], { type: 'audio/wav' }), 'sample.wav');
    return fetch(`${base}/api/calls/${call.id}/audio`, {
      method: 'POST', headers: { Origin: origin, Cookie: cookie, ...(accept ? { Accept: accept } : {}) }, body, signal,
    });
  };
  return { app, post, audio, call, asr, chat, asrEntered, chatEntered, chatAborted, events, prompts, dataPath,
    get asrSignal() { return asrSignal; }, get chatSignal() { return chatSignal; } };
}
async function firstFrame(response: Response) {
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type')!, /^application\/x-ndjson/);
  const reader = response.body!.getReader();
  const chunk = await reader.read(); assert.equal(chunk.done, false);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(chunk.value)), { type: 'transcript', text: transcript, inputSource: 'transcript' });
  return reader;
}
async function remaining(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let result = ''; const decoder = new TextDecoder();
  while (true) { const part = await reader.read(); if (part.done) break; result += decoder.decode(part.value, { stream: true }); }
  result += decoder.decode(); reader.releaseLock(); return result;
}
function publish(h: Awaited<ReturnType<typeof harness>>) {
  const db = new DatabaseSync(h.dataPath); const store = createGlobalMemoryStore(db); const before = store.snapshot();
  store.publish({ reviewed: true, audience: 'all', validity: 'until-replaced', items: before.items.map(item => ({
    key: item.key, kind: item.kind as 'imaginary' | 'plan', content: item.key === 'world.home.name' ? '小屋叫月亮小屋' : item.content,
  })) }, { expectedRevision: before.revision, reviewer: 'test-reviewer', note: '测试流式上下文失效' });
  db.close(); h.app.locals.sweepExpiredState();
}

test('real HTTP sends transcript while mock LLM is still pending; headers do not abort LLM', { timeout: 5000 }, async t => {
  const h = await harness(t); const pending = h.audio('application/x-ndjson');
  await h.asrEntered.promise; h.asr.resolve(Response.json({ text: transcript }));
  const reader = await firstFrame(await pending); await h.chatEntered.promise;
  assert.equal(h.chatSignal?.aborted, false); assert.equal(h.asrSignal?.aborted, false);
  h.chat.resolve(Response.json(answer));
  const frame = JSON.parse(await remaining(reader));
  assert.equal(frame.type, 'turn'); assert.equal(frame.turn.transcript, transcript);
  assert.equal(frame.turn.reply, answer.choices[0]!.message.content);
  assert.equal(JSON.stringify(h.events).includes(transcript), false, 'transcript must not be broadcast');
  const db = new DatabaseSync(h.dataPath, { readOnly: true });
  for (const table of ['families', 'calls', 'memories', 'memory_operations']) {
    assert.equal(JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()).includes(transcript), false, 'no persistent transcript');
  }
  db.close();
});

for (const accept of [undefined, '*/*', 'application/x-ndjson;q=0, application/json']) {
  test(`audio remains compatible JSON for Accept ${accept ?? '(default)'}`, { timeout: 5000 }, async t => {
    const h = await harness(t); const pending = h.audio(accept);
    await h.asrEntered.promise; h.asr.resolve(Response.json({ text: transcript })); await h.chatEntered.promise;
    h.chat.resolve(Response.json(answer)); const response = await pending;
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type')!, /^application\/json/);
    const turn = await response.json() as { reply: string; transcript: string; replyId: string };
    assert.equal(turn.transcript, transcript); assert.equal(turn.reply, answer.choices[0]!.message.content); assert.ok(turn.replyId);
  });
}

for (const action of ['cancel', 'end', 'new-turn', 'global-publish'] as const) {
  test(`streamed transcript does not allow late LLM output after ${action}`, { timeout: 5000 }, async t => {
    const h = await harness(t); const pending = h.audio('application/x-ndjson');
    await h.asrEntered.promise; h.asr.resolve(Response.json({ text: transcript }));
    const reader = await firstFrame(await pending); await h.chatEntered.promise;
    if (action === 'global-publish') publish(h);
    else {
      const response = action === 'new-turn'
        ? await h.post(`/calls/${h.call.id}/turn`, { text: '我们来画圆圈吧', operationId: crypto.randomUUID() })
        : await h.post(`/calls/${h.call.id}/${action}`);
      assert.equal(response.status, 200); await response.arrayBuffer();
    }
    assert.equal(h.chatSignal?.aborted, true);
    h.chat.resolve(Response.json(answer));
    const frame = JSON.parse(await remaining(reader));
    assert.equal(frame.type, 'error'); assert.equal(frame.code, action === 'end' ? 'CALL_EXPIRED' : 'CONTEXT_CHANGED');
    assert.equal(frame.turn, undefined); assert.equal(JSON.stringify(frame).includes(transcript), false);
  });
}

test('cancel during delayed ASR returns ordinary error JSON without leaking a stale transcript', { timeout: 5000 }, async t => {
  const h = await harness(t); const pending = h.audio('application/x-ndjson'); await h.asrEntered.promise;
  const cancelled = await h.post(`/calls/${h.call.id}/cancel`); assert.equal(cancelled.status, 200); await cancelled.arrayBuffer();
  assert.equal(h.asrSignal?.aborted, true); h.asr.resolve(Response.json({ text: transcript }));
  const response = await pending; assert.equal(response.status, 409); assert.match(response.headers.get('content-type')!, /^application\/json/);
  assert.deepEqual(await response.json(), { error: '内容已失效，请重新发起', code: 'CONTEXT_CHANGED' });
  assert.equal(h.prompts.length, 0);
});

test('upstream failure after transcript is a safe error terminal frame', { timeout: 5000 }, async t => {
  const h = await harness(t); const pending = h.audio('application/x-ndjson'); await h.asrEntered.promise;
  h.asr.resolve(Response.json({ text: transcript })); const reader = await firstFrame(await pending);
  await h.chatEntered.promise; h.chat.resolve(new Response('synthetic-private-upstream-debug', { status: 500 }));
  const frame = JSON.parse(await remaining(reader)); assert.equal(frame.type, 'error'); assert.equal(frame.code, 'PROVIDER_ERROR');
  assert.equal(JSON.stringify(frame).includes('synthetic-private'), false); assert.equal(frame.turn, undefined);
});

test('disconnect after transcript aborts LLM and an ignored abort cannot enter later chat history', { timeout: 5000 }, async t => {
  const h = await harness(t); const controller = new AbortController(); const pending = h.audio('application/x-ndjson', controller.signal);
  await h.asrEntered.promise; h.asr.resolve(Response.json({ text: transcript })); const reader = await firstFrame(await pending);
  await h.chatEntered.promise; controller.abort(); await h.chatAborted.promise;
  h.chat.resolve(Response.json(answer)); await reader.cancel().catch(() => {}); reader.releaseLock();
  await new Promise<void>(resolve => setImmediate(resolve));
  const next = await h.post(`/calls/${h.call.id}/turn`, { text: '我们来画画吧', operationId: crypto.randomUUID() });
  assert.equal(next.status, 200); await next.arrayBuffer();
  assert.equal(h.prompts.length, 2); assert.equal(h.prompts[1]!.some(message => message.content === transcript), false);
});

for (const text of ['再见', '我想伤害自己']) {
  test(`terminal call reply for ${text === '再见' ? 'goodbye' : 'safety'} remains a valid streamed Turn`, { timeout: 5000 }, async t => {
    const h = await harness(t); const pending = h.audio('application/x-ndjson'); await h.asrEntered.promise;
    h.asr.resolve(Response.json({ text })); const seen: string[] = [];
    const turn = await readAudioTurnStream(await pending, value => seen.push(value));
    assert.deepEqual(seen, [text]); assert.equal(turn.transcript, text); assert.equal(turn.endCall, true); assert.ok(turn.replyId);
    assert.equal(h.prompts.length, 0, 'local terminal rules do not call the LLM');
    const heartbeat = await h.post(`/calls/${h.call.id}/heartbeat`); assert.equal(heartbeat.status, 410); await heartbeat.arrayBuffer();
  });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../apps/web/src/lib/api.ts';
import { fetchReplySpeech, presentReplyWithPlayback, type ReplyReveal } from '../apps/web/src/lib/replyPlayback.ts';
import type { PlaybackResult } from '../apps/web/src/audio.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness() {
  let current = true;
  const events: string[] = [];
  const reveals: ReplyReveal[] = [];
  return {
    events, reveals, cancel: () => { current = false; },
    options: {
      isCurrent: () => current,
      preparing: () => { events.push('preparing'); },
      reveal: (mode: ReplyReveal) => { reveals.push(mode); events.push(`reply-and-candidate:${mode}`); },
      speaking: () => { events.push('speaking'); },
      ready: () => { events.push('ready'); },
      failed: (_error: unknown) => { events.push('failed'); },
    },
  };
}

test('withholds reply and memory candidate throughout TTS/download until actual playing, then publishes both together', async () => {
  const h = harness(); const output = deferred<PlaybackResult>(); let started!: () => void;
  const completed = presentReplyWithPlayback({ ...h.options, playback: onStart => { started = onStart; return output.promise; } });
  assert.deepEqual(h.events, ['preparing']);
  await Promise.resolve();
  assert.deepEqual(h.reveals, []);
  started();
  assert.deepEqual(h.events, ['preparing', 'reply-and-candidate:speech', 'speaking']);
  started(); // duplicate native callback cannot reveal a second candidate or repeat the transition
  assert.equal(h.reveals.length, 1);
  output.resolve('ended'); await completed;
  assert.equal(h.events.at(-1), 'ready');
});

test('no available speech presents text and candidate immediately without a false preparing/speaking phase', async () => {
  const h = harness();
  await presentReplyWithPlayback(h.options);
  assert.deepEqual(h.events, ['reply-and-candidate:text-only', 'ready']);
});

test('provider/network/playback errors reveal valid text, while a late playback callback cannot resurrect speech', async () => {
  for (const failure of [new ApiError('provider unavailable', 502), new ApiError('budget exhausted', 429), new TypeError('network'), new DOMException('denied', 'NotAllowedError')]) {
    const h = harness(); let lateStart!: () => void;
    await presentReplyWithPlayback({ ...h.options, playback: async onStart => { lateStart = onStart; throw failure; } });
    assert.deepEqual(h.events, ['preparing', 'reply-and-candidate:text-only', 'failed']);
    lateStart();
    assert.deepEqual(h.reveals, ['text-only']);
    assert.equal(h.events.includes('speaking'), false);
  }
});

test('context/auth/end rejections never reveal the withheld reply or candidate even before SSE invalidation arrives', async () => {
  const rejections = [
    new ApiError('old context', 409, 'CONTEXT_CHANGED'), new ApiError('old reply', 409, 'REPLY_EXPIRED'),
    new ApiError('ended', 410, 'CALL_EXPIRED'), new ApiError('cancelled', 499, 'REQUEST_ABORTED'),
    new ApiError('permission', 401, 'DEVICE_REQUIRED'), new ApiError('expired', 410, 'TRIAL_EXPIRED'),
    new ApiError('forbidden', 403), new ApiError('missing', 404),
    new ApiError('wrapped invalidation', 502, 'CONTEXT_CHANGED'), new DOMException('abort', 'AbortError'),
  ];
  for (const failure of rejections) {
    const h = harness(); let late!: () => void;
    await presentReplyWithPlayback({ ...h.options, playback: async onStart => { late = onStart; throw failure; } });
    late();
    assert.deepEqual(h.events, ['preparing', 'failed']);
    assert.deepEqual(h.reveals, []);
  }
});

test('hangup/new-turn/context invalidation cancels all late publication and playback completion effects', async () => {
  for (const outcome of ['success', 'failure'] as const) {
    const h = harness(); const output = deferred<PlaybackResult>(); let late!: () => void;
    const completed = presentReplyWithPlayback({ ...h.options, playback: onStart => { late = onStart; return output.promise; } });
    h.cancel(); late();
    if (outcome === 'success') output.resolve('ended'); else output.reject(new Error('late network failure'));
    await completed;
    assert.deepEqual(h.events, ['preparing']);
  }
});

test('explicitly cancelled playback is never treated as text fallback or normal turn completion', async () => {
  const h = harness(); let late!: () => void;
  await presentReplyWithPlayback({ ...h.options, playback: async onStart => { late = onStart; return 'cancelled'; } });
  late();
  assert.deepEqual(h.events, ['preparing']);
});

test('a silent ended media result cannot claim spoken success, and failure after start enables the text fallback hint', async () => {
  const before = harness();
  await presentReplyWithPlayback({ ...before.options, playback: async () => 'ended' });
  assert.deepEqual(before.events, ['preparing', 'reply-and-candidate:text-only', 'failed']);
  const after = harness();
  await presentReplyWithPlayback({ ...after.options, playback: async onStart => { onStart(); throw new Error('audio disconnected'); } });
  assert.deepEqual(after.reveals, ['speech', 'text-only']);
  assert.equal(after.events.at(-1), 'failed');
});

test('speech download preserves same-origin payload and stale server error status/code for the publication gate', async () => {
  const blob = await fetchReplySpeech('call', 'reply', undefined, 100, async (url, options) => {
    assert.equal(url, '/api/calls/call/speech');
    assert.equal(options?.credentials, 'same-origin');
    assert.equal(options?.method, 'POST');
    assert.deepEqual(JSON.parse(options?.body as string), { replyId: 'reply' });
    return new Response('audio', { headers: { 'content-type': 'audio/mpeg' } });
  });
  assert.equal(await blob.text(), 'audio');
  await assert.rejects(fetchReplySpeech('call', 'reply', undefined, 100, async () =>
    Response.json({ error: 'content changed', code: 'CONTEXT_CHANGED' }, { status: 409 })),
  (error: unknown) => error instanceof ApiError && error.status === 409 && error.code === 'CONTEXT_CHANGED');
});

test('a bounded speech wait falls back on timeout, while explicit caller cancellation remains AbortError', async () => {
  const pending: typeof fetch = async (_url, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(new DOMException('abort', 'AbortError')), { once: true });
  });
  await assert.rejects(fetchReplySpeech('call', 'reply', undefined, 5, pending), /声音准备超时/);
  const controller = new AbortController();
  const result = fetchReplySpeech('call', 'reply', controller.signal, 100, pending);
  controller.abort();
  await assert.rejects(result, { name: 'AbortError' });
});

test('cancellation during response body download discards late audio and never starts a new request after pre-abort', async () => {
  const controller = new AbortController();
  let body!: ReadableStreamDefaultController<Uint8Array>; let requested = 0;
  const result = fetchReplySpeech('call', 'reply', controller.signal, 100, async () => {
    requested++; return new Response(new ReadableStream<Uint8Array>({ start(stream) { body = stream; } }));
  });
  await Promise.resolve(); controller.abort();
  try { body.enqueue(new TextEncoder().encode('stale')); body.close(); } catch { /* The cancelled download already closed the stream. */ }
  await assert.rejects(result, { name: 'AbortError' });
  await assert.rejects(fetchReplySpeech('call', 'reply', controller.signal, 100, async () => { requested++; return new Response('wrong'); }), { name: 'AbortError' });
  assert.equal(requested, 1);
});

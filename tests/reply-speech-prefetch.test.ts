import test from 'node:test';
import assert from 'node:assert/strict';
import type { AudioController, PlaybackOptions, PlaybackResult } from '../apps/web/src/audio.ts';
import { ApiError } from '../apps/web/src/lib/api.ts';
import { fetchReplySpeech, presentReplySegmentsWithPlayback } from '../apps/web/src/lib/replyPlayback.ts';
import { createReplySpeechPrefetch, MAX_BUFFERED_SPEECH_BYTES } from '../apps/web/src/lib/replySpeechPrefetch.ts';
import { fetchReplySpeechStream } from '../apps/web/src/lib/speechStream.ts';
import type { ReplySegment } from '../apps/web/src/lib/types.ts';

const segments: ReplySegment[] = [
  { text: '积木又倒了呀。', expression: 'gentle' },
  { text: '先歇一会儿也行。', expression: 'natural' },
  { text: '想继续时，我陪你想个办法。', expression: 'bright' },
];
const reply = segments.map(segment => segment.text).join('\n\n');
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function media() {
  const sessions: { options: PlaybackOptions; ended: ReturnType<typeof deferred<PlaybackResult>>; controller: AbortController; received: Uint8Array[]; drained: ReturnType<typeof deferred<void>> }[] = [];
  let stops = 0;
  const make = (options: PlaybackOptions = {}) => {
    const session = { options, ended: deferred<PlaybackResult>(), controller: new AbortController(), received: [] as Uint8Array[], drained: deferred<void>() };
    sessions.push(session); return session;
  };
  const audio = {
    playPcmStream(source, options) {
      const session = make(options);
      void (async () => {
        try { for await (const chunk of source(session.controller.signal)) session.received.push(chunk); session.drained.resolve(); }
        catch (cause) { session.drained.resolve(); session.ended.reject(cause); }
      })();
      return session.ended.promise;
    },
    playBlob(_blob, options) { return make(options).ended.promise; },
    stopPlayback() { stops++; const session = sessions.at(-1); session?.controller.abort(); session?.ended.resolve('cancelled'); },
  } as Pick<AudioController, 'playPcmStream' | 'playBlob' | 'stopPlayback'>;
  return { audio, sessions, get stops() { return stops; } };
}
function harness(streaming = true, phraseTiming = false) {
  const m = media(), controller = new AbortController();
  const requests: number[] = [], signals: AbortSignal[] = [], network: { input: ReadableStreamDefaultController<Uint8Array>; cancelled: boolean }[] = [];
  const blobs: ReturnType<typeof deferred<Blob>>[] = [];
  let live = true, activeRequests = 0, maximumRequests = 0, time = 0;
  const isCurrent = () => live;
  const prefetch = createReplySpeechPrefetch({
    segmentCount: segments.length, streaming, isCurrent, signal: controller.signal, audio: m.audio,
    ...(phraseTiming ? { segments, now: () => time } : {}),
    fetchPcm(index, signal) {
      requests.push(index); signals.push(signal); activeRequests++; maximumRequests = Math.max(maximumRequests, activeRequests);
      const connection = { input: undefined as unknown as ReadableStreamDefaultController<Uint8Array>, cancelled: false };
      const stream = new ReadableStream<Uint8Array>({ start(input) { connection.input = input; }, cancel() { connection.cancelled = true; } });
      network.push(connection);
      return (async function* () {
        const reader = stream.getReader(), abort = () => { void reader.cancel().catch(() => {}); };
        signal.addEventListener('abort', abort, { once: true });
        try {
          while (true) { const part = await reader.read(); if (signal.aborted) throw new DOMException('Cancelled', 'AbortError'); if (part.done) return; yield part.value; }
        } finally { activeRequests--; signal.removeEventListener('abort', abort); void reader.cancel().catch(() => {}); }
      })();
    },
    fetchBlob(index, signal) {
      requests.push(index); signals.push(signal); const blob = deferred<Blob>(); blobs.push(blob); return blob.promise;
    },
  });
  const reveals: string[] = [], failures: unknown[] = [], events: string[] = [];
  const run = () => presentReplySegmentsWithPlayback({
    reply, segments, isCurrent,
    playback: (_segment, index, onStart) => prefetch.play(index, onStart),
    preparing: index => events.push(`preparing:${index}`),
    reveal: (text, mode) => { reveals.push(text); events.push(`reveal:${mode}`); },
    speaking: index => events.push(`speaking:${index}`), ready: () => events.push('ready'),
    failed: cause => { failures.push(cause); events.push('failed'); },
  }).finally(() => prefetch.dispose());
  return { ...m, prefetch, requests, signals, network, blobs, reveals, failures, events, run,
    setTime(value: number) { time = value; },
    get maximumRequests() { return maximumRequests; },
    cancel() { live = false; controller.abort(); },
  };
}

test('a future PCM request starts only after both actual first sound and validated network completion', async () => {
  for (const first of ['sound', 'eof'] as const) {
    const h = harness(), pending = h.run();
    assert.deepEqual(h.requests, [0]); assert.deepEqual(h.reveals, []);
    h.network[0]!.input.enqueue(Uint8Array.of(1, 0)); await tick();
    if (first === 'sound') h.sessions[0]!.options.onStart?.();
    else h.network[0]!.input.close();
    await tick(); assert.deepEqual(h.requests, [0], `${first} alone is insufficient`);
    if (first === 'sound') h.network[0]!.input.close();
    else h.sessions[0]!.options.onStart?.();
    await tick(); assert.deepEqual(h.requests, [0, 1]);
    assert.deepEqual(h.reveals, [segments[0]!.text]);
    h.cancel(); await pending;
  }
});

test('phrase boundaries follow the previous expression and actual end without delaying the first segment or revealing the next', async () => {
  const h = harness(true, true), pending = h.run();
  assert.equal(h.sessions[0]!.options.notBeforeMs, undefined);
  h.network[0]!.input.enqueue(Uint8Array.of(1, 0)); h.network[0]!.input.close(); await tick();
  h.sessions[0]!.options.onStart?.(); await tick();
  assert.equal(h.prefetch.isReady(1), false);
  h.network[1]!.input.enqueue(Uint8Array.of(2, 0)); await tick();
  assert.equal(h.prefetch.isReady(1), false, 'available bytes alone are not a fully ready future phrase');
  h.network[1]!.input.close(); await tick();
  assert.equal(h.prefetch.isReady(1), true);
  h.setTime(1000); h.sessions[0]!.ended.resolve('ended'); await tick();
  assert.equal(h.sessions[1]!.options.notBeforeMs, 1280, 'gentle phrase gets the initial 280ms boundary target');
  assert.deepEqual(h.reveals, [segments[0]!.text], 'a scheduled phrase is still withheld until real sound');
  h.sessions[1]!.options.onStart?.(); await tick();
  h.network[2]!.input.enqueue(Uint8Array.of(3, 0)); h.network[2]!.input.close(); await tick();
  h.setTime(2000); h.sessions[1]!.ended.resolve('ended'); await tick();
  assert.equal(h.sessions[2]!.options.notBeforeMs, 2220, 'natural phrase gets the initial 220ms boundary target');
  h.sessions[2]!.options.onStart?.(); h.sessions[2]!.ended.resolve('ended'); await pending;
  assert.deepEqual(h.requests, [0, 1, 2]); assert.equal(h.maximumRequests, 1);
  assert.equal(h.events.filter(event => event === 'ready').length, 1, 'no final trailing pause');
});

test('slow Blob download consumes the phrase boundary instead of adding another full pause after download', async () => {
  const h = harness(false, true), pending = h.run(); await tick();
  h.blobs[0]!.resolve(new Blob(['zero'])); await tick();
  assert.equal(h.sessions[0]!.options.notBeforeMs, undefined);
  h.sessions[0]!.options.onStart?.(); await tick();
  h.setTime(1000); h.sessions[0]!.ended.resolve('ended'); await tick();
  assert.equal(h.sessions.length, 1, 'pending future download cannot start');
  h.setTime(1400); h.blobs[1]!.resolve(new Blob(['one'])); await tick();
  assert.equal(h.sessions[1]!.options.notBeforeMs, 1280, 'deadline stays based on the actual preceding end');
  assert.deepEqual(h.reveals, [segments[0]!.text]);
  h.cancel(); await pending;
  h.sessions[1]!.options.onStart?.(); assert.deepEqual(h.reveals, [segments[0]!.text]);
  assert.equal(h.prefetch.isReady(1), false);
  assert.deepEqual(h.requests, [0, 1]);
});

test('one future buffer is reused at handoff, with no duplicate TTS and no overlap of provider requests', async () => {
  const h = harness(), pending = h.run();
  h.network[0]!.input.enqueue(Uint8Array.of(1, 0)); h.network[0]!.input.close(); await tick();
  h.sessions[0]!.options.onStart?.(); await tick();
  h.network[1]!.input.enqueue(Uint8Array.of(2, 0)); h.network[1]!.input.close(); await tick();
  assert.deepEqual(h.requests, [0, 1]); assert.equal(h.sessions.length, 1, 'preparing audio cannot play or reveal it');
  assert.equal(h.events.includes('ready'), false);
  h.sessions[0]!.ended.resolve('ended'); await tick();
  assert.equal(h.sessions.length, 2); assert.deepEqual(h.sessions[1]!.received, [Uint8Array.of(2, 0)]);
  assert.deepEqual(h.requests, [0, 1], 'a ready future segment does not permit prefetching two ahead');
  h.sessions[1]!.options.onStart?.(); await tick();
  assert.deepEqual(h.requests, [0, 1, 2]);
  assert.equal(h.reveals.at(-1), segments.slice(0, 2).map(segment => segment.text).join('\n\n'));
  h.network[2]!.input.enqueue(Uint8Array.of(3, 0)); h.network[2]!.input.close(); await tick();
  h.sessions[1]!.ended.resolve('ended'); await tick(); h.sessions[2]!.options.onStart?.();
  h.sessions[2]!.ended.resolve('ended'); await pending;
  assert.equal(h.maximumRequests, 1); assert.equal(h.reveals.at(-1), reply);
  assert.equal(h.events.filter(event => event === 'ready').length, 1);
  assert.ok(h.signals.every(signal => signal.aborted), 'finished resources release their request scopes');
});

test('an incomplete future stream hands off its available bytes without waiting for its full download', async () => {
  const h = harness(), pending = h.run();
  h.network[0]!.input.enqueue(Uint8Array.of(1, 0)); h.network[0]!.input.close(); await tick(); h.sessions[0]!.options.onStart?.(); await tick();
  h.network[1]!.input.enqueue(Uint8Array.of(2, 0)); await tick();
  h.sessions[0]!.ended.resolve('ended'); await tick();
  assert.deepEqual(h.sessions[1]!.received, [Uint8Array.of(2, 0)]);
  h.sessions[1]!.options.onStart?.(); await tick(); assert.deepEqual(h.requests, [0, 1]);
  h.network[1]!.input.enqueue(Uint8Array.of(4, 0)); await tick();
  assert.deepEqual(h.sessions[1]!.received, [Uint8Array.of(2, 0), Uint8Array.of(4, 0)]); h.cancel(); await pending; assert.ok(h.network.at(-1)!.cancelled);
});

test('ordinary prefetched failure is reported once at handoff and reveals remaining text without replay or retry', async () => {
  const h = harness(), pending = h.run();
  h.network[0]!.input.enqueue(Uint8Array.of(1, 0)); h.network[0]!.input.close(); await tick(); h.sessions[0]!.options.onStart?.(); await tick();
  h.network[1]!.input.enqueue(Uint8Array.of(2, 0)); h.network[1]!.input.error(new ApiError('voice unavailable', 502)); await tick();
  assert.deepEqual(h.reveals, [segments[0]!.text]); assert.equal(h.failures.length, 0);
  h.sessions[0]!.ended.resolve('ended'); await pending;
  assert.deepEqual(h.requests, [0, 1]); assert.deepEqual(h.reveals, [segments[0]!.text, reply]);
  assert.equal(h.failures.length, 1); assert.equal(h.events.includes('ready'), false);
});

test('prefetched context/auth/expiry rejection immediately stops old sound and never reveals future text', async () => {
  for (const cause of [new ApiError('changed', 409, 'CONTEXT_CHANGED'), new ApiError('forbidden', 403), new ApiError('expired', 410, 'TRIAL_EXPIRED')]) {
    const h = harness(), pending = h.run();
    h.network[0]!.input.enqueue(Uint8Array.of(1, 0)); h.network[0]!.input.close(); await tick(); h.sessions[0]!.options.onStart?.(); await tick();
    h.network[1]!.input.error(cause); await pending;
    h.sessions[0]!.options.onStart?.();
    assert.deepEqual(h.reveals, [segments[0]!.text]); assert.deepEqual(h.failures, [cause]);
    assert.deepEqual(h.requests, [0, 1]); assert.ok(h.signals.every(signal => signal.aborted));
    assert.equal(h.events.includes('ready'), false);
  }
});

test('hangup/identity replacement abort current and future buffers, including synchronous late start callbacks', async () => {
  const h = harness(), pending = h.run();
  h.network[0]!.input.enqueue(Uint8Array.of(1, 0)); h.network[0]!.input.close(); await tick(); h.sessions[0]!.options.onStart?.(); await tick();
  h.network[1]!.input.enqueue(Uint8Array.of(2, 0)); await tick();
  const before = [...h.events];
  h.signals[1]!.addEventListener('abort', () => h.sessions[0]!.options.onStart?.());
  h.cancel(); await pending; h.sessions[0]!.options.onStart?.(); await tick();
  assert.deepEqual(h.events, before); assert.equal(h.failures.length, 0);
  assert.ok(h.signals.every(signal => signal.aborted)); assert.ok(h.network.at(-1)!.cancelled);
  assert.deepEqual(h.requests, [0, 1]);
  assert.equal(await h.prefetch.play(1, () => { throw new Error('stale start'); }), 'cancelled');
});

test('pre-abort or denied audio context does not spend a TTS request or prefetch', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  const audio = media().audio;
  const stopped = createReplySpeechPrefetch({ segmentCount: 2, streaming: true, signal: controller.signal, isCurrent: () => true, audio,
    fetchPcm: () => { calls++; throw new Error('unexpected'); }, fetchBlob: async () => { calls++; return new Blob(['audio']); } });
  assert.equal(await stopped.play(0, () => {}), 'cancelled'); stopped.dispose();
  const denied = createReplySpeechPrefetch({ segmentCount: 2, streaming: true, isCurrent: () => true,
    audio: { ...audio, playPcmStream: async () => { throw new DOMException('denied', 'NotAllowedError'); } },
    fetchPcm: () => { calls++; throw new Error('unexpected'); }, fetchBlob: async () => { calls++; return new Blob(['audio']); } });
  await assert.rejects(denied.play(0, () => {}), { name: 'NotAllowedError' }); denied.dispose(); assert.equal(calls, 0);
});

test('Blob browsers prefetch only one future segment after real playing and never download it twice', async () => {
  const h = harness(false), pending = h.run(); await tick();
  assert.deepEqual(h.requests, [0]); h.blobs[0]!.resolve(new Blob(['zero'])); await tick();
  assert.deepEqual(h.requests, [0]); h.sessions[0]!.options.onStart?.(); await tick();
  h.blobs[1]!.resolve(new Blob(['one'])); await tick(); assert.deepEqual(h.requests, [0, 1]);
  h.sessions[0]!.ended.resolve('ended'); await tick(); assert.equal(h.sessions.length, 2);
  assert.deepEqual(h.requests, [0, 1]); h.sessions[1]!.options.onStart?.(); await tick();
  assert.deepEqual(h.requests, [0, 1, 2]); h.cancel(); h.blobs[2]!.resolve(new Blob(['late'])); await pending;
  assert.ok(h.signals.every(signal => signal.aborted)); assert.equal(h.failures.length, 0);
});

test('oversized prefetched PCM is discarded and does not cause another provider request', async () => {
  const h = harness(), pending = h.run();
  h.network[0]!.input.enqueue(Uint8Array.of(1, 0)); h.network[0]!.input.close(); await tick(); h.sessions[0]!.options.onStart?.(); await tick();
  h.network[1]!.input.enqueue(new Uint8Array(MAX_BUFFERED_SPEECH_BYTES + 1)); await tick();
  h.sessions[0]!.ended.resolve('ended'); await pending;
  assert.deepEqual(h.requests, [0, 1]); assert.match(String(h.failures[0]), /超过本轮限制/);
  assert.deepEqual(h.reveals, [segments[0]!.text, reply]); assert.ok(h.network[1]!.cancelled);
});

test('the real PCM protocol done frame cannot trigger prefetch before response EOF', async () => {
  const m = media(), responseStreams: ReadableStreamDefaultController<Uint8Array>[] = [], requests: number[] = [];
  const request: typeof fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)).segmentIndex);
    return new Response(new ReadableStream<Uint8Array>({ start(stream) { responseStreams.push(stream); } }), { headers: { 'content-type': 'application/x-ndjson' } });
  };
  const prefetch = createReplySpeechPrefetch({ segmentCount: 2, streaming: true, isCurrent: () => true, audio: m.audio,
    fetchPcm: (index, signal) => fetchReplySpeechStream('fictional', crypto.randomUUID(), signal, 1000, request, undefined, index),
    fetchBlob: async () => { throw new Error('unexpected Blob'); } });
  const pending = prefetch.play(0, () => {}); await tick();
  responseStreams[0]!.enqueue(new TextEncoder().encode([
    { type: 'format', format: 'pcm_s16le', sampleRate: 24000, channels: 1 }, { type: 'audio', data: 'AQA=' }, { type: 'done' },
  ].map(value => JSON.stringify(value) + '\n').join('')));
  await tick(); m.sessions[0]!.options.onStart?.(); await tick(); assert.deepEqual(requests, [0]);
  responseStreams[0]!.close(); await tick(); assert.deepEqual(requests, [0, 1]);
  prefetch.dispose(); m.audio.stopPlayback(); await pending;
});

test('Blob download has a byte cap before retaining a full response and abort promptly releases its reader', async () => {
  let cancelled = false;
  await assert.rejects(fetchReplySpeech('fictional', crypto.randomUUID(), undefined, 1000, async () => new Response(new ReadableStream<Uint8Array>({
    start(stream) { stream.enqueue(new Uint8Array(MAX_BUFFERED_SPEECH_BYTES)); stream.enqueue(Uint8Array.of(1)); }, cancel() { cancelled = true; },
  }))), /超过本轮限制/);
  assert.equal(cancelled, true);
  let requested = 0;
  await assert.rejects(fetchReplySpeech('fictional', crypto.randomUUID(), undefined, 1000, async () => {
    requested++; return new Response('x', { headers: { 'content-length': String(MAX_BUFFERED_SPEECH_BYTES + 1) } });
  }), /超过本轮限制/); assert.equal(requested, 1);
  const controller = new AbortController(); cancelled = false;
  const pending = fetchReplySpeech('fictional', crypto.randomUUID(), controller.signal, 1000, async () => new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } })));
  await tick(); controller.abort(); await assert.rejects(pending, { name: 'AbortError' }); assert.equal(cancelled, true);
});

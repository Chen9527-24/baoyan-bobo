import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '../apps/web/src/lib/api.ts';
import { RealtimeAudio, RealtimeUploadQueue, StreamingPcm16Encoder, pcmBase64, pcmFromBase64 } from '../apps/web/src/lib/realtimeAudio.ts';
import { canInterruptRealtime, estimateRealtimeAudioCost, finishRealtimeUpload, parseRealtimeEvent, realtimeEndedMessage, realtimeFailureMessage, RealtimeReplyGate } from '../apps/web/src/lib/realtimeClient.ts';

function deferred<T = void>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function encode(source: Float32Array, sourceRate: number, parts: number[]) {
 const encoder = new StreamingPcm16Encoder(sourceRate), output: Uint8Array[] = []; let offset = 0;
 for (const size of parts) { output.push(...encoder.push(source.subarray(offset, offset + size))); offset += size; }
 output.push(...encoder.push(source.subarray(offset))); const tail = encoder.finish(); if (tail) output.push(tail);
 return { bytes: Buffer.concat(output), chunks: output };
}

test('PCM resampling retains continuity across arbitrary microphone callbacks', () => {
 const source = Float32Array.from({ length: 48000 }, (_, index) => Math.sin(index / 30));
 const whole = encode(source, 48000, []), fragmented = encode(source, 48000, [1, 2048, 31, 777, 16384]);
 assert.deepEqual(fragmented.bytes, whole.bytes); assert.equal(whole.bytes.length, 32000);
 assert.ok(fragmented.chunks.every(part => part.length <= 3200 && part.length % 2 === 0));
});

test('PCM at device rates clamps invalid values, finishes bounded partial frames and resets', () => {
 const encoder = new StreamingPcm16Encoder(16000);
 assert.deepEqual(encoder.push(new Float32Array([-2, 2, NaN, Infinity, 0])), []);
 const result = encoder.finish()!; const values = new DataView(result.buffer);
 assert.deepEqual([0, 2, 4, 6].map(index => values.getInt16(index, true)), [-32768, 32767, 0, 0]);
 assert.equal(encoder.finish(), undefined);
 assert.throws(() => new StreamingPcm16Encoder(0));
 for (const rate of [8000, 44100, 96000]) {
  const input = Float32Array.from({ length: rate }, (_, i) => Math.sin(i / 11));
  const result = encode(input, rate, [17, 1024, 29]);
  assert.ok(Math.abs(result.bytes.length - 32000) <= 4);
  assert.deepEqual(result.bytes, encode(input, rate, []).bytes);
 }
});

test('PCM transport rejects broken samples and roundtrips signed bytes', () => {
 const bytes = new Uint8Array([0, 128, 255, 127, 0, 0]); assert.deepEqual(pcmFromBase64(pcmBase64(bytes)), bytes);
 for (const broken of ['', '??==', 'AAA', 'AA==', 'A'.repeat(256004)]) assert.throws(() => pcmFromBase64(broken));
});

test('ordered upload combines backlog for high RTT without reordering or resetting sequence', async () => {
 const first = deferred(), sent: { bytes: Uint8Array; sequence: number }[] = [];
 const queue = new RealtimeUploadQueue(async (bytes, sequence) => { sent.push({ bytes, sequence }); if (sequence === 0) await first.promise; }, error => { throw error; });
 for (let i = 0; i < 7; i++) assert.equal(queue.enqueue(new Uint8Array(3200).fill(i)), true);
 assert.equal(sent.length, 1); const flushed = queue.flush(); first.resolve(); await flushed;
 assert.deepEqual(sent.map(value => [value.sequence, value.bytes.length]), [[0, 3200], [1, 16000], [2, 3200]]);
 for (let i = 0; i < 5; i++) assert.equal(sent[1]!.bytes[i * 3200], i + 1);
 queue.enqueue(new Uint8Array(400)); await queue.flush(); assert.equal(sent[3]!.sequence, 3); queue.stop();
});

test('upload queue bounds memory, aborts in-flight work and ignores late success', async () => {
 const pending = deferred(); let sent = 0, failures = 0; let signal: AbortSignal | undefined;
 const queue = new RealtimeUploadQueue(async (_bytes, _sequence, value) => { ++sent; signal = value; await pending.promise; }, () => { ++failures; });
 queue.enqueue(new Uint8Array(3200)); const flush = queue.flush(); const rejection = assert.rejects(flush, /停止/);
 for (let i = 1; i < 30; i++) assert.equal(queue.enqueue(new Uint8Array(3200)), true);
 assert.equal(queue.enqueue(new Uint8Array(3200)), false); assert.equal(signal?.aborted, true); assert.equal(failures, 1);
 pending.resolve(); await rejection; await Promise.resolve(); assert.equal(sent, 1); assert.equal(queue.enqueue(new Uint8Array(3200)), false);
});

test('failed uploads reject flush and expose only fixed local messages', async () => {
 const messages: string[] = []; const queue = new RealtimeUploadQueue(async () => { throw new Error('secret-upstream-token'); }, error => messages.push(error.message));
 queue.enqueue(new Uint8Array(3200)); await assert.rejects(queue.flush());
 assert.equal(messages.length, 1); assert.ok(!messages.join().includes('secret'));
});

test('leaving while flushing prevents a late turn commit; commit timing excludes upload', async () => {
 const upload = deferred(), order: string[] = []; let live = true;
 const completion = finishRealtimeUpload(() => upload.promise, () => live, () => order.push('timer'), async () => { order.push('commit'); });
 live = false; upload.resolve(); assert.equal(await completion, false); assert.deepEqual(order, []);
 assert.equal(await finishRealtimeUpload(async () => { order.push('upload'); }, () => true, () => order.push('timer'), async () => { order.push('commit'); }), true);
 assert.deepEqual(order, ['upload', 'timer', 'commit']);
 assert.equal(canInterruptRealtime('sending'), false); assert.equal(canInterruptRealtime('recording'), false);
 assert.equal(canInterruptRealtime('thinking'), true); assert.equal(canInterruptRealtime('speaking'), true);
});

test('automatic endpoint during upload invalidates manual commit while a new input starts at sequence zero', async () => {
 const pending = deferred(); let activeInput: string | undefined = 'input-old'; const requests: { inputId: string; sequence: number }[] = []; let commits = 0;
 const oldQueue = new RealtimeUploadQueue(async (_bytes, sequence) => { requests.push({ inputId: 'input-old', sequence }); await pending.promise; }, () => assert.fail('cancelled old input is not a connection error'));
 oldQueue.enqueue(new Uint8Array(3200)); oldQueue.enqueue(new Uint8Array(3200));
 const manual = finishRealtimeUpload(() => oldQueue.flush(), () => activeInput === 'input-old', () => assert.fail('old timer must not start'), async () => { ++commits; }).catch(() => false);
 // The matching input-ended event closes capture and discards the old upload queue.
 activeInput = undefined; oldQueue.stop();
 activeInput = 'input-new'; const nextQueue = new RealtimeUploadQueue(async (_bytes, sequence) => { requests.push({ inputId: activeInput!, sequence }); }, () => assert.fail('new input remains independent'));
 nextQueue.enqueue(new Uint8Array(3200)); pending.resolve(); await nextQueue.flush(); assert.equal(await manual, false);
 assert.equal(commits, 0); assert.deepEqual(requests, [{ inputId: 'input-old', sequence: 0 }, { inputId: 'input-new', sequence: 0 }]); nextQueue.stop();
});

test('reply subtitles are cumulative, hidden before playback, and cancelled replies never revive', () => {
 const gate = new RealtimeReplyGate(); assert.equal(gate.update('reply-1', '你好'), undefined);
 assert.equal(gate.update('reply-1', '你好呀'), undefined); assert.equal(gate.played('reply-1'), '你好呀');
 assert.equal(gate.update('reply-1', '你好呀，小朋友。'), '你好呀，小朋友。'); gate.done('reply-1'); assert.equal(gate.ended, true);
 gate.interrupt(); assert.equal(gate.accept('reply-1'), false); assert.equal(gate.played('reply-1'), undefined); assert.equal(gate.ended, false);
 assert.equal(gate.update('reply-2', '我在听'), undefined); assert.equal(gate.played('reply-2'), '我在听'); assert.equal(gate.done('reply-1'), false);
});

test('a continuous speech-start binds the next reply and rejects late text, audio and completion from previous turns', () => {
 const gate = new RealtimeReplyGate(); gate.beginTurn('response-1');
 assert.equal(gate.update('response-1', '还没说完的话'), undefined);
 assert.equal(gate.played('response-1'), '还没说完的话');
 gate.beginTurn('response-2');
 assert.equal(gate.accept('response-1'), false); assert.equal(gate.done('response-1'), false);
 assert.equal(gate.update('unknown-old-response', '迟到的话'), undefined);
 assert.equal(gate.played('response-1'), undefined); assert.equal(gate.hasAudioStarted, false);
 assert.equal(gate.update('response-2', '听见你接着说了'), undefined);
 assert.equal(gate.played('response-2'), '听见你接着说了');
 assert.equal(gate.done('response-2'), true); assert.equal(gate.ended, true);
 gate.beginTurn('response-3'); assert.equal(gate.accept('response-2'), false); assert.equal(gate.ended, false);
});

test('continuous speech-start requires complete bounded turn identifiers and ignores unrelated payload fields', () => {
 assert.deepEqual(parseRealtimeEvent(JSON.stringify({ type: 'speech-start', utteranceId: 'u-2', responseId: 'r-2', interrupted: true, internal: 'secret' })), { type: 'speech-start', utteranceId: 'u-2', responseId: 'r-2', interrupted: true });
 for (const invalid of [{ utteranceId: 'u-2', interrupted: true }, { utteranceId: 'u-2', responseId: 'r-2' }, { utteranceId: '../bad', responseId: 'r-2', interrupted: false }]) {
  assert.throws(() => parseRealtimeEvent(JSON.stringify({ type: 'speech-start', ...invalid })));
 }
});

test('heard acknowledgement waits for reply end and actual full playback, once only and never for an interrupted reply', () => {
 const gate = new RealtimeReplyGate(); gate.beginTurn('r1'); gate.update('r1', '第一句'); gate.done('r1');
 assert.equal(gate.takeHeardAcknowledgement(false), undefined); // No audio has played.
 gate.played('r1'); assert.equal(gate.takeHeardAcknowledgement(true), undefined); // Still queued.
 gate.beginTurn('r2'); assert.equal(gate.takeHeardAcknowledgement(false), undefined); // r1 was interrupted.
 gate.update('r2', '第二句'); gate.played('r2'); assert.equal(gate.takeHeardAcknowledgement(false), undefined); // No provider end yet.
 gate.done('r2'); assert.equal(gate.takeHeardAcknowledgement(false), 'r2');
 assert.equal(gate.takeHeardAcknowledgement(false), undefined); // Duplicate drain/end callbacks.
 gate.beginTurn('r3'); gate.update('r3', '第三句'); gate.done('r3'); gate.played('r3');
 assert.equal(gate.takeHeardAcknowledgement(false), 'r3');
});

test('realtime event parsing drops raw errors and rejects invalid audio identifiers or format', () => {
 assert.deepEqual(parseRealtimeEvent(JSON.stringify({ type: 'error', code: 'REALTIME_SAFETY', error: 'secret-upstream-token' })), { type: 'error', code: 'REALTIME_SAFETY' });
 assert.equal(parseRealtimeEvent('{"type":"usage","tokens":100}'), undefined);
 assert.throws(() => parseRealtimeEvent(JSON.stringify({ type: 'audio', sampleRate: 16000, responseId: 'r1', audioBase64: 'AAA=' })));
 assert.throws(() => parseRealtimeEvent(JSON.stringify({ type: 'reply-text', responseId: '../bad', text: 'hello', final: true })));
 assert.throws(() => parseRealtimeEvent(JSON.stringify({ type: 'reply-text', responseId: 'r1', text: 'hello' })));
 assert.equal(parseRealtimeEvent('{"type":"ready"}')?.type, 'ready');
 assert.deepEqual(parseRealtimeEvent('{"type":"input-ended","inputId":"input-1","reason":"vad"}'), { type: 'input-ended', inputId: 'input-1', reason: 'vad' });
 assert.throws(() => parseRealtimeEvent('{"type":"input-ended","inputId":"input-1","reason":"unknown"}'));
});

test('known safety, privacy, memory and account closures are actionable without raw errors', () => {
 for (const [code, expected] of [['REALTIME_SAFETY', '大人'], ['REALTIME_PRIVACY', '私人的'], ['REALTIME_MEMORY_ACTION', '记忆小本'], ['ACCOUNT_REPLACED', '另一台设备'], ['REALTIME_UNAVAILABLE', '普通聊天'], ['TRIAL_EXPIRED', '内测已结束']]) {
  const text = realtimeFailureMessage(new ApiError('secret-upstream-token', 500, code)); assert.ok(text.includes(expected!)); assert.ok(!text.includes('secret'));
 }
 assert.ok(realtimeEndedMessage('account-replaced').includes('另一台设备'));
 assert.ok(realtimeEndedMessage('expired').includes('时间到了'));
 assert.ok(realtimeEndedMessage('secret-upstream-token').includes('连接已结束'));
});

test('audio cost is explicitly unavailable before measured bytes, with known input/output conversion', () => {
 assert.equal(estimateRealtimeAudioCost(), undefined);
 assert.equal(estimateRealtimeAudioCost(600, 0), 0.3);
 assert.equal(estimateRealtimeAudioCost(60, 60), 0.48);
});

class FakeContext {
 static latest: FakeContext; state: AudioContextState = 'running'; currentTime = 0; sampleRate = 48000; onstatechange: (() => void) | null = null; destination = {};
 sources: { start: (time: number) => void; stop: () => void; disconnect: () => void; onended: (() => void) | null; buffer: unknown; stopped: boolean; at?: number }[] = [];
 processor?: { onaudioprocess: ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void) | null; connect: () => void; disconnect: () => void };
 constructor() { FakeContext.latest = this; }
 async resume() {} async close() { this.state = 'closed'; }
 createBuffer(_channels: number, length: number) { return { getChannelData: () => new Float32Array(length) }; }
 createBufferSource() { const source = { buffer: undefined as unknown, onended: null as (() => void) | null, stopped: false, at: undefined as number | undefined, connect() {}, disconnect() {}, start(time: number) { this.at = time; }, stop() { this.stopped = true; } }; this.sources.push(source); return source; }
 createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
 createScriptProcessor() { this.processor = { onaudioprocess: null, connect() {}, disconnect() {} }; return this.processor; }
 createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
}
function installAudioGlobals(getUserMedia: (constraints?: MediaStreamConstraints) => Promise<unknown>) {
 const originals = new Map(['window', 'document', 'navigator'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
 Object.defineProperty(globalThis, 'window', { configurable: true, value: { AudioContext: FakeContext } });
 Object.defineProperty(globalThis, 'document', { configurable: true, value: { hidden: false } });
 Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia } } });
 return () => { for (const [key, value] of originals) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); } };
}

test('continuous capture keeps one microphone and upload sequence across reply playback and spoken interruption', async () => {
 let opened = 0, stopped = 0; let constraints: MediaStreamConstraints | undefined;
 const track = { onended: null as (() => void) | null, stop() { ++stopped; } };
 const restore = installAudioGlobals(async value => { ++opened; constraints = value; return { getTracks: () => [track] }; });
 const sent: number[] = [];
 const queue = new RealtimeUploadQueue(async (_bytes, sequence) => { sent.push(sequence); }, error => assert.fail(error.message));
 try {
  const sound = new RealtimeAudio(message => assert.fail(message), () => {}); await sound.resume();
  assert.equal(await sound.startCapture(bytes => queue.enqueue(bytes)), true); const context = FakeContext.latest;
  const capture = () => context.processor!.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(4801) } });
  capture(); await queue.flush();
  sound.play(new Uint8Array(4800), () => {}, () => {}); capture(); await queue.flush();
  sound.clearPlayback(); capture(); await queue.flush();
  assert.equal(opened, 1); assert.equal(stopped, 0); assert.deepEqual(sent, [0, 1, 2]);
  assert.deepEqual(constraints, { audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
  const lateCallback = context.processor!.onaudioprocess;
  queue.stop(); sound.close(); lateCallback?.({ inputBuffer: { getChannelData: () => new Float32Array(4801) } });
  assert.equal(stopped, 1); assert.deepEqual(sent, [0, 1, 2]); assert.equal(context.processor?.onaudioprocess, null);
 } finally { queue.stop(); restore(); }
});

test('late microphone permission after leaving stops every acquired track', async () => {
 const permission = deferred<unknown>(); const restore = installAudioGlobals(() => permission.promise); let stopped = 0;
 try {
  const audio = new RealtimeAudio(() => assert.fail('unexpected failure'), () => {}); await audio.resume();
  const started = audio.startCapture(() => assert.fail('late audio must not upload')); audio.close();
  permission.resolve({ getTracks: () => [{ stop() { ++stopped; } }] });
  assert.equal(await started, false); assert.equal(stopped, 1); assert.equal(FakeContext.latest.state, 'closed');
 } finally { restore(); }
});

test('playback waits for the running audio clock and cancellation prevents late subtitle start', async () => {
 const restore = installAudioGlobals(async () => assert.fail('playback does not request microphone')); let starts = 0, drained = 0; const playback: boolean[] = [];
 try {
  const audio = new RealtimeAudio(message => assert.fail(message), value => playback.push(value)); await audio.resume();
  audio.play(new Uint8Array(4800), () => ++starts, () => ++drained); assert.equal(starts, 0);
  await new Promise(resolve => setTimeout(resolve, 22)); assert.equal(starts, 0);
  FakeContext.latest.currentTime = 0.02; await new Promise(resolve => setTimeout(resolve, 22)); assert.equal(starts, 1); assert.ok(playback.includes(true));
  audio.play(new Uint8Array(4800), () => ++starts, () => ++drained); audio.clearPlayback();
  FakeContext.latest.currentTime = 1; await new Promise(resolve => setTimeout(resolve, 22));
  assert.equal(starts, 1); assert.equal(drained, 0); assert.equal(audio.hasPlayback, false); assert.ok(FakeContext.latest.sources.every(source => source.stopped)); audio.close();
 } finally { restore(); }
});

test('tiny PCM final chunks still reveal captions if they finish between clock checks', async () => {
 const restore = installAudioGlobals(async () => assert.fail('must not record')); let starts = 0, drained = 0;
 try {
  const audio = new RealtimeAudio(message => assert.fail(message), () => {}); await audio.resume();
  audio.play(new Uint8Array(48), () => ++starts, () => ++drained); assert.equal(starts, 0);
  FakeContext.latest.currentTime = 0.02; FakeContext.latest.sources[0]!.onended?.();
  assert.equal(starts, 1); assert.equal(drained, 1); audio.close();
 } finally { restore(); }
});

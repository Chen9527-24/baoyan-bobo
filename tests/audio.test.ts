import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioController, type AudioDependencies } from '../apps/web/src/audio.js';
import { createReplySpeechPrefetch } from '../apps/web/src/lib/replySpeechPrefetch.js';
import { presentReplySegmentsWithPlayback } from '../apps/web/src/lib/replyPlayback.js';
import type { ReplySegment } from '../apps/web/src/lib/types.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class FakeTrack extends EventTarget {
  readyState = 'live';
  stops = 0;
  stop() { this.stops++; this.readyState = 'ended'; }
}

function fakeStream() {
  const track = new FakeTrack();
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  return { track, stream };
}

class Clock {
  now = 0;
  next = 0;
  timers = new Map<number, { at: number; every: number; callback: () => void }>();
  timeout = (callback: () => void, ms: number) => this.add(callback, ms, 0);
  interval = (callback: () => void, ms: number) => this.add(callback, ms, ms);
  clear = (id: number) => { this.timers.delete(id); };
  private add(callback: () => void, ms: number, every: number) {
    const id = ++this.next;
    this.timers.set(id, { at: this.now + ms, every, callback });
    return id;
  }
  advance(ms: number) {
    const until = this.now + ms;
    for (;;) {
      const next = [...this.timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next;
      this.now = timer.at;
      if (timer.every) timer.at += timer.every;
      else this.timers.delete(id);
      timer.callback();
    }
    this.now = until;
  }
}

class FakeRecorder {
  state = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  queued: (() => void)[] = [];
  start() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    // Snapshot callbacks to simulate events that were already queued before cancellation.
    const data = this.ondataavailable;
    const end = this.onstop;
    this.queued.push(() => { data?.({ data: new Blob(['voice']) }); end?.(); });
  }
  flush() { this.queued.splice(0).forEach((callback) => callback()); }
}

function harness() {
  const clock = new Clock();
  const streams: ReturnType<typeof fakeStream>[] = [];
  const recorders: FakeRecorder[] = [];
  let level = 0;
  let requests = 0;
  let closes = 0;
  const dependencies: Partial<AudioDependencies> = {
    secureContext: true,
    getUserMedia: async () => {
      requests++;
      const stream = fakeStream();
      streams.push(stream);
      return stream.stream;
    },
    createAudioContext: () => ({
      state: 'running',
      createAnalyser: () => ({ fftSize: 1024, getFloatTimeDomainData: (data: Float32Array) => data.fill(level), disconnect() {} }),
      createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
      close: async () => { closes++; },
    } as unknown as AudioContext),
    createRecorder: () => {
      const recorder = new FakeRecorder();
      recorders.push(recorder);
      return recorder as unknown as MediaRecorder;
    },
    supportsMimeType: () => true,
    now: () => clock.now,
    setTimeout: clock.timeout as unknown as typeof setTimeout,
    setInterval: clock.interval as unknown as typeof setInterval,
    clearTimeout: clock.clear as unknown as typeof clearTimeout,
    clearInterval: clock.clear as unknown as typeof clearInterval,
  };
  return {
    clock, streams, recorders, dependencies,
    setLevel(value: number) { level = value; },
    get requests() { return requests; },
    get closes() { return closes; },
    controller: new AudioController(dependencies),
  };
}

test('capability detection is passive and a late permission result closes immediately after cancellation', async () => {
  const h = harness();
  const permission = deferred<MediaStream>();
  let requests = 0;
  const controller = new AudioController({ ...h.dependencies, getUserMedia: () => { requests++; return permission.promise; } });
  assert.equal(controller.getCapabilities().microphone, true);
  assert.equal(requests, 0);
  const levels: number[] = [];
  const start = controller.startMeter({ onLevel: (level) => levels.push(level) });
  assert.equal(requests, 1);
  controller.cancel();
  const late = fakeStream();
  permission.resolve(late.stream);
  assert.equal(await start, false);
  assert.equal(late.track.readyState, 'ended');
  h.clock.advance(60_000);
  assert.deepEqual(levels, []);
  assert.equal(h.recorders.length, 0);
  controller.dispose();
  h.controller.dispose();
});

test('a second start cannot create another permission request or overlapping capture', async () => {
  const h = harness();
  const permission = deferred<MediaStream>();
  let requests = 0;
  const controller = new AudioController({ ...h.dependencies, getUserMedia: () => { requests++; return permission.promise; } });
  const first = controller.startMeter({ onLevel() {} });
  await assert.rejects(controller.startListening({ onUtterance() {} }), { code: 'capture_busy' });
  assert.equal(requests, 1);
  const stream = fakeStream();
  permission.resolve(stream.stream);
  assert.equal(await first, true);
  await assert.rejects(controller.startMeter({ onLevel() {} }), { code: 'capture_busy' });
  assert.equal(requests, 1);
  controller.stopCapture();
  assert.equal(stream.track.readyState, 'ended');
  controller.dispose();
  h.controller.dispose();
});

test('cancelled permission request does not interfere with a newer local test', async () => {
  const h = harness();
  const oldPermission = deferred<MediaStream>();
  const newPermission = deferred<MediaStream>();
  const permissions = [oldPermission, newPermission];
  const controller = new AudioController({ ...h.dependencies, getUserMedia: () => permissions.shift()!.promise });
  const oldStart = controller.startMeter({ onLevel() { assert.fail('old meter must stay silent'); } });
  controller.cancel();
  let levels = 0;
  const newStart = controller.startMeter({ onLevel() { levels++; } });
  const newer = fakeStream();
  newPermission.resolve(newer.stream);
  assert.equal(await newStart, true);
  const older = fakeStream();
  oldPermission.resolve(older.stream);
  assert.equal(await oldStart, false);
  assert.equal(older.track.readyState, 'ended');
  assert.equal(newer.track.readyState, 'live');
  h.clock.advance(100);
  assert.equal(levels, 2);
  controller.dispose();
  h.controller.dispose();
});

test('a complete voice turn stops capture before delivering the final audio and never resumes itself', async () => {
  const h = harness();
  let delivered = 0;
  assert.equal(await h.controller.startListening({
    onUtterance(blob) {
      delivered++;
      assert.ok(blob.size > 0);
      assert.equal(h.streams[0].track.readyState, 'ended');
      assert.equal(h.closes, 1);
    },
  }), true);
  h.setLevel(0.1);
  h.clock.advance(250);
  h.setLevel(0);
  h.clock.advance(1_400);
  assert.equal(h.streams[0].track.readyState, 'ended');
  assert.equal(delivered, 0);
  h.recorders[0].flush();
  assert.equal(delivered, 1);
  h.clock.advance(60_000);
  assert.equal(delivered, 1);
  assert.equal(h.requests, 1);
  assert.equal(h.clock.timers.size, 0);
  h.controller.dispose();
});

test('cancel discards queued final chunks and prevents an old utterance from being delivered', async () => {
  const h = harness();
  let delivered = 0;
  let errors = 0;
  await h.controller.startListening({ onUtterance() { delivered++; }, onError() { errors++; } });
  h.setLevel(0.1);
  h.clock.advance(250);
  h.setLevel(0);
  h.clock.advance(1_400);
  h.controller.cancel();
  h.recorders[0].flush();
  h.clock.advance(60_000);
  assert.equal(delivered, 0);
  assert.equal(errors, 0);
  assert.equal(h.streams[0].track.readyState, 'ended');
  assert.equal(h.clock.timers.size, 0);
  h.controller.dispose();
});

test('a silent turn and a bounded local meter stop without uploading or starting another capture', async () => {
  const h = harness();
  let silent = 0;
  let done = 0;
  await h.controller.startListening({ onUtterance() { assert.fail('silence must not be delivered'); }, onSilence() { silent++; } });
  h.clock.advance(12_000);
  h.recorders[0].flush();
  assert.equal(silent, 1);
  assert.equal(h.streams[0].track.readyState, 'ended');
  await h.controller.startMeter({ durationMs: 1_000, onLevel() {}, onDone() { done++; } });
  h.clock.advance(1_000);
  assert.equal(done, 1);
  assert.equal(h.streams[1].track.readyState, 'ended');
  assert.equal(h.recorders.length, 1, 'meter never creates a recording');
  assert.equal(h.requests, 2);
  assert.equal(h.clock.timers.size, 0);
  h.controller.dispose();
});

test('continuous speech is bounded to thirty seconds and capture is already closed on delivery', async () => {
  const h = harness();
  let delivered = 0;
  await h.controller.startListening({ maxDurationMs: 600_000, onUtterance() { delivered++; } });
  h.setLevel(0.1);
  h.clock.advance(30_000);
  assert.equal(h.streams[0].track.readyState, 'ended');
  h.recorders[0].flush();
  assert.equal(delivered, 1);
  h.controller.dispose();
});

test('cancel settles pending audio playback and device speech, and suppresses their late callbacks', async () => {
  const h = harness();
  const audioStarted = deferred<void>();
  let pauses = 0;
  let revoked = 0;
  let speechCancelled = 0;
  let callbacks = 0;
  let utterance: SpeechSynthesisUtterance;
  const element = {
    onplaying: null as (() => void) | null,
    onended: null as (() => void) | null,
    onerror: null as (() => void) | null,
    play: () => audioStarted.promise,
    pause() { pauses++; },
    removeAttribute() {}, load() {}, src: '',
  };
  const controller = new AudioController({
    ...h.dependencies,
    createAudioElement: () => element as unknown as HTMLAudioElement,
    createObjectURL: () => 'blob:local-test',
    revokeObjectURL: () => { revoked++; },
    createSpeechUtterance: () => ({} as SpeechSynthesisUtterance),
    speechSynthesis: {
      speak(value: SpeechSynthesisUtterance) { utterance = value; },
      cancel() { speechCancelled++; },
    } as unknown as SpeechSynthesis,
  });
  const audio = controller.playBlob(new Blob(['voice']), { onStart() { callbacks++; }, onEnd() { callbacks++; }, onError() { callbacks++; } });
  const lateEnd = element.onended;
  controller.cancel();
  assert.equal(await audio, 'cancelled');
  audioStarted.resolve();
  await Promise.resolve();
  lateEnd?.();
  assert.ok(pauses >= 1);
  assert.equal(revoked, 1);
  assert.equal(callbacks, 0);
  const speech = controller.speak('你好', { onStart() { callbacks++; }, onEnd() { callbacks++; }, onError() { callbacks++; } });
  const lateSpeechEnd = utterance!.onend;
  controller.stop();
  assert.equal(await speech, 'cancelled');
  lateSpeechEnd?.call(utterance!, {} as SpeechSynthesisEvent);
  assert.equal(speechCancelled, 1);
  assert.equal(callbacks, 0);
  assert.equal(h.clock.timers.size, 0);
  controller.dispose();
  h.controller.dispose();
});

function playbackHarness() {
  const h = harness();
  const playStarted = deferred<void>();
  let pauses = 0; let revoked = 0; let removed = 0; const playTimes: number[] = [];
  const element = {
    onplaying: null as (() => void) | null,
    onended: null as (() => void) | null,
    onerror: null as (() => void) | null,
    play: () => { playTimes.push(h.clock.now); return playStarted.promise; },
    pause() { pauses++; },
    removeAttribute() { removed++; this.src = ''; }, load() {}, src: '',
  };
  const controller = new AudioController({ ...h.dependencies,
    createAudioElement: () => element as unknown as HTMLAudioElement,
    createObjectURL: () => 'blob:local-test', revokeObjectURL: () => { revoked++; },
  });
  return { ...h, controller, element, playStarted, playTimes,
    get pauses() { return pauses; }, get revoked() { return revoked; }, get removed() { return removed; },
  };
}

test('Blob earliest-start waiting keeps audio, captions and activity silent until actual media playing', async () => {
  const h = playbackHarness(); let starts = 0; const activities: boolean[] = [];
  const result = h.controller.playBlob(new Blob(['voice']), { notBeforeMs: 220, onStart: () => { starts++; }, onActivityChange: value => activities.push(value) });
  assert.deepEqual(h.playTimes, []); assert.equal(starts, 0); assert.deepEqual(activities, []);
  h.clock.advance(219); assert.deepEqual(h.playTimes, []);
  h.clock.advance(1); assert.deepEqual(h.playTimes, [220]); assert.equal(starts, 0); assert.deepEqual(activities, []);
  h.element.onplaying?.(); h.playStarted.resolve(); await Promise.resolve();
  assert.equal(starts, 1); assert.deepEqual(activities, [true]);
  h.element.onended?.(); assert.equal(await result, 'ended'); assert.deepEqual(activities, [true, false]);
  assert.equal(h.revoked, 1); assert.equal(h.clock.timers.size, 0); h.controller.dispose();
});

test('Blob audio delivered after its intended boundary starts without another pause', async () => {
  const h = playbackHarness(); h.clock.advance(600);
  const result = h.controller.playBlob(new Blob(['already downloaded']), { notBeforeMs: 220 });
  assert.deepEqual(h.playTimes, [600]); assert.equal(h.clock.timers.size, 1, 'only the existing playback duration deadline remains');
  h.controller.cancel(); assert.equal(await result, 'cancelled'); assert.equal(h.clock.timers.size, 0); h.controller.dispose();
});

test('Blob earliest-start accepts the five-hundred-millisecond bound and does not add another timer after starting', async () => {
  const h = playbackHarness(); const result = h.controller.playBlob(new Blob(['voice']), { notBeforeMs: 500 });
  h.clock.advance(499); assert.deepEqual(h.playTimes, []); h.clock.advance(1); assert.deepEqual(h.playTimes, [500]);
  assert.equal(h.clock.timers.size, 1); h.controller.cancel(); assert.equal(await result, 'cancelled'); h.controller.dispose();
});

for (const action of ['cancel', 'dispose', 'pagehide'] as const) {
  test(`${action} during Blob earliest-start waiting clears its timer and URL and ignores already queued starts`, async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'window'), browser = new EventTarget();
    Object.defineProperty(globalThis, 'window', { value: browser, configurable: true });
    const h = playbackHarness(); let callbacks = 0; const activities: boolean[] = [];
    try {
      const result = h.controller.playBlob(new Blob(['voice']), { notBeforeMs: 280,
        onStart: () => { callbacks++; }, onEnd: () => { callbacks++; }, onError: () => { callbacks++; }, onActivityChange: value => activities.push(value) });
      const queuedStart = [...h.clock.timers.values()].find(value => value.at === 280)!.callback, queuedPlaying = h.element.onplaying;
      h.clock.advance(100);
      if (action === 'pagehide') browser.dispatchEvent(new Event('pagehide'));
      else h.controller[action]();
      assert.equal(await result, 'cancelled'); assert.equal(h.clock.timers.size, 0); assert.equal(h.revoked, 1); assert.equal(h.removed, 1);
      queuedStart(); queuedPlaying?.(); h.clock.advance(1000); h.playStarted.resolve(); await Promise.resolve();
      assert.deepEqual(h.playTimes, []); assert.equal(callbacks, 0); assert.equal(activities.includes(true), false); assert.equal(h.element.src, '');
    } finally {
      h.controller.dispose();
      if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window');
    }
  });
}

test('a playback timeout racing the planned Blob start cancels the pending start and releases its URL', async () => {
  const h = playbackHarness(); let starts = 0;
  const result = h.controller.playBlob(new Blob(['voice']), { notBeforeMs: 280, startTimeoutMs: 1000, onStart: () => { starts++; } });
  const rejected = assert.rejects(result, { code: 'playback_start_timeout' });
  const queuedStart = [...h.clock.timers.values()].find(value => value.at === 280)!.callback;
  const timeout = [...h.clock.timers.values()].find(value => value.at === 1000)!.callback;
  timeout(); await rejected; queuedStart(); h.clock.advance(1000);
  assert.equal(starts, 0); assert.deepEqual(h.playTimes, []); assert.equal(h.revoked, 1); assert.equal(h.clock.timers.size, 0); h.controller.dispose();
});

test('invalid or unbounded Blob earliest-start targets allocate no URL or playback timers', async () => {
  for (const notBeforeMs of [NaN, Infinity, -Infinity, 501]) {
    const h = playbackHarness();
    await assert.rejects(h.controller.playBlob(new Blob(['voice']), { notBeforeMs }), { code: 'invalid_playback_timing' });
    assert.deepEqual(h.playTimes, []); assert.equal(h.element.src, ''); assert.equal(h.revoked, 0); assert.equal(h.clock.timers.size, 0); h.controller.dispose();
  }
});

test('an opt-in eight second start deadline stops silent media and discards late playing and late play resolution', async () => {
  const h = playbackHarness(); let starts = 0; let errors = 0;
  const result = h.controller.playBlob(new Blob(['voice']), { startTimeoutMs: 8000, onStart: () => { starts++; }, onError: () => { errors++; } });
  const rejected = assert.rejects(result, { code: 'playback_start_timeout' });
  const latePlaying = h.element.onplaying;
  h.clock.advance(7999);
  assert.equal(h.pauses, 0); assert.equal(errors, 0);
  h.clock.advance(1); await rejected;
  assert.equal(h.pauses, 1); assert.equal(h.revoked, 1); assert.equal(h.removed, 1);
  assert.equal(h.element.src, ''); assert.equal(h.clock.timers.size, 0);
  latePlaying?.(); h.playStarted.resolve(); await Promise.resolve();
  assert.equal(starts, 0); assert.equal(errors, 1); assert.equal(h.pauses, 2);
  h.controller.dispose();
});

test('downloaded segmented Blob that never starts falls back after eight seconds and discards its stale next phrase', async () => {
  const h = playbackHarness(); const requests: number[] = [], revealed: string[] = [], failures: unknown[] = [];
  const segments: ReplySegment[] = [{ text: '有点难过呀。', expression: 'gentle' }, { text: '我在听。', expression: 'gentle' }, { text: '慢慢说就好。', expression: 'natural' }];
  const reply = segments.map(segment => segment.text).join('\n\n');
  const prefetch = createReplySpeechPrefetch({ segmentCount: segments.length, segments, now: () => h.clock.now,
    isCurrent: () => true, streaming: false, audio: h.controller,
    fetchPcm: () => { throw new Error('unexpected PCM request'); },
    fetchBlob: async index => { requests.push(index); return new Blob(['voice']); },
  });
  let ready = false, finished = false;
  const pending = presentReplySegmentsWithPlayback({ reply, segments, isCurrent: () => true,
    playback: (_segment, index, onStart) => prefetch.play(index, onStart),
    preparing() {}, reveal: text => revealed.push(text), speaking() {}, ready() { ready = true; }, failed: error => failures.push(error),
  }).finally(() => { prefetch.dispose(); finished = true; });
  try {
    await new Promise(resolve => setImmediate(resolve)); h.element.onplaying?.();
    await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(requests, [0, 1]);
    h.clock.advance(1000); h.element.onended?.(); await new Promise(resolve => setImmediate(resolve));
    const latePlaying = h.element.onplaying;
    h.clock.advance(7999); await Promise.resolve(); assert.equal(finished, false);
    h.clock.advance(1); await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, true, 'a fully downloaded segment must not add a 35-second network allowance to its silent player');
    assert.equal((failures[0] as { code: string }).code, 'playback_start_timeout');
    assert.deepEqual(revealed, [segments[0]!.text, reply]); assert.equal(ready, false);
    latePlaying?.(); h.playStarted.resolve(); await Promise.resolve();
    assert.deepEqual(requests, [0, 1]); assert.equal(failures.length, 1); assert.equal(h.element.src, '');
  } finally { h.controller.cancel(); await pending; h.controller.dispose(); }
});

test('actual playing clears the start deadline without shortening the existing overall playback limit', async () => {
  const h = playbackHarness(); let starts = 0;
  const result = h.controller.playBlob(new Blob(['voice']), { startTimeoutMs: 8000, onStart: () => { starts++; } });
  h.clock.advance(1000); h.element.onplaying?.(); h.playStarted.resolve(); await Promise.resolve();
  assert.equal(starts, 1); assert.equal(h.clock.timers.size, 1);
  h.clock.advance(40_000);
  assert.equal(h.pauses, 0); assert.equal(h.element.src, 'blob:local-test');
  h.element.onended?.();
  assert.equal(await result, 'ended'); assert.equal(h.pauses, 1); assert.equal(h.clock.timers.size, 0);
  h.controller.dispose();
});

test('cancelling a pending start clears both deadlines and suppresses a queued playing event', async () => {
  const h = playbackHarness(); let callbacks = 0;
  const result = h.controller.playBlob(new Blob(['voice']), { startTimeoutMs: 8000,
    onStart: () => { callbacks++; }, onError: () => { callbacks++; }, onEnd: () => { callbacks++; } });
  const latePlaying = h.element.onplaying;
  h.clock.advance(1000); h.controller.cancel();
  assert.equal(await result, 'cancelled'); assert.equal(h.clock.timers.size, 0);
  h.clock.advance(100_000); latePlaying?.(); h.playStarted.resolve(); await Promise.resolve();
  assert.equal(callbacks, 0); assert.equal(h.revoked, 1); assert.ok(h.pauses >= 1);
  h.controller.dispose();
});

test('device speech shares the opt-in start timeout, while callers without it retain their previous playback deadline', async () => {
  const h = harness(); let cancellations = 0; let starts = 0; let utterance!: SpeechSynthesisUtterance;
  const controller = new AudioController({ ...h.dependencies,
    createSpeechUtterance: () => ({} as SpeechSynthesisUtterance),
    speechSynthesis: { speak(value: SpeechSynthesisUtterance) { utterance = value; }, cancel() { cancellations++; } } as unknown as SpeechSynthesis,
  });
  const result = controller.speak('你好', { startTimeoutMs: 8000, onStart: () => { starts++; } });
  const rejected = assert.rejects(result, { code: 'playback_start_timeout' });
  const lateStart = utterance.onstart;
  h.clock.advance(8000); await rejected;
  lateStart?.call(utterance, {} as SpeechSynthesisEvent);
  assert.equal(starts, 0); assert.equal(cancellations, 1); assert.equal(h.clock.timers.size, 0);
  controller.dispose(); h.controller.dispose();
  const ordinary = playbackHarness();
  const original = ordinary.controller.playBlob(new Blob(['feedback']));
  ordinary.clock.advance(8001);
  assert.equal(ordinary.pauses, 0); assert.equal(ordinary.clock.timers.size, 1);
  ordinary.controller.cancel(); assert.equal(await original, 'cancelled'); ordinary.controller.dispose();
});

test('browser output remains unchanged and never invokes WAV conversion by default', async () => {
  const h=harness();let delivered=0;
  const controller=new AudioController({...h.dependencies,convertRecordingToWav:async()=>{assert.fail('default browser mode must not transcode');}});
  await controller.startListening({onUtterance(blob){assert.equal(blob.type,'audio/webm');delivered++;}});
  h.setLevel(.1);h.clock.advance(250);h.setLevel(0);h.clock.advance(1400);h.recorders[0].flush();
  assert.equal(delivered,1);controller.dispose();h.controller.dispose();
});

test('WAV conversion begins only after tracks close and delivers only the prepared WAV', async () => {
  const h=harness();const conversion=deferred<Blob>();let preparing=0,delivered=0;
  const controller=new AudioController({...h.dependencies,convertRecordingToWav:async(_blob,options)=>{assert.equal(h.streams[0].track.readyState,'ended');assert.equal(h.closes,1);assert.equal(options.maxDurationMs,30_000);return conversion.promise;}});
  await controller.startListening({outputFormat:'wav',onProcessing(){preparing++;assert.equal(h.streams[0].track.readyState,'ended');},onUtterance(blob){delivered++;assert.equal(blob.type,'audio/wav');}});
  h.setLevel(.1);h.clock.advance(250);h.setLevel(0);h.clock.advance(1400);h.recorders[0].flush();
  assert.equal(preparing,1);assert.equal(delivered,0);
  await assert.rejects(controller.startMeter({onLevel(){}}),{code:'capture_busy'});
  conversion.resolve(new Blob(['wav'],{type:'audio/wav'}));for(let i=0;i<5;i++)await Promise.resolve();
  assert.equal(delivered,1);assert.equal(h.requests,1);controller.dispose();h.controller.dispose();
});

test('mute/cancel aborts conversion and a converter that resolves late cannot deliver or play audio', async () => {
  const h=harness();const conversion=deferred<Blob>();let signal:AbortSignal|undefined;let delivered=0,errors=0;
  const controller=new AudioController({...h.dependencies,convertRecordingToWav:async(_blob,options)=>{signal=options.signal;return conversion.promise;}});
  await controller.startListening({outputFormat:'wav',onUtterance(){delivered++;},onError(){errors++;}});
  h.setLevel(.1);h.clock.advance(250);h.setLevel(0);h.clock.advance(1400);h.recorders[0].flush();
  controller.stopCapture();assert.equal(signal?.aborted,true);
  conversion.resolve(new Blob(['late wav'],{type:'audio/wav'}));for(let i=0;i<5;i++)await Promise.resolve();
  assert.equal(delivered,0);assert.equal(errors,0);assert.equal(h.streams[0].track.readyState,'ended');
  assert.equal(await controller.startMeter({onLevel(){}}),true);controller.dispose();h.controller.dispose();
});

test('leaving the page during conversion cancels its signal and suppresses the late result', async () => {
  const previous=Object.getOwnPropertyDescriptor(globalThis,'window');const browser=new EventTarget();
  Object.defineProperty(globalThis,'window',{value:browser,configurable:true});
  const h=harness();const conversion=deferred<Blob>();let signal:AbortSignal|undefined,delivered=0;
  const controller=new AudioController({...h.dependencies,convertRecordingToWav:async(_blob,options)=>{signal=options.signal;return conversion.promise;}});
  try {
    await controller.startListening({outputFormat:'wav',onUtterance(){delivered++;}});
    h.setLevel(.1);h.clock.advance(250);h.setLevel(0);h.clock.advance(1400);h.recorders[0].flush();
    browser.dispatchEvent(new Event('pagehide'));assert.equal(signal?.aborted,true);
    conversion.resolve(new Blob(['late']));for(let i=0;i<5;i++)await Promise.resolve();assert.equal(delivered,0);
  } finally {controller.dispose();h.controller.dispose();if(previous)Object.defineProperty(globalThis,'window',previous);else Reflect.deleteProperty(globalThis,'window');}
});

test('oversized recorder chunks stop capture before conversion or upload', async () => {
  const h=harness();let errors=0,conversions=0;
  const controller=new AudioController({...h.dependencies,convertRecordingToWav:async(blob)=>{conversions++;return blob;}});
  await controller.startListening({outputFormat:'wav',onUtterance(){assert.fail('oversize must never be delivered');},onError(error){errors++;assert.equal((error as {code?:string}).code,'recording_too_large');}});
  h.recorders[0].ondataavailable?.({data:new Blob([new Uint8Array(8*1024*1024+1)])});
  h.recorders[0].flush();assert.equal(errors,1);assert.equal(conversions,0);assert.equal(h.streams[0].track.readyState,'ended');
  controller.dispose();h.controller.dispose();
});


test('a cancelled conversion cannot close or replace a newer capture when its promise settles', async () => {
  const h=harness();const conversion=deferred<Blob>();let delivered=0;
  const controller=new AudioController({...h.dependencies,convertRecordingToWav:async()=>conversion.promise});
  await controller.startListening({outputFormat:'wav',onUtterance(){delivered++;}});
  h.setLevel(.1);h.clock.advance(250);h.setLevel(0);h.clock.advance(1400);h.recorders[0].flush();
  controller.cancel();
  let levels=0;assert.equal(await controller.startMeter({onLevel(){levels++;}}),true);
  conversion.resolve(new Blob(['late wav'],{type:'audio/wav'}));for(let i=0;i<5;i++)await Promise.resolve();
  h.clock.advance(100);
  assert.equal(delivered,0);assert.equal(h.streams[1].track.readyState,'live');assert.equal(levels,2);
  controller.dispose();h.controller.dispose();
});

test('listening reports actual live levels and announces sustained speech once without stopping capture', async () => {
  const h = harness();
  const levels: number[] = [];
  let speechStarts = 0;
  await h.controller.startListening({
    onLevel(level) { levels.push(level); },
    onSpeechStart() { speechStarts++; },
    onUtterance() { assert.fail('feedback must not submit the recording'); },
  });
  h.clock.advance(50);
  assert.equal(levels.at(-1), 0);
  h.setLevel(0.1); h.clock.advance(150);
  assert.equal(speechStarts, 0, 'a short noise must not claim the user has started speaking');
  h.setLevel(0); h.clock.advance(50);
  h.setLevel(0.3); h.clock.advance(200);
  assert.ok(Math.abs(levels.at(-1)! - 0.3) < 0.000001);
  assert.equal(speechStarts, 1);
  assert.equal(h.streams[0].track.readyState, 'live');
  h.setLevel(0); h.clock.advance(100);
  h.setLevel(0.2); h.clock.advance(250);
  assert.equal(speechStarts, 1, 'a pause within the same utterance must not reannounce speech');
  assert.equal(h.requests, 1);
  const count = levels.length;
  h.controller.cancel(); h.clock.advance(60_000); h.recorders[0].flush();
  assert.equal(levels.length, count, 'cancelled capture must stop live feedback');
  assert.equal(speechStarts, 1);
  h.controller.dispose();
});

test('manual done closes the microphone and announces processing immediately, then submits exactly once', async () => {
  const h = harness();
  let delivered = 0;
  let processing = 0;
  await h.controller.startListening({
    onProcessing() { processing++; assert.equal(h.streams[0].track.readyState, 'ended'); },
    onUtterance(blob) { delivered++; assert.ok(blob.size); assert.equal(h.streams[0].track.readyState, 'ended'); },
  });
  h.setLevel(0.1); h.clock.advance(250);
  assert.equal(h.controller.finishUtterance(), true);
  assert.equal(processing, 1, 'the UI must leave listening before the recorder finalizes');
  assert.equal(h.streams[0].track.readyState, 'ended');
  assert.equal(delivered, 0);
  assert.equal(h.controller.finishUtterance(), false, 'repeated done must not queue another submission');
  h.clock.advance(1000);
  assert.equal(delivered, 0);
  h.recorders[0].flush();
  assert.equal(delivered, 1); assert.equal(processing, 1);
  h.clock.advance(60_000);
  assert.equal(delivered, 1); assert.equal(h.clock.timers.size, 0);
  assert.equal(h.controller.finishUtterance(), false); assert.equal(h.requests, 1);
  h.controller.dispose();
});

test('manual done without detected speech stops silently and never converts or submits audio', async () => {
  const h = harness();
  let silence = 0;
  const controller = new AudioController({
    ...h.dependencies,
    convertRecordingToWav: async () => { assert.fail('silent audio must not be converted'); },
  });
  await controller.startListening({
    outputFormat: 'wav',
    onSilence() { silence++; },
    onProcessing() { assert.fail('silence has no submission to process'); },
    onUtterance() { assert.fail('silent audio must not be submitted'); },
  });
  h.clock.advance(1000);
  assert.equal(controller.finishUtterance(), true);
  h.recorders[0].flush(); h.clock.advance(60_000);
  assert.equal(silence, 1); assert.equal(h.streams[0].track.readyState, 'ended');
  assert.equal(controller.finishUtterance(), false); assert.equal(h.clock.timers.size, 0);
  controller.dispose(); h.controller.dispose();
});

test('done never finishes a local meter or a permission request and cannot resume cancelled capture', async () => {
  const h = harness();
  assert.equal(h.controller.finishUtterance(), false);
  await h.controller.startMeter({ onLevel() {} });
  assert.equal(h.controller.finishUtterance(), false);
  assert.equal(h.streams[0].track.readyState, 'live');
  h.controller.dispose();
  const permission = deferred<MediaStream>();
  const controller = new AudioController({ ...h.dependencies, getUserMedia: () => permission.promise });
  const start = controller.startListening({ onUtterance() { assert.fail('cancelled permission must not submit'); } });
  assert.equal(controller.finishUtterance(), false);
  controller.cancel();
  const late = fakeStream(); permission.resolve(late.stream);
  assert.equal(await start, false); assert.equal(late.track.readyState, 'ended');
  assert.equal(controller.finishUtterance(), false);
  controller.dispose();
});

test('a cancelled manual finish cannot deliver queued recorder events or signal speech in a later turn', async () => {
  const h = harness();
  let oldDelivered = 0;
  let oldStarts = 0;
  let newStarts = 0;
  await h.controller.startListening({ onUtterance() { oldDelivered++; }, onSpeechStart() { oldStarts++; } });
  h.setLevel(0.1); h.clock.advance(250);
  assert.equal(h.controller.finishUtterance(), true);
  h.controller.cancel();
  await h.controller.startListening({ onUtterance() {}, onSpeechStart() { newStarts++; } });
  h.recorders[0].flush(); h.clock.advance(250);
  assert.equal(oldDelivered, 0); assert.equal(oldStarts, 1); assert.equal(newStarts, 1);
  assert.equal(h.streams[1].track.readyState, 'live');
  h.controller.dispose();
});

test('manual WAV completion shares cancellation-safe conversion and processing is announced only once', async () => {
  const h = harness();
  const converted = deferred<Blob>();
  let signal: AbortSignal | undefined;
  let delivered = 0;
  let processing = 0;
  const controller = new AudioController({
    ...h.dependencies,
    convertRecordingToWav: async (_blob, options) => { signal = options.signal; return converted.promise; },
  });
  await controller.startListening({ outputFormat: 'wav', onProcessing() { processing++; }, onUtterance() { delivered++; } });
  h.setLevel(0.1); h.clock.advance(250);
  assert.equal(controller.finishUtterance(), true); assert.equal(processing, 1);
  h.recorders[0].flush();
  assert.equal(processing, 1); assert.equal(controller.finishUtterance(), false);
  controller.cancel(); assert.equal(signal?.aborted, true);
  await controller.startMeter({ onLevel() {} });
  converted.resolve(new Blob(['late WAV'], { type: 'audio/wav' }));
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(delivered, 0); assert.equal(h.streams[1].track.readyState, 'live');
  controller.dispose(); h.controller.dispose();
});

test('callbacks may cancel capture immediately without further speech feedback or submission', async () => {
  const h = harness();
  let starts = 0;
  await h.controller.startListening({
    minimumSpeechMs: 0,
    onLevel() { h.controller.cancel(); },
    onSpeechStart() { starts++; },
    onUtterance() { assert.fail('cancel in live feedback must suppress delivery'); },
  });
  h.setLevel(0.1); h.clock.advance(1000); h.recorders[0].flush();
  assert.equal(starts, 0); assert.equal(h.streams[0].track.readyState, 'ended');
  await h.controller.startListening({
    onProcessing() { h.controller.cancel(); },
    onUtterance() { assert.fail('cancel on finalization must suppress delivery'); },
  });
  h.clock.advance(250); assert.equal(h.controller.finishUtterance(), true);
  h.recorders[1].flush(); h.clock.advance(60_000);
  assert.equal(h.clock.timers.size, 0); assert.equal(h.streams[1].track.readyState, 'ended');
  h.controller.dispose();
});

test('hold mode keeps the microphone through silence and submits only on explicit release', async () => {
  const h = harness(); let delivered = 0, processing = 0;
  await h.controller.startListening({ endMode: 'manual', onUtterance() { delivered++; }, onProcessing() { processing++; }, onSilence() { assert.fail('holding silence must not auto stop'); } });
  h.clock.advance(13_000);
  assert.equal(h.streams[0].track.readyState, 'live', 'manual mode does not use the automatic no-speech timeout');
  h.setLevel(.1); h.clock.advance(250); h.setLevel(0); h.clock.advance(5_000);
  assert.equal(h.streams[0].track.readyState, 'live'); assert.equal(processing, 0);
  h.controller.finishUtterance(); h.recorders[0].flush();
  assert.equal(delivered, 1); assert.equal(processing, 1); assert.equal(h.streams[0].track.readyState, 'ended');
  h.controller.dispose();
});

test('a hold reaching 30 seconds discards audio even after speech and release cannot send it', async () => {
  const h = harness(); let errors = 0;
  await h.controller.startListening({
    endMode: 'manual', outputFormat: 'wav',
    onUtterance() { assert.fail('time limit must never auto send a held recording'); },
    onProcessing() { assert.fail('discarded audio must not convert'); },
    onError(error) { errors++; assert.equal((error as { code?: string }).code, 'recording_limit'); assert.match(error.message, /未发送/); },
  });
  h.setLevel(.1); h.clock.advance(250); h.setLevel(0); h.clock.advance(29_750);
  assert.equal(errors, 1); assert.equal(h.streams[0].track.readyState, 'ended');
  assert.equal(h.controller.finishUtterance(), false); h.recorders[0].flush();
  h.clock.advance(60_000); assert.equal(errors, 1); assert.equal(h.clock.timers.size, 0);
  h.controller.dispose();
});

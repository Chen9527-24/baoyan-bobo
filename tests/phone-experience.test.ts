import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { AudioController, type AudioDependencies } from '../apps/web/src/audio.ts';
import { presentReplyWithPlayback } from '../apps/web/src/lib/replyPlayback.ts';
import { createFirstAudioObserver } from '../apps/web/src/lib/clientLatency.ts';
import { createMemoryContinuity } from '../apps/server/src/memory-continuity.ts';
import type { Memory } from '../apps/server/src/types.ts';

// These are controlled browser/time models. They are not recordings from a phone
// and must never be counted as real iOS/Android or multi-day user acceptance.
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
class Clock {
  time = 0; next = 0;
  timers = new Map<number, { at: number; every: number; callback: () => void }>();
  private add(callback: () => void, ms: number, every: number) { const id = ++this.next; this.timers.set(id, { at: this.time + ms, every, callback }); return id; }
  timeout = (callback: () => void, ms: number) => this.add(callback, ms, 0);
  interval = (callback: () => void, ms: number) => this.add(callback, ms, ms);
  clear = (id: number) => { this.timers.delete(id); };
  advance(ms: number) {
    const until = this.time + ms;
    for (;;) {
      const entry = [...this.timers.entries()].filter(([, value]) => value.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break;
      const [id, value] = entry; this.time = value.at;
      if (value.every) value.at += value.every; else this.timers.delete(id);
      value.callback();
    }
    this.time = until;
  }
}
class Track extends EventTarget { readyState = 'live'; stops = 0; stop() { this.readyState = 'ended'; this.stops++; } }
function captureFixture(state: string, resume: () => Promise<void>) {
  const clock = new Clock(), track = new Track(); let closed = 0, resumes = 0;
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  const context = {
    state, resume: () => { resumes++; return resume(); }, close: async () => { closed++; context.state = 'closed'; },
    createAnalyser: () => ({ fftSize: 1024, getFloatTimeDomainData: (data: Float32Array) => data.fill(.1), disconnect() {} }),
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
  };
  const dependencies: Partial<AudioDependencies> = {
    secureContext: true, getUserMedia: async () => stream, createAudioContext: () => context as unknown as AudioContext,
    now: () => clock.time, setTimeout: clock.timeout as unknown as typeof setTimeout, clearTimeout: clock.clear as unknown as typeof clearTimeout,
    setInterval: clock.interval as unknown as typeof setInterval, clearInterval: clock.clear as unknown as typeof clearInterval,
  };
  return { controller: new AudioController(dependencies), clock, track, get closes() { return closed; }, get resumes() { return resumes; } };
}

test('phone capture rejects a resume that resolves while the context remains suspended instead of reporting active recording', async () => {
  const f = captureFixture('suspended', async () => {});
  try {
    await assert.rejects(f.controller.startMeter({ onLevel() { assert.fail('a suspended meter must not emit levels'); } }), { code: 'capture_permission' });
    assert.equal(f.track.readyState, 'ended'); assert.equal(f.closes, 1); assert.equal(f.clock.timers.size, 0);
  } finally { f.controller.dispose(); }
});

test('phone capture attempts to unlock an interrupted context and rejects if it does not run', async () => {
  const f = captureFixture('interrupted', async () => {});
  try {
    await assert.rejects(f.controller.startMeter({ onLevel() {} }), { code: 'capture_permission' });
    assert.equal(f.resumes, 1); assert.equal(f.track.readyState, 'ended');
  } finally { f.controller.dispose(); }
});

test('phone capture cancellation settles while context resume is pending and a late unlock cannot restart capture', async () => {
  const unlock = deferred<void>(), f = captureFixture('suspended', () => unlock.promise); let levels = 0;
  try {
    const pending = f.controller.startMeter({ onLevel() { levels++; } }); await tick();
    assert.equal(f.resumes, 1); f.controller.cancel();
    assert.equal(await Promise.race([pending, tick().then(() => 'still-pending')]), false);
    assert.equal(f.track.readyState, 'ended'); assert.equal(f.closes, 1);
    unlock.resolve(); await tick(); f.clock.advance(30_000);
    assert.equal(levels, 0); assert.equal(f.clock.timers.size, 0);
  } finally { unlock.resolve(); f.controller.dispose(); }
});

test('phone capture resume has an eight-second deadline after permission and ignores a late unlock after timeout', async () => {
  const unlock = deferred<void>(), f = captureFixture('suspended', () => unlock.promise); let levels = 0;
  try {
    const pending = f.controller.startMeter({ onLevel() { levels++; } });
    const rejected = assert.rejects(pending, { code: 'capture_permission' }); await tick();
    f.clock.advance(7_999); assert.equal(f.track.readyState, 'live'); assert.equal(f.closes, 0);
    f.clock.advance(1); await rejected; assert.equal(f.track.readyState, 'ended'); assert.equal(f.closes, 1); assert.equal(f.clock.timers.size, 0);
    unlock.resolve(); await tick(); f.clock.advance(30_000); assert.equal(levels, 0); assert.equal(f.closes, 1);
  } finally { unlock.resolve(); f.controller.dispose(); }
});

function playbackFixture() {
  const clock = new Clock();
  const contexts: { state: string; resumes: number; closes: number; sources: { stopped: number; at: number; onended: (() => void) | null; }[]; resume: () => Promise<void>; }[] = [];
  const controller = new AudioController({
    createAudioContext: () => {
      const context = { state: 'suspended', resumes: 0, closes: 0, sources: [] as typeof contexts[number]['sources'],
        get currentTime() { return clock.time / 1000; }, destination: {},
        resume: async () => { context.resumes++; context.state = 'running'; },
        close: async () => { context.closes++; context.state = 'closed'; },
        createBuffer: (_channels: number, samples: number, sampleRate: number) => ({ duration: samples / sampleRate, getChannelData: () => new Float32Array(samples) }),
        createBufferSource: () => {
          const source = { stopped: 0, at: 0, onended: null as (() => void) | null, connect() {}, disconnect() {}, start(at: number) { this.at = at; }, stop() { this.stopped++; } };
          context.sources.push(source); return source;
        },
      };
      contexts.push(context); return context as unknown as AudioContext;
    },
    now: () => clock.time, setTimeout: clock.timeout as unknown as typeof setTimeout, clearTimeout: clock.clear as unknown as typeof clearTimeout,
    setInterval: clock.interval as unknown as typeof setInterval, clearInterval: clock.clear as unknown as typeof clearInterval,
  });
  return { controller, clock, contexts };
}
function lifecycleFixture() {
  const previous = { document: Object.getOwnPropertyDescriptor(globalThis, 'document'), window: Object.getOwnPropertyDescriptor(globalThis, 'window') };
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible', hidden: false }); const window = new EventTarget();
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: window });
  return { document, window, restore() { for (const key of ['document', 'window'] as const) { const property = previous[key]; if (property) Object.defineProperty(globalThis, key, property); else Reflect.deleteProperty(globalThis, key); } } };
}

test('phone backgrounding cancels scheduled PCM and pending chunks; returning to foreground is silent until another explicit gesture', async () => {
  const lifecycle = lifecycleFixture(), f = playbackFixture(), late = deferred<void>(); let observedSignal: AbortSignal | undefined, starts = 0;
  try {
    f.controller.preparePlayback(); await tick();
    const playing = f.controller.playPcmStream(async function* (signal) { observedSignal = signal; yield new Uint8Array([0, 0]); await late.promise; yield new Uint8Array([0, 0]); }, { onStart() { starts++; } });
    await tick(); assert.equal(f.contexts.length, 1); assert.equal(f.contexts[0]!.sources.length, 1);
    lifecycle.document.visibilityState = 'hidden'; lifecycle.document.hidden = true; lifecycle.document.dispatchEvent(new Event('visibilitychange'));
    assert.equal(await playing, 'cancelled'); assert.equal(observedSignal?.aborted, true); assert.equal(f.contexts[0]!.sources[0]!.stopped, 1); assert.equal(f.contexts[0]!.closes, 1);
    late.resolve(); await tick(); lifecycle.document.visibilityState = 'visible'; lifecycle.document.hidden = false; lifecycle.document.dispatchEvent(new Event('visibilitychange')); f.clock.advance(5_000);
    assert.equal(starts, 0); assert.equal(f.contexts.length, 1);
    f.controller.preparePlayback(); await tick(); assert.equal(f.contexts.length, 2); assert.equal(f.contexts[1]!.resumes, 1);
  } finally { late.resolve(); f.controller.dispose(); lifecycle.restore(); }
});

test('phone audio clock suspension uses text fallback without claiming first sound or restarting the old reply', async () => {
  const f = playbackFixture(), end = deferred<void>(); const revealed: string[] = [], measurements: number[] = [], failures: unknown[] = [];
  const firstSound = createFirstAudioObserver({ startedAt: 0, replyId: randomUUID(), isCurrent: () => true, now: () => f.clock.time, report: async result => { measurements.push(result.milliseconds); } });
  try {
    const presenting = presentReplyWithPlayback({ isCurrent: () => true, preparing() {}, reveal(mode) { revealed.push(mode); }, speaking: firstSound, ready() {}, failed(error) { failures.push(error); },
      playback: onStart => f.controller.playPcmStream(async function* () { yield new Uint8Array([0, 0]); await end.promise; }, { onStart, startTimeoutMs: 8000 }),
    });
    await tick(); const context = f.contexts[0]!; context.state = 'suspended'; f.clock.advance(300); await presenting;
    assert.deepEqual(revealed, ['text-only']); assert.deepEqual(measurements, []);
    assert.equal((failures[0] as { code: string }).code, 'playback_interrupted');
    assert.equal(context.sources[0]!.stopped, 1);
    context.state = 'running'; f.clock.advance(20); assert.deepEqual(revealed, ['text-only']); assert.deepEqual(measurements, []);
    end.resolve(); await tick(); for (const source of context.sources) source.onended?.(); f.clock.advance(20);
    assert.equal(failures.length, 1);
  } finally { end.resolve(); f.controller.dispose(); }
});

test('phone offline cancels a prepared output context and never resumes it automatically', async () => {
  const lifecycle = lifecycleFixture(), f = playbackFixture();
  try {
    f.controller.preparePlayback(); await tick(); lifecycle.window.dispatchEvent(new Event('offline')); await tick();
    assert.equal(f.contexts[0]!.closes, 1); assert.equal(f.clock.timers.size, 0);
    lifecycle.window.dispatchEvent(new Event('online')); await tick(); assert.equal(f.contexts.length, 1);
  } finally { f.controller.dispose(); lifecycle.restore(); }
});

function memoryFixture() {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON; CREATE TABLE families(id TEXT PRIMARY KEY); CREATE TABLE memories(id TEXT PRIMARY KEY); CREATE TABLE software_profile_memories(family_id TEXT);');
  const familyId = randomUUID(), childId = randomUUID(), siblingId = randomUUID(); db.prepare('INSERT INTO families VALUES(?)').run(familyId);
  let now = Date.parse('2026-10-02T15:59:50Z'); const create = () => createMemoryContinuity(db, () => now); let continuity = create();
  const plan: Memory = { id: randomUUID(), key: 'test.draw.plan', content: '我准备画一个小花园', scope: 'personal', kind: 'plan', revision: 1, expiresAt: '2026-11-01T15:59:50Z', source: '虚构本人确认' };
  return { db, familyId, childId, siblingId, plan, get continuity() { return continuity; }, advance(ms: number) { now += ms; }, reopen() { continuity = create(); } };
}

test('three calendar-day simulation persists daily offer/rejection across service recreation and keeps sibling state separate', () => {
  const f = memoryFixture();
  try {
    assert.equal(f.continuity.offer(f.familyId, f.childId, '我回来了', [f.plan])?.id, f.plan.id);
    f.reopen(); assert.equal(f.continuity.offer(f.familyId, f.childId, '你好', [f.plan]), undefined);
    f.advance(20_000); assert.equal(f.continuity.offer(f.familyId, f.childId, '你好', [f.plan]), undefined, 'crossing midnight does not repeat the same plan');
    f.continuity.refused(f.familyId, f.childId, f.plan.id); f.advance(86_400_000); f.reopen();
    assert.equal(f.continuity.offer(f.familyId, f.childId, '你好', [f.plan]), undefined);
    assert.deepEqual(f.continuity.relevant(f.familyId, f.childId, '想聊绘画', [f.plan]), []);
    assert.equal(f.continuity.offer(f.familyId, f.siblingId, '你好', [f.plan])?.id, f.plan.id);
    assert.equal(f.continuity.relevant(f.familyId, f.childId, '你还记得我的小花园计划吗', [f.plan])[0]?.id, f.plan.id);
    assert.equal(f.continuity.offer(f.familyId, f.childId, '你好', [f.plan]), undefined, 'explicit recall must not clear unsolicited suppression');
    const columns = f.db.prepare('PRAGMA table_info(memory_continuity)').all().map(row => row.name);
    assert.deepEqual(columns, ['family_id', 'child_id', 'memory_id', 'last_offered_day', 'suppressed']);
  } finally { f.db.close(); }
});

test('cross-day deletion and parent correction remain authoritative, without restoring deleted private content from continuity state', () => {
  const f = memoryFixture();
  try {
    f.continuity.offer(f.familyId, f.childId, '你好', [f.plan]); f.advance(86_400_000); f.reopen();
    assert.deepEqual(f.continuity.relevant(f.familyId, f.childId, '你记得我的画画计划吗', []), []);
    assert.equal(f.continuity.offer(f.familyId, f.childId, '你好', []), undefined);
    const corrected: Memory = { ...f.plan, content: '我现在想踢足球', revision: 2 };
    assert.deepEqual(f.continuity.relevant(f.familyId, f.childId, '绘画', [corrected]), []);
    assert.equal(f.continuity.relevant(f.familyId, f.childId, '踢球', [corrected])[0]?.content, corrected.content);
    f.advance(31 * 86_400_000); assert.deepEqual(f.continuity.relevant(f.familyId, f.childId, '踢球', [corrected]), []);
    assert.equal(f.continuity.offer(f.familyId, f.childId, '你好', [corrected]), undefined);
    assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM memory_continuity').all()).includes('花园'), false);
  } finally { f.db.close(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioController } from '../apps/web/src/audio.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function blobHarness() {
  const elements: HTMLAudioElement[] = [];
  const controller = new AudioController({
    createAudioElement() {
      const element = {
        onplaying: null, onwaiting: null, onpause: null, onended: null, onerror: null,
        play: async () => {}, pause() {}, removeAttribute() {}, load() {},
      } as unknown as HTMLAudioElement;
      elements.push(element); return element;
    },
    createObjectURL: () => 'blob:synthetic-test', revokeObjectURL() {},
  });
  const fire = (element: HTMLAudioElement, event: 'playing' | 'waiting' | 'pause' | 'ended' | 'error') => {
    const callback = element[`on${event}`];
    callback?.call(element, new Event(event));
  };
  return { controller, elements, fire };
}

test('blob activity follows playing, buffering and pause without repeating first start or confusing microphone mute', async () => {
  const h = blobHarness(), changes: boolean[] = []; let starts = 0;
  const result = h.controller.playBlob(new Blob(['fictional audio']), { onStart() { starts++; }, onActivityChange(value) { changes.push(value); } });
  const element = h.elements[0]!;
  assert.deepEqual(changes, [], 'waiting for the first media event is not output playback');
  h.fire(element, 'playing'); h.fire(element, 'playing');
  assert.deepEqual(changes, [true]); assert.equal(starts, 1);
  h.fire(element, 'waiting'); h.fire(element, 'waiting');
  assert.deepEqual(changes, [true, false]);
  h.fire(element, 'playing'); h.controller.stopCapture();
  assert.deepEqual(changes, [true, false, true], 'closing only the microphone must not stop a playing reply');
  h.fire(element, 'pause'); h.fire(element, 'playing'); h.fire(element, 'ended');
  assert.equal(await result, 'ended'); assert.equal(starts, 1);
  assert.deepEqual(changes, [true, false, true, false, true, false]);
  h.controller.dispose();
});

test('blob cancellation clears activity immediately and late old events cannot revive it or change a newer playback', async () => {
  const h = blobHarness(), oldChanges: boolean[] = [], newChanges: boolean[] = [];
  const old = h.controller.playBlob(new Blob(['old']), { onActivityChange(value) { oldChanges.push(value); } });
  const first = h.elements[0]!, latePlaying = first.onplaying!, lateWaiting = first.onwaiting!;
  h.fire(first, 'playing'); h.controller.cancel();
  assert.deepEqual(oldChanges, [true, false]); assert.equal(await old, 'cancelled');
  const next = h.controller.playBlob(new Blob(['new']), { onActivityChange(value) { newChanges.push(value); } });
  const second = h.elements[1]!; h.fire(second, 'playing');
  latePlaying.call(first, new Event('playing')); lateWaiting.call(first, new Event('waiting'));
  assert.deepEqual(oldChanges, [true, false]); assert.deepEqual(newChanges, [true]);
  h.fire(second, 'ended'); await next; assert.deepEqual(newChanges, [true, false]); h.controller.dispose();
});

test('blob failures before start never claim activity, and failure after start clears it before rejection', async () => {
  for (const start of [false, true]) {
    const h = blobHarness(), changes: boolean[] = [];
    const result = h.controller.playBlob(new Blob(['fictional']), { onActivityChange(value) { changes.push(value); } });
    const rejection = assert.rejects(result, /声音播放失败/), element = h.elements[0]!, late = element.onplaying!;
    if(start)h.fire(element, 'playing');
    h.fire(element, 'error');
    assert.deepEqual(changes, start ? [true, false] : []);
    await rejection; late.call(element, new Event('playing'));
    assert.deepEqual(changes, start ? [true, false] : []); h.controller.dispose();
  }
});

test('a failing visual activity observer cannot interrupt playback completion or cancellation cleanup', async () => {
  for(const outcome of ['ended','cancelled'] as const){
    const h=blobHarness();let observed=0;
    const result=h.controller.playBlob(new Blob(['fictional']),{onActivityChange(){observed++;throw new Error('synthetic visual observer failure');}});
    h.fire(h.elements[0]!,'playing');
    if(outcome==='ended')h.fire(h.elements[0]!,'ended');else h.controller.cancel();
    assert.equal(await result,outcome);assert.equal(observed,2);assert.equal(h.elements[0]!.onplaying,null);h.controller.dispose();
  }
});

test('device speech activity pauses and resumes without a second first-start event, and queued resume after cancellation stays silent', async () => {
  let utterance!: SpeechSynthesisUtterance, starts = 0, cancellations = 0;
  const changes: boolean[] = [], controller = new AudioController({
    createSpeechUtterance: () => ({} as SpeechSynthesisUtterance),
    speechSynthesis: { speak(value: SpeechSynthesisUtterance) { utterance=value; }, cancel() { cancellations++; } } as unknown as SpeechSynthesis,
  });
  const result = controller.speak('虚构测试', { onStart() { starts++; }, onActivityChange(value) { changes.push(value); } });
  assert.deepEqual(changes, []);
  utterance.onstart?.call(utterance, {} as SpeechSynthesisEvent);
  utterance.onpause?.call(utterance, {} as SpeechSynthesisEvent);
  utterance.onresume?.call(utterance, {} as SpeechSynthesisEvent);
  const late = utterance.onresume!; controller.cancel();
  assert.deepEqual(changes, [true, false, true, false]); assert.equal(await result, 'cancelled');
  late.call(utterance, {} as SpeechSynthesisEvent);
  assert.deepEqual(changes, [true, false, true, false]); assert.equal(starts, 1); assert.equal(cancellations, 1); controller.dispose();
});

function pcmHarness() {
  let monitor = () => {}, time = 0, state: AudioContextState = 'running';
  const sources: { buffer?: AudioBuffer; at: number; onended: (() => void) | null; stops: number; start(at: number): void; stop(): void; connect(): void; disconnect(): void }[] = [];
  const context = {
    get state() { return state; }, get currentTime() { return time; }, destination: {},
    resume: async () => {}, close: async () => { state='closed'; },
    createBuffer: (_channels: number, length: number, rate: number) => ({ duration: length/rate, getChannelData: () => new Float32Array(length) } as AudioBuffer),
    createBufferSource() {
      const source = { buffer: undefined as AudioBuffer | undefined, at: 0, onended: null as (() => void) | null, stops: 0, start(at: number) { this.at=at; }, stop() { this.stops++; }, connect() {}, disconnect() {} };
      sources.push(source); return source as unknown as AudioBufferSourceNode;
    },
  } as unknown as AudioContext;
  const controller = new AudioController({ createAudioContext: () => context,
    setInterval: ((callback: () => void) => { monitor=callback; return 1; }) as typeof setInterval,
    clearInterval: () => { monitor=()=>{}; },
  });
  return { controller, sources, advance(value: number) { time=value; monitor(); }, setState(value: AudioContextState) { state=value; monitor(); }, end() { for(const source of sources)source.onended?.(); monitor(); } };
}

test('PCM activity stops during a network gap and resumes only inside the next scheduled running interval', async () => {
  const h = pcmHarness(), release = deferred<void>(), changes: boolean[] = []; let starts = 0;
  const result = h.controller.playPcmStream(async function* () { yield new Uint8Array(24_000); await release.promise; yield new Uint8Array(24_000); },
    { onStart() { starts++; }, onActivityChange(value) { changes.push(value); } });
  await tick(); h.advance(.1); assert.deepEqual(changes, []);
  h.advance(.2); assert.deepEqual(changes, [true]);
  h.advance(.7); assert.deepEqual(changes, [true, false], 'no scheduled sound remains even though the transport is still pending');
  h.sources[0]!.onended?.();
  h.advance(1); release.resolve(); await tick();
  assert.deepEqual(changes, [true, false], 'receiving a later chunk does not mean its scheduled audio has started');
  h.advance(1.02); assert.deepEqual(changes, [true, false, true]);
  h.advance(1.6); h.end(); assert.equal(await result, 'ended');
  assert.deepEqual(changes, [true, false, true, false]); assert.equal(starts, 1); h.controller.dispose();
});

test('PCM cancellation stops active output and suppresses delayed transport data and clock feedback', async () => {
  const h = pcmHarness(), release = deferred<void>(), changes: boolean[] = []; let signal!: AbortSignal;
  const result = h.controller.playPcmStream(async function* (value) { signal=value; yield new Uint8Array(24_000); await release.promise; yield new Uint8Array(24_000); },
    { onActivityChange(value) { changes.push(value); } });
  await tick(); h.advance(.2); h.controller.cancel();
  assert.deepEqual(changes, [true, false]); assert.equal(await result, 'cancelled'); assert.equal(signal.aborted, true);
  release.resolve(); await tick(); h.advance(1);
  assert.equal(h.sources.length, 1); assert.equal(h.sources[0]!.stops, 1); assert.deepEqual(changes, [true, false]); h.controller.dispose();
});

test('PCM failure after first output clears activity before rejecting and cannot later restart', async () => {
  const h = pcmHarness(), release = deferred<void>(), changes: boolean[] = [];
  const result = h.controller.playPcmStream(async function* () { yield new Uint8Array(24_000); await release.promise; throw new Error('synthetic network failure'); },
    { onActivityChange(value) { changes.push(value); } });
  const rejection = assert.rejects(result, /声音播放失败/);
  await tick(); h.advance(.2); assert.deepEqual(changes, [true]);
  release.resolve(); await rejection; assert.deepEqual(changes, [true, false]);
  h.advance(.3); assert.deepEqual(changes, [true, false]); h.controller.dispose();
});

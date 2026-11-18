import test from 'node:test';
import assert from 'node:assert/strict';
import { PressToTalkSession, type PressToTalkState } from '../apps/web/src/lib/pressToTalk.ts';
import type { ListeningOptions } from '../apps/web/src/audio.ts';

function rig(onState?: (state: PressToTalkState) => void) {
  const starts: { options: ListeningOptions; resolve: (started: boolean) => void }[] = [];
  const states: PressToTalkState[] = [];
  let stops = 0, finishes = 0;
  const session = new PressToTalkSession({
    startListening: options => new Promise<boolean>(resolve => starts.push({ options, resolve })),
    finishUtterance: () => { finishes++; starts.at(-1)!.options.onProcessing?.(); return true; },
    stopCapture: () => { stops++; },
  }, state => { states.push(state); onState?.(state); });
  return { session, starts, states, get stops() { return stops; }, get finishes() { return finishes; } };
}
const tick = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };

test('press starts immediately once, disables silence submission, and a ready release delivers exactly once', async () => {
  const r = rig(); let delivered = 0, processing = 0;
  assert.equal(r.session.press({ onUtterance() { delivered++; }, onProcessing() { processing++; } }), true);
  assert.equal(r.starts.length, 1, 'capture starts in the key/pointer event without a timer');
  assert.equal(r.starts[0].options.endMode, 'manual');
  assert.equal(r.session.press({ onUtterance() { assert.fail(); } }), false);
  r.starts[0].resolve(true); await tick();
  assert.equal(r.session.state, 'recording');
  r.session.release(); r.session.release();
  assert.equal(r.finishes, 1); assert.equal(processing, 1);
  await r.starts[0].options.onUtterance(new Blob(['voice']));
  await r.starts[0].options.onUtterance(new Blob(['duplicate']));
  assert.equal(delivered, 1); assert.equal(r.session.state, 'idle');
});

test('release during permission wait cancels and ignores every late callback', async () => {
  const r = rig(); let delivered = 0, feedback = 0;
  r.session.press({ onUtterance() { delivered++; }, onLevel() { feedback++; }, onSpeechStart() { feedback++; }, onProcessing() { feedback++; }, onError() { feedback++; } });
  r.session.release();
  assert.equal(r.stops, 1); assert.equal(r.finishes, 0); assert.equal(r.session.state, 'idle');
  const old = r.starts[0]; old.resolve(true); await tick();
  old.options.onLevel?.(1); old.options.onSpeechStart?.(); old.options.onProcessing?.();
  old.options.onError?.(new Error('late'));
  await old.options.onUtterance(new Blob(['late']));
  assert.equal(r.session.state, 'idle'); assert.equal(delivered, 0); assert.equal(feedback, 0);
  assert.ok(!r.states.includes('recording'));
});

test('cancel during finalization rejects the late upload while a newer press remains live', async () => {
  const r = rig(); let oldDelivery = 0, newDelivery = 0;
  r.session.press({ onUtterance() { oldDelivery++; } });
  r.starts[0].resolve(true); await tick(); r.session.release();
  r.session.cancel();
  r.session.press({ onUtterance() { newDelivery++; } });
  r.starts[1].resolve(true); await tick();
  r.starts[0].options.onProcessing?.();
  await r.starts[0].options.onUtterance(new Blob(['late']));
  assert.equal(oldDelivery, 0); assert.equal(r.session.state, 'recording');
  r.session.release(); await r.starts[1].options.onUtterance(new Blob(['new']));
  assert.equal(newDelivery, 1); assert.equal(r.finishes, 2);
});

test('a silent or timed-out hold finishes without a send and cannot later be submitted on release', async () => {
  for (const kind of ['silence', 'limit'] as const) {
    const r = rig(); let feedback = 0;
    r.session.press({ onUtterance() { assert.fail('discarded hold must not deliver'); }, onSilence() { feedback++; }, onError() { feedback++; } });
    r.starts[0].resolve(true); await tick();
    if (kind === 'silence') r.starts[0].options.onSilence?.();
    else r.starts[0].options.onError?.(new Error('recording_limit'));
    r.session.release();
    r.starts[0].options.onProcessing?.();
    await r.starts[0].options.onUtterance(new Blob(['late']));
    assert.equal(feedback, 1); assert.equal(r.finishes, 0); assert.equal(r.session.state, 'idle');
  }
});

test('permission rejection from a cancelled press does not change a new recording', async () => {
  const r = rig();
  r.session.press({ onUtterance() {} }); r.session.cancel();
  r.session.press({ onUtterance() {} }); r.starts[1].resolve(true); await tick();
  r.starts[0].resolve(false); await tick();
  assert.equal(r.session.state, 'recording'); assert.equal(r.stops, 1);
  r.session.cancel();
});

test('synchronous cancellation in state callbacks cannot start or finish a capture afterwards', async () => {
  let cancelAt: PressToTalkState = 'starting';
  const r = rig(state => { if (state === cancelAt) r.session.cancel(); });
  assert.equal(r.session.press({ onUtterance() { assert.fail(); } }), false);
  assert.equal(r.starts.length, 0);
  cancelAt = 'finishing';
  r.session.press({ onUtterance() { assert.fail(); } }); r.starts[0].resolve(true); await tick();
  r.session.release();
  assert.equal(r.finishes, 0); assert.equal(r.session.state, 'idle');
});

test('cancellation during terminal state notification blocks the already queued utterance', async () => {
  let cancelled = false, blockIdle = false;
  const r = rig(state => { if (state === 'idle' && blockIdle && !cancelled) { cancelled = true; r.session.cancel(); } });
  r.session.press({ onUtterance() { assert.fail('terminal callback must still honor cancellation'); } });
  r.starts[0].resolve(true); await tick(); r.session.release(); blockIdle = true;
  await r.starts[0].options.onUtterance(new Blob(['cancelled']));
  assert.equal(cancelled, true); assert.equal(r.session.state, 'idle');
});

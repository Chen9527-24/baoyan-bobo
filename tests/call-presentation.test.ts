import test from 'node:test';
import assert from 'node:assert/strict';
import { getCallPresentation, type CallPresentationInput, type ProcessingPhase } from '../apps/web/src/lib/callPresentation.ts';

const baseline: CallPresentationInput = {
  state: 'listening',
  liveVoice: true,
  voiceReady: true,
  muted: false,
  audioPreparing: false,
  memoryPending: false,
  cancelling: false,
  hasCandidate: false,
  forgetCandidate: false,
  processingPhase: 'thinking',
};
const present = (overrides: Partial<CallPresentationInput> = {}) => getCallPresentation({ ...baseline, ...overrides });

test('idle, ended and connecting override stale busy/readiness flags', () => {
  const stale = { audioPreparing: true, memoryPending: true, hasCandidate: true, muted: true, voiceReady: true };
  assert.equal(present({ ...stale, state: 'idle' }).turn, 'off');
  assert.equal(present({ ...stale, state: 'ended' }).title, '这次先聊到这里');
  assert.equal(present({ ...stale, state: 'ended' }).turn, 'off');
  assert.equal(present({ ...stale, state: 'connecting' }).title, '正在和宝妍连接');
  assert.equal(present({ ...stale, state: 'connecting' }).turn, 'waiting');
});

test('opening permission or starting a recorder never claims the user can already speak', () => {
  const value = present({ voiceReady: false });
  assert.equal(value.title, '正在打开麦克风');
  assert.equal(value.turn, 'waiting');
  assert.doesNotMatch(value.title, /在听|轮到你说/);
  const ready = present();
  assert.equal(ready.title, '轮到你说了');
  assert.equal(ready.turn, 'you');
  assert.match(ready.detail, /停顿.*自动发送.*说完了/);
});

test('the three processing phases remain distinct and muted never overrides work in progress', () => {
  const titles: Record<ProcessingPhase, string> = {
    recognizing: '正在识别你说的话',
    thinking: '宝妍在想一想',
    'preparing-speech': '正在准备宝妍的声音',
  };
  for (const phase of Object.keys(titles) as ProcessingPhase[]) {
    const value = present({ state: 'processing', processingPhase: phase, muted: true, hasCandidate: true });
    assert.equal(value.title, titles[phase]);
    assert.equal(value.turn, 'waiting');
    assert.match(value.detail, /麦克风已关闭/);
    assert.doesNotMatch(value.title, /在说话/);
  }
});

test('speaking is reserved for actual playback and stays visible while microphone is muted', () => {
  const value = present({ state: 'speaking', muted: true, hasCandidate: true });
  assert.equal(value.title, '宝妍在说话');
  assert.equal(value.turn, 'baoyan');
  assert.match(value.detail, /我来说/);
});

test('memory candidates wait for confirmation instead of showing a ready microphone', () => {
  const save = present({ hasCandidate: true });
  const forget = present({ hasCandidate: true, forgetCandidate: true, muted: true });
  assert.equal(save.title, '一起确认这件小事');
  assert.equal(forget.title, '只忘记这一条');
  assert.equal(save.turn, 'waiting');
  assert.equal(forget.turn, 'waiting');
  assert.match(save.detail, /麦克风已关闭/);
});

test('audio finalization precedes other active flags and never pretends capture is still open', () => {
  const value = present({ audioPreparing: true, memoryPending: true, hasCandidate: true, muted: true });
  assert.equal(value.title, '正在整理这段声音');
  assert.equal(value.turn, 'waiting');
  assert.match(value.detail, /麦克风已关闭/);
});

test('a pending memory write cannot advertise another voice turn', () => {
  const value = present({ memoryPending: true, hasCandidate: true });
  assert.equal(value.title, '正在提交，请稍等');
  assert.equal(value.turn, 'waiting');
  assert.match(value.detail, /麦克风已关闭/);
});

test('paused cancellation and recovery outrank stale readiness and preserve mute expectations', () => {
  const cancelling = present({ state: 'paused', cancelling: true, muted: true });
  assert.equal(cancelling.title, '正在停止这一轮');
  assert.equal(cancelling.turn, 'waiting');
  const paused = present({ state: 'paused', muted: true });
  assert.match(paused.detail, /仍保持静音/);
  assert.equal(paused.turn, 'waiting');
});

test('muted listening never advertises active capture while text remains available', () => {
  const value = present({ muted: true });
  assert.equal(value.title, '麦克风已关闭');
  assert.equal(value.turn, 'off');
  assert.match(value.detail, /文字输入仍可使用/);
});

test('text mode never implies microphone capture even if a stale ready flag remains', () => {
  for (const voiceReady of [false, true]) {
    const value = present({ liveVoice: false, voiceReady });
    assert.equal(value.title, '轮到你输入了');
    assert.equal(value.turn, 'you');
    assert.match(value.detail, /不会录音/);
  }
});

test('presentation does not mutate the lifecycle state supplied by the caller', () => {
  const input = Object.freeze({ ...baseline, audioPreparing: true });
  const before = JSON.stringify(input);
  getCallPresentation(input);
  assert.equal(JSON.stringify(input), before);
});

test('hold mode names the deliberate press and does not claim an idle microphone is open', () => {
  const idle = present({ voiceMode: 'hold', voiceHolding: false, voiceReady: false });
  assert.match(idle.title, /按住/); assert.match(idle.detail, /未按住时麦克风关闭/);
  const starting = present({ voiceMode: 'hold', voiceHolding: true, voiceReady: false });
  assert.equal(starting.turn, 'waiting'); assert.equal(starting.title, '正在打开麦克风');
  const ready = present({ voiceMode: 'hold', voiceHolding: true, voiceReady: true });
  assert.match(ready.title, /正在收音.*松手发送/); assert.match(ready.detail, /停顿不会自动发送/);
  assert.equal(present({ voiceMode: 'hold', voiceHolding: true, muted: true }).turn, 'off');
  assert.equal(present({ voiceMode: 'hold', voiceHolding: false, audioPreparing: true }).title, '正在整理这段声音');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { characterMotionFor, characterReactionFor, type CharacterEmotion } from '../apps/web/src/lib/characterMotion.js';

const emotions: CharacterEmotion[] = ['warm', 'happy', 'thoughtful', 'calm'];

test('stale expressions and media flags cannot override inactive, preparation or suspended states', () => {
  for (const emotion of emotions) {
    for (const state of ['idle', 'ended'] as const) {
      assert.equal(characterMotionFor({ state, emotion, playbackActive: true, listeningActive: true }), 'cover');
    }
    for (const state of ['connecting', 'paused'] as const) {
      assert.equal(characterMotionFor({ state, emotion, playbackActive: true, listeningActive: true }), 'idle');
    }
    assert.equal(characterMotionFor({ state: 'processing', emotion, playbackActive: true, listeningActive: true }), 'thinking');
    for (const state of ['connecting', 'paused', 'processing', 'listening', 'speaking'] as const) {
      assert.equal(characterMotionFor({ state, emotion, playbackActive: true, listeningActive: true, suspended: true }), 'idle');
    }
  }
});

test('speaking requires actual output and listening requires actual capture in its own turn', () => {
  for (const emotion of emotions) {
    assert.equal(characterMotionFor({ state: 'speaking', emotion, playbackActive: false, listeningActive: true }), 'idle');
    assert.equal(characterMotionFor({ state: 'listening', emotion, playbackActive: true, listeningActive: false }), 'idle');
    assert.equal(characterMotionFor({ state: 'listening', emotion, playbackActive: false, listeningActive: true }), 'listening');
  }
  assert.equal(characterMotionFor({ state: 'speaking', playbackActive: true }), 'speaking-natural');
  assert.equal(characterMotionFor({ state: 'speaking', playbackActive: true, emotion: 'thoughtful' }), 'speaking-explaining');
});

test('a current segment question can refine ordinary delivery but never replaces happy or caring delivery', () => {
  for (const segmentText of ['你想先说哪一件？', 'What happened?  ']) {
    assert.equal(characterMotionFor({ state: 'speaking', playbackActive: true, emotion: 'warm', segmentText }), 'speaking-question');
    assert.equal(characterMotionFor({ state: 'speaking', playbackActive: true, emotion: 'thoughtful', segmentText }), 'speaking-question');
    assert.equal(characterMotionFor({ state: 'speaking', playbackActive: true, emotion: 'happy', segmentText }), 'speaking-happy');
    assert.equal(characterMotionFor({ state: 'speaking', playbackActive: true, emotion: 'calm', segmentText }), 'speaking-caring');
  }
  assert.equal(characterMotionFor({ state: 'speaking', playbackActive: true, segmentText: '你问为什么？我陪你看看。' }), 'speaking-natural');
  assert.equal(characterMotionFor({ state: 'processing', playbackActive: false, segmentText: '你想先说哪一件？' }), 'thinking');
});

test('a sad reaction needs both a direct current first-person statement and this reply’s caring language', () => {
  for (const inputText of ['我好难过。', '宝妍，我现在很伤心', '今天我真的很委屈！', '我有点想哭', '我的积木倒了，我很难过']) {
    assert.equal(characterReactionFor({ emotion: 'calm', spokenText: '我在，慢慢说。', inputText }), 'reaction-sad', inputText);
    assert.equal(characterReactionFor({ emotion: 'warm', spokenText: '我在，慢慢说。', inputText }), undefined, inputText);
    assert.equal(characterReactionFor({ emotion: 'calm', spokenText: '小兔子回家睡觉了。', inputText }), undefined, inputText);
  }
});

test('calm does not mean sadness: negation, questions, attribution, quotation and practice never trigger crying', () => {
  const rejected = [
    '', '我想睡觉了', '今天我们听个睡前故事', '我很开心',
    '我不难过', '我并不伤心', '我没有觉得很难过', '我不想哭', '我不觉得我很伤心',
    '我很难过，但现在不难过了', '我很伤心，开玩笑的', '昨天我很伤心', '我以前很难过',
    '我很难过吗', '我是不是很委屈', '我想哭？', '为什么我很伤心', '我难不难过',
    '妈妈很难过', '我朋友很难过', '我觉得妈妈很伤心', '妈妈说我很难过', '小明说，我很难过',
    '“我很难过”', '我说“我很难过”是台词', '我很难过用英语怎么说',
    '翻译：我很难过', '我很难过。这句话是什么意思', '假如我很难过',
    '我很难过，这个词怎么造句', '我很难过是歌名', '我想哭是他写的台词', '我很难过，但那是故事里的我', '我很难过，不是真的',
  ];
  for (const inputText of rejected) {
    assert.equal(characterReactionFor({ emotion: 'calm', spokenText: '我在，慢慢说。', inputText }), undefined, inputText);
  }
});

test('only happy delivery selects a happy reaction, independently of retained user text', () => {
  assert.equal(characterReactionFor({ emotion: 'happy', spokenText: '拼好了！', inputText: '我拼好啦' }), 'reaction-happy');
  assert.equal(characterReactionFor({ emotion: 'thoughtful', spokenText: '我在，慢慢说。', inputText: '我很难过' }), undefined);
  assert.equal(characterReactionFor({ emotion: 'calm', spokenText: '我们看看你画的画。', inputText: '我很难过' }), undefined);
});

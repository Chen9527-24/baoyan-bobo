import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConversationPolicyPrompt, conversationPolicy } from '../apps/server/src/conversation-policy.js';

const user = (content: string) => ({ role: 'user', content });
const assistant = (content: string) => ({ role: 'assistant', content });

test('explicit everyday sharing language receives existing listening guidance without inferring emotion', () => {
  for (const inputText of ['我只是想告诉你一下', '我就是和你说一声', '只是想分享一下', '我只想跟你分享这个', '我就是想说说而已', '宝妍，我只是想跟你说说这件事']) {
    const policy = conversationPolicy({ history: [], inputText });
    assert.equal(policy.listenOnly, true, inputText);
    assert.equal(policy.questionsDeclined, true, inputText);
    const prompt = buildConversationPolicyPrompt({ history: [], inputText });
    assert.match(prompt, /最近的明确偏好是先倾诉/, inputText);
    assert.match(prompt, /本轮有情绪、受挫或明确只分享的直述线索/, inputText);
    assert.doesNotMatch(prompt, /本轮有直接提出的问题、求办法/, inputText);
  }
});

test('later direct help releases new sharing phrases within and across turns', () => {
  const history = [user('我只是想分享一下'), assistant('好，先听你说。')];
  for (const inputText of ['那我应该怎么办？', '现在帮我想一个办法', '水为什么会变成冰？']) {
    const policy = conversationPolicy({ history, inputText });
    assert.equal(policy.listenOnly, false, inputText);
    const prompt = buildConversationPolicyPrompt({ history, inputText });
    assert.match(prompt, /本轮有直接提出的问题、求办法/, inputText);
    assert.doesNotMatch(prompt, /最近的明确偏好是先倾诉/, inputText);
  }
  assert.equal(conversationPolicy({ history: [], inputText: '我只是想分享一下，不过现在帮我想个办法' }).listenOnly, false);
  assert.equal(conversationPolicy({ history: [], inputText: '帮我想个办法，不过我只是想分享一下' }).listenOnly, true);
});

test('sharing words in quotes, reports, hypotheticals and partner questions do not impose a preference', () => {
  for (const inputText of ['“我只是想分享一下”是什么意思？', '同桌说，我只是想分享一下', '如果我只是想分享一下，你会怎么回答？', '你只是想分享一下吗？', '宝妍，你就是想说说而已吗？', '我不是只想分享一下', '我不只是想分享一下', '我想知道这句话是什么意思']) {
    assert.equal(conversationPolicy({ history: [], inputText }).listenOnly, false, inputText);
    assert.equal(conversationPolicy({ history: [], inputText }).questionsDeclined, false, inputText);
  }
});

test('sharing preference survives bounded chat only and cannot suppress safety reminders', () => {
  const prior = [user('我就是和你说一声'), assistant('知道啦。')];
  assert.equal(conversationPolicy({ history: prior, inputText: '贴在本子上了' }).listenOnly, true);
  const expired = [...prior, ...Array.from({ length: 8 }, () => assistant('换个话题。'))];
  assert.equal(conversationPolicy({ history: expired, inputText: '今天有太阳' }).listenOnly, false);
  const prompt = buildConversationPolicyPrompt({ history: prior, inputText: '现在肚子一直疼，我只是想告诉你一下' });
  assert.match(prompt, /不得因只倾诉、没有问办法或要求少说而省去必要的成人求助提醒/);
});

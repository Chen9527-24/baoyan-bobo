import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { boundedContextReply, conversationPolicy } from '../apps/server/src/conversation-policy.js';
import { createApp } from '../apps/server/src/app.js';

const resultQuestion = '我后来有没有把风筝做完，你知道吗？';
test('an outcome check is recognized across comma clauses without treating a future plan as a result', () => {
  for (const inputText of [resultQuestion, '我那天到底有没有去成，你记得吗？', '我昨天有没有交上作业？'])
    assert.equal(conversationPolicy({ history: [], inputText }).personalExperienceCheck, true, inputText);
  for (const inputText of ['我明天想做完风筝', '我明天有没有机会参加比赛？', '我朋友后来有没有完成作品，你记得吗？', '有没有办法把风筝做完？', '妈妈说，我后来有没有把风筝做完，你知道吗？', '“我后来有没有把风筝做完，你知道吗？”是什么意思', '如果我有没有做完，你会怎么说？'])
    assert.equal(conversationPolicy({ history: [], inputText }).personalExperienceCheck, false, inputText);
});
test('unknown context is corrected locally while preserving the generated answer and paragraphs', () => {
  assert.equal(boundedContextReply(resultQuestion, '我不知道诶，你后来没跟我说结果。\n\n只记得你想做风筝。'), '我不知道诶，我目前还不清楚结果。\n\n只记得你想做风筝。');
  assert.equal(boundedContextReply(resultQuestion, '你从来没有告诉过我后来怎么样。'), '我目前还不清楚后来怎么样。');
  assert.equal(boundedContextReply(resultQuestion, '你没告诉我那天有没有去成。'), '我目前还不清楚那天有没有去成。');
  assert.equal(boundedContextReply(resultQuestion, '我还不知道后来有没有完成，结果还没听你说过。'), '我还不知道后来有没有完成，我目前还不清楚结果。');
  assert.equal(boundedContextReply(resultQuestion, '我还没听你说过结果。'), '我目前还不清楚结果。');
});
test('quotes, questions, reported and hypothetical speech and known facts are not rewritten', () => {
  for (const reply of ['你没跟我说结果吗？', '我还没听你说过结果吗？', '我还没听你说完。', '妈妈说，你后来没跟我说结果。', '你后来没跟我说“我已经做完了”吗？', '你后来没跟我说完。', '妈妈说你没跟我说结果。', '如果你没跟我说结果，我会不知道。', '这句“你后来没跟我说结果”不准确。', '可以说「你没有告诉过我结果」。', '你刚才说已经做完了。', '我不知道后来怎么样。', '你说你没跟我说结果。'])
    assert.equal(boundedContextReply(resultQuestion, reply), undefined, reply);
  assert.equal(boundedContextReply('替我写一句：你没告诉我结果', '你没告诉我结果。'), undefined);
  assert.equal(boundedContextReply('我只是没告诉你结果', '你没告诉我结果。'), undefined);
  assert.equal(boundedContextReply(resultQuestion, '你没跟我说结果，是吗？'), undefined);
  for (const reply of ['爷爷说，你没跟我说结果。', '弟弟问，你没跟我说结果。', '小明说，你没跟我说结果。', '你没跟我说结果，对不对。'])
    assert.equal(boundedContextReply(resultQuestion, reply), undefined, reply);
});
test('a guarded answer is registered before voice and history with no extra provider request', async t => {
  let calls = 0; const seen: any[] = [];
  const app = createApp({ dataPath: ':memory:', env: { CHAT_PROVIDER: 'volc', CHAT_API_BASE_URL: 'https://synthetic.invalid/api/v3', CHAT_API_KEY: 'synthetic-only', CHAT_MODEL: 'synthetic-model' }, fetch: async (_url, init) => {
    calls++; seen.push(JSON.parse(String(init?.body)));
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '我不知道诶，你后来没跟我说结果。' } }] });
  } }); t.after(() => app.locals.close());
  const agent = request.agent(app), post = (path: string, body: object) => agent.post(path).set('Origin', 'http://localhost:5173').send(body);
  await post('/api/setup', { pin: '123456', nickname: '虚构测试', ageGroup: '9-12', sessionMinutes: 10, dailyMinutes: 30, consent: true }).expect(201);
  const call = (await post('/api/calls', { operationId: randomUUID() }).expect(201)).body;
  const turn = await post(`/api/calls/${call.id}/turn`, { text: resultQuestion, operationId: randomUUID() }).expect(200);
  assert.equal(turn.body.reply, '我不知道诶，我目前还不清楚结果。'); assert.ok(turn.body.replyId); assert.equal(calls, 1);
  await post(`/api/calls/${call.id}/turn`, { text: '那聊点别的', operationId: randomUUID() }).expect(200);
  assert.ok(seen[1].messages.some((message: any) => message.role === 'assistant' && message.content === turn.body.reply));
  assert.equal(calls, 2);
});

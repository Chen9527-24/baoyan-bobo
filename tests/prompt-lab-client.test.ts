import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../apps/web/src/lib/api.ts';
import {
  preparePromptLabDraft, promptLabAuthorizationExpired, promptLabDefaultLimits, promptLabDraftMatches,
  promptLabError, promptLabExport, promptLabDisplayOrder, promptLabChoiceLabel, type PromptLabDraft, type PromptLabRecord,
} from '../apps/web/src/lib/promptLab.ts';

const record: PromptLabRecord = {
  id: 'run-1', createdAt: '2026-09-30T05:00:00Z', savedAt: '2026-09-30T05:01:00Z', expiresAt: '2026-10-30T05:01:00Z',
  ageGroup: '6-8', question: '搭积木倒了怎么办？', experimentPrompt: '先回应困难，给一个小建议。',
  baselinePrompt: '宝妍小姐姐的参考人设。', model: 'model-test', personaVersion: 'persona-test',
  baseline: { reply: '慢慢来。', elapsedMs: 900 }, experiment: { reply: '有点泄气呢，要不要先把底座搭宽一点？', elapsedMs: 1200 },
  choice: 'experiment', note: 'B 给了具体建议。', expectedReply: '可以先接住失望的感觉。',
};

test('prompt comparison sends only the explicit synthetic question, age and edited prompt', () => {
  const draft = preparePromptLabDraft({
    ageGroup: '6-8', question: `  ${record.question}\n`, experimentPrompt: ` ${record.experimentPrompt} `,
    familyId: 'not-for-test', memories: ['private'], history: ['real-chat'],
  } as PromptLabDraft, promptLabDefaultLimits);
  assert.deepEqual(draft, { ageGroup: '6-8', question: record.question, experimentPrompt: record.experimentPrompt });
  assert.equal(Object.keys(draft).length, 3);
});

test('comparison rejects empty or oversized drafts before any paid request', () => {
  const draft: PromptLabDraft = { ageGroup: '6-8', question: '问题', experimentPrompt: '提示' };
  assert.throws(() => preparePromptLabDraft({ ...draft, question: ' \n ' }, promptLabDefaultLimits), /填写/);
  assert.throws(() => preparePromptLabDraft({ ...draft, experimentPrompt: ' ' }, promptLabDefaultLimits), /不能为空/);
  assert.throws(() => preparePromptLabDraft({ ...draft, question: '字'.repeat(1201) }, promptLabDefaultLimits), /1200/);
  assert.throws(() => preparePromptLabDraft({ ...draft, experimentPrompt: '字'.repeat(6001) }, promptLabDefaultLimits), /6000/);
  assert.doesNotThrow(() => preparePromptLabDraft({ ...draft, question: '字'.repeat(1200), experimentPrompt: '字'.repeat(6000) }, promptLabDefaultLimits));
});

test('explicit fictional context is normalized, confirmation is required, and malformed turns or test memories are blocked', () => {
  const draft: PromptLabDraft = { ageGroup: '6-8', question: '问题', experimentPrompt: '提示', testHistory: [{ role: 'user', content: ' 小猫画歪了 ' }, { role: 'assistant', content: ' 哪里画歪了？ ' }], testMemories: [{ key: 'test.drawing', content: ' 喜欢画小猫 ', kind: 'preference' }], fictionalConfirmed: true };
  const prepared = preparePromptLabDraft(draft, promptLabDefaultLimits);
  assert.deepEqual(prepared.testHistory, [{ role: 'user', content: '小猫画歪了' }, { role: 'assistant', content: '哪里画歪了？' }]);
  assert.equal(prepared.testMemories?.[0].content, '喜欢画小猫');
  assert.throws(() => preparePromptLabDraft({ ...draft, fictionalConfirmed: false }, promptLabDefaultLimits), /确认.*虚构/);
  assert.throws(() => preparePromptLabDraft({ ...draft, testHistory: draft.testHistory!.slice(0, 1) }, promptLabDefaultLimits), /交替/);
  assert.throws(() => preparePromptLabDraft({ ...draft, testHistory: [{ role: 'user', content: '' }, { role: 'assistant', content: '回答' }] }, promptLabDefaultLimits), /每句前文/);
  assert.throws(() => preparePromptLabDraft({ ...draft, testHistory: [{ role: 'user', content: '字'.repeat(601) }, { role: 'assistant', content: '回答' }] }, promptLabDefaultLimits), /600/);
  assert.throws(() => preparePromptLabDraft({ ...draft, testMemories: [{ key: 'personal.real', content: '文字', kind: 'event' }] }, promptLabDefaultLimits), /test\./);
  assert.throws(() => preparePromptLabDraft({ ...draft, testMemories: [draft.testMemories![0], draft.testMemories![0]] }, promptLabDefaultLimits), /重复/);
  assert.throws(() => preparePromptLabDraft({ ...draft, testMemories: [{ ...draft.testMemories![0], content: '字'.repeat(61) }] }, promptLabDefaultLimits), /60/);
});

test('context changes mark generated snapshots stale and exports retain fictional data and original display order', () => {
  const contextual: PromptLabRecord = { ...record, testHistory: [{ role: 'user', content: '你好' }, { role: 'assistant', content: '你来啦。' }], testMemories: [{ key: 'test.drawing', content: '喜欢画画', kind: 'preference' }], fictionalConfirmed: true, displayOrder: ['experiment', 'baseline'] };
  assert.equal(promptLabDraftMatches(contextual, contextual), true);
  assert.equal(promptLabDraftMatches(contextual, { ...contextual, fictionalConfirmed: false }), false);
  assert.equal(promptLabDraftMatches(contextual, { ...contextual, testHistory: [] }), false);
  assert.equal(promptLabDraftMatches(contextual, { ...contextual, testMemories: [{ ...contextual.testMemories![0], content: '喜欢积木' }] }), false);
  const exported = JSON.parse(promptLabExport(contextual));
  assert.equal(exported.format, 'baoyan-prompt-lab-v2'); assert.deepEqual(exported.record, contextual);
});

test('blind preference maps to the correct underlying variant while legacy snapshots keep A/B order', () => {
  const reversed: PromptLabRecord = { ...record, displayOrder: ['experiment', 'baseline'] };
  assert.deepEqual(promptLabDisplayOrder(reversed), ['experiment', 'baseline']);
  assert.match(promptLabChoiceLabel(reversed, 'experiment'), /回复 1 更好.*实验/);
  assert.match(promptLabChoiceLabel(reversed, 'baseline'), /回复 2 更好.*当前人设/);
  assert.deepEqual(promptLabDisplayOrder(record), ['baseline', 'experiment']);
  assert.match(promptLabChoiceLabel(record, 'experiment'), /回复 2 更好/);
  assert.equal(promptLabChoiceLabel(record, 'tie'), '差不多'); assert.equal(promptLabChoiceLabel(record, 'neither'), '都不满意');
});

test('changing age, question or prompt marks previous results stale and export retains generated snapshot', () => {
  const draft: PromptLabDraft = { ageGroup: record.ageGroup, question: record.question, experimentPrompt: record.experimentPrompt };
  assert.equal(promptLabDraftMatches(record, draft), true);
  assert.equal(promptLabDraftMatches(record, { ...draft, question: ` ${draft.question}\n` }), true);
  for (const changed of [{ ...draft, ageGroup: '9-12' as const }, { ...draft, question: '新的问题' }, { ...draft, experimentPrompt: '新的提示词' }]) {
    assert.equal(promptLabDraftMatches(record, changed), false);
    const exported = JSON.parse(promptLabExport(record));
    assert.deepEqual(exported.record, record);
    assert.equal(exported.record.question, '搭积木倒了怎么办？');
    assert.equal(exported.record.model, 'model-test');
    assert.match(exported.scope, /不含语音、真实家庭记忆/);
  }
});

test('expired parent authorization is distinguished from model failures and network uncertainty', () => {
  for (const status of [401, 403]) {
    const error = new ApiError('expired', status);
    assert.equal(promptLabAuthorizationExpired(error), true);
    assert.match(promptLabError(error), /重新进入家长空间/);
  }
  const quota = new ApiError('今日测试次数已用完。', 429);
  assert.equal(promptLabAuthorizationExpired(quota), false);
  assert.equal(promptLabError(quota), '今日测试次数已用完。');
  for (const error of [new TypeError('network'), new DOMException('timed out', 'AbortError')]) {
    assert.match(promptLabError(error), /未自动重试.*可能已消耗模型额度/);
    assert.doesNotMatch(promptLabError(error), /保存成功|不会计费/);
  }
});

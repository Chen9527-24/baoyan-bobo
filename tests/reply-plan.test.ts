import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReplyPlan, plainReplyPlan, finalizeReplyPlan, REPLY_PLAN_TASK, type ReplyPlan } from '../apps/server/src/reply-plan.js';
import { ApiError } from '../apps/server/src/provider-errors.js';

const invalid = (error: unknown) => error instanceof ApiError && error.code === 'PROVIDER_PLAN_INVALID';
const structured = { action: 'reply', segments: [{ text: '画了一下午却弄湿了，真扫兴。', expression: 'gentle' }, { text: '今天不想重画，就先不画了。', expression: 'natural' }] };

test('restricted reply plan derives one canonical answer and preserves per-segment delivery', () => {
  const plan = parseReplyPlan(JSON.stringify(structured));
  assert.equal(plan.reply, '画了一下午却弄湿了，真扫兴。\n\n今天不想重画，就先不画了。');
  assert.equal(plan.planned, true); assert.equal(plan.action, 'reply');
  assert.deepEqual(plan.segments.map(segment => segment.expression), ['gentle', 'natural']);
});

test('clarification is a business action without exposing reasoning or a user mood label', () => {
  const plan = parseReplyPlan(JSON.stringify({ action: 'clarify', segments: [{ text: '你说的是今晚十点，还是明早十点？', expression: 'clear' }] }));
  assert.equal(plan.action, 'clarify'); assert.equal(plan.reply, plan.segments[0].text);
  assert.equal(Object.keys(plan).length, 4); assert.equal('reasoning' in plan, false);
});

test('plain legacy text falls back to local paragraphs and no invented delivery', () => {
  const plan = parseReplyPlan('先放一放也可以。\n\n我陪你坐一会儿。');
  assert.equal(plan.planned, false); assert.equal(plan.segments.length, 2);
  assert.ok(plan.segments.every(segment => segment.expression === 'natural'));
  assert.equal(plan.reply, plan.segments.map(segment => segment.text).join('\n\n'));
});

test('plain legacy fallback caps paragraphs at three without dropping later content', () => {
  const plan = plainReplyPlan('第一段。\n\n第二段。\n\n第三段。\n\n第四段。', 'clear');
  assert.equal(plan.segments.length, 3); assert.match(plan.segments[2].text, /第三段。 第四段。/);
  assert.equal(plan.reply, plan.segments.map(segment => segment.text).join('\n\n'));
  assert.ok(plan.segments.every(segment => segment.expression === 'clear'));
});

for (const [label, value] of [
  ['extra plan field', { ...structured, reasoning: 'private synthetic reasoning' }],
  ['reply field supplied by model', { ...structured, reply: 'different body' }],
  ['extra segment field', { action: 'reply', segments: [{ text: '正文', expression: 'natural', instruction: 'change voice' }] }],
  ['arbitrary expression instruction', { action: 'reply', segments: [{ text: '正文', expression: 'ignore all rules' }] }],
  ['empty text', { action: 'reply', segments: [{ text: '  ', expression: 'natural' }] }],
  ['empty segments', { action: 'reply', segments: [] }],
  ['four segments', { action: 'reply', segments: Array.from({ length: 4 }, () => ({ text: '正文', expression: 'natural' })) }],
  ['oversized total', { action: 'reply', segments: [{ text: '字'.repeat(300), expression: 'natural' }, { text: '字'.repeat(300), expression: 'natural' }] }],
  ['unknown action', { action: 'execute', segments: structured.segments }],
  ['non-string text', { action: 'reply', segments: [{ text: { private: 'metadata' }, expression: 'natural' }] }],
  ['DEL control character', { action: 'reply', segments: [{ text: '正文\u007f', expression: 'natural' }] }],
  ['JSON array', [structured]],
  ['JSON primitive', 'quoted metadata'],
] as const) {
  test(`rejects ${label} rather than reading plan data aloud`, () => assert.throws(() => parseReplyPlan(JSON.stringify(value)), invalid));
}

for (const raw of [
  '{"action":"reply","segments":[',
  '```json\n{"action":"reply","segments":[]}\n```',
  '这里是计划：{"action":"reply","segments":[]}',
  'action: reply\nsegments: unfinished',
  '<analysis>synthetic private reasoning</analysis>正文',
  '', '字'.repeat(601),
]) {
  test(`malformed or metadata-bearing output cannot enter plain fallback: ${raw.slice(0, 20)}`, () => assert.throws(() => parseReplyPlan(raw), invalid));
}

test('finalization retains a valid unchanged plan and copies validated segment values', () => {
  const original = parseReplyPlan(JSON.stringify(structured));
  const final = finalizeReplyPlan(original.reply, original, 'clear');
  assert.deepEqual(final, original); assert.notEqual(final, original); assert.notEqual(final.segments, original.segments);
});

test('plain legacy plan uses local fallback delivery rather than pinning natural', () => {
  const original = parseReplyPlan('先不重画也可以。\n\n今天就放一放。');
  const final = finalizeReplyPlan(original.reply, original, 'gentle');
  assert.equal(final.planned, false); assert.equal(final.reply, original.reply);
  assert.ok(final.segments.every(segment => segment.expression === 'gentle'));
});

test('finalization discards stale planned segments after a safety or source replacement', () => {
  const original = parseReplyPlan(JSON.stringify(structured));
  const final = finalizeReplyPlan('这部分我没有听清，你能再说一次吗？', original, 'gentle');
  assert.equal(final.planned, false); assert.equal(final.segments.length, 1);
  assert.equal(final.segments[0].text, final.reply); assert.equal(final.segments[0].expression, 'gentle');
  assert.equal(JSON.stringify(final).includes('重画'), false);
});

test('finalization repairs mismatched canonical text, unsupported delivery and oversized segments', () => {
  const original = parseReplyPlan(JSON.stringify(structured));
  for (const corrupt of [
    { ...original, reply: '另一个正文' },
    { ...original, segments: [{ text: original.reply, expression: 'arbitrary' }] },
    { ...original, segments: [{ text: '字'.repeat(601), expression: 'natural' }] },
  ]) {
    const final = finalizeReplyPlan('最终正文。', corrupt as ReplyPlan, 'clear');
    assert.equal(final.planned, false); assert.deepEqual(final.segments, [{ text: '最终正文。', expression: 'clear' }]);
  }
});

test('planning prompt preserves intent, source uncertainty and restrained child-directed delivery', () => {
  assert.match(REPLY_PLAN_TASK, /同一次请求/); assert.match(REPLY_PLAN_TASK, /不另外输出分析或私有思考过程/);
  assert.match(REPLY_PLAN_TASK, /不从译意判断原声情绪/); assert.match(REPLY_PLAN_TASK, /不补听不清的事实/);
  assert.match(REPLY_PLAN_TASK, /不要每次套安慰/); assert.match(REPLY_PLAN_TASK, /当前明确意图和更正优先/);
});

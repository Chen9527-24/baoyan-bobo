import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { adoptionCanApply, adoptionScopeLabel, directionMatches, directionLabel, retestSelection, type DirectionPreview, type AdoptionChoice, type AdoptionComparison, type AdoptionState } from '../apps/web/src/lib/sceneAdoption.ts';
import { prepareCalibrationSubmission, type CalibrationCase } from '../apps/web/src/lib/calibration.ts';

register('data:text/javascript,' + encodeURIComponent(`export async function load(url, context, nextLoad) {
  if (url.endsWith('.css')) return { format: 'module', source: 'export default {}', shortCircuit: true };
  return nextLoad(url, context);
}`), import.meta.url);
const { SceneAdoption } = await import('../apps/web/src/components/SceneAdoption');

const at = Date.parse('2026-10-13T12:00:00Z');
const item: CalibrationCase = { ...prepareCalibrationSubmission({ question: '我今天画了一只猫。', actualReply: '', ageGroup: '6-8', guideline: '先听我说。' }, true), id: '00000000-0000-4000-8000-000000000001', revision: 2, status: 'accepted', createdAt: new Date(at).toISOString(), updatedAt: new Date(at).toISOString(), reviewNote: '', reviewHistory: [] };
const state: AdoptionState = { version: 0 };
function report(changes: Partial<AdoptionComparison> = {}): AdoptionComparison {
  return { id: '00000000-0000-4000-8000-000000000002', operationId: '00000000-0000-4000-8000-000000000003', caseId: item.id, caseRevision: item.revision, baseVersion: 0, ageGroup: '6-8', intent: 'sharing', preferences: ['listen-first'], model: 'fictional-model', personaVersion: 'fictional-persona', replyPlanVersion: '4', policyVersion: '1', createdAt: new Date(at).toISOString(), completedAt: new Date(at).toISOString(), expiresAt: new Date(at + 1000).toISOString(), scope: 'family', status: 'completed', completedPairs: 3, total: 3, rows: [
    { id: '0', label: '原场景', question: item.question, ageGroup: '6-8', baseline: { reply: '画了一只猫呀。', elapsedMs: 1 }, candidate: { reply: '小猫画好啦，我听你讲。', elapsedMs: 1 } },
    { id: '1', label: '相似情况', question: '我今天画了一只小狗。', ageGroup: '6-8', baseline: { reply: '小狗呀。', elapsedMs: 1 }, candidate: { reply: '小狗画好啦。', elapsedMs: 1 } },
    { id: '2', label: '其他年龄与话题', question: '什么是影子？', ageGroup: '3-5', baseline: { reply: '影子是光被挡住的地方。', elapsedMs: 1 }, candidate: { reply: '影子是光被挡住的地方。', elapsedMs: 1 } },
  ], ...changes };
}
const approved: AdoptionChoice[] = ['candidate', 'tie', 'tie'];

test('using a saved direction requires all three reviewed pairs and an improvement in the matched questions', () => {
  assert.equal(adoptionCanApply(report(), approved, state, item, at), true);
  assert.equal(adoptionCanApply(report(), ['tie', 'candidate', 'tie'], state, item, at), true);
  for (const choices of [[], ['candidate'], ['candidate', '', 'tie'], ['tie', 'tie', 'tie'], ['tie', 'tie', 'candidate'], ['candidate', 'baseline', 'tie'], ['candidate', 'tie', 'neither'], ['candidate', 'tie', 'tie', 'tie']] as (AdoptionChoice | '')[][]) {
    assert.equal(adoptionCanApply(report(), choices, state, item, at), false, JSON.stringify(choices));
  }
});

test('a previous scene or adoption revision cannot reuse another review confirmation', () => {
  assert.equal(adoptionCanApply(report(), approved, undefined, item, at), false);
  assert.equal(adoptionCanApply(report(), approved, { version: 1 }, item, at), false);
  assert.equal(adoptionCanApply(report({ caseId: 'other-scene' }), approved, state, item, at), false);
  assert.equal(adoptionCanApply(report(), approved, state, { ...item, revision: 3 }, at), false);
  for (const status of ['proposed', 'rejected'] as const) assert.equal(adoptionCanApply(report(), approved, state, { ...item, status }, at), false);
});

test('pending, cancelled, failed and expired comparisons cannot be adopted', () => {
  assert.equal(adoptionCanApply(null, approved, state, item, at), false);
  for (const status of ['pending', 'cancelled', 'failed'] as const) assert.equal(adoptionCanApply(report({ status }), approved, state, item, at), false);
  assert.equal(adoptionCanApply(report(), approved, state, item, at + 1000), false, 'expiry is exclusive');
  assert.equal(adoptionCanApply(report({ expiresAt: 'not-a-date' }), approved, state, item, at), false);
});

test('a successful-looking row does not hide a missing or failed counterpart', () => {
  for (const side of ['baseline', 'candidate'] as const) {
    const failed = report(); failed.rows[1]![side] = { error: '这份回答未完成', elapsedMs: 1 };
    assert.equal(adoptionCanApply(failed, approved, state, item, at), false);
    const mixed = report(); mixed.rows[1]![side].error = '部分失败';
    assert.equal(adoptionCanApply(mixed, approved, state, item, at), false);
  }
  assert.equal(adoptionCanApply(report({ rows: report().rows.slice(0, 2) }), approved, state, item, at), false);
});

test('eligibility checks leave saved outputs, review choices and active state untouched', () => {
  const snapshot = report(); const selected = [...approved]; const current = { ...state };
  const before = JSON.stringify({ snapshot, selected, current, item });
  adoptionCanApply(snapshot, selected, current, item, at);
  adoptionCanApply(snapshot, selected, current, item, at + 2000);
  assert.equal(JSON.stringify({ snapshot, selected, current, item }), before);
});

test('scope wording distinguishes a family change from isolated debug use', () => {
  assert.equal(adoptionScopeLabel('family'), '仅本家庭');
  assert.equal(adoptionScopeLabel('debug'), '仅内测调试');
});

test('saved-scene initial rendering offers a collapsed adoption entry without claiming adoption or rendering a confirmation form', () => {
  const runtime = globalThis as unknown as { React?: typeof React };
  const previous = runtime.React;
  try {
    runtime.React = React;
    for (const apiBase of ['/parent/calibration', '/debug/calibration'] as const) {
      const markup = renderToStaticMarkup(React.createElement(SceneAdoption, { item, apiBase, childId: 'fictional-child', onBusyChange: () => {}, onAuthorizationExpired: () => {} }));
      assert.match(markup, /<summary>让这个方向用于以后的聊天<\/summary>/);
      assert.doesNotMatch(markup, /<details[^>]*\bopen\b|<input|<select|<button/);
      assert.doesNotMatch(markup, /已在使用|已经采用|已采用这个|保持默认接法|自动用于/);
    }
  } finally { if (previous) runtime.React = previous; else delete runtime.React; }
});

const preview = (): DirectionPreview => ({ id: 'direction-1', operationId: 'preview-1', caseId: item.id, caseRevision: item.revision, ageGroup: item.ageGroup, intent: 'sharing', sourceText: '先听我说完', direction: { version: '1', steps: ['give-space'] }, steps: [{ id: 'give-space', label: '留空间', description: '先让孩子说' }], warnings: [], model: 'fictional', personaVersion: '0', replyPlanVersion: '4', conversationPolicyVersion: '1', policyVersion: '1', createdAt: new Date(at).toISOString(), expiresAt: new Date(at + 1000).toISOString(), scope: 'family' });
test('natural direction confirmation belongs to exact text, scene revision, scope and intent', () => {
  assert.equal(directionMatches(preview(), item, ' 先听我说完 ', 'sharing', 'family', at), true);
  for (const changed of [{ ...preview(), sourceText: '别的意思' }, { ...preview(), caseId: 'other' }, { ...preview(), caseRevision: 3 }, { ...preview(), scope: 'debug' as const }, { ...preview(), intent: 'help' as const }, { ...preview(), expiresAt: new Date(at).toISOString() }, { ...preview(), direction: { version: '1' as const, steps: [] } }]) assert.equal(directionMatches(changed, item, '先听我说完', 'sharing', 'family', at), false);
  assert.equal(directionMatches(preview(), { ...item, status: 'proposed' }, '先听我说完', 'sharing', 'family', at), false);
});
test('direction display preserves ordered actions and supports existing fixed preferences', () => {
  assert.equal(directionLabel({ preferences: [], direction: { version: '1', steps: ['event', 'example'] } }, [{ id: 'event', label: '回应事情', description: '' }, { id: 'example', label: '生活例子', description: '' }]), '回应事情 → 生活例子');
  assert.equal(directionLabel({ preferences: ['concise'] }), '说短一点');
});
test('batch retest selects only 3–5 unique current accepted cases and preserves exact revisions', () => {
  const cases = Array.from({ length: 6 }, (_, index) => ({ ...item, expectedReply: '虚构满意回答', id: String(index), revision: index + 2 }));
  assert.deepEqual(retestSelection(cases, ['0', '1', '2']), [{ id: '0', revision: 2 }, { id: '1', revision: 3 }, { id: '2', revision: 4 }]);
  for (const ids of [[], ['0', '1'], ['0', '0', '1'], ['0', '1', 'missing'], cases.map(row => row.id)]) assert.equal(retestSelection(cases, ids), null);
  assert.equal(retestSelection(cases.map(row => row.id === '2' ? { ...row, status: 'rejected' } : row), ['0', '1', '2']), null);
});
test('batch retest is initially folded without starting paid calls or preselecting scenes', async () => {
  const { SceneRetest } = await import('../apps/web/src/components/SceneRetest');
  const runtime = globalThis as unknown as { React?: typeof React }; const previous = runtime.React;
  try { runtime.React = React;
    const markup = renderToStaticMarkup(React.createElement(SceneRetest, { cases: [item], apiBase: '/parent/calibration', onBusyChange: () => {}, onAuthorizationExpired: () => {} }));
    assert.match(markup, /一起试试已保存的场景/); assert.doesNotMatch(markup, /<input|<button|已完成|<details[^>]* open/);
  } finally { if (previous) runtime.React = previous; else delete runtime.React; }
});

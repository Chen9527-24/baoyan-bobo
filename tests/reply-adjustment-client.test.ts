import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareReplyAdjustment, replyAdjustmentMatches, replyAdjustmentConfirmation, type ReplyAdjustmentRun } from '../apps/web/src/lib/replyAdjustment.ts';
import { parseCalibrationImport, splitCalibrationExport, type CalibrationCase, type CalibrationDraft } from '../apps/web/src/lib/calibration.ts';
const draft: CalibrationDraft = { question: '我搭的城堡又倒了。', actualReply: '坚持就会成功，加油！', ageGroup: '6-8', guideline: '先接住失落，再给一个小办法。', testHistory: [{ role: 'user', content: '搭了很久。' }, { role: 'assistant', content: '嗯，搭了一座大城堡。' }], testMemories: [{ key: 'test.blocks', content: '喜欢搭城堡', kind: 'preference' }] };
const run: ReplyAdjustmentRun = { ...prepareReplyAdjustment(draft, true), id: '00000000-0000-4000-8000-000000000001', operationId: '00000000-0000-4000-8000-000000000002', createdAt: '2026-10-09T01:00:00Z', expiresAt: '2026-10-09T01:15:00Z', reply: '搭了很久，倒掉真让人泄气。\n\n先歇一会儿也可以。', model: 'fixture-only', personaVersion: '0.13', elapsedMs: 100, baselinePrompt: '姐姐人设', experimentPrompt: '调整参考' };
test('natural language adjustment requires explicit fictional scope and a direction, without silently using an old ideal reply', () => {
  assert.throws(() => prepareReplyAdjustment(draft, false), /虚构/);
  assert.throws(() => prepareReplyAdjustment({ ...draft, guideline: '', expectedReply: '旧理想答' }, true), /调整/);
  assert.equal(prepareReplyAdjustment({ ...draft, actualReply: '' }, true).actualReply, '');
  assert.equal(prepareReplyAdjustment({ ...draft, guideline: '  自然一些。 ' }, true).guideline, '自然一些。');
  assert.throws(() => prepareReplyAdjustment({ ...draft, guideline: '改'.repeat(1001) }, true), /1000/);
});
test('changing any source field or withdrawing fictional confirmation invalidates the candidate; whitespace-only edit can match', () => {
  assert.equal(replyAdjustmentMatches(run, draft, true), true);
  assert.equal(replyAdjustmentMatches(run, { ...draft, question: ' '+draft.question+' ' }, true), true);
  for (const change of [ { question: '现在不想搭了。' }, { actualReply: '换掉原答' }, { guideline: '改用另外方向' }, { ageGroup: '9-12' as const }, { testHistory: [] }, { testMemories: [] } ]) assert.equal(replyAdjustmentMatches(run, { ...draft, ...change }, true), false);
  assert.equal(replyAdjustmentMatches(run, draft, false), false);
});
test('confirmation freezes exactly the preview run, stable operation and title for uncertain-network retries', () => {
  const frozen = replyAdjustmentConfirmation(run, '00000000-0000-4000-8000-000000000003', '  城堡倒了  ');
  assert.deepEqual(frozen, { operationId: '00000000-0000-4000-8000-000000000003', runId: run.id, title: '城堡倒了', fictionalConfirmed: true, satisfied: true });
  assert.equal(replyAdjustmentConfirmation(run, frozen.operationId, '').title, run.question);
  assert.throws(() => replyAdjustmentConfirmation(run, frozen.operationId, '名'.repeat(81)), /80/);
});
test('scene generation provenance survives version-one import and export; legacy records need no rewrite', () => {
  const item: CalibrationCase = { ...draft, testHistory: draft.testHistory!, testMemories: draft.testMemories!, title: '城堡', category: '回答调整', expectedReply: run.reply, guideline: draft.guideline!, note: '', fictionalConfirmed: true,
    id: run.id, revision: 1, status: 'accepted', createdAt: run.createdAt, updatedAt: run.createdAt, reviewNote: '满意', reviewHistory: [],
    rewrite: { generationId: run.id, guideline: run.guideline, model: run.model, personaVersion: run.personaVersion, generatedAt: run.createdAt, confirmedAt: run.createdAt, elapsedMs: run.elapsedMs, actualReplySource: 'user-provided', provenance: 'server-generated' } };
  const exported = { schemaVersion: 'baoyan-calibration-v1' as const, cases: [item, { ...item, id: run.operationId, rewrite: undefined }] };
  const parts = splitCalibrationExport(exported);
  const parsed = parseCalibrationImport(JSON.stringify(parts[0]));
  assert.deepEqual(parsed.cases[0].rewrite, item.rewrite);
  assert.equal(parsed.cases[1].rewrite, undefined);
});

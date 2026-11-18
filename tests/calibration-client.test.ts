import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calibrationComparison, calibrationExperimentPrompt, calibrationExportPartByteLimit,
  calibrationImportByteLimit, calibrationRunDraft, calibrationSnapshotChoiceLabel,
  calibrationProgress, calibrationStatusLabels,
  parseCalibrationImport, prepareCalibrationSubmission, splitCalibrationExport,
  type CalibrationCase, type CalibrationDraft, type CalibrationExport,
} from '../apps/web/src/lib/calibration.ts';
import type { PromptLabRun } from '../apps/web/src/lib/promptLab.ts';

const draft = (changes: Partial<CalibrationDraft> = {}): CalibrationDraft => ({
  question: '我画的小猫又歪了。', actualReply: '', ageGroup: '6-8', title: '画画受挫', category: '受挫接话',
  expectedReply: '擦了好多次，有点烦了吧。\n\n先歇一下也可以。', guideline: '先接住具体感受，不连续追问。', ...changes,
});
const item = (index = 1, changes: Partial<CalibrationCase> = {}): CalibrationCase => ({
  ...prepareCalibrationSubmission(draft(), true), id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  revision: 2, status: 'accepted', createdAt: '2026-10-03T00:00:00.000Z', updatedAt: '2026-10-03T01:00:00.000Z',
  reviewNote: '简短但没有忽略孩子的感受。', reviewHistory: [{ date: '2026-10-03T01:00:00.000Z', previousStatus: 'proposed', status: 'accepted', note: '简短但没有忽略孩子的感受。' }], ...changes,
});
const document = (cases: CalibrationCase[]): CalibrationExport => ({ schemaVersion: 'baoyan-calibration-v1', scope: 'family-fictional-calibration', exportedAt: '2026-10-03T02:00:00.000Z', samplesVersion: 'bobo-child-v1', cases });

test('confirmed reference is visibly a next calibration step, while imported and withdrawn references require confirmation', () => {
  const accepted = calibrationProgress('accepted');
  assert.equal(accepted.referenceConfirmed, true);
  assert.match(accepted.detail, /保存不会自动改变日常聊天/);
  assert.match(accepted.next, /保存不会自动开始校准/);
  assert.match(calibrationStatusLabels.accepted, /已确认的参考/);
  const proposed = calibrationProgress('proposed');
  assert.equal(proposed.referenceConfirmed, false);
  assert.match(proposed.detail, /导入的场景也需要重新确认/);
  assert.equal(calibrationProgress('rejected').referenceConfirmed, false);
  assert.match(calibrationProgress('rejected').next, /换个方向试答/);
});

test('suggestions require explicit fictional confirmation and a useful correction, while empty original reply is allowed', () => {
  assert.throws(() => prepareCalibrationSubmission(draft(), false), /虚构或脱敏/);
  assert.throws(() => prepareCalibrationSubmission(draft({ expectedReply: '', guideline: '' }), true), /期望回复/);
  const submitted = prepareCalibrationSubmission(draft({ title: '', actualReply: '', note: '  没有原回复，先建场景  ' }), true);
  assert.equal(submitted.title, '我画的小猫又歪了。');
  assert.equal(submitted.actualReply, '');
  assert.equal(submitted.note, '没有原回复，先建场景');
  assert.equal(submitted.expectedReply, '擦了好多次，有点烦了吧。\n\n先歇一下也可以。');
  assert.equal(submitted.fictionalConfirmed, true);
});

test('a fictional scene keeps bounded alternating history, distinct memories and actual model prompt metadata', () => {
  const submitted = prepareCalibrationSubmission(draft({ testHistory: [{ role: 'user', content: ' 我擦了好多次。 ' }, { role: 'assistant', content: ' 嗯。 ' }], testMemories: [{ key: 'test.drawing', content: '喜欢画小猫', kind: 'preference' }], model: 'old-text-model', personaVersion: 'old-persona', baselinePrompt: '朴素一点。', experimentPrompt: '先接住孩子。' }), true);
  assert.equal(submitted.testHistory[0].content, '我擦了好多次。');
  assert.equal(submitted.model, 'old-text-model');
  assert.equal(submitted.baselinePrompt, '朴素一点。');
  assert.throws(() => prepareCalibrationSubmission(draft({ testHistory: [{ role: 'assistant', content: '嗯。' }, { role: 'user', content: '不想画了。' }] }), true), /交替/);
  assert.throws(() => prepareCalibrationSubmission(draft({ testMemories: [{ key: 'test.x', content: '喜欢画画', kind: 'preference' }, { key: 'test.x', content: '打算去公园', kind: 'plan' }] }), true), /不能重复/);
  assert.throws(() => prepareCalibrationSubmission(draft({ model: 'a'.repeat(121) }), true), /120/);
});

test('comparison capture retains both original results and does not turn an unscored run into negative feedback', () => {
  const run: PromptLabRun = { id: '00000000-0000-4000-8000-000000000001', ageGroup: '6-8', question: '我搭好啦！', baselinePrompt: 'A', experimentPrompt: 'B', createdAt: '2026-10-03T02:00:00.000Z', expiresAt: '2026-10-03T02:15:00.000Z', model: 'original-model', personaVersion: 'original-persona', baseline: { reply: '这回站稳啦。', elapsedMs: 900 }, experiment: { reply: '这回站稳啦！\n\n你搭的门还在呢。', elapsedMs: 1100 }, displayOrder: ['experiment', 'baseline'] };
  const unscored = calibrationRunDraft(run, 'experiment');
  assert.equal(unscored.actualReply, run.experiment.reply);
  assert.deepEqual(unscored.comparison?.baseline, run.baseline);
  assert.deepEqual(unscored.comparison?.experiment, run.experiment);
  assert.equal(unscored.comparison?.rated, false);
  assert.match(calibrationSnapshotChoiceLabel(unscored.comparison!), /未评价/);
  assert.match(calibrationSnapshotChoiceLabel(calibrationRunDraft(run, 'baseline', '', '', undefined, 'experiment').comparison!), /回复 1 更好/);
  assert.equal(calibrationSnapshotChoiceLabel({ ...unscored.comparison!, rated: undefined }), '原记录未标明评分状态');
  unscored.comparison!.baseline.reply = '本机编辑副本';
  assert.equal(run.baseline.reply, '这回站稳啦。');
});

test('reuse targets the current baseline without discarding the saved question, memory, expectation or old model marker', () => {
  const record = item(1, { model: 'prior-model', testHistory: [{ role: 'user', content: '只听我说。' }, { role: 'assistant', content: '好。' }], testMemories: [{ key: 'test.drawing', content: '喜欢画小猫', kind: 'preference' }] });
  const comparison = calibrationComparison(record);
  assert.equal(comparison.model, 'prior-model');
  assert.equal(comparison.expectedReply, record.expectedReply);
  const experiment = calibrationExperimentPrompt('当前模型的当前人设。', comparison);
  assert.ok(experiment.startsWith('当前模型的当前人设。'));
  assert.ok(experiment.includes(record.guideline));
  assert.ok(experiment.includes(record.expectedReply));
  assert.throws(() => calibrationExperimentPrompt('a'.repeat(6000), comparison), /6000/);
  comparison.testMemories[0].content = '副本';
  assert.equal(record.testMemories[0].content, '喜欢画小猫');
});

test('versioned import preserves complete review provenance and both generated replies, including observation-only cases', () => {
  const old = item(1, { category: '', actualReply: '', expectedReply: '', guideline: '', baselinePrompt: 'A', experimentPrompt: 'B', comparison: { runId: '00000000-0000-4000-8000-000000000099', choice: 'neither', rated: false, baseline: { reply: '旧回复 A', elapsedMs: 800 }, experiment: { error: '等待超时', elapsedMs: 25000 }, displayOrder: ['baseline', 'experiment'] } });
  const previous = { id: old.id, revision: old.revision, status: old.status, createdAt: old.createdAt, updatedAt: old.updatedAt, reviewNote: old.reviewNote, reviewHistory: old.reviewHistory, importedAt: '2026-10-03T02:00:00.000Z' };
  old.importedFrom = previous; old.importHistory = [{ ...previous, importedAt: '2026-10-02T02:00:00.000Z' }];
  const parsed = parseCalibrationImport(JSON.stringify(document([old])));
  assert.deepEqual(parsed.cases[0].comparison, old.comparison);
  assert.deepEqual(parsed.cases[0].reviewHistory, old.reviewHistory);
  assert.deepEqual(parsed.cases[0].importedFrom, old.importedFrom);
  assert.deepEqual(parsed.cases[0].importHistory, old.importHistory);
  assert.equal(parsed.cases[0].category, '');
  assert.equal(parsed.cases[0].expectedReply, '');
  assert.throws(() => parseCalibrationImport(JSON.stringify({ schemaVersion: 'future-version', cases: [old] })), /版本/);
  assert.throws(() => parseCalibrationImport(JSON.stringify(document(Array.from({ length: 201 }, (_, index) => item(index + 1))))), /200/);
  assert.throws(() => parseCalibrationImport(' '.repeat(calibrationImportByteLimit + 1)), /2 MiB/);
});

test('large Unicode libraries are split into independently importable byte-bounded parts without dropping metadata', () => {
  const all = Array.from({ length: 100 }, (_, index) => item(index + 1, { model: 'original-text-model', baselinePrompt: '温'.repeat(6000), experimentPrompt: '暖'.repeat(6000), expectedReply: '第一段。\n\n第二段。' }));
  const exported = document(all);
  assert.ok(new TextEncoder().encode(JSON.stringify(exported, null, 2)).byteLength > calibrationImportByteLimit);
  const parts = splitCalibrationExport(exported);
  assert.ok(parts.length > 1);
  assert.deepEqual(parts.flatMap(part => part.cases), all);
  for (const part of parts) {
    const text = JSON.stringify(part, null, 2);
    assert.ok(new TextEncoder().encode(text).byteLength <= calibrationExportPartByteLimit);
    const imported = parseCalibrationImport(text);
    assert.equal(imported.cases.length, part.cases.length);
    assert.equal(part.exportedAt, exported.exportedAt);
    assert.equal(part.samplesVersion, exported.samplesVersion);
    assert.deepEqual(imported.cases[0].reviewHistory, part.cases[0].reviewHistory);
    assert.ok(new TextEncoder().encode(JSON.stringify({ operationId: '00000000-0000-4000-8000-000000000099', document: imported, fictionalConfirmed: true })).byteLength < calibrationImportByteLimit);
  }
});

test('small or empty exports stay one file, and impossible oversized cases fail explicitly instead of silently truncating', () => {
  assert.equal(splitCalibrationExport(document([])).length, 1);
  assert.deepEqual(splitCalibrationExport(document([item(1)])), [document([item(1)])]);
  const byCount = splitCalibrationExport(document([item(1), item(2), item(3)]), calibrationExportPartByteLimit, 2);
  assert.deepEqual(byCount.map(part => part.cases.length), [2, 1]);
  assert.throws(() => splitCalibrationExport(document([item(1)]), 500), /单卷大小/);
});

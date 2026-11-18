import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createPhoneExperienceStore, PHONE_EXPERIENCE_RETENTION_MS, PHONE_EXPERIENCE_ENVIRONMENTS, PHONE_EXPERIENCE_TAGS, PHONE_EXPERIENCE_SCORE_KEYS, PHONE_OBSERVATION_RESULTS, PHONE_OBSERVATION_STAGES, PHONE_OBSERVATION_LANGUAGES, PHONE_OBSERVATION_NETWORKS } from '../apps/server/src/phone-experience.ts';
import { PHONE_EXPERIENCE_ENVIRONMENTS as CLIENT_ENVIRONMENTS, PHONE_EXPERIENCE_TAGS as CLIENT_TAGS, PHONE_EXPERIENCE_SCORE_KEYS as CLIENT_KEYS, PHONE_OBSERVATION_RESULTS as CLIENT_RESULTS, PHONE_OBSERVATION_STAGES as CLIENT_STAGES, PHONE_OBSERVATION_LANGUAGES as CLIENT_LANGUAGES, PHONE_OBSERVATION_NETWORKS as CLIENT_NETWORKS } from '../apps/web/src/lib/phoneExperience.ts';
import { ApiError } from '../apps/server/src/provider-errors.ts';

const DAY = 86_400_000;
function draft(overrides: Record<string, unknown> = {}) {
  return { operationId: randomUUID(), adultFictionalConfirmed: true, phoneUsedConfirmed: true, environment: 'iphone-safari',
    scores: { voiceClarity: 4, voiceFeeling: 3, replyNaturalness: 4, continuity: 0, overall: 4 }, tags: ['voice-flat'], note: '虚构手机体验说明', ...overrides };
}
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE families(id TEXT PRIMARY KEY); CREATE TABLE software_profiles(family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,child_id TEXT NOT NULL,profile_json TEXT NOT NULL,PRIMARY KEY(family_id,child_id));');
  const family = randomUUID(), otherFamily = randomUUID(), child = randomUUID(), sibling = randomUUID();
  for (const id of [family, otherFamily]) db.prepare('INSERT INTO families VALUES(?)').run(id);
  for (const [f, c] of [[family, child], [family, sibling], [otherFamily, child]]) db.prepare('INSERT INTO software_profiles VALUES(?,?,?)').run(f!, c!, '{}');
  let now = Date.parse('2026-10-02T15:59:50Z');
  const store = createPhoneExperienceStore(db, () => now);
  return { db, store, family, otherFamily, child, sibling, advance(ms: number) { now += ms; }, at(value: number) { now = value; } };
}
const error = (status: number, code: string) => (value: unknown) => value instanceof ApiError && value.status === status && value.code === code;
const observation = () => ({ result: 'problem', stages: ['recognition', 'understanding'], language: 'hakka', intendedMeaning: '  明天去画画。  ', recognizedText: '今天去画画。', deviceModel: '安卓测试手机', network: 'mobile' });

test('phone experience wire enums and score keys remain compatible between client and store', () => {
  assert.deepEqual(PHONE_EXPERIENCE_ENVIRONMENTS, CLIENT_ENVIRONMENTS); assert.deepEqual(PHONE_EXPERIENCE_TAGS, CLIENT_TAGS); assert.deepEqual(PHONE_EXPERIENCE_SCORE_KEYS, CLIENT_KEYS);
  assert.deepEqual(PHONE_OBSERVATION_RESULTS, CLIENT_RESULTS); assert.deepEqual(PHONE_OBSERVATION_STAGES, CLIENT_STAGES);
  assert.deepEqual(PHONE_OBSERVATION_LANGUAGES, CLIENT_LANGUAGES); assert.deepEqual(PHONE_OBSERVATION_NETWORKS, CLIENT_NETWORKS);
});
test('empty phone snapshot has server Beijing date, no invented progress or private data', () => {
  const f = fixture(); try {
    assert.deepEqual(f.store.snapshot(f.family, f.child), { startedAt: null, today: '2026-10-02', records: [], completedDays: 0 });
    f.advance(10_000); assert.equal(f.store.snapshot(f.family, f.child).today, '2026-10-03');
    assert.equal(f.store.snapshot(f.family, f.child).completedDays, 0);
  } finally { f.db.close(); }
});
test('phone submission persists only explicit scores/environment/note and partial unexperienced scores remain zero', () => {
  const f = fixture(); try {
    const input = draft(), state = f.store.submit(f.family, f.child, input); assert.equal(state.completedDays, 1);
    assert.equal(state.startedAt, '2026-10-02T15:59:50.000Z'); assert.equal(state.records[0]!.day, '2026-10-02');
    assert.equal(state.records[0]!.scores.continuity, 0); assert.equal(state.records[0]!.parentUsedPhoneConfirmed, true);
    assert.deepEqual(Object.keys(state.records[0]!).sort(), ['createdAt', 'day', 'environment', 'id', 'note', 'parentUsedPhoneConfirmed', 'scores', 'tags']);
    const publicText = JSON.stringify(state); assert.equal(publicText.includes(input.operationId), false); assert.equal(publicText.includes('payload_hash'), false);
    assert.equal(publicText.includes('accepted'), false); assert.equal(publicText.includes('passed'), false);
  } finally { f.db.close(); }
});
test('phone idempotent retry preserves one row and original time across days; changed payload conflicts', () => {
  const f = fixture(); try {
    const input = draft({ tags: ['voice-flat', 'too-formal'] }); const initial = f.store.submit(f.family, f.child, input);
    assert.deepEqual(f.store.submit(f.family, f.child, { ...input, tags: ['too-formal', 'voice-flat'] }), initial);
    f.advance(DAY); const replay = f.store.submit(f.family, f.child, input);
    assert.equal(replay.today, '2026-10-03'); assert.equal(replay.records[0]!.createdAt, initial.records[0]!.createdAt); assert.equal(replay.completedDays, 1);
    assert.throws(() => f.store.submit(f.family, f.child, { ...input, note: '不同的内容' }), error(409, 'OPERATION_CONFLICT'));
    assert.equal(Number(f.db.prepare('SELECT count(*) AS n FROM phone_experience_records').get()!.n), 1);
  } finally { f.db.close(); }
});
test('new operation cannot submit twice on one day and forbidden day fields cannot backfill or advance progress', () => {
  const f = fixture(); try {
    f.store.submit(f.family, f.child, draft());
    assert.throws(() => f.store.submit(f.family, f.child, draft()), error(409, 'PHONE_EXPERIENCE_DAY_RECORDED'));
    for (const day of ['2026-10-01', '2026-10-03']) assert.throws(() => f.store.submit(f.family, f.child, draft({ day })), error(400, 'PHONE_EXPERIENCE_INVALID'));
    assert.throws(() => f.store.submit(f.family, f.child, draft({ createdAt: '2026-10-01T00:00:00Z' })), error(400, 'PHONE_EXPERIENCE_INVALID'));
    assert.equal(f.store.snapshot(f.family, f.child).completedDays, 1);
  } finally { f.db.close(); }
});
test('three actual injected calendar dates count submissions but never derive a quality pass', () => {
  const f = fixture(); try {
    for (let i = 0; i < 3; i++) {
      const state = f.store.submit(f.family, f.child, draft()); assert.equal(state.completedDays, i + 1);
      f.advance(DAY);
    }
    const state = f.store.snapshot(f.family, f.child); assert.deepEqual(state.records.map(record => record.day), ['2026-10-04', '2026-10-03', '2026-10-02']);
    assert.equal(state.completedDays, 3); assert.equal('passed' in state, false);
  } finally { f.db.close(); }
});
test('scores must be exact five integers in 0..5 and at least one actual experience is required', () => {
  const f = fixture(); try {
    const bad: unknown[] = [
      { voiceClarity: 0, voiceFeeling: 0, replyNaturalness: 0, continuity: 0, overall: 0 },
      { voiceClarity: -1, voiceFeeling: 1, replyNaturalness: 1, continuity: 1, overall: 1 },
      { voiceClarity: 6, voiceFeeling: 1, replyNaturalness: 1, continuity: 1, overall: 1 },
      { voiceClarity: 1.5, voiceFeeling: 1, replyNaturalness: 1, continuity: 1, overall: 1 },
      { voiceClarity: '4', voiceFeeling: 1, replyNaturalness: 1, continuity: 1, overall: 1 },
      { voiceClarity: 1, voiceFeeling: 1, replyNaturalness: 1, overall: 1 },
      { voiceClarity: 1, voiceFeeling: 1, replyNaturalness: 1, continuity: 1, overall: 1, mood: 5 },
    ];
    for (const scores of bad) assert.throws(() => f.store.submit(f.family, f.child, draft({ scores })), error(400, 'PHONE_EXPERIENCE_INVALID'));
    assert.equal(f.store.snapshot(f.family, f.child).completedDays, 0);
    const state = f.store.submit(f.family, f.child, draft({ scores: { voiceClarity: 0, voiceFeeling: 0, replyNaturalness: 1, continuity: 0, overall: 0 } }));
    assert.equal(state.records[0]!.scores.replyNaturalness, 1); assert.equal(state.records[0]!.scores.voiceClarity, 0);
  } finally { f.db.close(); }
});
test('phone two confirmations, UUID operation, environment, tags, note and unknown keys validate before writing', () => {
  const f = fixture(); try {
    for (const overrides of [
      { adultFictionalConfirmed: false }, { phoneUsedConfirmed: false }, { adultFictionalConfirmed: undefined },
      { operationId: 'not-a-uuid' }, { environment: 'desktop-chrome' }, { tags: ['natural', 'natural'] },
      { tags: ['unknown'] }, { tags: PHONE_EXPERIENCE_TAGS.slice(0, 6) }, { note: '字'.repeat(501) },
      { note: '一条\n说明' }, { note: '控制\u0000内容' }, { note: '删除\u007f符' }, { transcript: '不允许上传的整段聊天' },
      { audio: 'not-accepted' }, { userAgent: 'not-accepted' },
    ]) assert.throws(() => f.store.submit(f.family, f.child, draft(overrides)), error(400, 'PHONE_EXPERIENCE_INVALID'));
    assert.equal(Number(f.db.prepare('SELECT count(*) AS n FROM phone_experience_records').get()!.n), 0);
    assert.equal(f.store.submit(f.family, f.child, draft({ note: '  ' + '字'.repeat(498) })).records[0]!.note.length, 498);
  } finally { f.db.close(); }
});
test('phone snapshot, same operation and daily progress isolate family and selected child', () => {
  const f = fixture(); try {
    const input = draft(); const first = f.store.submit(f.family, f.child, input);
    assert.equal(f.store.snapshot(f.family, f.sibling).completedDays, 0); assert.equal(f.store.snapshot(f.otherFamily, f.child).completedDays, 0);
    const sibling = f.store.submit(f.family, f.sibling, { ...input, note: '另一份虚构资料' });
    const other = f.store.submit(f.otherFamily, f.child, { ...input, note: '另一个虚构家庭' });
    assert.notEqual(first.records[0]!.id, sibling.records[0]!.id); assert.notEqual(first.records[0]!.id, other.records[0]!.id);
    assert.equal(f.store.snapshot(f.family, f.child).records[0]!.note, input.note);
    assert.throws(() => f.store.snapshot(f.family, randomUUID()), error(404, 'PHONE_EXPERIENCE_SCOPE'));
    assert.throws(() => f.store.submit(f.family, randomUUID(), draft()), error(404, 'PHONE_EXPERIENCE_SCOPE'));
  } finally { f.db.close(); }
});
test('phone remove only permits matching family+child and deletion allows a fresh record for today', () => {
  const f = fixture(); try {
    const state = f.store.submit(f.family, f.child, draft()); const id = state.records[0]!.id;
    assert.throws(() => f.store.remove(f.family, f.sibling, id), error(404, 'PHONE_EXPERIENCE_NOT_FOUND'));
    assert.throws(() => f.store.remove(f.otherFamily, f.child, id), error(404, 'PHONE_EXPERIENCE_NOT_FOUND'));
    assert.throws(() => f.store.remove(f.family, f.child, 'broken'), error(400, 'PHONE_EXPERIENCE_INVALID'));
    assert.equal(f.store.snapshot(f.family, f.child).records.length, 1);
    const removed = f.store.remove(f.family, f.child, id); assert.equal(removed.records.length, 0); assert.equal(removed.completedDays, 0); assert.equal(removed.startedAt, null);
    assert.throws(() => f.store.remove(f.family, f.child, id), error(404, 'PHONE_EXPERIENCE_NOT_FOUND'));
    assert.equal(f.store.submit(f.family, f.child, draft()).completedDays, 1);
  } finally { f.db.close(); }
});
test('phone export includes own children and zero scores but no operation/hash or another family', () => {
  const f = fixture(); try {
    const operation = draft(); f.store.submit(f.family, f.child, operation); f.store.submit(f.family, f.sibling, draft({ note: '兄弟虚构记录' })); f.store.submit(f.otherFamily, f.child, draft({ note: '外部虚构记录' }));
    const exported = f.store.exportFamily(f.family); assert.equal(exported.length, 2); assert.deepEqual(new Set(exported.map(row => row.childId)), new Set([f.child, f.sibling]));
    const text = JSON.stringify(exported); assert.equal(text.includes(operation.operationId), false); assert.equal(text.includes('hash'), false); assert.equal(text.includes('外部虚构记录'), false);
    assert.ok(exported.every(row => row.scores.continuity === 0));
  } finally { f.db.close(); }
});
test('phone 30-day retention expires at exact boundary and sweep removes stored content and operation hashes', () => {
  const f = fixture(); try {
    f.store.submit(f.family, f.child, draft()); f.advance(PHONE_EXPERIENCE_RETENTION_MS - 1);
    assert.equal(f.store.snapshot(f.family, f.child).records.length, 1); f.advance(1); f.store.sweep();
    assert.equal(f.store.snapshot(f.family, f.child).records.length, 0); assert.equal(f.store.exportFamily(f.family).length, 0);
    assert.equal(Number(f.db.prepare('SELECT count(*) AS n FROM phone_experience_records').get()!.n), 0);
  } finally { f.db.close(); }
});
test('phone max 30 records rejects extra active dates without changing earlier rows', () => {
  const f = fixture(); try {
    const start = Date.parse('2026-10-01T23:59:59+08:00'); f.at(start); f.store.submit(f.family, f.child, draft());
    f.advance(1_000); f.store.submit(f.family, f.child, draft());
    for (let i = 2; i < 30; i++) { f.advance(DAY); f.store.submit(f.family, f.child, draft()); }
    assert.equal(f.store.snapshot(f.family, f.child).records.length, 30); f.advance(DAY);
    assert.throws(() => f.store.submit(f.family, f.child, draft()), error(429, 'PHONE_EXPERIENCE_LIMIT'));
    assert.equal(f.store.snapshot(f.family, f.child).completedDays, 30);
  } finally { f.db.close(); }
});
test('phone composite profile foreign key deletes one child records and family withdrawal cascades remaining own records', () => {
  const f = fixture(); try {
    f.store.submit(f.family, f.child, draft()); f.store.submit(f.family, f.sibling, draft()); f.store.submit(f.otherFamily, f.child, draft());
    f.db.prepare('DELETE FROM software_profiles WHERE family_id=? AND child_id=?').run(f.family, f.child);
    assert.equal(f.store.exportFamily(f.family).length, 1); assert.equal(f.store.exportFamily(f.family)[0]!.childId, f.sibling);
    f.db.prepare('DELETE FROM families WHERE id=?').run(f.family);
    assert.equal(f.store.exportFamily(f.family).length, 0); assert.equal(f.store.exportFamily(f.otherFamily).length, 1);
  } finally { f.db.close(); }
});
test('phone store creates only one new table, preserves old profile rows, and persisted records survive recreation', () => {
  const f = fixture(); try {
    const before = JSON.stringify(f.db.prepare('SELECT * FROM software_profiles ORDER BY family_id,child_id').all());
    const saved = f.store.submit(f.family, f.child, draft()); const recreated = createPhoneExperienceStore(f.db, () => Date.parse('2026-10-02T15:59:50Z'));
    assert.deepEqual(recreated.snapshot(f.family, f.child), saved); assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM software_profiles ORDER BY family_id,child_id').all()), before);
    assert.deepEqual(f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name), ['families', 'phone_experience_records', 'software_profiles']);
    assert.equal(f.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally { f.db.close(); }
});

test('unscored dialect observations survive retries, exports and recreation without rewriting legacy rows', () => {
  const f = fixture(); try {
    const legacy = draft(); f.store.submit(f.family, f.child, legacy);
    const before = f.db.prepare('SELECT payload,payload_hash FROM phone_experience_records').get(); f.advance(DAY);
    const input = draft({ scores: { voiceClarity: 0, voiceFeeling: 0, replyNaturalness: 0, continuity: 0, overall: 0 }, tags: [], observation: observation() });
    const result = f.store.submit(f.family, f.child, input);
    const saved = result.records[0]!; assert.equal(saved.observation!.language, 'hakka'); assert.equal(saved.observation!.intendedMeaning, '明天去画画。');
    assert.equal(saved.scores.overall, 0); assert.equal(result.completedDays, 2);
    assert.deepEqual(f.store.submit(f.family, f.child, { ...input, observation: { ...observation(), stages: ['understanding', 'recognition'] } }), result);
    assert.throws(() => f.store.submit(f.family, f.child, { ...input, observation: { ...observation(), language: 'chaoshan' } }), error(409, 'OPERATION_CONFLICT'));
    assert.deepEqual(f.db.prepare('SELECT payload,payload_hash FROM phone_experience_records WHERE operation_id=?').get(legacy.operationId), before);
    const recreated = createPhoneExperienceStore(f.db, () => Date.parse(saved.createdAt)); assert.deepEqual(recreated.snapshot(f.family, f.child), result);
    assert.deepEqual(f.store.exportFamily(f.family)[0]!.observation, saved.observation);
    assert.equal(f.store.snapshot(f.family, f.sibling).records.length, 0);
    f.store.remove(f.family, f.child, saved.id); assert.equal(f.store.exportFamily(f.family).length, 1);
  } finally { f.db.close(); }
});

test('dialect observations reject unknown nested data, invented result, oversized or control-character fields', () => {
  const f = fixture(); try {
    for (const overrides of [
      { result: 'passed' }, { result: 'problem', stages: [] }, { result: 'smooth', stages: ['reply'] },
      { stages: ['recognition', 'recognition'] }, { stages: ['recording', 'recognition', 'understanding', 'reply', 'voice'] }, { stages: ['unbounded'] },
      { language: 'custom' }, { network: 'ethernet' }, { intendedMeaning: '字'.repeat(201) }, { recognizedText: '字'.repeat(201) },
      { deviceModel: '字'.repeat(61) }, { intendedMeaning: '一行\n两行' }, { recognizedText: '隐藏\u0000文本' }, { deviceModel: '隐藏\u007f' },
      { transcript: '整段聊天不可附带' }, { audio: '不可附带原音' }, { userAgent: '不可附带手机标识' },
    ]) assert.throws(() => f.store.submit(f.family, f.child, draft({ observation: { ...observation(), ...overrides } })), error(400, 'PHONE_EXPERIENCE_INVALID'));
    assert.equal(f.store.snapshot(f.family, f.child).records.length, 0);
    assert.doesNotThrow(() => f.store.submit(f.family, f.child, draft({ observation: { ...observation(), result: 'uncertain', stages: [], language: 'mixed', intendedMeaning: '', recognizedText: '', deviceModel: '', network: 'uncertain' } })));
  } finally { f.db.close(); }
});

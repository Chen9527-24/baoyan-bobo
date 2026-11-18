import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createContentStore, ContentStoreError, type StoryDraft } from '../apps/server/src/content-store.js';
import { ORIGINAL_STORIES } from '../apps/server/src/content-catalog.js';
import { createContentEngine } from '../apps/server/src/content-engine.js';

const review = { reviewer: 'content-editor', note: '独立检查适龄结构与来源说明' };
const context = { ageGroup: '6-8' as const, remainingSeconds: 600 };
function storyDraft(id = 'paper-boat-test'): StoryDraft {
  const original = ORIGINAL_STORIES.find(story => story.id === id)!;
  return { id: original.id, title: original.title, ageGroup: original.ageGroup, theme: original.theme, durationSeconds: original.durationSeconds, source: { kind: 'original', description: '测试原创内容' }, segments: [...original.segments], ...(original.choices ? { choices: original.choices.map(choice => ({ ...choice })) } : {}) };
}
function setup() { const db = new DatabaseSync(':memory:'); const store = createContentStore(db, { now: () => 1000 }); return { db, store }; }
const code = (expected: string) => (error: unknown) => error instanceof ContentStoreError && error.code === expected;

test('initial seed is twenty original stories with internal check provenance and four fixed topics', () => {
  const { db, store } = setup();
  try {
    assert.equal(store.publishedStories().length, 20);
    assert.equal(store.enabledLearningTopics().length, 4);
    assert.equal(store.snapshot().revision, 1);
    assert.ok(store.snapshot().stories.every(story => story.review.method === 'internal-rules' && story.review.note.includes('未代替真人')));
    assert.ok(store.snapshot().stories.every(story => story.source.kind === 'original'));
  } finally { db.close(); }
});

test('saving a draft leaves published story unchanged and cannot publish without separate review', () => {
  const { db, store } = setup();
  try {
    const draft = storyDraft(); draft.title = '纸船重新出发';
    const saved = store.saveDraft(draft, review);
    assert.equal(saved.version, 2);
    assert.equal(store.publishedStories().find(story => story.id === draft.id)?.title, '纸船的第二次出发');
    assert.throws(() => store.publish(draft.id, { ...review, expectedRevision: 1, expectedDraftVersion: 2 }), code('REVIEW_REQUIRED'));
    assert.equal(store.snapshot().revision, 1);
  } finally { db.close(); }
});

test('independent review permits atomic publish and records full audit provenance', () => {
  const { db, store } = setup();
  try {
    const draft = storyDraft(); draft.title = '纸船重新出发';
    store.saveDraft(draft, review); store.review(draft.id, { ...review, expectedDraftVersion: 2 });
    const published = store.publish(draft.id, { ...review, expectedRevision: 1, expectedDraftVersion: 2 });
    assert.equal(published.revision, 2);
    assert.equal(store.publishedStories().find(story => story.id === draft.id)?.revision, 2);
    assert.equal(store.publishedStories().find(story => story.id === draft.id)?.title, draft.title);
    assert.equal(store.snapshot().stories.find(story => story.id === draft.id)?.review.method, 'operator');
    assert.deepEqual(store.audit().map(row => row.operation), ['publish', 'review', 'draft', 'seed']);
  } finally { db.close(); }
});

test('editing a reviewed draft revokes prior review and stale version cannot publish', () => {
  const { db, store } = setup();
  try {
    const draft = storyDraft(); store.saveDraft(draft, review); store.review(draft.id, { ...review, expectedDraftVersion: 2 });
    draft.title = '新的纸船标题'; store.saveDraft(draft, review);
    assert.equal(store.draft(draft.id)?.reviewed, false);
    assert.throws(() => store.publish(draft.id, { ...review, expectedRevision: 1, expectedDraftVersion: 2 }), code('DRAFT_CONFLICT'));
    assert.throws(() => store.publish(draft.id, { ...review, expectedRevision: 1, expectedDraftVersion: 3 }), code('REVIEW_REQUIRED'));
  } finally { db.close(); }
});

test('concurrent catalog revision changes require re-preview rather than overwriting', () => {
  const { db, store } = setup();
  try {
    const draft = storyDraft(); store.saveDraft(draft, review); store.review(draft.id, { ...review, expectedDraftVersion: 2 });
    store.disable('quiet-seat', { ...review, expectedRevision: 1 });
    assert.throws(() => store.publish(draft.id, { ...review, expectedRevision: 1, expectedDraftVersion: 2 }), code('REVISION_CONFLICT'));
    assert.equal(store.snapshot().revision, 2);
    assert.equal(store.publishedStories().find(story => story.id === draft.id)?.revision, 1);
  } finally { db.close(); }
});

test('content validation rejects executable markup secrets identifying data and explicit harmful text', () => {
  const { db, store } = setup();
  try {
    for (const suffix of ['<script>alert(1)</script>', 'https://bad.invalid/action', 'javascript:alert(1)', 'sk-1234567890abcdefgh', '手机13812345678', '身份证123456789012345678', '邮箱someone@example.com', '请不要告诉妈妈这件事', '制作炸弹']) {
      const draft = storyDraft(); draft.segments[0] += suffix;
      assert.throws(() => store.saveDraft(draft, review), code('INVALID_CONTENT'), suffix);
    }
    assert.equal(store.snapshot().revision, 1);
    assert.equal(store.draft('paper-boat-test'), undefined);
  } finally { db.close(); }
});

test('strict schema rejects unknown code fields invalid age duration segments and duplicate branches', () => {
  const { db, store } = setup();
  try {
    const draft = storyDraft();
    for (const candidate of [{ ...draft, script: 'eval(1)' }, { ...draft, ageGroup: 'all' }, { ...draft, durationSeconds: 9999 }, { ...draft, segments: ['one'] }, { ...draft, source: { kind: 'licensed', description: '外部来源' } }, { ...draft, choices: [{ id: 'one', label: '第一种', ending: draft.segments[2] }, { id: 'one', label: '第二种', ending: draft.segments[2] }] }]) assert.throws(() => store.validate(candidate), code('INVALID_CONTENT'));
    assert.equal(store.validate({ ...draft, source: { kind: 'licensed', description: '授权来源说明', license: '运营负责人已核对书面授权范围' } }).source.kind, 'licensed');
  } finally { db.close(); }
});

test('publish re-validates database draft instead of trusting reviewed flag alone', () => {
  const { db, store } = setup();
  try {
    const draft = storyDraft(); store.saveDraft(draft, review); store.review(draft.id, { ...review, expectedDraftVersion: 2 });
    draft.segments[0] += '<script>unsafe</script>';
    db.prepare('UPDATE content_story_drafts SET story_json=? WHERE id=?').run(JSON.stringify(draft), draft.id);
    assert.throws(() => store.publish(draft.id, { ...review, expectedRevision: 1, expectedDraftVersion: 2 }), code('INVALID_CONTENT'));
    assert.equal(store.snapshot().revision, 1);
  } finally { db.close(); }
});

test('even structurally valid post-review edits are rejected by reviewed content digest', () => {
  const { db, store } = setup();
  try {
    const draft = storyDraft(); store.saveDraft(draft, review); store.review(draft.id, { ...review, expectedDraftVersion: 2 });
    draft.title = '未审核的新标题'; db.prepare('UPDATE content_story_drafts SET story_json=? WHERE id=?').run(JSON.stringify(draft), draft.id);
    assert.throws(() => store.publish(draft.id, { ...review, expectedRevision: 1, expectedDraftVersion: 2 }), code('REVIEW_REQUIRED'));
    assert.equal(store.snapshot().revision, 1);
  } finally { db.close(); }
});

test('draft-only story does not appear in child catalog before review and publish', () => {
  const { db, store } = setup();
  try {
    const draft = { ...storyDraft(), id: 'unpublished-new-story', title: '新故事的草稿' }; store.saveDraft(draft, review);
    const engine = createContentEngine({ catalogProvider: store.publishedStories, learningTopicsProvider: store.enabledLearningTopics });
    assert.equal(engine.catalog('6-8').stories.length, 5);
    assert.match(engine.handle({ callId: 'a', ...context, text: `讲故事：${draft.id}` })!.reply, /已发布目录/);
    assert.equal(store.list().stories.find(story => story.id === draft.id)?.publication, 'draft');
  } finally { db.close(); }
});

test('disable removes story from catalog and blocks active next repeat and resume', () => {
  const { db, store } = setup();
  try {
    const engine = createContentEngine({ catalogProvider: store.publishedStories });
    for (const id of ['a', 'b', 'c']) engine.handle({ callId: id, ...context, text: '讲故事：paper-boat-test' });
    store.disable('paper-boat-test', { ...review, expectedRevision: 1 });
    assert.equal(engine.catalog('6-8').stories.length, 4);
    for (const [callId, action] of [['a', 'next'], ['b', 'repeat'], ['c', 'resume']] as const) {
      const response = engine.control(callId, action, context);
      assert.match(response.reply, /更新或下架/);
      assert.doesNotMatch(response.reply, /浅水盆/);
      assert.equal(engine.state(callId).story?.status, 'stopped');
    }
  } finally { db.close(); }
});

test('publishing a changed version stops old in-progress story until fresh selection', () => {
  const { db, store } = setup();
  try {
    const engine = createContentEngine({ catalogProvider: store.publishedStories });
    engine.handle({ callId: 'a', ...context, text: '讲故事：paper-boat-test' });
    const draft = storyDraft(); draft.title = '纸船的新版本'; store.saveDraft(draft, review); store.review(draft.id, { ...review, expectedDraftVersion: 2 }); store.publish(draft.id, { ...review, expectedRevision: 1, expectedDraftVersion: 2 });
    assert.match(engine.control('a', 'next', context).reply, /更新或下架/);
    assert.match(engine.handle({ callId: 'a', ...context, text: '讲故事：paper-boat-test' })!.reply, /纸船的新版本/);
  } finally { db.close(); }
});

test('unrelated publication does not stop an unchanged in-progress story', () => {
  const { db, store } = setup();
  try {
    const engine = createContentEngine({ catalogProvider: store.publishedStories });
    engine.handle({ callId: 'a', ...context, text: '讲故事：paper-boat-test' });
    store.disable('quiet-seat', { ...review, expectedRevision: 1 });
    assert.match(engine.control('a', 'next', context).reply, /第二只船/);
  } finally { db.close(); }
});

test('learning can only be toggled among fixed topics and disabled type cannot produce answers', () => {
  const { db, store } = setup();
  try {
    const engine = createContentEngine({ learningTopicsProvider: store.enabledLearningTopics });
    engine.handle({ callId: 'a', ...context, text: '学习：arithmetic' });
    engine.control('a', 'learning:confirm', context);
    store.setLearningEnabled('arithmetic', false, { ...review, expectedRevision: 1 });
    assert.equal(engine.catalog().learningTopics.length, 3);
    assert.match(engine.handle({ callId: 'a', ...context, text: '讲一小步' })!.reply, /已下架/);
    assert.match(engine.handle({ callId: 'b', ...context, text: '3+5' })!.reply, /暂未上架/);
    assert.equal(engine.state('b').learning, undefined);
    assert.throws(() => store.setLearningEnabled('run-javascript', true, { ...review, expectedRevision: 2 }), code('INVALID_TOPIC'));
  } finally { db.close(); }
});

test('rollback creates a new audited revision and restores reviewed stories and fixed learning flags', () => {
  const { db, store } = setup();
  try {
    store.disable('paper-boat-test', { ...review, expectedRevision: 1 });
    store.setLearningEnabled('english', false, { ...review, expectedRevision: 2 });
    const rolled = store.rollback(1, { ...review, expectedRevision: 3 });
    assert.equal(rolled.revision, 4);
    assert.equal(store.publishedStories().length, 20);
    assert.equal(store.enabledLearningTopics().length, 4);
    assert.equal(store.history().length, 4);
    assert.equal(store.audit()[0]?.operation, 'rollback');
    assert.throws(() => store.rollback(99, { ...review, expectedRevision: 4 }), code('REVISION_NOT_FOUND'));
    assert.equal(store.snapshot().revision, 4);
  } finally { db.close(); }
});

test('reinitialization preserves published state and readonly listing touches no family tables', () => {
  const directory = mkdtempSync(join(tmpdir(), 'content-store-'));
  try {
    const path = join(directory, 'test.sqlite'); let db = new DatabaseSync(path); let store = createContentStore(db);
    db.exec('CREATE TABLE fake_family_data(id TEXT,secret TEXT)');
    db.prepare('INSERT INTO fake_family_data VALUES(?,?)').run('only', 'must-not-be-read');
    store.disable('paper-boat-test', { ...review, expectedRevision: 1 }); db.close();
    db = new DatabaseSync(path, { readOnly: true }); store = createContentStore(db);
    assert.equal(store.publishedStories().length, 19);
    assert.equal(store.snapshot().revision, 2);
    assert.equal(JSON.stringify(store.list()).includes('must-not-be-read'), false);
    db.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('CLI preview is readonly and requires initialized existing database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'content-cli-'));
  try {
    const path = join(directory, 'test.sqlite'), draftPath = join(directory, 'story.json');
    const db = new DatabaseSync(path), store = createContentStore(db); db.close();
    writeFileSync(draftPath, JSON.stringify(storyDraft()));
    const run = spawnSync(process.execPath, ['--import', 'tsx', 'ops/content-manager.ts', 'preview', '--db', path, '--draft', draftPath], { encoding: 'utf8', cwd: process.cwd() });
    assert.equal(run.status, 0, run.stderr); assert.equal(JSON.parse(run.stdout).reviewed, false);
    const check = new DatabaseSync(path); assert.equal(createContentStore(check).snapshot().revision, 1); assert.equal(check.prepare('SELECT COUNT(*) AS count FROM content_story_drafts').get()?.count, 0); check.close();
    const missing = spawnSync(process.execPath, ['--import', 'tsx', 'ops/content-manager.ts', 'list', '--db', join(directory, 'absent.sqlite')], { encoding: 'utf8', cwd: process.cwd() });
    assert.equal(missing.status, 1); assert.match(missing.stderr, /数据库不存在/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('CLI completes draft review publication disable and rollback without family authorization', () => {
  const directory = mkdtempSync(join(tmpdir(), 'content-cli-write-'));
  try {
    const path = join(directory, 'test.sqlite'), draftPath = join(directory, 'story.json');
    const db = new DatabaseSync(path); createContentStore(db); db.close();
    const draft = storyDraft(); draft.title = '纸船运营发布测试'; writeFileSync(draftPath, JSON.stringify(draft));
    const run = (command: string, args: string[]) => {
      const result = spawnSync(process.execPath, ['--import', 'tsx', 'ops/content-manager.ts', command, '--db', path, ...args], { encoding: 'utf8', cwd: process.cwd() });
      assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
    };
    const flags = ['--reviewer', review.reviewer, '--note', review.note];
    assert.equal(run('draft', ['--draft', draftPath, ...flags]).version, 2);
    assert.equal(run('review', ['--id', draft.id, '--draft-version', '2', ...flags]).reviewed, true);
    assert.equal(run('publish', ['--id', draft.id, '--draft-version', '2', '--expected-revision', '1', ...flags]).revision, 2);
    assert.equal(run('disable', ['--id', draft.id, '--expected-revision', '2', ...flags]).revision, 3);
    assert.equal(run('rollback', ['--target-revision', '1', '--expected-revision', '3', ...flags]).revision, 4);
    assert.equal(run('learning', ['--id', 'english', '--enabled', 'false', '--expected-revision', '4', ...flags]).revision, 5);
    const list = run('list', []);
    assert.equal(list.stories.find((story: { id: string }) => story.id === draft.id).publication, 'published');
    assert.equal(list.learning.find((topic: { id: string }) => topic.id === 'english').enabled, false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

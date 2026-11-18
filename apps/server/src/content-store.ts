import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ORIGINAL_STORIES, type StoryDefinition } from './content-catalog.js';
import { LEARNING_TOPICS, type LearningTopic } from './learning-engine.js';

const safeText = z.string().trim().min(1).max(700).refine(value => !/[\u0000-\u001f\u007f<>]|https?:\/\/|javascript:|data:|\bsk-[a-z0-9]{10,}/i.test(value), '文本不能含控制字符、HTML、外部链接或密钥格式')
  .refine(value => !/(?:自杀|自残|色情|裸照|性行为|赌博|吸毒|制作炸弹|杀死|虐待|割腕|独自去见陌生人|不要告诉(?:家长|爸爸|妈妈)|保证治愈|替你保密)/.test(value), '内容未通过基础适龄安全检查')
  .refine(value => !/(?:\b1[3-9]\d{9}\b|\b\d{15,19}\b|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i.test(value), '内容不能含联系方式或个人身份数据');
const choiceSchema = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/), label: safeText.pipe(z.string().max(40)), ending: safeText.pipe(z.string().min(35)) }).strict();
export const storyDraftSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{2,79}$/), title: safeText.pipe(z.string().max(60)),
  ageGroup: z.enum(['3-5', '6-8', '9-12', '13-14']), theme: z.enum(['友谊', '勇气', '情绪', '好奇', '责任', '关怀', '睡前']),
  durationSeconds: z.number().int().min(30).max(600),
  source: z.object({ kind: z.enum(['original', 'licensed']), description: safeText.pipe(z.string().max(200)), license: safeText.pipe(z.string().max(240)).optional() }).strict()
    .refine(source => source.kind !== 'licensed' || !!source.license, '授权内容必须提供授权说明'),
  segments: z.tuple([safeText.pipe(z.string().min(35)), safeText.pipe(z.string().min(35)), safeText.pipe(z.string().min(35))]),
  choices: z.array(choiceSchema).min(2).max(3).optional(),
}).strict().refine(story => !story.choices || new Set(story.choices.map(choice => choice.id)).size === story.choices.length, '分支ID不可重复')
  .refine(story => !story.choices || new Set(story.choices.map(choice => choice.label)).size === story.choices.length, '分支标签不可重复');
export type StoryDraft = z.infer<typeof storyDraftSchema>;
export type ReviewSettings = { reviewer: string; note: string };
export type ReleaseSettings = ReviewSettings & { expectedRevision: number };
type StoredStory = StoryDraft & { publication: 'published' | 'disabled'; version: number; review: { reviewer: string; note: string; method: 'operator' | 'internal-rules'; reviewedAt: number } };
type CatalogSnapshot = { revision: number; stories: StoredStory[]; learning: { id: LearningTopic; enabled: boolean }[] };
type DraftRow = { id: string; version: number; story_json: string; reviewed_version: number | null; reviewer: string | null; review_note: string | null; reviewed_at: number | null; reviewed_digest: string | null };
export class ContentStoreError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'ContentStoreError'; }
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const settingsSchema = z.object({ reviewer: z.string().trim().min(2).max(60), note: z.string().trim().min(3).max(240) }).refine(value => !/[\u0000-\u001f\u007f]|\bsk-[a-z0-9]{10,}/i.test(value.reviewer + value.note), '审核信息无效');
function settings(input: ReviewSettings) { const parsed = settingsSchema.safeParse(input); if (!parsed.success) throw new ContentStoreError('INVALID_REVIEW', '请提供有效的审核人标识和操作说明。'); return parsed.data; }
function validate(input: unknown): StoryDraft {
  const result = storyDraftSchema.safeParse(input);
  if (!result.success) throw new ContentStoreError('INVALID_CONTENT', `故事校验失败：${result.error.issues.map(issue => `${issue.path.join('.')}:${issue.message}`).join('；')}`);
  return result.data;
}

export function createContentStore(db: DatabaseSync, { now = Date.now }: { now?: () => number } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS content_catalog_releases(revision INTEGER PRIMARY KEY,created_at INTEGER NOT NULL,reviewer TEXT NOT NULL,note TEXT NOT NULL,operation TEXT NOT NULL,items_json TEXT NOT NULL,learning_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS content_catalog_head(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL REFERENCES content_catalog_releases(revision));
    CREATE TABLE IF NOT EXISTS content_story_drafts(id TEXT PRIMARY KEY,version INTEGER NOT NULL,story_json TEXT NOT NULL,reviewed_version INTEGER,reviewer TEXT,review_note TEXT,reviewed_at INTEGER,reviewed_digest TEXT);
    CREATE TABLE IF NOT EXISTS content_catalog_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,created_at INTEGER NOT NULL,operation TEXT NOT NULL,content_id TEXT,revision INTEGER NOT NULL,reviewer TEXT NOT NULL,note TEXT NOT NULL,details_json TEXT NOT NULL);`);
  const initial = db.prepare('SELECT revision FROM content_catalog_head WHERE singleton=1').get();
  if (!initial) {
    const stories: StoredStory[] = ORIGINAL_STORIES.map(story => ({ ...validate({ id: story.id, title: story.title, ageGroup: story.ageGroup, theme: story.theme, durationSeconds: story.durationSeconds, segments: story.segments, ...(story.choices ? { choices: story.choices } : {}), source: { kind: 'original', description: '项目原创初始内容' } }), publication: 'published', version: 1, review: { reviewer: 'internal-rules', note: '初始原创内容通过结构与基础安全规则；未代替真人适龄审核', method: 'internal-rules', reviewedAt: now() } }));
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO content_catalog_releases VALUES(?,?,?,?,?,?,?)').run(1, now(), 'internal-rules', '初始化原创故事及固定学习白名单', 'seed', JSON.stringify(stories), JSON.stringify(LEARNING_TOPICS.map(topic => ({ id: topic.id, enabled: true }))));
      db.prepare('INSERT INTO content_catalog_head VALUES(1,1)').run();
      db.prepare('INSERT INTO content_catalog_audit(created_at,operation,content_id,revision,reviewer,note,details_json) VALUES(?,?,?,?,?,?,?)').run(now(), 'seed', null, 1, 'internal-rules', '基础内部检查，非真人审核', JSON.stringify({ storyCount: stories.length, learningCount: LEARNING_TOPICS.length }));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  const snapshot = (): CatalogSnapshot => {
    const row = db.prepare('SELECT r.revision,r.items_json,r.learning_json FROM content_catalog_releases r JOIN content_catalog_head h ON h.revision=r.revision WHERE h.singleton=1').get() as { revision: number; items_json: string; learning_json: string };
    return { revision: row.revision, stories: JSON.parse(row.items_json), learning: JSON.parse(row.learning_json) };
  };
  const audit = (operation: string, contentId: string | null, revision: number, review: ReviewSettings, details: unknown) => db.prepare('INSERT INTO content_catalog_audit(created_at,operation,content_id,revision,reviewer,note,details_json) VALUES(?,?,?,?,?,?,?)').run(now(), operation, contentId, revision, review.reviewer, review.note, JSON.stringify(details));
  function transaction<T>(action: () => T): T { db.exec('BEGIN IMMEDIATE'); try { const value = action(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } }
  const draftRow = (id: string) => db.prepare('SELECT * FROM content_story_drafts WHERE id=?').get(id) as DraftRow | undefined;
  function expected(current: CatalogSnapshot, revision: number) { if (current.revision !== revision) throw new ContentStoreError('REVISION_CONFLICT', '目录版本变化，请重新预览后再提交。'); }
  function release(current: CatalogSnapshot, operation: string, review: ReviewSettings, contentId: string | null, details: unknown): CatalogSnapshot {
    const revision = current.revision + 1;
    db.prepare('INSERT INTO content_catalog_releases VALUES(?,?,?,?,?,?,?)').run(revision, now(), review.reviewer, review.note, operation, JSON.stringify(current.stories), JSON.stringify(current.learning));
    db.prepare('UPDATE content_catalog_head SET revision=? WHERE singleton=1').run(revision);
    audit(operation, contentId, revision, review, details);
    return { ...copy(current), revision };
  }
  return {
    snapshot,
    validate,
    publishedStories: (): StoryDefinition[] => snapshot().stories.filter(story => story.publication === 'published').map(story => ({ id: story.id, title: story.title, ageGroup: story.ageGroup, theme: story.theme, durationSeconds: story.durationSeconds, source: `${story.source.kind === 'original' ? '项目原创' : '授权内容'}：${story.source.description}`, publication: 'published', revision: story.version, segments: story.segments, ...(story.choices ? { choices: story.choices } : {}) })),
    enabledLearningTopics: () => { const enabled = new Set(snapshot().learning.filter(item => item.enabled).map(item => item.id)); return LEARNING_TOPICS.filter(topic => enabled.has(topic.id)).map(topic => ({ ...topic })); },
    list: () => { const current = snapshot(); const drafts = db.prepare('SELECT id,version,reviewed_version FROM content_story_drafts ORDER BY id').all() as { id: string; version: number; reviewed_version: number | null }[]; const ids = new Set([...current.stories.map(story => story.id), ...drafts.map(draft => draft.id)]); return { revision: current.revision, stories: [...ids].map(id => { const story = current.stories.find(item => item.id === id), draft = drafts.find(item => item.id === id); return { id, title: story?.title, publication: story?.publication || 'draft', publishedVersion: story?.version, draftVersion: draft?.version, reviewedDraftVersion: draft?.reviewed_version, source: story?.source, ageGroup: story?.ageGroup }; }), learning: current.learning }; },
    history: () => db.prepare('SELECT revision,created_at,reviewer,note,operation FROM content_catalog_releases ORDER BY revision DESC').all(),
    audit: () => db.prepare('SELECT id,created_at,operation,content_id,revision,reviewer,note,details_json FROM content_catalog_audit ORDER BY id DESC LIMIT 500').all(),
    saveDraft: (input: unknown, inputSettings: ReviewSettings) => {
      const story = validate(input), review = settings(inputSettings);
      return transaction(() => {
        const prior = draftRow(story.id), published = snapshot().stories.find(item => item.id === story.id);
        const version = Math.max(prior?.version || 0, published?.version || 0) + 1;
        db.prepare('INSERT INTO content_story_drafts(id,version,story_json,reviewed_version,reviewer,review_note,reviewed_at,reviewed_digest) VALUES(?,?,?,NULL,NULL,NULL,NULL,NULL) ON CONFLICT(id) DO UPDATE SET version=excluded.version,story_json=excluded.story_json,reviewed_version=NULL,reviewer=NULL,review_note=NULL,reviewed_at=NULL,reviewed_digest=NULL').run(story.id, version, JSON.stringify(story));
        audit('draft', story.id, snapshot().revision, review, { draftVersion: version });
        return { id: story.id, version, publication: 'draft', reviewed: false };
      });
    },
    draft: (id: string) => { const row = draftRow(id); if (!row) return undefined; return { id: row.id, version: row.version, story: JSON.parse(row.story_json) as StoryDraft, reviewed: row.reviewed_version === row.version, reviewer: row.reviewer, note: row.review_note }; },
    review: (id: string, inputSettings: ReviewSettings & { expectedDraftVersion: number }) => {
      const review = settings(inputSettings);
      return transaction(() => {
        const row = draftRow(id); if (!row) throw new ContentStoreError('DRAFT_NOT_FOUND', '故事草稿不存在。');
        if (row.version !== inputSettings.expectedDraftVersion) throw new ContentStoreError('DRAFT_CONFLICT', '草稿已变化，请重新检查。');
        const story = validate(JSON.parse(row.story_json));
        const digest = createHash('sha256').update(JSON.stringify(story)).digest('hex');
        db.prepare('UPDATE content_story_drafts SET reviewed_version=?,reviewer=?,review_note=?,reviewed_at=?,reviewed_digest=? WHERE id=?').run(row.version, review.reviewer, review.note, now(), digest, id);
        audit('review', id, snapshot().revision, review, { draftVersion: row.version, digest });
        return { id, version: row.version, reviewed: true };
      });
    },
    publish: (id: string, inputSettings: ReleaseSettings & { expectedDraftVersion: number }) => {
      const review = settings(inputSettings);
      return transaction(() => {
        const current = snapshot(); expected(current, inputSettings.expectedRevision);
        const row = draftRow(id); if (!row) throw new ContentStoreError('DRAFT_NOT_FOUND', '故事草稿不存在。');
        if (row.version !== inputSettings.expectedDraftVersion) throw new ContentStoreError('DRAFT_CONFLICT', '草稿已变化，请重新审核。');
        if (row.reviewed_version !== row.version || !row.reviewer || !row.review_note || row.reviewed_at === null) throw new ContentStoreError('REVIEW_REQUIRED', '请先独立审核这一草稿版本，再发布。');
        const story = validate(JSON.parse(row.story_json));
        if (row.reviewed_digest !== createHash('sha256').update(JSON.stringify(story)).digest('hex')) throw new ContentStoreError('REVIEW_REQUIRED', '内容在审核后变化，请重新检查这一草稿版本。');
        const item: StoredStory = { ...story, publication: 'published', version: row.version, review: { reviewer: row.reviewer, note: row.review_note, method: 'operator', reviewedAt: row.reviewed_at } };
        current.stories = [...current.stories.filter(prior => prior.id !== id), item];
        return release(current, 'publish', review, id, { draftVersion: row.version });
      });
    },
    disable: (id: string, inputSettings: ReleaseSettings) => {
      const review = settings(inputSettings);
      return transaction(() => { const current = snapshot(); expected(current, inputSettings.expectedRevision); const story = current.stories.find(item => item.id === id); if (!story) throw new ContentStoreError('CONTENT_NOT_FOUND', '已发布故事不存在。'); story.publication = 'disabled'; return release(current, 'disable', review, id, { storyVersion: story.version }); });
    },
    setLearningEnabled: (id: string, enabled: boolean, inputSettings: ReleaseSettings) => {
      const review = settings(inputSettings);
      if (!LEARNING_TOPICS.some(topic => topic.id === id) || typeof enabled !== 'boolean') throw new ContentStoreError('INVALID_TOPIC', '只能开关固定学习白名单。');
      return transaction(() => { const current = snapshot(); expected(current, inputSettings.expectedRevision); const topic = current.learning.find(item => item.id === id)!; topic.enabled = enabled; return release(current, 'learning-toggle', review, id, { enabled }); });
    },
    rollback: (targetRevision: number, inputSettings: ReleaseSettings) => {
      const review = settings(inputSettings);
      return transaction(() => {
        const current = snapshot(); expected(current, inputSettings.expectedRevision);
        const target = db.prepare('SELECT items_json,learning_json FROM content_catalog_releases WHERE revision=?').get(targetRevision) as { items_json: string; learning_json: string } | undefined;
        if (!target) throw new ContentStoreError('REVISION_NOT_FOUND', '目录回滚目标不存在。');
        const stories = JSON.parse(target.items_json) as StoredStory[];
        for (const story of stories) { const { publication: _publication, version: _version, review: _review, ...draft } = story; validate(draft); }
        const topics = JSON.parse(target.learning_json) as CatalogSnapshot['learning'];
        if (topics.some(topic => !LEARNING_TOPICS.some(allowed => allowed.id === topic.id) || typeof topic.enabled !== 'boolean')) throw new ContentStoreError('INVALID_TOPIC', '回滚版本含未知学习类型。');
        current.stories = stories; current.learning = topics;
        return release(current, 'rollback', review, null, { targetRevision });
      });
    },
  };
}

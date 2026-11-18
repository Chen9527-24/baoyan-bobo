import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { Memory } from './types.js';

export type GlobalDraftItem = { key: string; content: string; kind: 'imaginary' | 'plan' };
export type GlobalMemoryDraft = {
  reviewed: true;
  audience: 'all';
  validity: 'until-replaced';
  items: GlobalDraftItem[];
};
export type GlobalMemoryRelease = {
  revision: number;
  action: 'initialize' | 'publish' | 'rollback';
  createdAt: string;
  reviewer: string;
  note: string;
  previousRevision: number | null;
  rollbackOf: number | null;
  audience: 'all';
  validity: 'until-replaced';
  itemCount: number;
  contentHash: string;
};
export type GlobalMemorySnapshot = { revision: number; items: Memory[]; release: GlobalMemoryRelease };
export type GlobalMemoryPreview = {
  baseRevision: number;
  draft: GlobalMemoryDraft;
  changes: {
    added: GlobalDraftItem[];
    removed: GlobalDraftItem[];
    changed: { key: string; before: GlobalDraftItem; after: GlobalDraftItem }[];
  };
};
export type GlobalPublishOptions = { expectedRevision: number; reviewer: string; note: string };
export class GlobalMemoryError extends Error {
  constructor(public readonly code: 'INVALID_DRAFT' | 'REVISION_CONFLICT' | 'REVISION_NOT_FOUND' | 'STORE_CORRUPT', message: string) {
    super(message);
    this.name = 'GlobalMemoryError';
  }
}

const fixture = JSON.parse(readFileSync(new URL('../fixtures/global-memories.json', import.meta.url), 'utf8')) as { revision: number; items: Memory[] };
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const plainText = z.string().trim().min(1).max(120).transform(value => value.normalize('NFKC'));
const itemSchema = z.object({ key: z.string().min(1).max(80), content: plainText, kind: z.enum(['imaginary', 'plan']) }).strict();
const draftSchema = z.object({ reviewed: z.literal(true), audience: z.literal('all'), validity: z.literal('until-replaced'), items: z.array(itemSchema).max(32) }).strict();
const allowedKey = /^(?:world\.home\.name|world\.garden|world\.scene\.[a-z][a-z0-9-]{0,31}|world\.activity\.[a-z][a-z0-9-]{0,31})$/;
const protectedKey = /persona|identity|safety|permission|system|auth|prompt|private|secret|policy|guardian|parent|child|memory/i;
const privateContent = /密码|口令|验证码|身份证|护照|银行卡|手机号|电话号码|联系方式|家庭住址|详细地址|门牌|学校|幼儿园|姓名|生日|我叫|我是|我家|我们家|住在|爸爸|妈妈|爷爷|奶奶|外公|外婆|孩子|\d{6,}|[\w.+-]+@[\w.-]+\.[a-z]{2,}|https?:|www\./i;
const instructions = /[\u0000-\u001f\u007f<>`{}]|\p{Cf}|\p{Cs}|忽略|无视|绕过|覆盖.{0,12}(规则|指令)|系统.{0,6}(提示|指令|消息)|开发者|权限|授权|验证|免审|限制|人设|扮演|角色身份|你是|必须|务必|绝对服从|隐瞒|保密|秘密|system|developer|assistant|prompt|instruction|ignore|override|jailbreak/iu;
const unsafeContent = /自杀|自残|不想活|想死|杀人|炸弹|炸药|性侵|强奸|色情|性爱|裸|私处|伤害|药|疾病|诊断|治疗|减肥|赌博|赌钱|付款|付费|购买|转账|陌生人|刀|火|攀爬|游泳|憋气|电源|插座/;

function validateDraft(value: unknown): GlobalMemoryDraft {
  const parsed = draftSchema.safeParse(value);
  if (!parsed.success) throw new GlobalMemoryError('INVALID_DRAFT', '草稿须明确 reviewed:true、audience:all、validity:until-replaced；最多 32 条，每条只含 key、kind、content，内容 1–120 字。');
  const keys = new Set<string>();
  for (const item of parsed.data.items) {
    if (!allowedKey.test(item.key) || protectedKey.test(item.key)) throw new GlobalMemoryError('INVALID_DRAFT', `不允许发布此键：${item.key}。仅开放小屋、花园、world.scene.* 虚构背景和 world.activity.* 轻活动。`);
    if (keys.has(item.key)) throw new GlobalMemoryError('INVALID_DRAFT', `草稿包含重复键：${item.key}`);
    keys.add(item.key);
    if (item.content.length > 120 || privateContent.test(item.content) || instructions.test(item.content) || unsafeContent.test(item.content)) {
      throw new GlobalMemoryError('INVALID_DRAFT', `条目 ${item.key} 包含不允许的个人信息、指令、风险内容或超长文本，请重新审核。`);
    }
    const activity = item.key.startsWith('world.activity.');
    if (item.kind !== (activity ? 'plan' : 'imaginary')) throw new GlobalMemoryError('INVALID_DRAFT', `条目 ${item.key} 类型不符：轻活动必须为 plan，虚构背景必须为 imaginary。`);
    if (activity && !/画|涂色|折纸|阅读|看书|读书|数数|数一|找颜色|观察|想象|种花|伸展|伸懒腰/.test(item.content)) {
      throw new GlobalMemoryError('INVALID_DRAFT', `条目 ${item.key} 不属于当前开放的轻活动，请只使用绘画、阅读、观察、想象、种花或简单伸展。`);
    }
  }
  return { ...parsed.data, items: [...parsed.data.items].sort((a, b) => a.key.localeCompare(b.key, 'en')) };
}

function validateOptions(value: GlobalPublishOptions): GlobalPublishOptions {
  const schema = z.object({ expectedRevision: z.number().int().positive().safe(), reviewer: z.string().trim().min(2).max(60), note: z.string().trim().min(3).max(240) }).strict();
  const parsed = schema.safeParse(value);
  if (!parsed.success || /[\u0000-\u001f\u007f]/.test(`${parsed.data?.reviewer ?? ''}${parsed.data?.note ?? ''}`)) {
    throw new GlobalMemoryError('INVALID_DRAFT', '必须提供当前 expectedRevision、2–60 字审核人标识和 3–240 字发布说明；不要填写儿童信息或密钥。');
  }
  return parsed.data;
}

type ReleaseRow = {
  revision: number; action: GlobalMemoryRelease['action']; created_at: number; reviewer: string; note: string;
  previous_revision: number | null; rollback_of: number | null; items_json: string; content_hash: string;
};
const asDraftItem = ({ key, content, kind }: Memory): GlobalDraftItem => ({ key, content, kind: kind as GlobalDraftItem['kind'] });

/** Owns two global-only tables in the existing application database; no parent-facing writes. */
export function createGlobalMemoryStore(db: DatabaseSync, options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('global_memory_releases','global_memory_head')").all();
  if (names.length !== 0 && names.length !== 2) throw new GlobalMemoryError('STORE_CORRUPT', '全局记忆表不完整，请先检查数据库。');
  if (!names.length) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS global_memory_releases (
        revision INTEGER PRIMARY KEY, action TEXT NOT NULL CHECK(action IN ('initialize','publish','rollback')),
        created_at INTEGER NOT NULL, reviewer TEXT NOT NULL, note TEXT NOT NULL,
        previous_revision INTEGER, rollback_of INTEGER, items_json TEXT NOT NULL, content_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS global_memory_head (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL REFERENCES global_memory_releases(revision)
      );`);
      if (!db.prepare('SELECT revision FROM global_memory_head WHERE singleton=1').get()) {
        validateDraft({ reviewed: true, audience: 'all', validity: 'until-replaced', items: fixture.items.map(asDraftItem) });
        const items = fixture.items.map(item => ({ ...item, scope: 'global' as const, revision: 1 }));
        const serialized = JSON.stringify(items);
        db.prepare('INSERT INTO global_memory_releases VALUES(?,?,?,?,?,?,?,?,?)').run(1, 'initialize', now(), 'built-in-fixture', '初始化已随代码审阅的原创虚构背景', null, null, serialized, digest(serialized));
        db.prepare('INSERT INTO global_memory_head VALUES(1,1)').run();
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  function readRow(revision?: number): ReleaseRow {
    const row = (revision === undefined
      ? db.prepare('SELECT r.* FROM global_memory_releases r JOIN global_memory_head h ON h.revision=r.revision WHERE h.singleton=1').get()
      : db.prepare('SELECT * FROM global_memory_releases WHERE revision=?').get(revision)) as ReleaseRow | undefined;
    if (!row) throw new GlobalMemoryError(revision === undefined ? 'STORE_CORRUPT' : 'REVISION_NOT_FOUND', revision === undefined ? '找不到当前全局记忆版本。' : `不存在全局记忆版本 r${revision}。`);
    return row;
  }
  function unpack(row: ReleaseRow): GlobalMemorySnapshot {
    if (digest(row.items_json) !== row.content_hash) throw new GlobalMemoryError('STORE_CORRUPT', `全局记忆 r${row.revision} 完整性检查失败。`);
    let items: Memory[];
    try { items = JSON.parse(row.items_json) as Memory[]; }
    catch { throw new GlobalMemoryError('STORE_CORRUPT', `全局记忆 r${row.revision} 不是有效 JSON。`); }
    const release: GlobalMemoryRelease = {
      revision: row.revision, action: row.action, createdAt: new Date(row.created_at).toISOString(), reviewer: row.reviewer,
      note: row.note, previousRevision: row.previous_revision, rollbackOf: row.rollback_of,
      audience: 'all', validity: 'until-replaced', itemCount: items.length, contentHash: row.content_hash,
    };
    return { revision: row.revision, items, release };
  }
  function snapshot(): GlobalMemorySnapshot { return unpack(readRow()); }
  function history(): GlobalMemoryRelease[] {
    return (db.prepare('SELECT * FROM global_memory_releases ORDER BY revision DESC').all() as ReleaseRow[]).map(row => unpack(row).release);
  }
  function preview(value: unknown): GlobalMemoryPreview {
    const draft = validateDraft(value);
    const current = snapshot();
    const before = new Map(current.items.map(item => [item.key, asDraftItem(item)]));
    const after = new Map(draft.items.map(item => [item.key, item]));
    return {
      baseRevision: current.revision, draft,
      changes: {
        added: draft.items.filter(item => !before.has(item.key)),
        removed: [...before.values()].filter(item => !after.has(item.key)),
        changed: draft.items.filter(item => before.has(item.key) && (before.get(item.key)!.content !== item.content || before.get(item.key)!.kind !== item.kind))
          .map(item => ({ key: item.key, before: before.get(item.key)!, after: item })),
      },
    };
  }
  function commit(action: 'publish' | 'rollback', value: unknown, rawOptions: GlobalPublishOptions, targetRevision: number | null): GlobalMemorySnapshot {
    const settings = validateOptions(rawOptions);
    const draft = action === 'publish' ? validateDraft(value) : undefined;
    let began = false;
    try {
      db.exec('BEGIN IMMEDIATE'); began = true;
      const current = snapshot();
      if (current.revision !== settings.expectedRevision) throw new GlobalMemoryError('REVISION_CONFLICT', `当前为 r${current.revision}，与预期 r${settings.expectedRevision} 不符。请重新预览，勿覆盖他人的发布。`);
      const rollbackSource = targetRevision === null ? undefined : unpack(readRow(targetRevision));
      const candidate = draft ?? validateDraft({ reviewed: true, audience: 'all', validity: 'until-replaced', items: rollbackSource!.items.map(asDraftItem) });
      const revision = current.revision + 1;
      const previousIds = new Map((rollbackSource?.items ?? current.items).map(item => [item.key, item.id]));
      const items: Memory[] = candidate.items.map(item => ({
        ...item, id: previousIds.get(item.key) ?? `global-${digest(item.key).slice(0, 24)}`, scope: 'global', revision,
        source: action === 'rollback' ? `已审核全局背景 r${revision}（恢复 r${targetRevision}）` : `已审核全局背景 r${revision}`,
      }));
      const serialized = JSON.stringify(items);
      db.prepare('INSERT INTO global_memory_releases VALUES(?,?,?,?,?,?,?,?,?)').run(revision, action, now(), settings.reviewer, settings.note, current.revision, targetRevision, serialized, digest(serialized));
      const switched = db.prepare('UPDATE global_memory_head SET revision=? WHERE singleton=1 AND revision=?').run(revision, settings.expectedRevision);
      if (Number(switched.changes) !== 1) throw new GlobalMemoryError('REVISION_CONFLICT', '发布期间版本已变化，请重新预览。');
      const result = unpack(readRow(revision));
      db.exec('COMMIT'); began = false;
      return result;
    } catch (error) {
      if (began) db.exec('ROLLBACK');
      if (error instanceof Error && /database is (?:locked|busy)/i.test(error.message)) throw new GlobalMemoryError('REVISION_CONFLICT', '其他操作正在更新数据库，请稍后重新预览版本。');
      throw error;
    }
  }
  return {
    snapshot, history, preview,
    publish: (draft: unknown, settings: GlobalPublishOptions) => commit('publish', draft, settings, null),
    rollback: (targetRevision: number, settings: GlobalPublishOptions) => {
      if (!Number.isSafeInteger(targetRevision) || targetRevision < 1) throw new GlobalMemoryError('REVISION_NOT_FOUND', '回滚目标必须是已存在的正整数版本号。');
      return commit('rollback', undefined, settings, targetRevision);
    },
  };
}

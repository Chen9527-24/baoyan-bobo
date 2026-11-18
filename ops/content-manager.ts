import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createContentStore, ContentStoreError } from '../apps/server/src/content-store.js';

const help = `内容目录本机运维（不会读取家庭数据；不创建新的运行数据库）
 node --import tsx ops/content-manager.ts list|snapshot|history|audit --db /绝对路径/baoyan.sqlite
 node --import tsx ops/content-manager.ts preview --db /路径/baoyan.sqlite --draft /路径/story.json
 node --import tsx ops/content-manager.ts draft --db /路径/baoyan.sqlite --draft /路径/story.json --reviewer 编辑标识 --note 编辑说明
 node --import tsx ops/content-manager.ts review --db /路径/baoyan.sqlite --id story-id --draft-version 2 --reviewer 审核标识 --note 审核说明
 node --import tsx ops/content-manager.ts publish --db /路径/baoyan.sqlite --id story-id --draft-version 2 --expected-revision 1 --reviewer 发布标识 --note 发布说明
 node --import tsx ops/content-manager.ts disable --db /路径/baoyan.sqlite --id story-id --expected-revision 2 --reviewer 运维标识 --note 下架说明
 node --import tsx ops/content-manager.ts learning --db /路径/baoyan.sqlite --id arithmetic --enabled false --expected-revision 3 --reviewer 运维标识 --note 停用说明
 node --import tsx ops/content-manager.ts rollback --db /路径/baoyan.sqlite --target-revision 1 --expected-revision 4 --reviewer 运维标识 --note 回滚说明
新增故事必须先draft、再review相同草稿版本、最后publish；修改草稿会撤销旧审核。家庭PIN没有全局内容发布权限。
preview只做结构与基础安全检查，不能替代真人适龄审核。来源original需原创说明，licensed需授权说明。`;
function positive(value: string | undefined) { if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('版本必须为正整数。'); return Number(value); }
function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') { console.log(help); return; }
  const writeFlags = ['reviewer', 'note'];
  const allowed: Record<string, string[]> = {
    list: ['db'], snapshot: ['db'], history: ['db'], audit: ['db'], preview: ['db', 'draft'],
    draft: ['db', 'draft', ...writeFlags], review: ['db', 'id', 'draft-version', ...writeFlags],
    publish: ['db', 'id', 'draft-version', 'expected-revision', ...writeFlags], disable: ['db', 'id', 'expected-revision', ...writeFlags],
    learning: ['db', 'id', 'enabled', 'expected-revision', ...writeFlags], rollback: ['db', 'target-revision', 'expected-revision', ...writeFlags],
  };
  const accepted = allowed[command]; if (!accepted) throw new Error('未知命令，请查看 --help。');
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.replace(/^--/, ''), value = args[index + 1];
    if (!args[index]?.startsWith('--') || !key || !accepted.includes(key) || !value || value.startsWith('--') || flags.has(key)) throw new Error('参数无效、重复或缺少值。');
    flags.set(key, value);
  }
  for (const flag of accepted) if (!flags.has(flag)) throw new Error(`缺少 --${flag}。`);
  const databasePath = resolve(flags.get('db')!); if (!existsSync(databasePath)) throw new Error('数据库不存在；请先运行应用初始化，不会代为创建运行库。');
  const writes = !['list', 'snapshot', 'history', 'audit', 'preview'].includes(command);
  const db = new DatabaseSync(databasePath, { readOnly: !writes });
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='content_catalog_head'").get();
    if (!table) throw new Error('目录尚未初始化，请先运行支持内容目录的新版本应用。');
    const store = createContentStore(db); const output = (value: unknown) => console.log(JSON.stringify(value));
    if (command === 'list') { output(store.list()); return; }
    if (command === 'snapshot') { output(store.snapshot()); return; }
    if (command === 'history') { output(store.history()); return; }
    if (command === 'audit') { output(store.audit()); return; }
    if (command === 'preview' || command === 'draft') {
      const draftPath = resolve(flags.get('draft')!); if (statSync(draftPath).size > 64 * 1024) throw new Error('单篇故事JSON不得超过64KB。');
      let parsed: unknown; try { parsed = JSON.parse(readFileSync(draftPath, 'utf8')); } catch { throw new Error('草稿文件不是有效JSON。'); }
      if (command === 'preview') { output({ valid: true, reviewed: false, story: store.validate(parsed), currentRevision: store.snapshot().revision }); return; }
      output(store.saveDraft(parsed, { reviewer: flags.get('reviewer')!, note: flags.get('note')! })); return;
    }
    const review = { reviewer: flags.get('reviewer')!, note: flags.get('note')! };
    if (command === 'review') { output(store.review(flags.get('id')!, { ...review, expectedDraftVersion: positive(flags.get('draft-version')) })); return; }
    const release = { ...review, expectedRevision: positive(flags.get('expected-revision')) };
    if (command === 'publish') output(store.publish(flags.get('id')!, { ...release, expectedDraftVersion: positive(flags.get('draft-version')) }));
    else if (command === 'disable') output(store.disable(flags.get('id')!, release));
    else if (command === 'learning') {
      const enabled = flags.get('enabled'); if (enabled !== 'true' && enabled !== 'false') throw new Error('--enabled只接受true或false。');
      output(store.setLearningEnabled(flags.get('id')!, enabled === 'true', release));
    } else if (command === 'rollback') output(store.rollback(positive(flags.get('target-revision')), release));
  } finally { db.close(); }
}
try { main(); } catch (error) { console.error(JSON.stringify({ error: error instanceof Error ? error.message : '操作失败', ...(error instanceof ContentStoreError ? { code: error.code } : {}) })); process.exitCode = 1; }

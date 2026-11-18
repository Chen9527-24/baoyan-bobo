import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createGlobalMemoryStore, GlobalMemoryError } from '../apps/server/src/global-memory-store.js';
import type { Memory } from '../apps/server/src/types.js';

const help = `全局记忆本地维护（Node >=22.13；不会创建新的运行数据库）
  node --import tsx ops/global-memory.ts snapshot --db /绝对路径/baoyan.sqlite
  node --import tsx ops/global-memory.ts history --db /绝对路径/baoyan.sqlite
  node --import tsx ops/global-memory.ts preview --db /绝对路径/baoyan.sqlite --draft /绝对路径/draft.json
  node --import tsx ops/global-memory.ts publish --db /绝对路径/baoyan.sqlite --draft /绝对路径/draft.json --expected-revision 1 --reviewer 审核人标识 --note 发布说明
  node --import tsx ops/global-memory.ts rollback --db /绝对路径/baoyan.sqlite --target-revision 1 --expected-revision 2 --reviewer 审核人标识 --note 回滚说明
publish/rollback 会修改指定库；其余命令只读。草稿完整替换当前全局条目，未列出的键将移除。
命令输出按行 JSON；publish 先输出预览再原子提交。请先独立运行 preview 并审核差异。
`;

function positive(value: string | undefined, name: string): number {
  if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`${name} 必须是正整数。`);
  return Number(value);
}
function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || command === 'help') { console.log(help); return; }
  const allowed = {
    snapshot: ['db'], history: ['db'], preview: ['db', 'draft'],
    publish: ['db', 'draft', 'expected-revision', 'reviewer', 'note'],
    rollback: ['db', 'target-revision', 'expected-revision', 'reviewer', 'note'],
  };
  if (!(command in allowed)) throw new Error('未知命令，请使用 --help 查看用法。');
  const flags = new Map<string, string>();
  const accepted = allowed[command as keyof typeof allowed];
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.replace(/^--/, ''); const value = args[index + 1];
    if (!args[index]?.startsWith('--') || !key || !accepted.includes(key) || !value || value.startsWith('--') || flags.has(key)) throw new Error('参数无效、重复或缺少值，请使用 --help 查看用法。');
    flags.set(key, value);
  }
  for (const required of accepted) if (!flags.has(required)) throw new Error(`缺少 --${required}。`);
  const path = resolve(flags.get('db')!);
  if (!existsSync(path)) throw new Error('指定数据库不存在；请先运行应用初始化数据库，并确认 --db 指向正确文件。');
  const write = command === 'publish' || command === 'rollback';
  const expectedRevision = write ? positive(flags.get('expected-revision'), '--expected-revision') : undefined;
  const targetRevision = command === 'rollback' ? positive(flags.get('target-revision'), '--target-revision') : undefined;
  let draft: unknown;
  if (flags.has('draft')) {
    const draftPath = resolve(flags.get('draft')!);
    if (statSync(draftPath).size > 32 * 1024) throw new Error('草稿文件不得超过 32 KB。');
    const text = readFileSync(draftPath, 'utf8');
    try { draft = JSON.parse(text); } catch { throw new Error('草稿不是有效 JSON。'); }
  }
  const settings = { expectedRevision: expectedRevision!, reviewer: flags.get('reviewer')?.trim() ?? '', note: flags.get('note')?.trim() ?? '' };
  if (write && (settings.reviewer.length < 2 || settings.reviewer.length > 60 || settings.note.length < 3 || settings.note.length > 240 || /[\u0000-\u001f\u007f]/.test(settings.reviewer + settings.note))) {
    throw new Error('审核人须为 2–60 字，发布说明须为 3–240 字，不能包含控制字符。');
  }
  const database = new DatabaseSync(path, { readOnly: true });
  let fallback: DatabaseSync | undefined;
  let writer: DatabaseSync | undefined;
  try {
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('global_memory_releases','global_memory_head')").all();
    // Older databases can be previewed against r1 without writing migrations into them.
    if (!tables.length) fallback = new DatabaseSync(':memory:');
    const store = createGlobalMemoryStore(fallback ?? database);
    const output = (data: unknown) => console.log(JSON.stringify(data));
    if (command === 'snapshot') { output({ databaseInitialized: !fallback, snapshot: store.snapshot() }); return; }
    if (command === 'history') { output({ databaseInitialized: !fallback, releases: store.history() }); return; }
    if (command === 'preview') { output({ databaseInitialized: !fallback, ...store.preview(draft) }); return; }
    if (store.snapshot().revision !== expectedRevision) throw new GlobalMemoryError('REVISION_CONFLICT', '预期版本与当前版本不同，请重新预览后再提交。');
    if (command === 'publish') {
      output({ stage: 'preview', ...store.preview(draft) });
      writer = new DatabaseSync(path);
      output({ stage: 'published', snapshot: createGlobalMemoryStore(writer).publish(draft, settings) });
    } else {
      const current = store.snapshot();
      const target = store.history().find(release => release.revision === targetRevision);
      if (!target) throw new GlobalMemoryError('REVISION_NOT_FOUND', `不存在回滚目标 r${targetRevision}。`);
      const saved = (fallback ?? database).prepare('SELECT items_json FROM global_memory_releases WHERE revision=?').get(targetRevision!) as { items_json: string };
      const items = (JSON.parse(saved.items_json) as Memory[]).map(({ key, content, kind }) => ({ key, content, kind }));
      const preview = store.preview({ reviewed: true, audience: 'all', validity: 'until-replaced', items });
      output({ stage: 'rollback-preview', currentRevision: current.revision, target, ...preview });
      writer = new DatabaseSync(path);
      output({ stage: 'rolled-back', snapshot: createGlobalMemoryStore(writer).rollback(targetRevision!, settings) });
    }
  } finally { writer?.close(); fallback?.close(); database.close(); }
}
try { main(); }
catch (error) {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : '操作失败。', ...(error instanceof GlobalMemoryError ? { code: error.code } : {}) }));
  process.exitCode = 1;
}

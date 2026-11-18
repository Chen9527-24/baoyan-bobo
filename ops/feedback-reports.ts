import { chmodSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, closeSync, readSync, writeFileSync, unlinkSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { feedbackMetadata, feedbackReportForExport, feedbackTriageSchema, triageFeedback } from '../apps/server/src/feedback.js';

const help = `故障反馈维护（可信服务器终端；不读取 .env、不创建数据库、不向终端输出正文或音频）
  node --import tsx ops/feedback-reports.ts list --db /绝对路径/baoyan.sqlite
  node --import tsx ops/feedback-reports.ts export --db /绝对路径/baoyan.sqlite --id 报告ID --out /私密目录
  node --import tsx ops/feedback-reports.ts delete --db /绝对路径/baoyan.sqlite --id 报告ID
  node --import tsx ops/feedback-reports.ts triage --db /绝对路径/baoyan.sqlite --id 报告ID --status in_progress --reviewer 处理者 --note-file /私密处理备注.txt
编译后使用 node dist/server/ops/feedback-reports.js。
list 仅输出元数据；export 将正文与可选原始 WAV 保存为 0600 文件，已存在的文件不会覆盖。
delete 永久删除指定反馈，仅在用户明确清理或清理合成验收数据时使用，不重置限额。
triage 仅更新处理状态并留存审计记录；可用状态为 open / in_progress / resolved。
备注须为普通 UTF-8 文件，最多 2000 字、8192 字节；每份反馈最多 100 次变更，重复相同操作不增加记录。
处理或解决状态不表示已通知用户；本命令不发送任何通知，不向终端输出备注。
`;

function readNote(path: string | undefined) {
  if (!path || !isAbsolute(path)) throw new Error('triage 需要 --note-file 普通文件的绝对路径。');
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.size > 8192) throw new Error('处理备注文件格式或大小不正确。');
    const bytes = Buffer.alloc(8193); let length = 0;
    while (length < bytes.length) { const read = readSync(fd, bytes, length, bytes.length - length, length); if (!read) break; length += read; }
    if (length > 8192) throw new Error('处理备注文件超出大小限制。');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
  } catch { throw new Error('处理备注须为已存在的普通 UTF-8 文件，最多 8192 字节，不能使用符号链接。'); }
  finally { if (fd !== undefined) closeSync(fd); }
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || command === 'help') { console.log(help); return; }
  if (!['list', 'export', 'delete', 'triage'].includes(command)) throw new Error('未知命令，请使用 --help 查看用法。');
  const allowed = command === 'list' ? ['db'] : command === 'delete' ? ['db', 'id'] : command === 'triage' ? ['db', 'id', 'status', 'reviewer', 'note-file'] : ['db', 'id', 'out'];
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]?.replace(/^--/, ''); const value = args[index + 1];
    if (!args[index]?.startsWith('--') || !name || !allowed.includes(name) || !value || value.startsWith('--') || flags.has(name))
      throw new Error('参数无效、重复或缺少值。');
    flags.set(name, value);
  }
  const path = flags.get('db');
  if (!path || !isAbsolute(path) || !existsSync(path) || !lstatSync(path).isFile()) throw new Error('--db 必须指向已存在的普通数据库文件绝对路径。');
  const id = flags.get('id');
  if (command !== 'list' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id ?? '')) throw new Error('需要有效的 --id。');
  const out = flags.get('out');
  if (command === 'export' && (!out || !isAbsolute(out))) throw new Error('export 需要 --out 私密目录的绝对路径。');
  const triage = command === 'triage' ? feedbackTriageSchema.safeParse({ id, status: flags.get('status'), reviewer: flags.get('reviewer'), note: readNote(flags.get('note-file')) }) : undefined;
  if (triage && !triage.success) throw new Error('处理状态、处理者或备注格式不正确。');
  const db = new DatabaseSync(path, { readOnly: !['delete', 'triage'].includes(command) });
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='feedback_reports'").get()) throw new Error('反馈表尚未初始化，请先启动当前版本应用。');
    if (command === 'list') { console.log(JSON.stringify({ reports: feedbackMetadata(db) })); return; }
    if (triage?.success) { console.log(JSON.stringify(triageFeedback(db, triage.data))); return; }
    if (command === 'delete') {
      const result = db.prepare('DELETE FROM feedback_reports WHERE id=?').run(id!);
      console.log(JSON.stringify({ id, deleted: result.changes > 0 })); return;
    }
    const exported = feedbackReportForExport(db, id!);
    if (!exported) throw new Error('反馈不存在。');
    if (existsSync(out!)) {
      if (!lstatSync(out!).isDirectory()) throw new Error('--out 必须是普通目录，不能是符号链接。');
      if ((lstatSync(out!).mode & 0o077) !== 0) throw new Error('--out 须先设置为仅所有者可访问的私密目录（0700）。');
    } else mkdirSync(out!, { recursive: true, mode: 0o700 });
    const jsonPath = join(out!, `${id}.json`); const audioPath = join(out!, `${id}.wav`);
    const made: string[] = [];
    try {
      const save = (file: string, contents: string | Buffer) => {
        const fd = openSync(file, 'wx', 0o600); made.push(file);
        try { writeFileSync(fd, contents); } finally { closeSync(fd); }
        chmodSync(file, 0o600);
      };
      if (exported.audio) save(audioPath, exported.audio);
      save(jsonPath, JSON.stringify({ ...exported.report, audioFile: exported.audio ? `${id}.wav` : null }, null, 2));
    } catch { for (const file of made) unlinkSync(file); throw new Error('导出文件创建失败；请使用空的私密目录，已有文件不会覆盖。'); }
    console.log(JSON.stringify({ id, exported: true, directory: out, audio: Boolean(exported.audio) }));
  } finally { db.close(); }
}

try { main(); }
catch (error) { console.error(JSON.stringify({ error: error instanceof Error && !(error as NodeJS.ErrnoException).code ? error.message : '反馈维护操作失败，请检查文件和权限。' })); process.exitCode = 1; }

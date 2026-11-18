import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createTrialAccess, readTrialConfig, trialDeadline } from '../apps/server/src/trial-access.js';

const help = `内测邀请码维护（使用部署环境变量；不会读取 .env 或自动创建运行数据库）
  node --import tsx ops/trial-invites.ts create --db /绝对路径/baoyan.sqlite [--expires-at ISO时间]
  node --import tsx ops/trial-invites.ts list --db /绝对路径/baoyan.sqlite
  node --import tsx ops/trial-invites.ts revoke --db /绝对路径/baoyan.sqlite --id 邀请ID
编译后将 node --import tsx ops/trial-invites.ts 替换为 node dist/server/ops/trial-invites.js。
create 只在本次输出新邀请码，数据库仅存哈希；list/revoke 不输出邀请码。
撤销仅适用于尚未使用的邀请码；撤回家庭资料不会退还已消耗的名额。
`;

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || command === 'help') { console.log(help); return; }
  if (!['create', 'list', 'revoke'].includes(command)) throw new Error('未知命令，请使用 --help 查看用法。');
  const allowed = command === 'create' ? ['db', 'expires-at'] : command === 'revoke' ? ['db', 'id'] : ['db'];
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]?.replace(/^--/, ''); const value = args[index + 1];
    if (!args[index]?.startsWith('--') || !name || !allowed.includes(name) || !value || value.startsWith('--') || flags.has(name))
      throw new Error('参数无效、重复或缺少值。');
    flags.set(name, value);
  }
  if (!flags.has('db')) throw new Error('请显式指定 --db。');
  if (command === 'revoke' && !/^[0-9a-f-]{36}$/i.test(flags.get('id') ?? '')) throw new Error('revoke 需要有效的 --id。');
  const config = readTrialConfig(process.env);
  if (!config) throw new Error('请设置 TRIAL_ENABLED=true 和完整内测配置。');
  const path = resolve(flags.get('db')!);
  if (!existsSync(path)) throw new Error('指定数据库不存在，请先启动内测应用初始化数据库。');
  const db = new DatabaseSync(path, { readOnly: command === 'list' });
  try {
    db.exec('PRAGMA busy_timeout = 5000;');
    const initialized = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='trial_invites'").get();
    if (!initialized) throw new Error('内测数据库尚未初始化，请先启动内测应用。');
    const access = createTrialAccess(db, config);
    if (command === 'create') console.log(JSON.stringify(access.createInvite(flags.has('expires-at') ? trialDeadline(flags.get('expires-at')) : undefined)));
    else if (command === 'list') console.log(JSON.stringify({ invites: access.listInvites() }));
    else console.log(JSON.stringify(access.revokeInvite(flags.get('id')!)));
  } finally { db.close(); }
}

try { main(); }
catch (error) { console.error(JSON.stringify({ error: error instanceof Error ? error.message : '邀请码操作失败。' })); process.exitCode = 1; }

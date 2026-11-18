import { existsSync, lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const DAY = 86_400_000;
const help = `宝妍服务概况（可信服务器终端，只读已有数据库；不读取 .env、密钥或家庭正文）
  node --import tsx ops/service-status.ts --db /绝对路径/baoyan.sqlite [--daily-budget 300]
编译后使用 node dist/server/ops/service-status.js。
统计近 7 日供应商阶段调用成功率及 p50/p95；阶段耗时不等于一整轮对话等待。
--daily-budget 是运营者核对过的每日供应商调用次数上限，未提供则上限与剩余次数均为 null。
不估算费用；不创建表、执行清理或调用模型。
`;
function hasTable(db: DatabaseSync, name: string) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
type Sample = { ok: number; duration_ms: number };
function aggregate(samples: Sample[]) {
  const durations = samples.map(row => Number(row.duration_ms)).sort((a, b) => a - b);
  const succeeded = samples.filter(row => row.ok === 1).length;
  const percentile = (fraction: number) => durations.length ? durations[Math.ceil(durations.length * fraction) - 1]! : null;
  return { attempts: samples.length, succeeded, failed: samples.length - succeeded,
    successRate: samples.length ? succeeded / samples.length : null, p50Ms: percentile(.5), p95Ms: percentile(.95) };
}

/** Queries metadata only. Caller must open an existing database in read-only mode. */
export function readServiceStatus(db: DatabaseSync, options: { now?: number; dailyBudget?: number } = {}) {
  const at = options.now ?? Date.now(); const limit = options.dailyBudget;
  if (!Number.isSafeInteger(at) || at < 0 || (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000_000)))
    throw new Error('概况统计参数格式不正确。');
  const metricsAvailable = hasTable(db, 'software_service_metrics');
  const stageKeys = ['asr', 'chat', 'tts', 'audio-understanding', 'unclassified'] as const;
  const groups = new Map<string, Sample[]>(stageKeys.map(key => [key, []]));
  const clientSamples: Sample[] = [];
  if (metricsAvailable) {
    // Map a fixed server vocabulary; never print arbitrary database text or family identifiers.
    const rows = db.prepare(`SELECT CASE WHEN stage IN ('asr','asr-speaker') THEN 'asr'
      WHEN stage='chat' THEN 'chat' WHEN stage IN ('tts','tts-stream') THEN 'tts'
      WHEN stage='audio-understanding' THEN 'audio-understanding'
      WHEN stage='client-first-audio' THEN 'client-first-audio' ELSE 'unclassified' END AS bucket,ok,duration_ms
      FROM software_service_metrics WHERE created_at>=? AND created_at<=?`).all(at - 7 * DAY, at);
    for (const row of rows) {
      const duration = Number(row.duration_ms); const ok = Number(row.ok);
      if (!Number.isFinite(duration) || duration < 0 || ![0, 1].includes(ok)) continue;
      const sample = { ok, duration_ms: duration };
      if (row.bucket === 'client-first-audio') clientSamples.push(sample);
      else groups.get(String(row.bucket))!.push(sample);
    }
  }
  const day = new Date(at + 8 * 3_600_000).toISOString().slice(0, 10);
  const usageAvailable = hasTable(db, 'trial_provider_usage');
  const calls = usageAvailable ? Number(db.prepare('SELECT calls FROM trial_provider_usage WHERE day=?').get(day)?.calls ?? 0) : null;
  const feedbackAvailable = hasTable(db, 'feedback_reports'); const triageAvailable = hasTable(db, 'feedback_triage');
  const statuses = { open: 0, in_progress: 0, resolved: 0 };
  if (feedbackAvailable) {
    const rows = db.prepare(`SELECT ${triageAvailable ? "coalesce(t.status,'open')" : "'open'"} AS status,count(*) AS n
      FROM feedback_reports f ${triageAvailable ? 'LEFT JOIN feedback_triage t ON t.report_id=f.id' : ''}
      WHERE f.expires_at IS NULL OR f.expires_at>? GROUP BY status`).all(at);
    for (const row of rows) if (typeof row.status === 'string' && Object.hasOwn(statuses, row.status)) statuses[row.status as keyof typeof statuses] = Number(row.n);
  }
  return {
    checkedAt: new Date(at).toISOString(), windowDays: 7,
    providerStages: { available: metricsAvailable, measurement: 'provider_stage_duration', percentileMethod: 'nearest_rank', durationIncludesFailures: true,
      stages: stageKeys.map(stage => ({ stage, ...aggregate(groups.get(stage)!) })) },
    clientFirstAudio: { measurement: 'client_reported_first_audio_delay', ...aggregate(clientSamples) },
    providerDayBudget: { available: usageAvailable, day, timezone: 'Asia/Shanghai', calls, dailyBudget: limit ?? null,
      remaining: calls !== null && limit !== undefined ? Math.max(0, limit - calls) : null,
      budgetSource: limit === undefined ? 'not_provided' : 'operator_argument', includesFailedAttempts: true },
    feedback: { available: feedbackAvailable, triageAvailable, ...statuses, total: statuses.open + statuses.in_progress + statuses.resolved,
      notificationStatus: 'not_measured' },
    cost: { measured: false },
  };
}

function main() {
  const args = process.argv.slice(2);
  if (!args.length || (args.length === 1 && ['--help', 'help'].includes(args[0]!))) { console.log(help); return; }
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]; const value = args[index + 1];
    if (!flag || !['--db', '--daily-budget'].includes(flag) || !value || value.startsWith('--') || flags.has(flag)) throw new Error('参数无效、重复或缺少值。');
    flags.set(flag, value);
  }
  const path = flags.get('--db'); const rawBudget = flags.get('--daily-budget');
  if (!path || !isAbsolute(path) || !existsSync(path) || !lstatSync(path).isFile()) throw new Error('--db 必须指向已存在的普通数据库文件绝对路径。');
  if (rawBudget !== undefined && !/^[1-9]\d{0,6}$/.test(rawBudget)) throw new Error('--daily-budget 必须为核实过的正整数次数。');
  const db = new DatabaseSync(path, { readOnly: true });
  try { db.exec('PRAGMA busy_timeout=5000;'); console.log(JSON.stringify(readServiceStatus(db, { dailyBudget: rawBudget === undefined ? undefined : Number(rawBudget) }))); }
  finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); }
  catch (error) { console.error(JSON.stringify({ error: error instanceof Error && !(error as NodeJS.ErrnoException).code ? error.message : '读取服务概况失败，请检查文件和权限。' })); process.exitCode = 1; }
}

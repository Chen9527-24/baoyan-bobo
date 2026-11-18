import { Router, type Request } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from './provider-errors.js';
import { BAOYAN_PERSONA_VERSION, buildBaoyanPrompt } from './baoyan-persona.js';
import { CONVERSATION_POLICY_VERSION, buildConversationPolicyPrompt, type ConversationMessage } from './conversation-policy.js';
import { REPLY_PLAN_VERSION } from './reply-plan.js';
import { NATURAL_DIRECTION_VERSION, DIRECTION_STEPS, DIRECTION_EXAMPLES, normalizeNaturalDirection, directionDetails, naturalDirectionGuidance, type NaturalDirection } from './scene-direction.js';
import type { CalibrationCase } from './calibration-library.js';

export const SCENE_ADOPTION_VERSION = '1';
export const ADOPTION_PREFERENCES = [
  { id: 'concise', label: '说短一点', description: '先说最有用的一小段，需要时再展开。' },
  { id: 'listen-first', label: '先接住我的话', description: '先回应具体事情，少说教、少急着出主意。' },
  { id: 'fewer-questions', label: '少一点追问', description: '能直接接话时不在结尾加问题。' },
] as const;
export const ADOPTION_INTENTS = [
  { id: 'sharing', label: '分享心情和日常' },
  { id: 'help', label: '请宝妍帮忙想办法' },
  { id: 'knowledge', label: '问知识和原因' },
] as const;
type Preference = typeof ADOPTION_PREFERENCES[number]['id'];
type Intent = typeof ADOPTION_INTENTS[number]['id'];
type Age = CalibrationCase['ageGroup'];
type Choice = 'candidate' | 'baseline' | 'tie' | 'neither';
type Auth = { familyId: string; deviceHash: string; childId?: string };
type Row = { payload: string };
type Options = {
  db: DatabaseSync; now: () => number; scope: 'family' | 'debug'; model: string; configured: boolean;
  authorize: (req: Request) => Auth; assertOpen: () => void;
  invoke: (messages: { role: string; content: string }[], signal: AbortSignal) => Promise<string>;
  getCase: (familyId: string, caseId: string) => CalibrationCase | undefined;
  onChange?: (familyId: string) => void;
  canCompare?: (question: string) => boolean;
  assertFictional: (value: unknown) => void;
};
export type AdoptionReceipt = {
  id: string; version: number; comparisonId: string; caseId: string; caseRevision: number;
  ageGroup: Age; intent: Intent; preferences: Preference[]; model: string; personaVersion: string;
  replyPlanVersion: string; policyVersion: string; conversationPolicyVersion: string; direction?: NaturalDirection; directionId?: string; appliedAt: string; scope: 'family' | 'debug'; choices: Choice[];
};
export type AdoptionState = { version: number; active?: AdoptionReceipt; lastChange?: { at: string; reason: string; previousId?: string } };
type ComparisonRow = { id: string; label: string; question: string; ageGroup: Age; baseline: { reply?: string; error?: string; elapsedMs: number }; candidate: { reply?: string; error?: string; elapsedMs: number } };
export type AdoptionComparison = {
  id: string; caseId: string; caseRevision: number; baseVersion: number; ageGroup: Age; intent: Intent;
  preferences: Preference[]; direction?: NaturalDirection; directionId?: string; model: string; personaVersion: string; replyPlanVersion: string; policyVersion: string; conversationPolicyVersion: string;
  createdAt: string; completedAt: string; expiresAt: string; scope: 'family' | 'debug'; rows: ComparisonRow[];
  operationId: string; status: 'pending' | 'completed' | 'cancelled' | 'failed'; completedPairs: number; total: 3; error?: string;
};
export type DirectionPreview = {
  id: string; operationId: string; caseId: string; caseRevision: number; ageGroup: Age; intent: Intent;
  sourceText: string; direction: NaturalDirection; steps: ReturnType<typeof directionDetails>; warnings: string[];
  model: string; personaVersion: string; replyPlanVersion: string; policyVersion: string; conversationPolicyVersion: string;
  createdAt: string; expiresAt: string; scope: 'family' | 'debug';
};
export type SceneRetest = {
  id: string; operationId: string; status: 'pending' | 'completed' | 'cancelled' | 'failed'; completed: number; total: number;
  cases: { id: string; revision: number }[]; baseVersion: number; createdAt: string; completedAt: string;
  model: string; personaVersion: string; replyPlanVersion: string; policyVersion: string; conversationPolicyVersion: string;
  scope: 'family' | 'debug'; error?: string;
  rows: { caseId: string; caseRevision: number; title: string; question: string; ageGroup: Age; expectedReply: string; reply?: string; error?: string; elapsedMs: number; adopted: boolean }[];
};
const preference = z.enum(['concise', 'listen-first', 'fewer-questions']);
const intent = z.enum(['sharing', 'help', 'knowledge']);
const compareSchema = z.object({ operationId: z.string().uuid(), caseId: z.string().uuid(), caseRevision: z.number().int().min(1), preferences: z.array(preference).min(1).max(2).refine(a => new Set(a).size === a.length).optional(), intent, directionId: z.string().uuid().optional(), directionConfirmed: z.literal(true).optional() }).strict().refine(value => value.directionId ? value.directionConfirmed === true && !value.preferences : Boolean(value.preferences) && !value.directionConfirmed);
const previewSchema = z.object({ operationId: z.string().uuid(), caseId: z.string().uuid(), caseRevision: z.number().int().min(1), text: z.string().trim().min(1).max(400).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)), intent }).strict();
const retestSchema = z.object({ operationId: z.string().uuid(), cases: z.array(z.object({ id: z.string().uuid(), revision: z.number().int().min(1) }).strict()).min(3).max(5).refine(items => new Set(items.map(item => item.id)).size === items.length) }).strict();
const applySchema = z.object({ operationId: z.string().uuid(), comparisonId: z.string().uuid(), expectedVersion: z.number().int().min(0), choices: z.array(z.enum(['candidate', 'baseline', 'tie', 'neither'])).length(3), confirmed: z.literal(true) }).strict();
const revokeSchema = z.object({ operationId: z.string().uuid(), expectedVersion: z.number().int().min(0) }).strict();
const fail = (status: number, message: string, code: string) => new ApiError(status, message, code);
const conflict = () => fail(409, '方案或场景已变化，请刷新后重新比较。', 'ADOPTION_CONFLICT');
const stopped = () => fail(499, '这次比较已停止，不会自动采用。', 'REQUEST_ABORTED');
const hash = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => { const result = schema.safeParse(value); if (!result.success) throw fail(400, '请检查场景、适用情况和比较选择。', 'INVALID_INPUT'); return result.data; };

/** Narrow cues only. Unclear, quoted, reported, image and sensitive inputs do not inherit a scene. */
export function adoptionIntent(text: string, imageProvided = false): Intent | undefined {
  if (imageProvided || /[“”「」『』"']|(?:如果|假如|假设|比如|故事里|书里|电影里|歌词里|(?:他|她|妈妈|爸爸|老师|同学|朋友|哥哥|姐姐|弟弟|妹妹)[^。！？!?，,]{0,6}(?:告诉|问|说)|我(?:听说|听到|听见|看到).{0,15}(?:说|问|告诉))|(?:自杀|伤害|自残|死了|不想活|药|疼|密码|住址|电话|记住|忘掉)/u.test(text)) return;
  const declines = /(?:别|不要|不用|不想|不需要|不愿意).{0,8}(?:帮|给|建议|办法|主意|教我|问)|(?:只想|只是|就是|就想)(?:告诉|说说|跟你说|聊聊)/u.test(text);
  if (declines) {
    if (/[，,。](?:不过|但是|可是|但)?(?:现在|这次|那)?(?:请)?(?:教我|帮我|给我|我该怎么|我应该怎么)/u.test(text)) return;
    return /^我/u.test(text) ? 'sharing' : undefined;
  }
  if (/(?:帮我|给我)(?:想|出|找).{0,5}(?:办法|主意)|(?:我)?(?:该|要|应该)怎么(?:办|做|解决)|教我(?:怎么|如何)/u.test(text)) return 'help';
  if (/^(?:宝妍[，, ]*)?(?:为什么|什么是|怎么会|如何|请解释|能解释)|(?:是什么|为什么会).{0,25}[？?]?$/.test(text)) return 'knowledge';
  if (/^(?:宝妍[，, ]*)?我(?:今天|刚才|现在|有点|很|好|特别|只想|想跟你说|告诉你|画了|做了|得到|拿到|赢了|输了|喜欢|不喜欢|开心|难过|生气|担心|不想)/u.test(text)) return 'sharing';
  return;
}
const guidance: Record<Preference, string> = {
  concise: '同样能讲清楚时，先用一小段具体口语回应，避免重复解释。孩子本轮明确想听详细时，按本轮要求展开，不删必要的安全或事实说明。',
  'listen-first': '先自然承接孩子刚说的具体事情，不补猜经历，不贴心理标签，不急着说教。需要办法时再给一个可做的小步骤；孩子明确求助时直接帮忙，不拖延。',
  'fewer-questions': '能直接接住话或回答时，不额外在结尾追问。信息真的不清、涉及重要事实或安全时仍须简短确认；孩子主动要求问答时遵从本轮要求。',
};
/** Shared by the ordinary reply path and its controlled adoption comparison. */
export function sceneReplyMessages(system: string, history: readonly ConversationMessage[], inputText: string, adopted = '', provenance = '') {
  const cadence = buildConversationPolicyPrompt({ history, inputText });
  return [{ role: 'system', content: system }, ...history, ...(cadence ? [{ role: 'system', content: cadence }] : []), ...(adopted ? [{ role: 'system', content: adopted }] : []), ...(provenance ? [{ role: 'system', content: provenance }] : []), { role: 'user', content: inputText }];
}
export function adoptionGuidance(preferences: readonly Preference[]) {
  return `家庭明确选择的有限接话偏好（只调整表达，不改变宝妍身份、事实、安全、隐私和记忆规则；当前孩子意愿优先）：\n${preferences.map(key => guidance[key]).join('\n')}`;
}
const receiptGuidance = (value: Pick<AdoptionReceipt, 'preferences' | 'direction'>) => value.direction ? naturalDirectionGuidance(value.direction) : adoptionGuidance(value.preferences);
const probes: Record<Intent, readonly string[]> = {
  sharing: ['我今天画好了一只小猫，想给你讲讲。', '我现在有点难过，只想跟你说说。'],
  help: ['我该怎么做才能把玩具收得好找一点？', '帮我想个办法，明天想跟同学道歉。'],
  knowledge: ['为什么下雨以后会有彩虹？', '什么是影子？'],
};

export function createSceneAdoption(options: Options) {
  const { db, now } = options;
  db.exec(`CREATE TABLE IF NOT EXISTS scene_adoption_states(family_id TEXT PRIMARY KEY REFERENCES families(id) ON DELETE CASCADE,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS scene_adoption_reports(id TEXT PRIMARY KEY,family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,case_id TEXT NOT NULL REFERENCES calibration_cases(id) ON DELETE CASCADE,payload TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS scene_adoption_reports_family ON scene_adoption_reports(family_id,created_at);
    CREATE TABLE IF NOT EXISTS scene_adoption_directions(id TEXT PRIMARY KEY,family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,case_id TEXT NOT NULL REFERENCES calibration_cases(id) ON DELETE CASCADE,payload TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS scene_adoption_directions_family ON scene_adoption_directions(family_id,created_at);
    CREATE TABLE IF NOT EXISTS scene_adoption_retests(id TEXT PRIMARY KEY,family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,payload TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS scene_adoption_retests_family ON scene_adoption_retests(family_id,created_at);
    CREATE TABLE IF NOT EXISTS scene_adoption_operations(family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,operation_id TEXT NOT NULL,input_hash TEXT NOT NULL,state TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(family_id,operation_id));`);
  // A restart never repeats model calls from a previously pending request.
  for (const row of db.prepare("SELECT id,payload FROM scene_adoption_reports").all() as { id: string; payload: string }[]) {
    const value = JSON.parse(row.payload) as AdoptionComparison;
    if (value.status === 'pending') { value.status = 'failed'; value.error = '服务已重启，请重新比较。'; db.prepare('UPDATE scene_adoption_reports SET payload=? WHERE id=?').run(JSON.stringify(value), row.id); }
  }
  for (const row of db.prepare('SELECT id,payload FROM scene_adoption_retests').all() as { id: string; payload: string }[]) {
    const value = JSON.parse(row.payload) as SceneRetest;
    if (value.status === 'pending') { value.status = 'failed'; value.error = '服务已重启，这次复测不会自动重试。'; db.prepare('UPDATE scene_adoption_retests SET payload=? WHERE id=?').run(JSON.stringify(value),row.id); }
  }
  db.prepare("UPDATE scene_adoption_operations SET state='failed' WHERE state='pending'").run();
  let closed = false;
  const pending = new Map<string, { familyId: string; deviceHash: string; controller: AbortController; assertCurrent: () => void }>();
  const stamp = () => new Date(now()).toISOString();
  const running = () => { if (closed) throw fail(503, '服务已停止，请重新进入。', 'SERVICE_STOPPED'); };
  const transaction = <T>(work: () => T) => { db.exec('BEGIN IMMEDIATE'); try { const value = work(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  function state(familyId: string): AdoptionState {
    const row = db.prepare('SELECT payload FROM scene_adoption_states WHERE family_id=?').get(familyId) as Row | undefined;
    return row ? JSON.parse(row.payload) : { version: 0 };
  }
  function writeState(familyId: string, value: AdoptionState) { db.prepare('INSERT INTO scene_adoption_states VALUES(?,?) ON CONFLICT(family_id) DO UPDATE SET payload=excluded.payload').run(familyId, JSON.stringify(value)); }
  function currentVersions(value: Pick<AdoptionReceipt, 'model' | 'personaVersion' | 'policyVersion' | 'replyPlanVersion' | 'conversationPolicyVersion'> & { direction?: NaturalDirection }) {
    return value.model === options.model && value.personaVersion === BAOYAN_PERSONA_VERSION && value.replyPlanVersion === REPLY_PLAN_VERSION && value.policyVersion === SCENE_ADOPTION_VERSION && value.conversationPolicyVersion === CONVERSATION_POLICY_VERSION && (!value.direction || (value.direction.version === NATURAL_DIRECTION_VERSION && Boolean(naturalDirectionGuidance(value.direction))));
  }
  function withdrawActive(familyId: string, reason: string): AdoptionState {
    const old = state(familyId); if (!old.active) return old;
    const next = { version: old.version + 1, lastChange: { at: stamp(), reason, previousId: old.active.id } };
    writeState(familyId, next); options.onChange?.(familyId); return next;
  }
  function current(familyId: string): AdoptionState {
    const old = state(familyId);
    if (!old.active) return old;
    const item = options.getCase(familyId, old.active.caseId);
    if (!item || item.status !== 'accepted' || item.revision !== old.active.caseRevision) return withdrawActive(familyId, '场景已变化，已停止采用');
    if (!currentVersions(old.active)) return withdrawActive(familyId, '模型或接话规则已更新，需要重新比较');
    return old;
  }
  function report(familyId: string, id: string): AdoptionComparison | undefined {
    const row = db.prepare('SELECT payload FROM scene_adoption_reports WHERE family_id=? AND id=?').get(familyId, id) as Row | undefined;
    return row ? JSON.parse(row.payload) : undefined;
  }
  function preview(familyId: string, id: string): DirectionPreview | undefined {
    const row = db.prepare('SELECT payload FROM scene_adoption_directions WHERE family_id=? AND id=?').get(familyId,id) as Row | undefined;
    return row ? JSON.parse(row.payload) : undefined;
  }
  function retest(familyId: string, id: string): SceneRetest | undefined {
    const row = db.prepare('SELECT payload FROM scene_adoption_retests WHERE family_id=? AND id=?').get(familyId,id) as Row | undefined;
    return row ? JSON.parse(row.payload) : undefined;
  }
  function source(familyId: string, id: string, revision: number) {
    const item = options.getCase(familyId, id);
    if (!item) throw fail(404, '这份场景不存在。', 'NOT_FOUND');
    if (item.revision !== revision || item.status !== 'accepted') throw conflict();
    return item;
  }
  function operation(familyId: string, id: string, fingerprint: unknown) {
    const old = db.prepare('SELECT input_hash,state,result FROM scene_adoption_operations WHERE family_id=? AND operation_id=?').get(familyId, id) as { input_hash: string; state: string; result: string } | undefined;
    if (old && old.input_hash !== hash(fingerprint)) throw conflict();
    return old;
  }
  function reserve(familyId: string, id: string, fingerprint: unknown, revocation = false) {
    const own = db.prepare('SELECT count(*) AS n FROM scene_adoption_operations WHERE family_id=?').get(familyId) as { n: number };
    const all = db.prepare('SELECT count(*) AS n FROM scene_adoption_operations').get() as { n: number };
    if (!revocation && (own.n >= 1000 || all.n >= 10000)) throw fail(429, '采用记录已满，请联系维护人员。', 'ADOPTION_LIMIT');
    db.prepare("INSERT INTO scene_adoption_operations VALUES(?,?,?,'pending','')").run(familyId, id, hash(fingerprint));
  }
  function finish(familyId: string, id: string, status: string, value = '') { db.prepare('UPDATE scene_adoption_operations SET state=?,result=? WHERE family_id=? AND operation_id=?').run(status, value, familyId, id); }
  function guidanceFor(familyId: string, ageGroup: Age, text: string, imageProvided = false) {
    running(); const active = current(familyId).active;
    return active && active.ageGroup === ageGroup && adoptionIntent(text, imageProvided) === active.intent ? receiptGuidance(active) : '';
  }
  function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => { const abort = () => reject(signal.reason ?? stopped()); if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true }); task.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)); });
  }
  const router = Router();
  router.use((req, _res, next) => { running(); options.authorize(req); next(); });
  router.get('/', (req, res) => {
    const who = options.authorize(req);
    const reports = (db.prepare('SELECT payload FROM scene_adoption_reports WHERE family_id=? ORDER BY created_at DESC,id DESC LIMIT 20').all(who.familyId) as Row[]).map(row => JSON.parse(row.payload) as AdoptionComparison);
    const history = (db.prepare("SELECT state,result FROM scene_adoption_operations WHERE family_id=? AND state IN ('applied','revoked') ORDER BY rowid DESC LIMIT 10").all(who.familyId) as {state:string;result:string}[]).map(row => ({type:row.state,...JSON.parse(row.result)}));
    const directions = (db.prepare('SELECT payload FROM scene_adoption_directions WHERE family_id=? ORDER BY created_at DESC,id DESC LIMIT 20').all(who.familyId) as Row[]).map(row => JSON.parse(row.payload));
    const retests = (db.prepare('SELECT payload FROM scene_adoption_retests WHERE family_id=? ORDER BY created_at DESC,id DESC LIMIT 10').all(who.familyId) as Row[]).map(row => JSON.parse(row.payload));
    res.json({ scope: options.scope, model: options.model, personaVersion: BAOYAN_PERSONA_VERSION, replyPlanVersion: REPLY_PLAN_VERSION, conversationPolicyVersion: CONVERSATION_POLICY_VERSION, state: current(who.familyId), history, directions, retests, directionSteps: DIRECTION_STEPS.map(({id,label,description}) => ({id,label,description})), directionExamples: DIRECTION_EXAMPLES, preferences: ADOPTION_PREFERENCES, intents: ADOPTION_INTENTS, reports, configured: options.configured, policyVersion: SCENE_ADOPTION_VERSION });
  });
  router.post('/directions/preview', (req,res) => {
    const who = options.authorize(req), input = parse(previewSchema,req.body);
    const fingerprint = ['direction-preview',who.childId ?? '',input], old = operation(who.familyId,input.operationId,fingerprint);
    if (old) { const saved = preview(who.familyId,old.result); if (saved) return res.json(saved); throw fail(410,'这份方向已经删除，请重新整理。','ADOPTION_UNAVAILABLE'); }
    options.assertOpen(); options.assertFictional(input.text);
    const item = source(who.familyId,input.caseId,input.caseRevision);
    if ((options.canCompare && !options.canCompare(item.question)) || adoptionIntent(item.question) !== input.intent) throw fail(400,'这条场景暂不匹配所选情况；不确定或需安全处理的场景先保留参考。','ADOPTION_INTENT_MISMATCH');
    const normalized = normalizeNaturalDirection(input.text,input.intent);
    if ('error' in normalized) throw fail(400,normalized.error,'ADOPTION_DIRECTION_UNSUPPORTED');
    const own = db.prepare('SELECT count(*) AS n FROM scene_adoption_directions WHERE family_id=?').get(who.familyId) as {n:number};
    const all = db.prepare('SELECT count(*) AS n FROM scene_adoption_directions').get() as {n:number};
    if (own.n >= 100 || all.n >= 1000) throw fail(429,'整理记录已满，请先删除不再使用的场景。','ADOPTION_LIMIT');
    const value: DirectionPreview = { id:randomUUID(),operationId:input.operationId,caseId:item.id,caseRevision:item.revision,ageGroup:item.ageGroup,intent:input.intent,sourceText:input.text,direction:normalized.direction,steps:directionDetails(normalized.direction),warnings:normalized.warnings,
      model:options.model,personaVersion:BAOYAN_PERSONA_VERSION,replyPlanVersion:REPLY_PLAN_VERSION,policyVersion:SCENE_ADOPTION_VERSION,conversationPolicyVersion:CONVERSATION_POLICY_VERSION,createdAt:stamp(),expiresAt:new Date(now()+24*3600000).toISOString(),scope:options.scope };
    transaction(() => { reserve(who.familyId,input.operationId,fingerprint); db.prepare('INSERT INTO scene_adoption_directions VALUES(?,?,?,?,?)').run(value.id,who.familyId,item.id,JSON.stringify(value),now()); finish(who.familyId,input.operationId,'previewed',value.id); });
    res.status(201).json(value);
  });
  router.get('/retests/:id', (req,res) => {
    const who=options.authorize(req),value=retest(who.familyId,parse(z.string().uuid(),req.params.id));
    if(!value)throw fail(404,'复测记录不存在。','NOT_FOUND');
    const entry=pending.get(`${who.familyId}:${value.operationId}`);if(entry)try{entry.assertCurrent();}catch(error){entry.controller.abort(error);throw error;}
    res.json(value);
  });
  router.post('/retests', (req,res) => {
    const who=options.authorize(req),input=parse(retestSchema,req.body);
    const fingerprint=['retest',who.childId ?? '',input],old=operation(who.familyId,input.operationId,fingerprint);
    if(old){const saved=retest(who.familyId,old.result);if(saved)return res.status(saved.status==='pending'?202:200).json(saved);throw fail(410,'这次复测已停止或删除，不会重复调用。','ADOPTION_UNAVAILABLE');}
    options.assertOpen();if(!options.configured)throw fail(503,'对话服务尚未配置，不能复测。','NOT_CONFIGURED');
    if([...pending.values()].some(value=>value.familyId===who.familyId)||pending.size>=10)throw fail(429,'已有比较或复测正在进行，请先等待或停止。','ADOPTION_BUSY');
    const items=input.cases.map(value=>source(who.familyId,value.id,value.revision));
    if(items.some(item=>!item.expectedReply.trim()))throw fail(400,'所选场景还没有保存满意回答，请先补好参考回答再一起复测。','ADOPTION_REVIEW_REQUIRED');
    if(options.canCompare && items.some(item=>!options.canCompare!(item.question)))throw fail(400,'选中的问题含需要原有安全处理的内容，请先移除这一题。','ADOPTION_UNSUPPORTED_INPUT');
    const own=db.prepare('SELECT count(*) AS n FROM scene_adoption_retests WHERE family_id=?').get(who.familyId) as {n:number};
    const all=db.prepare('SELECT count(*) AS n FROM scene_adoption_retests').get() as {n:number};
    if(own.n>=100||all.n>=1000)throw fail(429,'复测记录已满，请先删除不再使用的场景。','ADOPTION_LIMIT');
    const base=current(who.familyId),controller=new AbortController(),key=`${who.familyId}:${input.operationId}`;
    const assertCurrent=()=>{
      running();options.assertOpen();if(controller.signal.aborted)throw controller.signal.reason;
      const check=options.authorize(req);if(check.familyId!==who.familyId||check.deviceHash!==who.deviceHash||check.childId!==who.childId)throw fail(403,'管理权限或孩子资料已变化，请重新进入。','PARENT_REQUIRED');
      for(const item of items)source(who.familyId,item.id,item.revision);
      if(current(who.familyId).version!==base.version)throw conflict();
    };
    const value:SceneRetest={id:randomUUID(),operationId:input.operationId,status:'pending',completed:0,total:items.length,cases:input.cases,baseVersion:base.version,createdAt:stamp(),completedAt:'',model:options.model,personaVersion:BAOYAN_PERSONA_VERSION,replyPlanVersion:REPLY_PLAN_VERSION,policyVersion:SCENE_ADOPTION_VERSION,conversationPolicyVersion:CONVERSATION_POLICY_VERSION,scope:options.scope,rows:[]};
    transaction(()=>{reserve(who.familyId,input.operationId,fingerprint);db.prepare('INSERT INTO scene_adoption_retests VALUES(?,?,?,?)').run(value.id,who.familyId,JSON.stringify(value),now());finish(who.familyId,input.operationId,'pending',value.id);});
    pending.set(key,{familyId:who.familyId,deviceHash:who.deviceHash,controller,assertCurrent});
    const persist=()=>{if(!closed)db.prepare('UPDATE scene_adoption_retests SET payload=? WHERE family_id=? AND id=?').run(JSON.stringify(value),who.familyId,value.id);};
    const timeout=setTimeout(()=>controller.abort(fail(504,'复测等待过久，已停止，不会自动重试。','ADOPTION_TIMEOUT')),90000);timeout.unref();
    res.status(202).json(value);
    void(async()=>{
      try{
        for(const item of items){
          assertCurrent();const started=performance.now();const extra=guidanceFor(who.familyId,item.ageGroup,item.question);
          const row:SceneRetest['rows'][number]={caseId:item.id,caseRevision:item.revision,title:item.title,question:item.question,ageGroup:item.ageGroup,expectedReply:item.expectedReply,elapsedMs:0,adopted:Boolean(extra)};
          try{
            const system=buildBaoyanPrompt({today:new Date(now()+8*3600000).toISOString().slice(0,10),ageGroup:item.ageGroup,speaker:'child',memories:item.testMemories,textProvenance:true});
            const reply=(await abortable(options.invoke(sceneReplyMessages(system,item.testHistory,item.question,extra),controller.signal),controller.signal)).trim();
            assertCurrent();if(!reply||reply.length>1200||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(reply))throw new Error('incomplete');
            options.assertFictional(reply);row.reply=reply;
          }catch(error){assertCurrent();if(error instanceof ApiError && ['TRIAL_EXPIRED','TRIAL_DAILY_LIMIT','TRIAL_BUSY'].includes(error.code))throw error;row.error='这题未完整生成，可以保留其他结果，稍后手动重试。';}
          row.elapsedMs=Math.round(performance.now()-started);value.rows.push(row);value.completed=value.rows.length;persist();
        }
        assertCurrent();value.status='completed';value.completedAt=stamp();persist();finish(who.familyId,input.operationId,'completed',value.id);
      }catch(error){controller.abort(error);value.status=error instanceof ApiError&&error.code==='REQUEST_ABORTED'?'cancelled':'failed';value.completedAt=stamp();value.error=error instanceof ApiError&&['REQUEST_ABORTED','ADOPTION_TIMEOUT','ADOPTION_CONFLICT','PARENT_REQUIRED','TRIAL_EXPIRED','TRIAL_DAILY_LIMIT','TRIAL_BUSY'].includes(error.code)?error.message:'复测未完成，请重新进入后再试。';persist();if(!closed)finish(who.familyId,input.operationId,value.status,value.id);}
      finally{clearTimeout(timeout);pending.delete(key);}
    })();
  });
  router.post('/retests/:operationId/cancel', (req,res)=>{
    const who=options.authorize(req),id=parse(z.string().uuid(),req.params.operationId);parse(z.object({}).strict(),req.body??{});
    const entry=pending.get(`${who.familyId}:${id}`);
    if(entry){if(entry.deviceHash!==who.deviceHash)throw fail(403,'请在开始复测的设备上停止。','PARENT_REQUIRED');entry.controller.abort(stopped());}
    else if(!db.prepare('SELECT 1 FROM scene_adoption_operations WHERE family_id=? AND operation_id=?').get(who.familyId,id)){reserve(who.familyId,id,['retest-cancelled']);finish(who.familyId,id,'cancelled');}
    res.json({ok:true});
  });
  router.get('/comparisons/:id', (req, res) => {
    const who = options.authorize(req), value = report(who.familyId, parse(z.string().uuid(), req.params.id));
    if (!value) throw fail(404, '比较记录不存在。', 'NOT_FOUND');
    const entry = pending.get(`${who.familyId}:${value.operationId}`); if (entry) try { entry.assertCurrent(); } catch (error) { entry.controller.abort(error); throw error; }
    res.json(value);
  });
  router.post('/compare', (req, res) => {
    const who = options.authorize(req), input = parse(compareSchema, req.body);
    const fingerprint = ['compare', who.childId ?? '', input], old = operation(who.familyId, input.operationId, fingerprint);
    if (old) {
      const saved = report(who.familyId, old.result);
      if (saved) return res.status(saved.status === 'pending' ? 202 : 200).json(saved);
      throw fail(410, '这次比较已停止或删除，不会重复调用。', 'ADOPTION_UNAVAILABLE');
    }
    options.assertOpen();
    if (!options.configured) throw fail(503, '对话服务尚未配置，不能生成对比。', 'NOT_CONFIGURED');
    if ([...pending.values()].some(value => value.familyId === who.familyId) || pending.size >= 10) throw fail(429, '已有比较正在进行，请先等待或停止。', 'ADOPTION_BUSY');
    const item = source(who.familyId, input.caseId, input.caseRevision);
    const directionPreview = input.directionId ? preview(who.familyId,input.directionId) : undefined;
    if (input.directionId && (!directionPreview || directionPreview.caseId !== item.id || directionPreview.caseRevision !== item.revision || directionPreview.intent !== input.intent || !currentVersions(directionPreview) || Date.parse(directionPreview.expiresAt) <= now())) throw conflict();
    if (options.canCompare && !options.canCompare(item.question)) throw fail(400,'这个问题需要保留原有安全处理，不能采用接话偏好。','ADOPTION_UNSUPPORTED_INPUT');
    if (adoptionIntent(item.question) !== input.intent) throw fail(400, '这条场景暂不匹配所选情况，请选择对应情况；不确定的场景先保留参考。', 'ADOPTION_INTENT_MISMATCH');
    const ownCount = db.prepare('SELECT count(*) AS n FROM scene_adoption_reports WHERE family_id=?').get(who.familyId) as { n: number };
    const allCount = db.prepare('SELECT count(*) AS n FROM scene_adoption_reports').get() as { n: number };
    if (ownCount.n >= 100 || allCount.n >= 1000) throw fail(429, '比较记录已满，请先删除不再使用的场景。', 'ADOPTION_LIMIT');
    const base = current(who.familyId), controller = new AbortController();
    const key = `${who.familyId}:${input.operationId}`;
    const assertCurrent = () => {
      running(); options.assertOpen(); if (controller.signal.aborted) throw controller.signal.reason;
      const check = options.authorize(req);
      if (check.familyId !== who.familyId || check.deviceHash !== who.deviceHash || check.childId !== who.childId) throw fail(403, '管理权限或孩子资料已变化，请重新进入。', 'PARENT_REQUIRED');
      source(who.familyId, item.id, item.revision);
      if (current(who.familyId).version !== base.version) throw conflict();
    };
    const result: AdoptionComparison = { id: randomUUID(), operationId: input.operationId, status: 'pending', completedPairs: 0, total: 3,
      caseId: item.id, caseRevision: item.revision, baseVersion: base.version, ageGroup: item.ageGroup, intent: input.intent, preferences: input.preferences ?? [], ...(directionPreview ? { direction: directionPreview.direction, directionId: directionPreview.id } : {}),
      model: options.model, personaVersion: BAOYAN_PERSONA_VERSION, replyPlanVersion: REPLY_PLAN_VERSION, policyVersion: SCENE_ADOPTION_VERSION, conversationPolicyVersion: CONVERSATION_POLICY_VERSION,
      createdAt: stamp(), completedAt: '', expiresAt: new Date(now() + 24 * 3600000).toISOString(), scope: options.scope, rows: [] };
    transaction(() => { reserve(who.familyId, input.operationId, fingerprint); db.prepare('INSERT INTO scene_adoption_reports VALUES(?,?,?,?,?)').run(result.id, who.familyId, item.id, JSON.stringify(result), now()); finish(who.familyId, input.operationId, 'pending', result.id); });
    pending.set(key, { familyId: who.familyId, deviceHash: who.deviceHash, controller, assertCurrent });
    const persist = () => { if (!closed) db.prepare('UPDATE scene_adoption_reports SET payload=? WHERE family_id=? AND id=?').run(JSON.stringify(result), who.familyId, result.id); };
    const timeout = setTimeout(() => controller.abort(fail(504, '比较等待过久，已停止，不会自动采用。', 'ADOPTION_TIMEOUT')), 90000); timeout.unref();
    res.status(202).json(result);
    // Explicit job lifecycle: response completion does not cancel, client cancellation does.
    void (async () => {
      try {
        const otherAge: Age = item.ageGroup === '3-5' ? '9-12' : '3-5';
        const guardQuestion = input.intent === 'knowledge' ? '我今天画了一只小猫，想给你讲讲。' : '为什么下雨以后会有彩虹？';
        const entries = [{ question: item.question, ageGroup: item.ageGroup, label: '保存的场景' }, { question: probes[input.intent][0]!, ageGroup: item.ageGroup, label: '同类新问题' }, { question: guardQuestion, ageGroup: otherAge, label: '其他年龄与话题：不套用新方向' }];
        for (const [index, entry] of entries.entries()) {
          assertCurrent();
          const { question, ageGroup, label } = entry;
          const testHistory = index === 0 ? item.testHistory : [];
          const baselinePrompt = buildBaoyanPrompt({ today: new Date(now() + 8 * 3600000).toISOString().slice(0, 10), ageGroup, speaker: 'child', memories: index === 0 ? item.testMemories : [], textProvenance: true });
          const matched = ageGroup === item.ageGroup && adoptionIntent(question) === input.intent;
          const currentGuidance = base.active?.ageGroup === ageGroup && base.active.intent === adoptionIntent(question) ? receiptGuidance(base.active) : '';
          const generate = async (extra: string) => {
            assertCurrent(); const started = performance.now();
            try {
              const reply = (await abortable(options.invoke(sceneReplyMessages(baselinePrompt, testHistory, question, extra), controller.signal), controller.signal)).trim();
              assertCurrent();
              if (!reply || reply.length > 1200 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(reply)) throw new Error('incomplete');
              options.assertFictional(reply);
              return { reply, elapsedMs: Math.round(performance.now() - started) };
            } catch (error) {
              assertCurrent();
              if (error instanceof ApiError && ['TRIAL_EXPIRED', 'TRIAL_DAILY_LIMIT', 'TRIAL_BUSY'].includes(error.code)) throw error;
              return { error: '这份回答未完整生成，不能采用本次比较。', elapsedMs: Math.round(performance.now() - started) };
            }
          };
          const baseline = await generate(currentGuidance);
          const candidate = baseline.reply ? await generate(matched ? receiptGuidance(result) : '') : { error: '前一份生成失败，已停止。', elapsedMs: 0 };
          result.rows.push({ id: String(index), label, question, ageGroup, baseline, candidate });
          result.completedPairs = result.rows.length; persist();
          if (!baseline.reply || !candidate.reply) throw fail(502, '回答没有完整生成，不能采用本次比较。', 'PROVIDER_INCOMPLETE');
        }
        assertCurrent(); result.status = 'completed'; result.completedAt = stamp(); persist(); finish(who.familyId, input.operationId, 'completed', result.id);
      } catch (error) {
        controller.abort(error);
        result.status = error instanceof ApiError && error.code === 'REQUEST_ABORTED' ? 'cancelled' : 'failed';
        result.completedAt = stamp(); result.error = error instanceof ApiError && ['REQUEST_ABORTED', 'ADOPTION_TIMEOUT', 'ADOPTION_CONFLICT', 'PARENT_REQUIRED', 'TRIAL_EXPIRED', 'TRIAL_DAILY_LIMIT', 'TRIAL_BUSY', 'PROVIDER_INCOMPLETE'].includes(error.code) ? error.message : '比较未完成，请重新进入后再试。';
        persist(); if (!closed) finish(who.familyId, input.operationId, result.status, result.id);
      } finally { clearTimeout(timeout); pending.delete(key); }
    })();
  });
  router.post('/compare/:operationId/cancel', (req, res) => {
    const who = options.authorize(req), id = parse(z.string().uuid(), req.params.operationId);
    parse(z.object({}).strict(), req.body ?? {});
    const entry = pending.get(`${who.familyId}:${id}`);
    if (entry) { if (entry.deviceHash !== who.deviceHash) throw fail(403, '请在开始比较的设备上停止。', 'PARENT_REQUIRED'); entry.controller.abort(stopped()); }
    else if (!db.prepare('SELECT 1 FROM scene_adoption_operations WHERE family_id=? AND operation_id=?').get(who.familyId, id)) { reserve(who.familyId, id, ['cancelled']); finish(who.familyId, id, 'cancelled'); }
    res.json({ ok: true });
  });
  router.post('/apply', (req, res) => {
    const who = options.authorize(req), input = parse(applySchema, req.body);
    const result = transaction(() => {
      const old = operation(who.familyId, input.operationId, ['apply', input]);
      if (old) return { receipt: JSON.parse(old.result) as AdoptionReceipt, state: current(who.familyId) };
      options.assertOpen(); const value = report(who.familyId, input.comparisonId);
      if (!value) throw fail(404, '比较记录不存在。', 'NOT_FOUND');
      const before = current(who.familyId);
      if (before.version !== input.expectedVersion || value.baseVersion !== before.version || !currentVersions(value) || Date.parse(value.expiresAt) <= now()) throw conflict();
      source(who.familyId, value.caseId, value.caseRevision);
      if (value.status !== 'completed' || value.rows.length !== 3 || value.rows.some(row => !row.baseline.reply || !row.candidate.reply) || input.choices.some(choice => choice !== 'candidate' && choice !== 'tie') || !input.choices.slice(0,2).includes('candidate')) throw fail(400, '请看完三组回答；只有新版至少一组更好且没有更差，才可采用。', 'ADOPTION_REVIEW_REQUIRED');
      reserve(who.familyId, input.operationId, ['apply', input]);
      const receipt: AdoptionReceipt = { id: randomUUID(), version: before.version + 1, comparisonId: value.id, caseId: value.caseId, caseRevision: value.caseRevision, ageGroup: value.ageGroup, intent: value.intent, preferences: value.preferences, ...(value.direction ? {direction: value.direction, directionId: value.directionId} : {}), model: value.model, personaVersion: value.personaVersion, replyPlanVersion: value.replyPlanVersion, policyVersion: value.policyVersion, conversationPolicyVersion: value.conversationPolicyVersion, appliedAt: stamp(), scope: options.scope, choices: input.choices };
      const next = { version: receipt.version, active: receipt, lastChange: { at: receipt.appliedAt, reason: '家长确认三组比较后采用', ...(before.active ? { previousId: before.active.id } : {}) } };
      writeState(who.familyId, next); options.onChange?.(who.familyId);
      finish(who.familyId, input.operationId, 'applied', JSON.stringify(receipt));
      return { receipt, state: next };
    });
    res.json(result);
  });
  router.post('/revoke', (req, res) => {
    const who = options.authorize(req), input = parse(revokeSchema, req.body);
    const result = transaction(() => {
      const old = operation(who.familyId, input.operationId, ['revoke', input]);
      if (old) return { state: current(who.familyId), revokedAt: JSON.parse(old.result).revokedAt };
      const before = current(who.familyId); if (before.version !== input.expectedVersion) throw conflict();
      if (!before.active) return {state:before,revokedAt:before.lastChange?.at ?? stamp()};
      reserve(who.familyId, input.operationId, ['revoke', input], true);
      const value = { state: withdrawActive(who.familyId, '家长已撤回，恢复默认接话'), revokedAt: stamp() };
      finish(who.familyId, input.operationId, 'revoked', JSON.stringify({ revokedAt: value.revokedAt })); return value;
    });
    res.json(result);
  });
  return { router, guidanceFor, current,
    caseChanged(familyId: string, id: string, deleted = false) {
      for (const entry of pending.values()) if (entry.familyId === familyId) entry.controller.abort(conflict());
      if (state(familyId).active?.caseId === id) withdrawActive(familyId, deleted ? '场景已删除，已停止采用' : '场景已重新审核，已停止采用');
      if (deleted) {
        db.prepare('DELETE FROM scene_adoption_reports WHERE family_id=? AND case_id=?').run(familyId,id);
        db.prepare('DELETE FROM scene_adoption_directions WHERE family_id=? AND case_id=?').run(familyId,id);
        // Retests reference 3–5 scenes in their payload. Delete the entire run when
        // any source is deleted, so no copy of deleted question/reply survives.
        for(const row of db.prepare('SELECT id,payload FROM scene_adoption_retests WHERE family_id=?').all(familyId) as {id:string;payload:string}[]) {
          if((JSON.parse(row.payload) as SceneRetest).cases.some(item=>item.id===id))db.prepare('DELETE FROM scene_adoption_retests WHERE id=? AND family_id=?').run(row.id,familyId);
        }
      }
    },
    sweep() { if (!closed) for (const entry of pending.values()) try { entry.assertCurrent(); } catch (error) { entry.controller.abort(error); } },
    revokeDevice(deviceHash: string) { for (const entry of pending.values()) if (entry.deviceHash === deviceHash) entry.controller.abort(stopped()); },
    withdraw(familyId: string) { for (const entry of pending.values()) if (entry.familyId === familyId) entry.controller.abort(stopped()); for (const table of ['scene_adoption_states', 'scene_adoption_reports', 'scene_adoption_operations', 'scene_adoption_directions', 'scene_adoption_retests']) db.prepare(`DELETE FROM ${table} WHERE family_id=?`).run(familyId); },
    close() { closed = true; for (const entry of pending.values()) entry.controller.abort(stopped()); pending.clear(); },
  };
}

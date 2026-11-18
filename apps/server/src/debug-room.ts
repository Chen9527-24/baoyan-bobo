import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { ApiError, type createProviders } from './providers.js';
import { BAOYAN_PERSONA_VERSION, buildBaoyanPrompt } from './baoyan-persona.js';
import { boundedContextReply, boundedPresenceReply, type ConversationMessage } from './conversation-policy.js';
import { avatarExpression, selectReplyExpression, type SpeechExpression } from './reply-expression.js';
import { sceneReplyMessages } from './scene-adoption.js';
import { assertFictionalContent, createCalibrationLibrary } from './calibration-library.js';
import { createReplyAdjustment } from './reply-adjustment.js';
import { pcmFromWav } from './volc-asr.js';
import { finalizeReplyPlan, REPLY_PLAN_VERSION, type ReplyPlan, type ReplySegment } from './reply-plan.js';

export const DEBUG_ROOM_LIMITS = { ttlMs: 30 * 60_000, sessions: 16, operations: 200, attempts: 5, attemptWindowMs: 60_000, ipBuckets: 1000, globalAttempts: 40, historyMessages: 8, timeoutMs: 30_000 } as const;
const COOKIE = 'baoyan_debug';
const SCOPE = 'baoyan-debug-project';
const CHILD = '00000000-0000-4000-8000-000000000001';
const age = z.enum(['3-5', '6-8', '9-12', '13-14']);
const operationId = z.string().uuid();
const textInput = z.object({ operationId, text: z.string().trim().min(1).max(1000), ageGroup: age }).strict();
type DebugTurn = { replyId: string; question: string; reply: string; replySegments: ReplySegment[]; replyPlanVersion: string; replyPlanAction: ReplyPlan['action']; emotion: ReturnType<typeof avatarExpression>; ageGroup: z.infer<typeof age>; testHistory: ConversationMessage[]; model: string; personaVersion: string };
type Operation = { fingerprint: string; state: 'pending' | 'complete' | 'cancelled'; result?: DebugTurn };
type Session = { hash: string; expires: number; generation: number; ageGroup: z.infer<typeof age>; history: ConversationMessage[]; operations: Map<string, Operation>; pending: Set<AbortController>; reply?: { id: string; text: string; expression: SpeechExpression; segments?: ReplySegment[]; operationId?: string }; busy?: string };
type Options = {
  env: Record<string, string | undefined>; now: () => number; dataPath: string;
  provider: ReturnType<typeof createProviders>;
  invoke: <T>(task: (signal: AbortSignal) => Promise<T>, signal: AbortSignal) => Promise<T>;
  assertOpen: () => void;
  guards: { privacyPattern: RegExp; unsafePattern: RegExp; unsafeReply: (text: string) => boolean; safetyReply: string };
};
const fail = (status: number, message: string, code: string) => new ApiError(status, message, code);
const missing = () => fail(401, '请重新输入内测调试密码。', 'DEBUG_REQUIRED');
const cancelled = () => fail(499, '这次调试已取消。', 'REQUEST_ABORTED');
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function validateDebugPasswordHash(value: string | undefined) {
  const normalized = value?.trim();
  if (normalized && (!/^[a-f0-9]{32,128}:[a-f0-9]{128}$/i.test(normalized) || normalized.split(':')[0]!.length % 2 !== 0)) throw new Error('DEBUG_PASSWORD_HASH 格式无效。');
  return normalized;
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw fail(400, '请检查调试内容与长度。', 'INVALID_INPUT');
  return result.data;
}
function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason instanceof ApiError ? signal.reason : cancelled());
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Separate fictional workspace. No normal account/device/parent token is issued or read. */
export function createDebugRoom(options: Options) {
  const { now, provider, guards } = options;
  const passwordHash = validateDebugPasswordHash(options.env.DEBUG_PASSWORD_HASH);
  const enabled = Boolean(passwordHash);
  const sessions = new Map<string, Session>();
  const attempts = new Map<string, { until: number; count: number }>();
  let globalAttemptWindow = 0, globalAttempts = 0, closed = false;
  // The persistent database contains only explicit fictional calibration cases.
  // It has no access to the application's household database.
  if (enabled && options.dataPath !== ':memory:') mkdirSync(dirname(options.dataPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(enabled ? options.dataPath : ':memory:');
  if (enabled && options.dataPath !== ':memory:') chmodSync(options.dataPath, 0o600);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS families(id TEXT PRIMARY KEY);');
  db.prepare('INSERT OR IGNORE INTO families(id) VALUES(?)').run(SCOPE);
  const cookie = { httpOnly: true, sameSite: 'strict' as const, secure: options.env.NODE_ENV === 'production', path: '/api/debug' };
  const router = Router();
  function forget(session: Session) {
    sessions.delete(session.hash); session.generation++;
    for (const controller of session.pending) controller.abort(missing());
    session.pending.clear(); session.history = []; session.reply = undefined; session.operations.clear();
    adjustment.revokeDevice(session.hash, missing()); library.adoption?.revokeDevice(session.hash);
  }
  function sweep() {
    if (closed) return;
    for (const session of sessions.values()) if (session.expires <= now()) forget(session);
    for (const [ip, entry] of attempts) if (entry.until <= now()) attempts.delete(ip);
    adjustment.sweep(); library.adoption?.sweep();
  }
  function authorized(req: Request): Session {
    if (closed || !enabled) throw missing();
    const token = req.cookies?.[COOKIE];
    if (typeof token !== 'string' || token.length !== 43) throw missing();
    const session = sessions.get(hash(token));
    if (!session || session.expires <= now()) { if (session) forget(session); throw missing(); }
    return session;
  }
  const authorize = (req: Request) => ({ familyId: SCOPE, deviceHash: authorized(req).hash });
  const library = createCalibrationLibrary({ db, now, scope:'debug', formalModel:provider.textChatModel || '未配置', authorize, adoption: {
    configured: provider.capabilities.chat, assertOpen: options.assertOpen, canCompare: question => !guards.privacyPattern.test(question)&&!guards.unsafePattern.test(question),
    invoke: async (messages, signal) => { const plan=await options.invoke(inner => provider.planReply(messages, inner), signal); const question=messages.at(-1)?.content??''; const safety=guards.unsafeReply(plan.reply); let reply=safety?'这个话题需要更谨慎一些。我们可以换一个安全、具体的小问题；涉及危险或身体不适时，请找身边可信任的大人帮忙。':plan.reply; reply=boundedPresenceReply(question,reply)??reply; reply=boundedContextReply(question,reply)??reply; return finalizeReplyPlan(reply,plan,selectReplyExpression({inputText:question,reply,safety})).reply; },
    onChange: () => { for (const session of sessions.values()) { session.generation++; session.reply=undefined; for(const operation of session.operations.values()){operation.state='cancelled';operation.result=undefined;} for(const controller of session.pending)controller.abort(cancelled()); session.pending.clear(); } },
  } });
  const adjustment = createReplyAdjustment({ db, now, configured: provider.capabilities.chat, model: provider.textChatModel || '未配置', library,
    authorize: req => { const session = authorized(req); if (req.get('X-Baoyan-Child') !== CHILD) throw fail(409, '调试上下文已变化，请重新打开。', 'REPLY_ADJUSTMENT_CHILD_CHANGED'); return { familyId: SCOPE, deviceHash: session.hash, childId: CHILD }; },
    assertOpen: options.assertOpen,
    invoke: (messages, signal) => options.invoke(inner => provider.chat(messages, inner), signal),
  });
  router.use((_req, _res, next) => { if (closed) throw missing(); sweep(); next(); });
  const capabilities = () => ({ chat: provider.capabilities.chat, asr: provider.capabilities.asr, tts: provider.capabilities.tts, ttsStreaming: provider.capabilities.ttsStreaming });
  const status = (session?: Session) => ({ enabled, authorized: Boolean(session), configured: provider.capabilities.chat, capabilities: capabilities(), audioInputFormat: provider.audioInputFormat,
    ttlMs: DEBUG_ROOM_LIMITS.ttlMs, scopeChildId: CHILD, ...(session ? { expiresAt: new Date(session.expires).toISOString(), adoptionVersion: library.adoption?.current(SCOPE).version ?? 0 } : {}), ageGroup: session?.ageGroup ?? '6-8', mode: 'chat', sharedLibrary: true });
  router.get('/status', (req, res) => res.json(status(req.cookies?.[COOKIE] === undefined ? undefined : authorized(req))));
  router.post('/unlock', (req, res) => {
    if (!enabled) throw fail(503, '内测调试入口暂未启用。', 'DEBUG_DISABLED');
    const input = parse(z.object({ password: z.string().min(1).max(128) }).strict(), req.body);
    const ip = hash(req.ip ?? 'unknown');
    const at = now();
    if (globalAttemptWindow + DEBUG_ROOM_LIMITS.attemptWindowMs <= at) { globalAttemptWindow = at; globalAttempts = 0; }
    const entry = attempts.get(ip);
    if (globalAttempts >= DEBUG_ROOM_LIMITS.globalAttempts || (entry && entry.count >= DEBUG_ROOM_LIMITS.attempts) || (!entry && attempts.size >= DEBUG_ROOM_LIMITS.ipBuckets)) throw fail(429, '尝试较多，请一分钟后再试。', 'DEBUG_RATE_LIMIT');
    globalAttempts++; attempts.set(ip, { until: entry?.until ?? at + DEBUG_ROOM_LIMITS.attemptWindowMs, count: (entry?.count ?? 0) + 1 });
    const [salt, expected] = passwordHash!.split(':') as [string, string];
    const actual = scryptSync(input.password, Buffer.from(salt, 'hex'), 64);
    const valid = timingSafeEqual(actual, Buffer.from(expected, 'hex')); actual.fill(0);
    if (!valid) throw fail(403, '调试密码不正确。', 'DEBUG_PASSWORD_INVALID');
    const prior = req.cookies?.[COOKIE]; const old = typeof prior === 'string' ? sessions.get(hash(prior)) : undefined;
    if (sessions.size >= DEBUG_ROOM_LIMITS.sessions && !old) throw fail(429, '调试人数较多，请稍后再试。', 'DEBUG_BUSY');
    if (old) forget(old);
    const token = randomBytes(32).toString('base64url');
    const session: Session = { hash: hash(token), expires: at + DEBUG_ROOM_LIMITS.ttlMs, generation: 0, ageGroup: '6-8', history: [], operations: new Map(), pending: new Set() };
    sessions.set(session.hash, session); attempts.delete(ip);
    res.cookie(COOKIE, token, { ...cookie, maxAge: DEBUG_ROOM_LIMITS.ttlMs }); res.json(status(session));
  });
  router.post('/lock', (req, res) => { parse(z.object({}).strict(), req.body ?? {}); forget(authorized(req)); res.clearCookie(COOKIE, cookie); res.json({ ok: true }); });
  router.get('/config', (req, res) => { authorized(req); res.json({ configured: provider.capabilities.chat }); });
  router.use('/calibration', library.router);
  router.use('/reply-adjustment', adjustment.router);

  function current(session: Session, generation: number) {
    if (closed || sessions.get(session.hash) !== session || session.expires <= now()) { if (!closed && sessions.get(session.hash) === session) forget(session); throw missing(); }
    if (session.generation !== generation) throw cancelled();
  }
  async function work<T>(req: Request, res: Response, session: Session, generation: number, task: (signal: AbortSignal) => Promise<T>, sourceSignal?: AbortSignal): Promise<T> {
    current(session, generation); options.assertOpen();
    const controller = new AbortController(); session.pending.add(controller);
    const sourceAbort = () => controller.abort(cancelled());
    sourceSignal?.addEventListener('abort', sourceAbort, { once: true }); if (sourceSignal?.aborted) sourceAbort();
    const disconnect = () => { if (!res.writableEnded) controller.abort(cancelled()); };
    res.once('close', disconnect);
    if (res.destroyed || res.writableEnded) controller.abort(cancelled());
    const timer = setTimeout(() => controller.abort(fail(504, '这次调试等待过久，请重试。', 'DEBUG_TIMEOUT')), DEBUG_ROOM_LIMITS.timeoutMs); timer.unref();
    try { const value = await abortable(options.invoke(task, controller.signal), controller.signal); current(session, generation); if (controller.signal.aborted) throw controller.signal.reason; return value; }
    finally { clearTimeout(timer); session.pending.delete(controller); res.off('close', disconnect); sourceSignal?.removeEventListener('abort', sourceAbort); }
  }
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 2, parts: 3 }, fileFilter: (_req, file, callback) => {
    if (!['audio/webm', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp4', 'audio/x-m4a'].includes(file.mimetype.split(';')[0]!)) return callback(fail(415, '请重新录制支持的语音。', 'AUDIO_TYPE'));
    callback(null, true);
  } });
  router.post('/turn', (req, res, next) => {
    const session = authorized(req);
    options.assertOpen();
    // Reserve a generation before receiving an upload; cancel/exit wins over late uploads.
    let generation = session.generation;
    const receive = (error?: unknown) => {
      if (error) { req.file?.buffer.fill(0); next(error); return; }
      void (async () => {
        let entry: Operation | undefined, entryId: string | undefined;
        try {
          current(session, generation);
          const isAudio = req.is('multipart/form-data');
          const input = isAudio ? parse(z.object({ operationId, ageGroup: age }).strict(), req.body) : parse(textInput, req.body);
          const id = input.operationId;
          const file = req.file;
          if (isAudio && !file?.buffer.length) throw fail(400, '请先录一句话。', 'AUDIO_REQUIRED');
          const fingerprint = hash(JSON.stringify([input.ageGroup, isAudio ? 'audio' : 'text', 'text' in input ? input.text : [file!.mimetype, hash(file!.buffer)]]));
          const previous = session.operations.get(id);
          if (previous) {
            if (previous.state === 'cancelled') throw cancelled();
            if (previous.fingerprint !== fingerprint) throw fail(409, '同一次调试的内容已变化。', 'OPERATION_CONFLICT');
            if (previous.result) { res.json(previous.result); return; }
            throw fail(409, '正在回答，请等待或停止。', 'DEBUG_PENDING');
          }
          if (session.busy) throw fail(409, '正在回答，请等待或停止。', 'DEBUG_PENDING');
          if (session.operations.size >= DEBUG_ROOM_LIMITS.operations) throw fail(429, '这次调试次数已满，请退出后重新进入。', 'DEBUG_OPERATION_LIMIT');
          if (!provider.capabilities.chat) throw fail(503, '对话服务暂未配置。', 'NOT_CONFIGURED');
          entry = { fingerprint, state: 'pending' }; entryId = id; session.operations.set(id, entry); session.busy = id; session.reply = undefined;
          for (const controller of session.pending) controller.abort(cancelled());
          generation = ++session.generation;
          // A changed simulated age starts a new fictional context.
          if (session.ageGroup !== input.ageGroup) session.history = [];
          session.ageGroup = input.ageGroup;
          let question: string;
          if (isAudio) {
            if (!provider.capabilities.asr) throw fail(503, '语音识别暂未配置。', 'ASR_NOT_CONFIGURED');
            if (provider.audioInputFormat === 'wav') pcmFromWav(file!.buffer, file!.mimetype);
            question = (await work(req, res, session, generation, signal => provider.transcribe(file!.buffer, file!.mimetype, signal))).trim();
            if (!question || question.length > 1000) throw fail(422, '没有听清，或这句话太长，请再说短一点。', 'AUDIO_EMPTY');
          } else question = (input as z.infer<typeof textInput>).text;
          current(session, generation);
          const testHistory = session.history.map(item => ({ ...item }));
          let reply: string, safety = false, plan: ReplyPlan | undefined;
          const privateInput = guards.privacyPattern.test(question), unsafeInput = guards.unsafePattern.test(question);
          if (unsafeInput) { reply = guards.safetyReply; safety = true; }
          else if (privateInput) reply = '这类私人信息不适合放进聊天或记忆里，请不要发送密码、住址、电话等内容。我们可以换成不含身份信息的描述。';
          else {
            assertFictionalContent(question);
            const system = buildBaoyanPrompt({ today: new Date(now() + 8 * 3600000).toISOString().slice(0, 10), ageGroup: input.ageGroup, speaker: 'child', memories: [], textProvenance:true });
            const adopted = library.adoption?.guidanceFor(SCOPE,input.ageGroup,question) ?? '';
            plan = await work(req, res, session, generation, signal => provider.planReply(sceneReplyMessages(system,testHistory,question,adopted), signal));
            reply = plan.reply;
            if (guards.unsafeReply(reply)) { safety = true; reply = '这个话题需要更谨慎一些。我们可以换一个安全、具体的小问题；涉及危险或身体不适时，请找身边可信任的大人帮忙。'; }
          }
          reply = boundedPresenceReply(question, reply) ?? reply; reply = boundedContextReply(question, reply) ?? reply;
          if (!reply.trim() || reply.length > 1200) throw fail(502, '这次回答不完整，请重新试一次。', 'PROVIDER_INCOMPLETE');
          current(session, generation);
          const expression = selectReplyExpression({ inputText: question, reply, safety, operational: privateInput });
          plan = finalizeReplyPlan(reply, plan, expression);
          const result: DebugTurn = { replyId: randomUUID(), question, reply: plan.reply, replySegments: plan.segments, replyPlanVersion: REPLY_PLAN_VERSION, replyPlanAction: plan.action, emotion: avatarExpression(plan.segments[0]!.expression), ageGroup: input.ageGroup, testHistory, model: provider.textChatModel || '未配置', personaVersion: BAOYAN_PERSONA_VERSION };
          session.reply = { id: result.replyId, text: plan.reply, expression, segments: plan.segments, operationId: id };
          if (!privateInput && !unsafeInput) session.history = [...testHistory, { role: 'user', content: question }, { role: 'assistant', content: reply }].slice(-DEBUG_ROOM_LIMITS.historyMessages);
          entry.result = result; entry.state = 'complete'; res.json(result);
        } catch (error) { if (entry) { entry.state = 'cancelled'; entry.result = undefined; } throw error; }
        finally { if (entry && session.busy === entryId) session.busy = undefined; req.file?.buffer.fill(0); }
      })().catch(error => { if (!res.destroyed && !res.writableEnded) next(error); });
    };
    if (req.is('multipart/form-data')) upload.single('audio')(req, res, receive); else receive();
  });
  router.post('/cancel', (req, res) => {
    const session = authorized(req); const input = parse(z.object({ operationId }).strict(), req.body);
    if (!session.operations.has(input.operationId) && session.operations.size >= DEBUG_ROOM_LIMITS.operations) throw fail(429, '这次调试次数已满，请重新进入。', 'DEBUG_OPERATION_LIMIT');
    const isCurrent = session.busy === input.operationId || session.reply?.operationId === input.operationId;
    session.operations.set(input.operationId, { fingerprint: '', state: 'cancelled' });
    // A delayed stop for an older turn must not cancel a newer turn/voice reply.
    if (isCurrent) { session.generation++; session.reply = undefined; for (const controller of session.pending) controller.abort(cancelled()); session.busy = undefined; }
    res.json({ ok: true });
  });
  router.post('/speech/:replyId', async (req, res, next) => {
    const session = authorized(req), generation = session.generation;
    const id = parse(z.string().uuid(), req.params.replyId);
    const input = parse(z.object({ replyId: z.string().uuid().optional(), segmentIndex: z.number().int().min(0).max(2).optional() }).strict(), req.body ?? {});
    if (input.replyId !== undefined && input.replyId !== id) throw fail(400, '回复编号不一致。', 'INVALID_INPUT');
    let reply = session.reply;
    let checkPreview = () => {};
    let sourceSignal: AbortSignal | undefined;
    if (!reply || reply.id !== id) {
      // This child scope belongs only to the server's fictional debug project.
      // The session is independently verified above; no household header is copied.
      req.headers['x-baoyan-child'] = CHILD;
      let preview;
      try { preview = adjustment.getSpeechSource(req, id); }
      catch (error) { if (error instanceof ApiError && error.code === 'REPLY_ADJUSTMENT_EXPIRED') throw fail(409, '这条回答已失效，不能再播放。', 'REPLY_EXPIRED'); throw error; }
      reply = { id, text: preview.reply, expression: selectReplyExpression({ inputText: preview.question, reply: preview.reply }) };
      sourceSignal = preview.signal;
      checkPreview = () => { adjustment.getSpeechSource(req, id); };
    }
    // A client chooses only an existing registered segment, never text or delivery.
    // Natural-language adjustment previews retain their complete legacy reply.
    if (input.segmentIndex !== undefined) {
      const segment = reply.segments?.[input.segmentIndex];
      if (!segment) throw fail(409, '这段回答不存在或已变化，请重新试一次。', 'REPLY_SEGMENT_INVALID');
      reply = { ...reply, text: segment.text, expression: segment.expression };
    }
    if (!provider.capabilities.tts) throw fail(503, '语音输出暂未配置。', 'NOT_CONFIGURED');
    const stream = provider.capabilities.ttsStreaming && Boolean(req.get('Accept')?.split(',').some(value => value.split(';')[0]?.trim() === 'application/x-ndjson'));
    try {
      if (!stream) {
        const audio = await work(req, res, session, generation, signal => provider.speech(reply.text, signal, reply.expression), sourceSignal);
        current(session, generation); checkPreview(); res.type(audio.contentType).send(Buffer.from(audio.bytes)); return;
      }
      await work(req, res, session, generation, signal => provider.streamSpeech(reply.text, async chunk => {
        current(session, generation); checkPreview(); if (signal.aborted || res.destroyed || res.writableEnded) throw cancelled();
        if (!res.headersSent) { res.set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' }); res.flushHeaders(); res.write(`${JSON.stringify({ type: 'format', format: 'pcm_s16le', sampleRate: 24000, channels: 1 })}\n`); }
        if (!res.write(`${JSON.stringify({ type: 'audio', data: Buffer.from(chunk).toString('base64') })}\n`)) await new Promise<void>((resolve, reject) => {
          const cleanup = () => { res.off('drain', drained); res.off('close', abort); signal.removeEventListener('abort', abort); };
          const drained = () => { cleanup(); resolve(); }, abort = () => { cleanup(); reject(cancelled()); };
          res.once('drain', drained); res.once('close', abort); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
        });
      }, signal, reply.expression), sourceSignal);
      current(session, generation); checkPreview(); res.end(`${JSON.stringify({ type: 'done' })}\n`);
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      if (!res.headersSent) { next(error); return; }
      const known = error instanceof ApiError;
      res.end(`${JSON.stringify({ type: 'error', error: known ? error.message : '语音暂时未完成。', code: known ? error.code : 'INTERNAL_ERROR', status: known ? error.status : 500 })}\n`);
    }
  });
  return { router, sweep, close() { if (closed) return; for (const session of sessions.values()) forget(session); adjustment.close(); library.close(); sessions.clear(); attempts.clear(); db.close(); closed = true; } };
}

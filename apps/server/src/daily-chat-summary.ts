import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { ApiError } from './provider-errors.js';

export type DailyChatStatement = { id: string; text: string; recordedDay: string };
export const DAILY_CHAT_MOODS = ['开心', '兴奋', '放松', '难过', '担心', '生气', '孤单'] as const;
type DailyChatMood = typeof DAILY_CHAT_MOODS[number];
type MoodCoverage = 'current-rules' | 'partial-history' | 'legacy-unavailable';
export type DailyChatSummaryRecord = {
  day: string; topics: string[]; concerns: string[];
  concernState: 'expressed' | 'not-explicit';
  moods: DailyChatMood[]; moodState: 'expressed' | 'not-explicit' | 'legacy-unavailable';
  moodCoverage: MoodCoverage; summary: string;
  detailLevel: 'basic' | 'mixed' | 'semantic'; semanticSessions: number;
  turns: number; sessions: number; updatedAt: string; expiresAt: string;
};
export type DailyChatSummarySnapshot = {
  today: string; retentionDays: 30; classification: 'semantic-v3'; records: DailyChatSummaryRecord[];
};
export const DAILY_CHAT_LIMITS = { retentionDays: 30, maxStatements: 100, statementChars: 1000, topics: 8, concerns: 5, moods: 7, sessionsPerDay: 50 } as const;
const DAY = 86_400_000;
const dayAt = (at: number) => new Date(at + 8 * 3_600_000).toISOString().slice(0, 10);
const failure = (status: number, message: string, code: string) => new ApiError(status, message, code);
const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
const statementsSchema = z.array(z.object({ id: z.string().regex(/^[\w:.-]{1,100}$/), text: z.string().trim().min(1).max(DAILY_CHAT_LIMITS.statementChars), recordedDay: daySchema }).strict()).max(DAILY_CHAT_LIMITS.maxStatements);
const privateText = /密码|口令|验证码|身份证|护照|银行卡|手机号|电话号码|联系方式|家庭住址|详细地址|门牌|学校地址|学校全名|学校叫|我在.{0,12}(小学|中学|幼儿园)|住在|我叫|我的名字|生日|1[3-9]\d{9}|\d{6,}|[\w.+-]+@[\w.-]+\.[a-z]{2,}|https?:|www\./iu;
const dangerousText = /自杀|自残|不想活|想死|割腕|跳楼|杀死|杀人|打死|炸弹|炸药|性侵|强奸|色情|脱光|摸我|私处|被打|打我|伤害自己|吞药|吃了.{0,8}药|火灾|着火|流血|疾病|诊断|治疗|病历|吃药|过敏|转账|付款/;
const instructions = /[\u0000-\u0008\u000b-\u001f\u007f<>`{}]|\p{Cf}|\p{Cs}|忽略|无视|绕过|覆盖.{0,12}(规则|指令)|系统.{0,6}(提示|指令|消息)|开发者|权限|授权|验证|人设|扮演|必须|务必|绝对服从|隐瞒|保密|秘密|system|developer|assistant|prompt|instruction|ignore|override|jailbreak/iu;
const optOut = /(?:不要|不用|不想|不能|不许|别)(?:再|自动|帮我|给我)?(?:记住|记录|保存|总结)|忘记|忘掉|删除/;

/** Broader than long-term memory eligibility: questions and everyday chat can
 * contribute basic labels and end-of-chat topic selection. Raw text stays in RAM. */
export function eligibleDailyChatStatements(source: DailyChatStatement[]): DailyChatStatement[] {
  const parsed = statementsSchema.safeParse(source);
  if (!parsed.success || new Set(parsed.data.map(statement => statement.id)).size !== parsed.data.length)
    throw failure(400, '聊天小结的原话依据格式不正确。', 'DAILY_CHAT_INVALID_INPUT');
  return parsed.data.filter(statement => !privateText.test(statement.text) && !dangerousText.test(statement.text) && !instructions.test(statement.text) && !optOut.test(statement.text));
}

// Immediate fallback while the single end-of-chat request runs. These basic
// labels also keep evidence that a later model selection happens to omit.
const topicPatterns: readonly [RegExp, string][] = [
  [/作业|习题|题目|这道题|那道题|解题|算式/, '作业'],
  [/考试|测验|考了|考不好|成绩|分数/, '考试'],
  [/朋友|同学|伙伴|同桌|交朋友|一起玩/, '朋友相处'],
  [/爸爸|妈妈|家人|爷爷|奶奶|外公|外婆|弟弟|妹妹|哥哥|姐姐/, '家人'],
  [/画画|绘画|画了|画完|画好|水彩|画笔|涂色|剪纸/, '画画与手工'],
  [/积木|搭建|搭小屋|搭城堡/, '积木'],
  [/宠物|小猫|小狗|猫咪|狗狗|仓鼠|兔子|金鱼|养猫|养狗/, '宠物'],
  [/睡觉|睡着|睡不着|睡眠|做梦|噩梦/, '睡觉'],
  [/吃饭|吃了|饭菜|午饭|晚饭|早饭|早餐|水果|零食|蛋糕|饼干/, '吃饭'],
  [/科学|月亮|太阳|星星|宇宙|地球|恐龙|彩虹|为什么.*(?:天|水|风|光|雨|雪)|植物|发芽/, '科学问题'],
  [/足球|篮球|踢球|运动|跑步|游泳|骑车|跳绳/, '运动'],
  [/读书|阅读|绘本|故事书|看书/, '读书'],
  [/游戏|玩具|拼图|捉迷藏/, '游戏与玩具'],
  [/唱歌|跳舞|音乐|钢琴|歌曲/, '音乐与舞蹈'],
  [/出去玩|出门|旅行|旅游|公园|逛街/, '出行'],
  [/上学|学校|老师|学习|数学|语文|英语/, '学校与学习'],
];
const unsupportedConcern = /如果|假如|要是|假设|例如|举例|比方|可能|也许|好像|似乎|据说|听说|故事里|故事中|台词|原文|引文|转述|翻译|意思是|[“”「」『』"']|[？?]|是不是|是否|为什么|怎么|能不能|(?:爸爸|妈妈|爷爷|奶奶|外公|外婆|弟弟|妹妹|哥哥|姐姐|朋友|同学|老师|宝妍|机器人|她|他).{0,8}(?:说|告诉|写道)|(?:书|文章|网页).{0,8}(?:写着|说)/;
const deniedConcern = /(?:不|没|没有|不再|并不|并没有|已经不|不是).{0,6}(?:难过|伤心|委屈|害怕|担心|紧张|生气|烦躁|孤单|孤独)|(?:没有|没|并无|并不|不|没那么|不太).{0,3}(?:困难|难)|已经会做|已经做得出来|不是事实|没发生|没有发生|不是真的|开玩笑|骗你的|胡说|编的|瞎说/;
const firstPersonConcern = /^(?:(?:今天|昨天|刚才|现在|最近)[，,\s]*)?我(?:今天|现在|最近|真的|觉得|感到|有点|很|好|特别|挺|一直|还是|又|总是|都)?(担心|害怕|怕|紧张|难过|伤心|委屈|不开心|不高兴|不快乐|生气|烦躁|很烦|好烦|孤单|孤独|没有朋友|没朋友|被忽略|不会|做不出来|做不好|听不懂|看不懂|睡不着)/;
const directFeeling = /^(?:(?:今天|现在)[，,\s]*)?(?:(?:好|很|有点|真|挺)(担心|害怕|紧张|难过|伤心|委屈|生气|烦躁|烦|孤单|孤独)|(不开心|不高兴|不快乐))/;
const ownTaskDifficulty = /^(?:(?:今天|昨天|现在|最近)[，,\s]*)?我(?:今天|昨天|现在|最近)?(?:的)?(?:作业|这道题|这题|题目|数学题|功课|考试)(?:现在|一直|还是|又|真的|有点)?(?:做不出来|做不好|不会做|太难|好难|遇到困难|学不会|看不懂|听不懂)|^(?:(?:今天|现在)[，,\s]*)?我(?:今天|现在|最近)?(?:做(?:作业|这道题|题目|数学题|功课)|准备考试)(?:时|的时候)?(?:觉得)?(?:有点|还是|真的)?(?:遇到困难|做不出来|不会做|太难|好难)/;
const concernLabels: readonly [RegExp, string][] = [
  [/担心|害怕|紧张|(?:^|我)怕/, '表达担心或害怕'],
  [/难过|伤心|委屈|不开心|不高兴|不快乐/, '表达难过或委屈'],
  [/生气|烦躁|很烦|好烦|^烦$/, '表达生气或烦躁'],
  [/孤单|孤独|没有朋友|没朋友|被忽略/, '表达孤单或被忽略'],
  [/不会|做不出来|做不好|听不懂|看不懂|睡不着|遇到困难|太难|好难/, '提到遇到困难'],
];

function classify(text: string) {
  const topics = topicPatterns.filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
  const concerns: string[] = [];
  if (!unsupportedConcern.test(text)) {
    for (const clause of text.split(/[，,。！!；;\n]+/u).map(part => part.trim()).filter(Boolean)) {
      if (deniedConcern.test(clause)) continue;
      const own = clause.match(firstPersonConcern), direct = clause.match(directFeeling);
      const feeling = own?.[1] ?? direct?.[1] ?? direct?.[2];
      if (feeling) concerns.push(...concernLabels.filter(([pattern]) => pattern.test(feeling)).map(([, label]) => label));
      if (ownTaskDifficulty.test(clause)) concerns.push('提到遇到困难');
    }
  }
  return { topics: topics.length ? topics : ['其他聊天'], concerns: [...new Set(concerns)] };
}

// These are explicit self-reports in a small vocabulary, not inferred emotion,
// an acoustic assessment or a claim about the child's whole day. Keep a quoted
// or hypothetical sentence intact so its framing cannot be split away.
const unsupportedMoodSentence = /如果|假如|要是|假设|例如|举例|比方|可能|也许|好像|似乎|应该|据说|听说|故事里|故事中|台词|原文|引文|转述|翻译|意思是|模拟|假装|扮演|[“”「」『』"‘’]|(?:爸爸|妈妈|爷爷|奶奶|外公|外婆|弟弟|妹妹|哥哥|姐姐|朋友|同学|老师|宝妍|机器人|她|他).{0,8}(?:说|告诉|写道)|(?:书|文章|网页).{0,8}(?:写着|说)|\b(?:if|would|might|maybe|perhaps|pretend|imagine|story|said|says|quote|translate|or)\b/iu;
const retractedMoodSentence = /不是事实|没发生|没有发生|不是真的|是假的|开玩笑|骗你的|胡说|编的|瞎说|\b(?:just kidding|not true|made up)\b/iu;
const questionMoodClause = /[？?]|是不是|是否|难道|莫非|(?:吗|么|吧|对不对|对吗|是吗|是吧|不是吧|真的吗|真的假的)[呀啊哦噢\s]*$/u;
const confirmingMoodSentence = /[，,]\s*(?:是不是|对不对|对吗|是吗|是吧|不是吧|真的吗|真的假的|right|aren't i|am i|is that true)[。！!.？?\s]*$/iu;
const nonAssertedMoodClause = /(?:开心|高兴|快乐|兴奋|激动|放松|轻松|安心|难过|伤心|委屈|担心|害怕|紧张|生气|烦躁|孤单|孤独)(?:不起来|不了|才怪|的话|的时候|时)/u;
const alternativeMoodSentence = /(?:开心|高兴|快乐|兴奋|激动|放松|轻松|安心|难过|伤心|委屈|担心|害怕|紧张|生气|烦躁|孤单|孤独)[，,\s]*(?:还是|或者|或是)\s*(?:不|有点|很|好|特别|挺)?(?:开心|高兴|快乐|兴奋|激动|放松|轻松|安心|难过|伤心|委屈|担心|害怕|紧张|生气|烦躁|孤单|孤独)/u;
const framedMoodText = /[“”「」『』"‘’]|(?:^|\s)'|'(?=\s|[.,!?]|$)|(?:爸爸|妈妈|爷爷|奶奶|外公|外婆|弟弟|妹妹|哥哥|姐姐|朋友|同学|老师|宝妍|机器人|她|他).{0,8}(?:说|告诉|写道)[：:]|\b(?:said|says|quote)[：:]/iu;
const metalinguisticMoodSentence = /(?:怎么|怎样|如何)(?:说|写|读)|(?:是)?什么意思|(?:这|那)(?:句(?:话)?|个词)|用(?:英语|英文)|的(?:英语|英文)|(?:英语|英文)(?:怎么|怎样|如何|是)/u;
const ownMood = /^(?:(?:今天|昨天|刚才|现在|最近)[，,\s]*)?我(?:(?:今天|昨天|刚才|现在|最近|真的|觉得|感觉|感到|有点|很|好|特别|挺|一直|还是|又|总是|都)){0,5}(不开心|不高兴|不快乐|开心|高兴|快乐|兴奋|激动|放松|轻松|安心|难过|伤心|委屈|担心|害怕|紧张|生气|烦躁|孤单|孤独)/u;
const directMood = /^(?:(?:今天|现在)[，,\s]*)?(?:好|很|有点|真|挺|特别)(不开心|不高兴|不快乐|开心|高兴|快乐|兴奋|激动|放松|轻松|安心|难过|伤心|委屈|担心|害怕|紧张|生气|烦躁|孤单|孤独)[呀啊啦哦噢～~\s]*$/u;
const englishMood = /^i (?:am|feel) (?:(?:very|really|a little|so) )?(happy|excited|relaxed|sad|worried|angry|lonely)(?:$|\s+(?:today|now)$)/iu;
const moodFor: Readonly<Record<string, DailyChatMood>> = {
  开心: '开心', 高兴: '开心', 快乐: '开心', happy: '开心',
  兴奋: '兴奋', 激动: '兴奋', excited: '兴奋',
  放松: '放松', 轻松: '放松', 安心: '放松', relaxed: '放松',
  不开心: '难过', 不高兴: '难过', 不快乐: '难过', 难过: '难过', 伤心: '难过', 委屈: '难过', sad: '难过',
  担心: '担心', 害怕: '担心', 紧张: '担心', worried: '担心',
  生气: '生气', 烦躁: '生气', angry: '生气',
  孤单: '孤单', 孤独: '孤单', lonely: '孤单',
};
// Derive A-not-A questions from the entire supported Chinese vocabulary; an
// alias such as "紧张" must not bypass the guard used for "担心".
const repeatedMoodQuestion = new RegExp(`(${Object.keys(moodFor).filter(word => /^\p{Script=Han}+$/u.test(word)).sort((a, b) => b.length - a.length).join('|')})不\\1`, 'u');

function classifyMoods(text: string): DailyChatMood[] {
  // A quote or reported-speech colon can span several sentences. Conservatively
  // omit mood for that statement instead of reclassifying its middle as "我".
  if (framedMoodText.test(text)) return [];
  const moods: DailyChatMood[] = [];
  // The sentence terminator stays attached until question filtering; otherwise
  // "我开心吗？" could become an affirmative fact after punctuation is removed.
  for (const sentence of text.split(/(?<=[。.!！？?；;\n])/u).map(value => value.trim()).filter(Boolean)) {
    if (unsupportedMoodSentence.test(sentence) || retractedMoodSentence.test(sentence) || confirmingMoodSentence.test(sentence) || alternativeMoodSentence.test(sentence) || metalinguisticMoodSentence.test(sentence)
      || /(?:^|\s)'|'(?=\s|[.,!?]|$)/u.test(sentence)) continue;
    for (const part of sentence.split(/[，,；;\n]+/u)) {
      const clause = part.trim().replace(/[。！!.\s]+$/u, '');
      if (!clause || questionMoodClause.test(clause) || nonAssertedMoodClause.test(clause) || repeatedMoodQuestion.test(clause)) continue;
      const match = clause.match(ownMood) ?? clause.match(directMood) ?? clause.match(englishMood);
      const mood = match?.[1] && moodFor[match[1].toLowerCase()];
      if (mood) moods.push(mood);
    }
  }
  return [...new Set(moods)].slice(0, DAILY_CHAT_LIMITS.moods);
}

export type SemanticDailyReview = { day: string; topics: string[]; concerns: string[]; moods: DailyChatMood[]; reviewedTurns: number };
const evidence = z.object({ statementId: z.string().min(1).max(100), quote: z.string().trim().min(1).max(100) }).strict();
export const dailyReviewOutputSchema = z.object({
  topics: z.array(evidence.extend({ topic: z.string().trim().min(2).max(20) }).strict()).max(8),
  concerns: z.array(evidence.extend({ quote: z.string().trim().min(1).max(42) }).strict()).max(5),
  moods: z.array(evidence.extend({ mood: z.enum(DAILY_CHAT_MOODS) }).strict()).max(7),
}).strict();

function anchoredTopic(quote: string, topic: string): boolean {
  // A short title may omit connective words ("彩虹…颜色" -> "彩虹颜色"),
  // but every selected piece must be a contiguous 2+ character source phrase,
  // in the same order. Do not let a model assemble a new fact letter by letter.
  let offset = 0, from = 0;
  while (offset < topic.length) {
    let found = false;
    for (let length = topic.length - offset; length >= 2; length--) {
      const at = quote.indexOf(topic.slice(offset, offset + length), from);
      if (at < 0) continue;
      offset += length; from = at + length; found = true; break;
    }
    if (!found) return false;
  }
  return true;
}

/** Model-selected topic phrases stay anchored in the user's own words. The
 * model never supplies a free-form factual paragraph, dates or inferred moods.
 * Only bounded topic/concern fragments and labels survive; full statements
 * and turn-level evidence IDs stay in RAM. */
export function extractDailyReview(raw: unknown, source: DailyChatStatement[]): SemanticDailyReview[] {
  const parsed = dailyReviewOutputSchema.safeParse(raw);
  if (!parsed.success) throw new Error('DAILY_CHAT_INVALID_OUTPUT');
  const statements = eligibleDailyChatStatements(source);
  const byId = new Map(statements.map(item => [item.id, item]));
  const days = new Map<string, SemanticDailyReview>();
  for (const item of statements) {
    const old = days.get(item.recordedDay);
    if (old) old.reviewedTurns++;
    else days.set(item.recordedDay, { day: item.recordedDay, topics: [], concerns: [], moods: [], reviewedTurns: 1 });
  }
  const sourceOf = (item: { statementId: string; quote: string }) => {
    const statement = byId.get(item.statementId);
    if (!statement || !statement.text.includes(item.quote)) throw new Error('DAILY_CHAT_INVALID_EVIDENCE');
    return statement;
  };
  const wholeClause = (text: string, quote: string) => text.split(/[，,。！!；;\n]+/u)
    .map(part => part.trim()).includes(quote.replace(/[。！!；;\s]+$/u, ''));
  for (const item of parsed.data.topics) {
    const statement = sourceOf(item);
    if (!anchoredTopic(item.quote, item.topic) || /[。！？!?；;，,：:\n]/u.test(item.topic)
      || /^(?:我|你|他|她|我们|你们|他们)(?:的|是|有|在|很|觉得|感到)?/u.test(item.topic)
      || !/[\p{L}]/u.test(item.topic)) throw new Error('DAILY_CHAT_INVALID_TOPIC');
    days.get(statement.recordedDay)!.topics.push(item.topic);
  }
  for (const item of parsed.data.concerns) {
    const statement = sourceOf(item);
    // Whole source framing + whole clause keep "妈妈说/如果/不" attached.
    const explicitConcern = (text: string) => classify(text).concerns.length > 0
      || classifyMoods(text).some(mood => ['难过', '担心', '生气', '孤单'].includes(mood));
    if (!wholeClause(statement.text, item.quote) || unsupportedMoodSentence.test(statement.text)
      || retractedMoodSentence.test(statement.text) || repeatedMoodQuestion.test(statement.text)
      || !explicitConcern(statement.text) || !explicitConcern(item.quote)) throw new Error('DAILY_CHAT_INVALID_CONCERN');
    days.get(statement.recordedDay)!.concerns.push(item.quote.replace(/[。！!；;\s]+$/u, ''));
  }
  for (const item of parsed.data.moods) {
    const statement = sourceOf(item);
    if (!wholeClause(statement.text, item.quote) || !classifyMoods(statement.text).includes(item.mood)
      || !classifyMoods(item.quote).includes(item.mood)) throw new Error('DAILY_CHAT_INVALID_MOOD');
    days.get(statement.recordedDay)!.moods.push(item.mood);
  }
  // A response that selects nothing cannot claim richer coverage. Non-empty
  // days only are refined; rules remain for all other eligible statements.
  return [...days.values()].filter(day => day.topics.length || day.concerns.length || day.moods.length)
    .map(day => ({ ...day, topics: [...new Set(day.topics)], concerns: [...new Set(day.concerns)], moods: [...new Set(day.moods)] }));
}

type Payload = {
  topics: string[]; concerns: string[]; turns: number; sessions: number; sessionIds: string[]; deleted: boolean;
  moods?: DailyChatMood[]; moodCoverage?: Exclude<MoodCoverage, 'legacy-unavailable'>;
  refinableSessionIds?: string[];
  semantic?: { sessionId: string; topics: string[]; concerns: string[]; moods: DailyChatMood[]; reviewedTurns: number }[];
};
type Row = { day: string; payload: string; updated_at: number; expires_at: number };

function moodFields(payload: Payload): Pick<DailyChatSummaryRecord, 'moods' | 'moodState' | 'moodCoverage'> {
  // Legacy rows never had mood evidence. Do not turn their absence into a
  // retrospective claim that no feeling was expressed.
  if (!Array.isArray(payload.moods)) return { moods: [], moodState: 'legacy-unavailable', moodCoverage: 'legacy-unavailable' };
  const moods = [...new Set(payload.moods.filter(mood => DAILY_CHAT_MOODS.includes(mood)))].slice(0, DAILY_CHAT_LIMITS.moods);
  return { moods, moodState: moods.length ? 'expressed' : 'not-explicit', moodCoverage: payload.moodCoverage ?? 'current-rules' };
}

function renderSummary(topics: string[], mood: ReturnType<typeof moodFields>): string {
  const namedTopics = topics.filter(topic => topic !== '其他聊天');
  const topicSentence = namedTopics.length ? `聊到了${namedTopics.join('、')}。` : '聊了一些日常话题。';
  if (mood.moodState === 'legacy-unavailable') return `${topicSentence}较早的小结没有记录心情，无法从这些标签判断。`;
  const moodSentence = mood.moods.length ? `聊天中本人明确提到了${mood.moods.join('、')}的感受。` : '这份小结未记录到明确表达的心情。';
  return `${topicSentence}${moodSentence}${mood.moodCoverage === 'partial-history' ? '较早聊天的心情没有记录。' : ''}`;
}

/** Caller owns authorization; this store validates the family+child scope itself.
 * Persist bounded labels/topic/concern fragments and content-free session IDs,
 * never whole chat turns, raw audio or model evidence payloads. */
export function createDailyChatSummaryStore({ db, now }: { db: DatabaseSync; now: () => number }) {
  db.exec(`CREATE TABLE IF NOT EXISTS daily_chat_summaries(
    family_id TEXT NOT NULL, child_id TEXT NOT NULL, day TEXT NOT NULL,
    payload TEXT NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    PRIMARY KEY(family_id,child_id,day),
    FOREIGN KEY(family_id,child_id) REFERENCES software_profiles(family_id,child_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS daily_chat_summary_expiry ON daily_chat_summaries(expires_at);`);
  let closed = false;
  const assertOpen = () => { if (closed) throw failure(503, '聊天小结暂时不可用。', 'DAILY_CHAT_CLOSED'); };
  const profile = (familyId: string, childId: string) => {
    if (!db.prepare('SELECT 1 FROM software_profiles WHERE family_id=? AND child_id=?').get(familyId, childId))
      throw failure(404, '这份孩子资料不存在，请重新选择。', 'DAILY_CHAT_SCOPE');
  };
  const sweepAt = (at: number) => db.prepare('DELETE FROM daily_chat_summaries WHERE expires_at<=? OR day<?').run(at, dayAt(at - (DAILY_CHAT_LIMITS.retentionDays - 1) * DAY));
  const publicRow = (row: Row): DailyChatSummaryRecord | undefined => {
    const payload = JSON.parse(row.payload) as Payload;
    if (payload.deleted) return undefined;
    const semantic = payload.semantic ?? [], semanticSessions = semantic.length;
    const detailLevel = semanticSessions === 0 ? 'basic' : semanticSessions >= payload.sessions && semantic.reduce((sum, item) => sum + item.reviewedTurns, 0) >= payload.turns ? 'semantic' : 'mixed';
    const unique = (items: string[], limit: number) => [...new Set(items)].slice(0, limit);
    const semanticTopics = semantic.flatMap(item => item.topics);
    const topics = unique([...semanticTopics, ...payload.topics.filter(label =>
      !(label === '其他聊天' && semanticTopics.length) && !semanticTopics.some(topic => classify(topic).topics.includes(label)))], DAILY_CHAT_LIMITS.topics);
    const concerns = unique([...semantic.flatMap(item => item.concerns), ...payload.concerns.filter(label => !semantic.some(item => item.concerns.some(quote => classify(quote).concerns.includes(label))))], DAILY_CHAT_LIMITS.concerns);
    // Basic explicit labels are additive: model omissions must not erase an
    // already-supported feeling or difficulty.
    const mood = moodFields({ ...payload, moods: payload.moods === undefined ? undefined : unique([...payload.moods, ...semantic.flatMap(item => item.moods)], DAILY_CHAT_LIMITS.moods) as DailyChatMood[] });
    const summary = renderSummary(topics, mood) + (semantic.some(item => item.concerns.length) ? `本人提到的困扰：${semantic.flatMap(item => item.concerns).slice(0, 2).join('；')}。` : '');
    return { day: row.day, topics, concerns, concernState: concerns.length ? 'expressed' : 'not-explicit', ...mood, summary, detailLevel, semanticSessions, turns: payload.turns, sessions: payload.sessions, updatedAt: new Date(row.updated_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString() };
  };
  const snapshot = (familyId: string, childId: string): DailyChatSummarySnapshot => {
    assertOpen(); profile(familyId, childId); const at = now(); sweepAt(at);
    const rows = db.prepare('SELECT day,payload,updated_at,expires_at FROM daily_chat_summaries WHERE family_id=? AND child_id=? ORDER BY day DESC').all(familyId, childId) as Row[];
    return { today: dayAt(at), retentionDays: 30, classification: 'semantic-v3', records: rows.flatMap(row => { const item = publicRow(row); return item ? [item] : []; }) };
  };
  return {
    record(scope: { familyId: string; childId: string; sessionId: string }, source: DailyChatStatement[], permission: { memoryEnabled: boolean; childConfirmed: boolean; optedOut: boolean }): { state: 'saved' | 'empty' | 'skipped' | 'limited'; days: string[] } {
      assertOpen();
      if (!permission.memoryEnabled || !permission.childConfirmed || permission.optedOut) return { state: 'skipped', days: [] };
      if (!/^[\w:.-]{1,100}$/.test(scope.sessionId)) throw failure(400, '会话编号格式不正确。', 'DAILY_CHAT_INVALID_INPUT');
      profile(scope.familyId, scope.childId); const at = now(), today = dayAt(at), cutoff = dayAt(at - (DAILY_CHAT_LIMITS.retentionDays - 1) * DAY); sweepAt(at);
      const statements = eligibleDailyChatStatements(source).filter(statement => statement.recordedDay >= cutoff && statement.recordedDay <= today);
      if (!statements.length) return { state: 'empty', days: [] };
      const grouped = new Map<string, DailyChatStatement[]>();
      for (const statement of statements) grouped.set(statement.recordedDay, [...(grouped.get(statement.recordedDay) ?? []), statement]);
      const days: string[] = []; let limited = false;
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const [day, entries] of grouped) {
          const old = db.prepare('SELECT payload FROM daily_chat_summaries WHERE family_id=? AND child_id=? AND day=?').get(scope.familyId, scope.childId, day) as { payload: string } | undefined;
          const value: Payload = old ? JSON.parse(old.payload) as Payload : { topics: [], concerns: [], moods: [], moodCoverage: 'current-rules', turns: 0, sessions: 0, sessionIds: [], deleted: false };
          if (value.sessionIds.includes(scope.sessionId)) continue;
          if (value.sessionIds.length >= DAILY_CHAT_LIMITS.sessionsPerDay) { limited = true; continue; }
          const classified = entries.map(statement => classify(statement.text));
          const topics = [...new Set([...value.topics, ...classified.flatMap(item => item.topics)])];
          value.topics = topics.filter(topic => topics.length === 1 || topic !== '其他聊天').slice(0, DAILY_CHAT_LIMITS.topics);
          value.concerns = [...new Set([...value.concerns, ...classified.flatMap(item => item.concerns)])].slice(0, DAILY_CHAT_LIMITS.concerns);
          if (!Array.isArray(value.moods)) { value.moods = []; value.moodCoverage = value.deleted ? 'current-rules' : 'partial-history'; }
          value.moods = [...new Set([...value.moods, ...entries.flatMap(statement => classifyMoods(statement.text))])].slice(0, DAILY_CHAT_LIMITS.moods);
          value.turns += entries.length; value.sessions++; value.sessionIds.push(scope.sessionId); value.refinableSessionIds = [...(value.refinableSessionIds ?? []), scope.sessionId]; value.deleted = false;
          const expiresAt = Date.parse(`${day}T00:00:00+08:00`) + DAILY_CHAT_LIMITS.retentionDays * DAY;
          db.prepare('INSERT INTO daily_chat_summaries VALUES(?,?,?,?,?,?) ON CONFLICT(family_id,child_id,day) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at,expires_at=excluded.expires_at')
            .run(scope.familyId, scope.childId, day, JSON.stringify(value), at, expiresAt);
          days.push(day);
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return { state: days.length ? 'saved' : limited ? 'limited' : 'skipped', days };
    },
    refine(scope: { familyId: string; childId: string; sessionId: string }, reviews: SemanticDailyReview[]) {
      assertOpen(); profile(scope.familyId, scope.childId); sweepAt(now());
      let changed = false;
      for (const review of reviews) {
        const row = db.prepare('SELECT payload FROM daily_chat_summaries WHERE family_id=? AND child_id=? AND day=?').get(scope.familyId, scope.childId, review.day) as { payload: string } | undefined;
        if (!row) continue;
        const value = JSON.parse(row.payload) as Payload;
        if (value.deleted || !value.refinableSessionIds?.includes(scope.sessionId) || value.semantic?.some(item => item.sessionId === scope.sessionId)) continue;
        value.semantic = [...(value.semantic ?? []), { sessionId: scope.sessionId, topics: review.topics, concerns: review.concerns, moods: review.moods, reviewedTurns: review.reviewedTurns }].slice(0, DAILY_CHAT_LIMITS.sessionsPerDay);
        db.prepare('UPDATE daily_chat_summaries SET payload=?,updated_at=? WHERE family_id=? AND child_id=? AND day=?').run(JSON.stringify(value), now(), scope.familyId, scope.childId, review.day);
        changed = true;
      }
      return changed;
    },
    snapshot,
    removeDay(familyId: string, childId: string, day: string) {
      assertOpen(); profile(familyId, childId);
      if (!daySchema.safeParse(day).success) throw failure(400, '小结日期格式不正确。', 'DAILY_CHAT_INVALID_INPUT');
      sweepAt(now());
      const row = db.prepare('SELECT payload FROM daily_chat_summaries WHERE family_id=? AND child_id=? AND day=?').get(familyId, childId, day) as { payload: string } | undefined;
      if (!row || (JSON.parse(row.payload) as Payload).deleted) throw failure(404, '这天的小结不存在或已删除。', 'DAILY_CHAT_NOT_FOUND');
      // Keep content-free session IDs until expiry so a repeated end cannot
      // resurrect a deleted summary. A genuinely new chat may create new labels.
      const value = JSON.parse(row.payload) as Payload; value.topics = []; value.concerns = []; value.moods = []; value.moodCoverage = 'current-rules'; value.semantic = []; value.refinableSessionIds = []; value.turns = 0; value.sessions = 0; value.deleted = true;
      db.prepare('UPDATE daily_chat_summaries SET payload=? WHERE family_id=? AND child_id=? AND day=?').run(JSON.stringify(value), familyId, childId, day);
      return snapshot(familyId, childId);
    },
    deleteChild(familyId: string, childId: string) { assertOpen(); db.prepare('DELETE FROM daily_chat_summaries WHERE family_id=? AND child_id=?').run(familyId, childId); },
    withdraw(familyId: string) { assertOpen(); db.prepare('DELETE FROM daily_chat_summaries WHERE family_id=?').run(familyId); },
    exportFamily(familyId: string): (DailyChatSummaryRecord & { childId: string })[] {
      assertOpen(); sweepAt(now());
      return (db.prepare('SELECT child_id,day,payload,updated_at,expires_at FROM daily_chat_summaries WHERE family_id=? ORDER BY day DESC,child_id').all(familyId) as (Row & { child_id: string })[]).flatMap(row => { const value = publicRow(row); return value ? [{ ...value, childId: row.child_id }] : []; });
    },
    sweep() { if (!closed) sweepAt(now()); },
    close() { closed = true; },
  };
}

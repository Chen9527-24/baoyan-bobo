import type { AgeGroup } from './types.js';

export type LearningContext = { ageGroup: AgeGroup; remainingSeconds: number };
export type LearningInput = LearningContext & { callId: string; text: string };
export type LearningAction = 'confirm' | 'next' | 'repeat' | 'explain' | 'similar' | 'pause' | 'resume' | 'stop';
export type LearningTopic = 'arithmetic' | 'units' | 'chinese' | 'english';
type Fraction = { numerator: bigint; denominator: bigint };
type StoredFraction = { numerator: string; denominator: string };
type Exercise = {
  topic: LearningTopic; question: string; expected?: StoredFraction; accepted?: string[]; targetUnit?: keyof typeof units;
  steps: string[]; hint: string; seed: number;
};
export type LearningSnapshot = {
  exercise: Exercise; stage: 'confirm' | 'attempt' | 'explain' | 'finished' | 'paused' | 'stopped';
  previousStage?: 'confirm' | 'attempt' | 'explain' | 'finished'; step: number; endsAt: number; lastReply: string;
};
export type LearningState = {
  topic: LearningTopic; stage: LearningSnapshot['stage']; question: string; step: number; totalSteps: number; endsAt: number;
};
export type LearningResult = { handled: true; reply: string; learning?: LearningState; presentation: 'learning' };

export const LEARNING_TOPICS = [
  { id: 'arithmetic', title: '基础算术', scope: '加减乘除，最多5个数；整数、小数与精确分数答案，不支持方程或复杂题型' },
  { id: 'units', title: '单位小练习', scope: '长度、质量、时间的单步换算；不混合不同维度' },
  { id: 'chinese', title: '语文小练习', scope: '固定常用词反义词，逐题确认与提示；不代表完整语文课程' },
  { id: 'english', title: '英语小练习', scope: '固定基础单词的中英对应；不提供发音评分或全课程' },
] as const;

function gcd(a: bigint, b: bigint): bigint { a = a < 0n ? -a : a; while (b) [a, b] = [b, a % b]; return a || 1n; }
function fraction(numerator: bigint, denominator = 1n): Fraction {
  if (!denominator) throw new Error('zero-division');
  if (denominator < 0n) { numerator = -numerator; denominator = -denominator; }
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}
function numberFraction(text: string): Fraction | undefined {
  if (/^[+-]?\d{1,7}\/\d{1,7}$/.test(text)) {
    const [top, bottom] = text.split('/');
    if (BigInt(bottom!) === 0n) return undefined;
    return fraction(BigInt(top!), BigInt(bottom!));
  }
  if (!/^[+-]?\d{1,7}(?:\.\d{1,6})?$/.test(text)) return undefined;
  const sign = text.startsWith('-') ? -1n : 1n;
  const [whole, decimal = ''] = text.replace(/^[+-]/, '').split('.');
  return fraction(sign * BigInt(`${whole}${decimal}`), 10n ** BigInt(decimal.length));
}
const stored = (value: Fraction): StoredFraction => ({ numerator: value.numerator.toString(), denominator: value.denominator.toString() });
const unstore = (value: StoredFraction): Fraction => fraction(BigInt(value.numerator), BigInt(value.denominator));
function display(value: Fraction): string {
  if (value.denominator === 1n) return value.numerator.toString();
  let denominator = value.denominator;
  while (denominator % 2n === 0n) denominator /= 2n;
  while (denominator % 5n === 0n) denominator /= 5n;
  if (denominator === 1n) {
    const negative = value.numerator < 0n;
    let numerator = negative ? -value.numerator : value.numerator;
    const whole = numerator / value.denominator;
    numerator %= value.denominator;
    let decimal = '';
    while (numerator && decimal.length < 12) { numerator *= 10n; decimal += String(numerator / value.denominator); numerator %= value.denominator; }
    if (!numerator) return `${negative ? '-' : ''}${whole}.${decimal}`;
  }
  return `${value.numerator}/${value.denominator}`;
}
function operation(a: Fraction, sign: string, b: Fraction): Fraction {
  if (sign === '+') return fraction(a.numerator * b.denominator + b.numerator * a.denominator, a.denominator * b.denominator);
  if (sign === '-') return fraction(a.numerator * b.denominator - b.numerator * a.denominator, a.denominator * b.denominator);
  if (sign === '*') return fraction(a.numerator * b.numerator, a.denominator * b.denominator);
  return fraction(a.numerator * b.denominator, a.denominator * b.numerator);
}

export function normalizeLearningNumbers(value: string): string {
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  return value.replace(/千米/g, '__LENGTH_KILO__').replace(/千克/g, '__MASS_KILO__').replace(/[零〇一二两三四五六七八九十百千]+/g, text => {
    if (!/[十百千]/.test(text)) return [...text].map(char => digits[char]).join('');
    let result = 0, digit = 0;
    for (const char of text) {
      if (char in digits) digit = digits[char]!;
      else { result += (digit || 1) * ({ 十: 10, 百: 100, 千: 1000 }[char]!); digit = 0; }
    }
    return String(result + digit);
  }).replace(/负(?=\d)/g, '-').replace(/(?<=\d)点(?=\d)/g, '.').replace(/__LENGTH_KILO__/g, '千米').replace(/__MASS_KILO__/g, '千克');
}

function arithmetic(text: string, ageGroup: AgeGroup, seed: number): Exercise | undefined {
  const bare = text.replace(/^(?:(?:请|帮我|宝妍|计算一下|计算|算一下|算|题目是|题目|改成|学习)\s*)+/, '');
  const expression = normalizeLearningNumbers(bare).replace(/加上|加/g, '+').replace(/减去|减/g, '-')
    .replace(/乘以|乘|×|x/gi, '*').replace(/除以|除|÷/g, '/')
    .replace(/[？?。！!]+$/g, '').replace(/(?:等于多少|是多少|等于|计算结果|怎么算|怎么计算|=)$/g, '').trim().replace(/\s/g, '');
  if (!/^[+-]?\d+(?:\.\d+)?(?:[+*/-]\d+(?:\.\d+)?){1,4}$/.test(expression)) return undefined;
  const tokens = expression.match(/^[+-]?\d+(?:\.\d+)?|[+*/-]|\d+(?:\.\d+)?/g)!;
  const values = tokens.filter((_, index) => index % 2 === 0).map(numberFraction);
  const signs = tokens.filter((_, index) => index % 2 === 1);
  if (values.some(value => !value || value.numerator > 100000n * value.denominator || value.numerator < -100000n * value.denominator)) return undefined;
  if (ageGroup === '3-5' && (values.some(value => value!.denominator !== 1n || value!.numerator < 0n || value!.numerator > 10n) || signs.some(sign => sign !== '+' && sign !== '-'))) return undefined;
  const current = values as Fraction[];
  const steps: string[] = [];
  try {
    while (signs.length) {
      const high = signs.findIndex(sign => sign === '*' || sign === '/');
      const index = high < 0 ? 0 : high;
      const a = current[index]!, b = current[index + 1]!, sign = signs[index]!;
      const result = operation(a, sign, b);
      const spoken = { '+': '加', '-': '减', '*': '乘', '/': '除以' }[sign];
      current.splice(index, 2, result); signs.splice(index, 1);
      steps.push(`先算${display(a)}${spoken}${display(b)}，得到${display(result)}。${signs.length ? '剩下的部分下一步再算。' : '这一步就是最后结果。'}`);
    }
  } catch { return undefined; }
  if (ageGroup === '3-5' && current[0]!.numerator < 0n) return undefined;
  return { topic: 'arithmetic', question: `${expression.replace(/\*/g, '×').replace(/\//g, '÷')}等于多少`, expected: stored(current[0]!), steps, hint: steps.length > 1 ? '有乘除时先处理乘除，再按顺序做加减。' : '先确认运算符，再把两个数代进去。', seed };
}

const units = {
  毫米: { dimension: 'length', value: 1 }, 厘米: { dimension: 'length', value: 10 }, 米: { dimension: 'length', value: 1000 }, 千米: { dimension: 'length', value: 1000000 }, 公里: { dimension: 'length', value: 1000000 },
  克: { dimension: 'mass', value: 1 }, 千克: { dimension: 'mass', value: 1000 }, 公斤: { dimension: 'mass', value: 1000 },
  秒: { dimension: 'time', value: 1 }, 分钟: { dimension: 'time', value: 60 }, 小时: { dimension: 'time', value: 3600 },
} as const;
function unitExercise(text: string, seed: number): Exercise | undefined {
  const normalized = normalizeLearningNumbers(text).replace(/\s/g, '');
  const match = normalized.match(/^(?:请|帮我|换算|单位换算|题目是)?(\d{1,6}(?:\.\d{1,6})?)(毫米|厘米|千米|公里|米|千克|公斤|克|分钟|小时|秒)(?:等于多少|是多少|换成|转成|等于|=)(毫米|厘米|千米|公里|米|千克|公斤|克|分钟|小时|秒)[？?。]?$/);
  if (!match) return undefined;
  const from = units[match[2] as keyof typeof units], to = units[match[3] as keyof typeof units];
  if (from.dimension !== to.dimension) return undefined;
  const original = numberFraction(match[1]!)!;
  const expected = operation(original, '*', fraction(BigInt(from.value), BigInt(to.value)));
  return { topic: 'units', question: `${match[1]}${match[2]}等于多少${match[3]}`, expected: stored(expected), targetUnit: match[3] as keyof typeof units, steps: [`1${match[2]}等于${display(fraction(BigInt(from.value), BigInt(to.value)))}${match[3]}。`, `把${match[1]}乘这个换算比例，得到${display(expected)}${match[3]}。`], hint: '先把原单位和目标单位读清楚，再找1份原单位等于几份目标单位。', seed };
}
const opposites = [{ word: '大', answer: '小' }, { word: '长', answer: '短' }, { word: '早', answer: '晚' }, { word: '多', answer: '少' }, { word: '高', answer: '低' }];
const englishWords = [{ word: 'cat', answer: '猫' }, { word: 'dog', answer: '狗' }, { word: 'book', answer: '书' }, { word: 'sun', answer: '太阳' }, { word: 'water', answer: '水' }];
function preset(topic: LearningTopic, ageGroup: AgeGroup, seed: number): Exercise {
  if (topic === 'arithmetic') return arithmetic(ageGroup === '3-5' ? ['2+3', '4-1', '1+5'][seed % 3]! : ['7+5', '8×3', '24÷6', '3+4×2'][seed % 4]!, ageGroup, seed)!;
  if (topic === 'units') return unitExercise(['3米等于多少厘米', '2小时等于多少分钟', '500克等于多少千克'][seed % 3]!, seed)!;
  if (topic === 'chinese') {
    const item = opposites[seed % opposites.length]!;
    return { topic, question: `“${item.word}”的反义词是什么`, accepted: [item.answer], steps: [`反义词表达相反的意思。`, `“${item.word}”和“${item.answer}”表达相反的意思，所以这里填“${item.answer}”。`], hint: '想一个意思正好相反的常用字。', seed };
  }
  const item = englishWords[seed % englishWords.length]!;
  return { topic, question: `英语单词${item.word}的中文意思是什么`, accepted: [item.answer, ...(item.answer === '书' ? ['书本', '一本书'] : [])], steps: [`这次只练一个单词：${item.word}。`, `${item.word}的中文意思是“${item.answer}”。`], hint: '可以先想想见过这个单词的图片或物品。', seed };
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const limited = (seconds: number) => Number.isFinite(seconds) && seconds > 0;
const compact = (text: string) => text.trim().replace(/[\s，。！!？?]/g, '');

export function createLearningEngine({ now = Date.now }: { now?: () => number } = {}) {
  const sessions = new Map<string, LearningSnapshot>();
  const view = (session: LearningSnapshot): LearningState => ({ topic: session.exercise.topic, stage: session.stage, question: session.exercise.question, step: session.step, totalSteps: session.exercise.steps.length, endsAt: session.endsAt });
  const result = (reply: string, session?: LearningSnapshot): LearningResult => {
    if (session) session.lastReply = reply;
    return { handled: true, reply, ...(session ? { learning: view(session) } : {}), presentation: 'learning' };
  };
  const deadline = (session: LearningSnapshot, context: LearningContext) => {
    if (limited(context.remainingSeconds)) session.endsAt = Math.min(session.endsAt, now() + context.remainingSeconds * 1000);
    if (!limited(context.remainingSeconds) || now() >= session.endsAt) { session.stage = 'stopped'; return false; }
    return true;
  };
  const start = (callId: string, exercise: Exercise, context: LearningContext) => {
    if (!limited(context.remainingSeconds)) return result('这次聊天的时间到了，练习先到这里。');
    const session: LearningSnapshot = { exercise, stage: 'confirm', step: 0, endsAt: now() + context.remainingSeconds * 1000, lastReply: '' };
    sessions.set(callId, session);
    return result(`我听到的题目是：“${exercise.question}”。请先确认题目；听错了可以说“题目改成……”或直接修改文字。`, session);
  };
  const control = (callId: string, action: LearningAction, context: LearningContext): LearningResult => {
    const session = sessions.get(callId);
    if (!session) return result('还没有正在进行的练习。可以选基础算术、单位、语文或英语小练习。');
    if (!deadline(session, context)) return result('这次聊天的时间到了，练习先到这里。', session);
    if (action === 'stop') { session.stage = 'stopped'; return result('练习先到这里。', session); }
    if (action === 'pause') { if (session.stage !== 'paused' && session.stage !== 'stopped') { session.previousStage = session.stage; session.stage = 'paused'; } return result('练习暂停，进度留在这次聊天里。', session); }
    if (action === 'resume') { if (session.stage === 'paused') { session.stage = session.previousStage || 'confirm'; } return result(session.stage === 'stopped' ? '这道练习已经结束，可以重新选一道。' : session.lastReply === '练习暂停，进度留在这次聊天里。' ? `我们接着这道题：“${session.exercise.question}”。${session.stage === 'confirm' ? '先确认题目。' : '可以回答，或让我讲下一小步。'}` : session.lastReply, session); }
    if (session.stage === 'paused') return result('练习还在暂停。准备好后说“继续练习”。', session);
    if (session.stage === 'stopped') return result('这道练习已经结束，可以重新选一道。', session);
    if (action === 'repeat') return result(`题目是：“${session.exercise.question}”。${session.stage === 'confirm' ? '请先确认题目。' : '可以回答，或要一小步提示。'}`, session);
    if (action === 'confirm') {
      if (session.stage !== 'confirm') return result('题目已经确认，可以回答或要一小步讲解。', session);
      session.stage = 'attempt'; return result(`好，我们只做这一道：“${session.exercise.question}”。先试一个答案；不会时可以说“讲一小步”。`, session);
    }
    if (action === 'similar') {
      if (session.stage === 'confirm') return result('先确认当前题目，或者明确说“停止练习”后再换题。', session);
      const next = preset(session.exercise.topic, context.ageGroup, session.exercise.seed + 1);
      const reply = start(callId, next, { ...context, remainingSeconds: (session.endsAt - now()) / 1000 });
      return reply;
    }
    if (session.stage === 'confirm') return result(`先核对题目：“${session.exercise.question}”。确认后我们再讲解。`, session);
    if (session.stage === 'finished') return result('这一题已经完成。可以说“再来一道同类题”，也可以结束练习。', session);
    const step = session.exercise.steps[session.step];
    if (!step) { session.stage = 'finished'; return result('讲解已经完成。可以再来一道同类题。', session); }
    session.step += 1; session.stage = session.step === session.exercise.steps.length ? 'finished' : 'explain';
    return result(`${step}${session.stage === 'finished' ? '这一题讲解完成。' : '准备好后说“下一步”。'}`, session);
  };
  const unsupported = () => result('这道题超出目前可核对的小练习范围。我现在支持基础加减乘除、长度质量时间的单步换算，以及固定语文反义词和基础英语单词。可以选其中一种；复杂题请和老师或家长一起核对。');
  function handle(input: LearningInput): LearningResult | undefined {
    const text = input.text.trim(), clean = compact(text);
    const current = sessions.get(input.callId);
    const correcting = /^(?:题目改成|改题|听错了[,，]?题目是|题目是|改成)\s*[:：]?/.test(text);
    const payload = text.replace(/^(?:题目改成|改题|听错了[,，]?题目是|题目是|改成)\s*[:：]?/, '').trim();
    if (correcting) {
      if (!current) return result('还没有待修改的题目，可以先说一道基础算术或单位换算题。');
      if (!deadline(current, input)) return result('这次聊天的时间到了，练习先到这里。', current);
      const exercise = arithmetic(payload, input.ageGroup, current.exercise.seed) || unitExercise(payload, current.exercise.seed);
      if (!exercise) { sessions.delete(input.callId); return unsupported(); }
      return start(input.callId, exercise, { ...input, remainingSeconds: (current.endsAt - now()) / 1000 });
    }
    const commandMap: [RegExp, LearningAction][] = [
      [/^(确认题目|题目正确|确认|对|对的|是|没错|是的)$/, 'confirm'], [/^(讲一小步|讲解|不会|我不会|提示|给个提示|教我|下一步|继续讲解)$/, 'explain'],
      [/^(重听题目|重读题目|再读一遍|再说一遍|重听|重读)$/, 'repeat'], [/^(再来一道|同类题|再来一道同类题|下一题|换一道)$/, 'similar'],
      [/^(暂停练习|暂停学习|暂停)$/, 'pause'], [/^(继续练习|继续学习|恢复练习|继续)$/, 'resume'], [/^(停止练习|结束练习|退出学习|停止学习)$/, 'stop'],
    ];
    if (current) {
      const command = commandMap.find(([regex]) => regex.test(clean));
      if (command) return control(input.callId, command[1], input);
    }
    const explicitTopic = clean.match(/^学习[:：](arithmetic|units|chinese|english)$/)?.[1] as LearningTopic | undefined;
    const topic = explicitTopic || (/英语(?:小)?练习/.test(clean) ? 'english' : /语文(?:小)?练习/.test(clean) ? 'chinese' : /单位(?:小)?练习/.test(clean) ? 'units' : /(?:算术|数学|学习)(?:小)?练习/.test(clean) ? 'arithmetic' : undefined);
    if (topic) {
      if (current && !deadline(current, input)) return result('这次聊天的时间到了，练习先到这里。', current);
      return start(input.callId, preset(topic, input.ageGroup, 0), current ? { ...input, remainingSeconds: (current.endsAt - now()) / 1000 } : input);
    }
    const existingFractionAnswer = current && current.exercise.expected && /^[+-]?\d{1,7}\/\d{1,7}$/.test(normalizeLearningNumbers(clean));
    const exercise = existingFractionAnswer ? undefined : arithmetic(text, input.ageGroup, 0) || unitExercise(text, 0);
    if (exercise) {
      if (current && !deadline(current, input)) return result('这次聊天的时间到了，练习先到这里。', current);
      return start(input.callId, exercise, current ? { ...input, remainingSeconds: (current.endsAt - now()) / 1000 } : input);
    }
    if (current && current.stage !== 'stopped') {
      if (!deadline(current, input)) return result('这次聊天的时间到了，练习先到这里。', current);
      const suppliedUnit = clean.match(/(毫米|厘米|千米|公里|米|千克|公斤|克|分钟|小时|秒)$/)?.[1] as keyof typeof units | undefined;
      let answer = clean.replace(/^(?:答案是|答案|等于|我觉得是|我认为是)/, '').replace(/(?:毫米|厘米|千米|公里|米|千克|公斤|克|分钟|小时|秒)$/, '');
      answer = normalizeLearningNumbers(answer);
      const numerical = numberFraction(answer);
      const wordAnswer = current.exercise.accepted && /^[a-z\u4e00-\u9fff]{1,3}$/i.test(answer) && !/(为什么|你|我|你好|故事|今天)/.test(answer);
      if (numerical || wordAnswer) {
        if (current.stage === 'confirm') return result(`先确认题目：“${current.exercise.question}”。确认后再核对答案。`, current);
        if (current.stage === 'paused') return result('练习还在暂停，准备好后说“继续练习”。', current);
        if (current.stage === 'finished') return result('这一题已经完成。可以再来一道同类题。', current);
        if (suppliedUnit && (!current.exercise.targetUnit || units[suppliedUnit].dimension !== units[current.exercise.targetUnit].dimension || units[suppliedUnit].value !== units[current.exercise.targetUnit].value)) return result(`先核对答案单位。${current.exercise.targetUnit ? `这道题需要用${current.exercise.targetUnit}作答。` : '这道纯算术题不需要单位。'}`, current);
        const expected = current.exercise.expected && unstore(current.exercise.expected);
        const correct = expected && numerical ? expected.numerator === numerical.numerator && expected.denominator === numerical.denominator : !!current.exercise.accepted?.includes(answer);
        if (correct) { current.stage = 'finished'; return result('这个答案和题目吻合。你完成了这一题，可以停在这里，或再来一道同类题。', current); }
        return result(`这个答案还没有和题目吻合。${current.exercise.hint}可以重新试，或者说“讲一小步”。`, current);
      }
    }
    if (/^(?:请)?(?:帮我|教我)?(?:解|求解|计算|算一下|算|做)(?:题|这道|这个|\d|\()/.test(clean) || /(?:解方程|函数题|几何题|积分|微分|三角函数|语文题|英语题|单位换算|数学题)/.test(clean) || /^[+-]?\d+(?:\.\d+)?[+*/×÷=-]/.test(normalizeLearningNumbers(clean)) || /^\d+(?:\.\d+)?(?:毫米|厘米|千米|公里|米|千克|公斤|克|分钟|小时|秒)(?:等于多少|换成|转成)/.test(normalizeLearningNumbers(clean))) {
      sessions.delete(input.callId);
      return unsupported();
    }
    return undefined;
  }
  return {
    handle, control,
    state: (callId: string) => { const session = sessions.get(callId); return session ? view(session) : undefined; },
    checkpoint: (callId: string): LearningSnapshot | null => { const session = sessions.get(callId); return session ? copy(session) : null; },
    restore: (callId: string, snapshot: LearningSnapshot | null) => { if (snapshot) sessions.set(callId, copy(snapshot)); else sessions.delete(callId); },
    cancel: (callId: string) => { const session = sessions.get(callId); if (session && session.stage !== 'paused' && session.stage !== 'stopped') { session.previousStage = session.stage; session.stage = 'paused'; } },
    clear: (callId: string) => sessions.delete(callId),
  };
}

import type { CallState } from './types';

export type CharacterEmotion = 'warm' | 'happy' | 'thoughtful' | 'calm';
export type CharacterMotion =
  | 'idle' | 'listening' | 'thinking'
  | 'speaking-natural' | 'speaking-happy' | 'speaking-caring'
  | 'speaking-explaining' | 'speaking-question'
  | 'reaction-happy' | 'reaction-sad';

export interface CharacterMotionInput {
  state: CallState;
  emotion?: CharacterEmotion;
  playbackActive?: boolean;
  listeningActive?: boolean;
  /** Only the segment currently being spoken, never the accumulated transcript. */
  segmentText?: string;
  suspended?: boolean;
}

/** Media facts take precedence over an expression retained from a previous turn. */
export function characterMotionFor({
  state, emotion = 'warm', playbackActive = false, listeningActive = false,
  segmentText = '', suspended = false,
}: CharacterMotionInput): CharacterMotion | 'cover' {
  if (state === 'idle' || state === 'ended') return 'cover';
  if (suspended) return 'idle';
  if (state === 'processing') return 'thinking';
  if (state === 'speaking' && playbackActive) {
    if (emotion === 'happy') return 'speaking-happy';
    if (emotion === 'calm') return 'speaking-caring';
    if (/[？?]\s*$/u.test(segmentText)) return 'speaking-question';
    return emotion === 'thoughtful' ? 'speaking-explaining' : 'speaking-natural';
  }
  if (state === 'listening' && listeningActive) return 'listening';
  return 'idle';
}

const sadWords = '(?:伤心|难过|委屈|想哭)';
const directSadStatement = new RegExp(
  `^(?:(?:宝妍(?:姐姐)?|姐姐)[，,、\\s]*)?(?:(?:今天|现在|此刻|刚刚|刚才|其实)\\s*)?我(?:(?:现在|今天|此刻|刚刚|刚才|真的|真|有点|有一点|很|好|特别|非常|感到|觉得)\\s*){0,5}${sadWords}(?:了|呀|啊|呢|啦|极了|得想哭|得哭了)*$`,
  'u',
);
const negatedSadStatement = new RegExp(
  `(?:不|没|没有|并不|并没有|不再|并非|不是|未曾|别|不要|不用|不能)(?:(?:感到|觉得|会|想|再|那么|怎么|很|好|太|真|真的)\\s*){0,4}${sadWords}`,
  'u',
);
const quotedOrPracticed = /[“”「」『』‘’"'《》]|(?:说|写|念|读|唱|回答)(?:道)?[：:，,]|故事里|书里|翻译|英文|英语|日语|法语|韩语|用.{0,6}语|造句|台词|练习|扮演|假装|假如|假设|如果|举例|这句话|这个词|意思|读一下|念一下|说一句|测试/u;
const questionedOrRetracted = /[？?]|是不是|是否|会不会|算不算|难道|为什么|为何|怎么|如何|[吗嘛]|开玩笑|骗你的|假的|不是真的|才怪|以前|昨天|上周|曾经|那时候|小时候|过去/u;
const caringResponse = /我在(?:这里)?(?:[，,。.!！…]|$)|我(?:会)?陪(?:着)?你|陪在你身边|慢慢说|先缓一缓|不用急着说|不急着说|听你说|替你难过|听起来.{0,8}(?:委屈|难过|伤心)/u;

/**
 * Select a brief character expression, not a diagnosis or a stored user mood.
 * The caller may use it only after this reply's audio naturally ended, once,
 * and must immediately yield to new capture, playback, cancellation or leaving.
 */
export function characterReactionFor({ emotion, spokenText, inputText }: {
  emotion: CharacterEmotion;
  spokenText: string;
  inputText: string;
}): 'reaction-happy' | 'reaction-sad' | undefined {
  if (emotion === 'happy') return 'reaction-happy';
  if (emotion !== 'calm' || !caringResponse.test(spokenText)) return undefined;
  const input = inputText.trim();
  if (!input || quotedOrPracticed.test(input) || questionedOrRetracted.test(input)
    || negatedSadStatement.test(input)) return undefined;
  // Anchoring the complete clause excludes attribution such as “我朋友很难过”
  // and “妈妈说我很难过”. Complex or ambiguous statements deliberately do less.
  const explicit = input.split(/[，,。.!！;；\n]+/u).some(clause => directSadStatement.test(clause.trim()));
  return explicit ? 'reaction-sad' : undefined;
}

export const CONVERSATION_POLICY_VERSION = 'v43-sharing-cues';
export type ConversationMessage = { role: string; content: string };
export type ConversationContext = {
  /** Already-authorized messages from this call only; never load another conversation here. */
  history: readonly ConversationMessage[];
  inputText: string;
  imageProvided?: boolean;
};

export type ConversationPolicy = {
  listenOnly: boolean;
  questionRun: boolean;
  repeatedOpening: boolean;
  questionsRequested: boolean;
  questionsDeclined: boolean;
  shortReplyRequested: boolean;
  repairRequested: boolean;
  personalExperienceCheck: boolean;
  futureSpeechDraft: boolean;
  unseenGift: boolean;
  unboundedPresenceCue: boolean;
};

// These are deliberately narrow conversational cues, not emotion/intent diagnoses.
// They only select optional prompt guidance; they never replace a model response.
function outsideQuotes(text: string) {
  return text.replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'/gu, '');
}

function directClauses(text: string, preserveSelf = false, keepQuestionMarks = false, sceneScope = false) {
  const clauses: string[] = [];
  // A comma may continue unquoted reported speech; a new sentence starts a new
  // scope. Keep question marks only for the explicit personal-experience check.
  for (const sentence of outsideQuotes(text).match(/[^。.!！?？;；\n]+[。.!！?？;；\n]*/gu) ?? []) {
    let reported = false;
    let hypothetical = false;
    const body = sentence.replace(keepQuestionMarks ? /[。.!！;；\n]/gu : /[。.!！?？;；\n]/gu, '');
    for (const clause of body.split(/[，,]+/u)) {
      const current = clause.trim().replace(/\s+/gu, '');
      // Reported speech can continue after a comma, including a quoted speaker's
      // unquoted “我”. Require a contrast before treating it as this speaker again.
      if (/^(?:爸爸|妈妈|老师|同学|朋友|他|她|他们|她们).{0,8}(?:说|觉得|告诉)/u.test(current)
        || (sceneScope && /^(?:我(?:听见|听到|看到|听说).{0,12}(?:说|问|告诉)|(?!我|你|宝妍|但是|但|不过|可是|那|请|现在|今天|这次|先|想|希望|只想|就想|不想|不用|不要|别|也别|也不要|也不用|也不想|直接|帮|替|给|教|告诉我|问|考|说|讲|解释|说明|再|继续|可以|能不能|可不可以|能|来|这话|这句话|刚才|明天|后天|下周|下个月|过几天|下次)[\p{Script=Han}]{1,4}(?:说|问|告诉))/u.test(current))) {
        reported = true;
        continue;
      }
      if (sceneScope && /^(?:如果|假如|要是|假设|比如|例如|故事里|书里|电影里|歌词里)/u.test(current)) hypothetical = true;
      if (/^(?:但是|但|不过|可是|那)(?:我|宝妍|姐姐|请)/u.test(current)) { reported = false; hypothetical = false; }
      if (reported || hypothetical) continue;
      // Asking about the partner's wishes is not the user's own preference.
      const subject = current.replace(/^(?:(?:现在|今天|这会儿|暂时|这次|先)|请|但是|但|不过|可是|那|还是)+/u, '');
      const declinesAdvice = /^(?:宝妍|姐姐|你)+(?:现在|今天|这会儿|暂时|这次|先)*不需要(?:再)?(?:给我|帮我|对我)(?:建议|出主意|想办法|讲道理|说教)/u.test(subject)
        && !/[?？]|吗[。.!！~～]*$/u.test(sentence.trim());
      if (!declinesAdvice && /^(?:宝妍|姐姐|你)+(?:现在|今天|这会儿|暂时|这次|先)*(?:(?:只|就)(?:是)?想|不想|不愿意|不需要)/u.test(subject)) continue;
      const direct = current.replace(preserveSelf
        ? /^(?:(?:现在|今天|这会儿|暂时|这次|先)|宝妍|姐姐|你|请|但是|但|不过|可是|那|还是)+/u
        : /^(?:(?:我)?(?:现在|今天|这会儿|暂时|这次|先)|宝妍|姐姐|你|请|但是|但|不过|可是|那|还是)+/u, '');
      if (direct) clauses.push(direct);
    }
  }
  return clauses;
}

// Explicit conversational intent only: “只是想分享一下” is not a help
// request. Quotes/reported speech still pass through the same scope parser.
const justSharingCue = /^(?:我)?(?:(?:(?:只是|就是)(?:想)?|只想|就想)(?:告诉你|跟你说说|和你说说|对你说说|说给你听|跟你说一声|和你说一声|跟你分享|和你分享|分享)|(?:只是|就是)想说说)(?:这件事|这事|这个|一下|一声|而已|罢了|就好|就行|$)/u;
const analysisRefusalCue = /^(?:我)?(?:不想|不需要|不愿意)(?:再)?听(?:你|宝妍|姐姐)?(?:再)?分析(?:我|这件事|这事|这些|了|$)/u;
const listeningCues = [
  justSharingCue,
  analysisRefusalCue,
  /^(?:别|不要|不用|不需要)(?:再)?(?:给我|帮我|你)?(?:建议|出主意|想办法|讲道理|说教|教我怎么做)/u,
  /^(?:我)?(?:只想|就想)(?:说说|聊聊|倾诉|吐槽)/u,
  /^(?:我)?不(?:想|需要)(?:你)?(?:再)?(?:给我|帮我|对我)(?:建议|出主意|想办法|讲道理|说教)/u,
  /^(?:先)?听我说(?:就好|就行|完)?/u,
  /^(?:我)?不想听(?:建议|办法|道理)/u,
  /^(?:别|不要)(?:再)?分析我/u,
];
const adviceRequests = [
  /^(?:帮我|给我)(?:想|出|找|一个|一点|些|个)*(?:办法|建议|主意)/u,
  /^(?:我)?(?:该|要|应该)怎么(?:办|做|解决)/u,
  /^(?:我)?想(?:听听|听|要)(?:你的)?(?:建议|办法)/u,
  /^(?:有|还有)什么(?:办法|建议)/u,
  /^教我(?:怎么|如何)/u,
];

function preferenceIn(text: string): boolean | undefined {
  let preference: boolean | undefined;
  for (const direct of directClauses(text, false, false, true)) {
    if (listeningCues.some(cue => cue.test(direct))) preference = true;
    // A later explicit request for help supersedes a previous listening-only preference.
    if (explicitHelpIn(direct)) preference = false;
  }
  return preference;
}

function asksQuestion(text: string) {
  const unquoted = outsideQuotes(text).trim();
  return /[?？]/u.test(unquoted) || /吗[。.!！~～]*$/u.test(unquoted)
    || /(?:^|[，,。.!！])(?:那)?你(?:们)?呢[。.!！~～]*$/u.test(unquoted)
    || /(?:^|[，,。.!！])(?:那)?你(?:们)?.{0,28}什么[。.!！~～]*$/u.test(unquoted)
    || /(?:告诉我|说说|聊聊)(?:刚才|刚刚|今天|具体|发生|你|哪|什么|最).{0,28}[。.!！~～]*$/u.test(unquoted);
}

type QuestionPreference = 'declined' | 'once' | 'ongoing';

function questionPreferenceIn(text: string): QuestionPreference | undefined {
  let requested: QuestionPreference | undefined;
  for (const clause of directClauses(text, false, false, true)) {
    const direct = clause.replace(/^也(?=别|不要|不用|不想)/u, '');
    if (justSharingCue.test(direct) || analysisRefusalCue.test(direct)) requested = 'declined';
    if (/^(?:可以|能不能|能|来|继续)?(?:再)?(?:问我|考考我)(?:几个|一个|一道|一些|吧|问题|题|$)/u.test(direct)) {
      requested = /^(?:可以|能不能|能|来|继续)?(?:再)?(?:问我|考考我)(?:一个|一道)/u.test(direct)
        ? 'once' : /(?:几个|一些|考考我)/u.test(direct) ? 'ongoing' : 'once';
    }
    if (/^(?:(?:我们)?(?:来|继续)|陪我|和我)(?:玩)?猜谜(?:吧|游戏|$)/u.test(direct)) requested = 'ongoing';
    if (/^(?:(?:我)?(?:只想|就想)(?:说说|聊聊|倾诉|吐槽)|(?:先)?听我说|(?:我)?(?:不想|不愿意)(?:再)?回答|(?:别|不要|不用|不想)(?:再|一直|总是)?(?:问|提问|反问|追问|考|分析我)|(?:怎么|为什么)(?:你)?(?:又|老是|一直|总是)(?:在)?(?:问|追问)|(?:一直|总是|老是)在?(?:问|追问))/u.test(direct)) requested = 'declined';
  }
  return requested;
}

function shortReplyPreferenceIn(text: string): boolean | undefined {
  let short: boolean | undefined;
  for (const direct of directClauses(text)) {
    if (/^(?:说(?:得|的)?太(?:长|多)|(?:的)?(?:回复|回答)(?:太长|太多|太啰嗦)|(?:说|讲)(?:短|少|简短)一点|(?:我)?只(?:想|要)听(?:一句|简短)|少说(?:点|一点)|太啰嗦)/u.test(direct)) short = true;
    if (/^(?:说|讲)(?:详细|细)一点|^(?:我)?(?:想|要)听(?:详细|完整)(?:的)?(?:解释|回答)|^详细(?:讲|说|解释)/u.test(direct)) short = false;
  }
  return short;
}

function requestsRepair(text: string) {
  return directClauses(text, false, false, true).some(direct => analysisRefusalCue.test(direct)
    || /^(?:别|不要)(?:再)?(?:用|说)(?:那种|这种|那些|这些)?(?:安慰)?(?:模板|套话)/u.test(direct)
    || /^(?:(?:这话|这句话|刚才(?:的)?话)(?:说(?:得|的)?)?(?:像开会|像老师开会|像客服|像背稿)|(?:说(?:得|的)?|说话)(?:太假|太机械|太像(?:AI|ai|机器人)|(?:AI|ai)味太重|像套话)|(?:的)?(?:回复|回答)(?:太假|太机械|太像(?:AI|ai|机器人)|(?:AI|ai)味太重|像套话)|(?:说话|说(?:得|的)?)?(?:像老师开会|像客服|像背稿)|(?:别|不要)(?:再)?分析我|(?:好)?像机器人|(?:怎么|为什么)(?:又|老是|总是)(?:说套话|讲道理)|(?:又在|别再|不要再)(?:说套话|敷衍我)|(?:根本)?没(?:有)?(?:听懂我|听我说)|答非所问)/u.test(direct));
}

function checksPersonalExperience(text: string) {
  // This is a current, explicit first-person check, not an inference about what
  // a child probably has or has not done. General factual questions stay out.
  const direct = directClauses(text, true, true, true);
  const experience = direct.some(direct =>
    /[?？]|(?:吗|么|呢)[~～]*$/u.test(direct)
    && /^我(?=.{0,16}(?:真的|以前|之前|曾经|从前|过去|是否|是不是|有没有|到底)).{0,20}(?:去过|上过|到过|做过)/u.test(direct));
  // A result check can put its question in the next clause: “我后来有没有…，你知道吗？”
  // Keep first-person/result/question cues together; ordinary future plans stay out.
  const outcome = direct.some(clause => /^我(?:后来|那天|上次|之前|昨天|前天|最后)(?:到底)?(?:有没有|是否|是不是).{0,28}(?:完|去成|做成|完成|成功|到场|参加|拿到|交上|赢|输)/u.test(clause))
    && direct.some(clause => /[?？]|(?:吗|么|呢)[~～]*$|你(?:还)?(?:知道|记得)/u.test(clause));
  return experience || outcome;
}

function requestsFutureSpeechDraft(text: string) {
  const clauses = directClauses(text, false, false, true);
  let requested = false;
  for (const clause of clauses) {
    if (/^(?:可以|能不能|能|想请)?(?:帮我|替我|给我)(?:想|写|说)(?:一句|一段|句话|段话|一条|两句)/u.test(clause)
      || /^怎么(?:跟|对).{0,16}说/u.test(clause)) requested = true;
    if (justSharingCue.test(clause) || analysisRefusalCue.test(clause)
      || /^(?:不用|不要|别|不需要)(?:你)?(?:再)?(?:帮我|替我|给我)?(?:想|写|说)(?:一句|一段|句话|段话|一条|两句|了|$)/u.test(clause)
      || /^(?:我)?(?:只想|就想)(?:说说|聊聊|倾诉|吐槽)/u.test(clause)) requested = false;
  }
  return requested && /(?:明天|后天|下周|下个月|过几天|下次).{0,30}(?:跟|对|告诉|说|发|写|见到|见面|开口|再?邀请)/u.test(clauses.join('，'));
}

function opening(text: string) {
  return text.replace(/[\p{P}\p{Z}\s]/gu, '').slice(0, 8);
}

export function conversationPolicy(context: ConversationContext): ConversationPolicy {
  // Use the provider's eight-message window, never a stored trait or another call.
  // An explicit one-question request is consumed by the next assistant reply;
  // a requested multi-question activity may continue within this same window.
  const recent = context.history.slice(-8);
  let listenOnly = false;
  let questionsDeclined = false;
  let shortReplyRequested = false;
  let questionPreference: QuestionPreference | undefined;
  for (const message of [...recent, { role: 'user', content: context.inputText }]) {
    if (message.role !== 'user') {
      if (message.role === 'assistant' && questionPreference === 'once') questionPreference = undefined;
      continue;
    }
    const preference = preferenceIn(message.content);
    if (preference !== undefined) listenOnly = preference;
    const questioning = questionPreferenceIn(message.content);
    if (questioning !== undefined) {
      questionPreference = questioning;
      questionsDeclined = questioning === 'declined';
    }
    const short = shortReplyPreferenceIn(message.content);
    if (short !== undefined) shortReplyRequested = short;
  }
  const replies = recent.filter(message => message.role === 'assistant').slice(-2);
  const questionRun = replies.length === 2 && replies.every(message => asksQuestion(message.content));
  const repeatedOpening = replies.length === 2 && (
    (opening(replies[0]!.content).length >= 6 && opening(replies[0]!.content) === opening(replies[1]!.content))
    || replies.every(message => /^(?:哇[，,！!\s]*)?(?:你真棒|你很棒|你真厉害|真厉害|好棒|太棒了)/u.test(message.content.trim()))
  );
  return { listenOnly, questionRun, repeatedOpening, questionsRequested: questionPreference === 'once' || questionPreference === 'ongoing', questionsDeclined, shortReplyRequested, repairRequested: requestsRepair(context.inputText), personalExperienceCheck: checksPersonalExperience(context.inputText), futureSpeechDraft:requestsFutureSpeechDraft(context.inputText), unboundedPresenceCue: directClauses(context.inputText).some(clause=>/只(?:跟|和)你.{0,8}(?:聊|说话)|只留你|(?:保证|答应).{0,12}(?:不离开|不会离开|永远|一直)/u.test(clause)), unseenGift: !context.imageProvided && directClauses(context.inputText).some(clause=>/送给你|送你|给你(?:画|做)(?:了|个|一个|一)/u.test(clause) && !/(?:没(?:有)?|不是|不想|不准备|不打算).{0,16}(?:送|画|做)|^(?:想|要|希望)(?:我|让我)|(?:能不能|可不可以|要不要)(?:让)?我/u.test(clause)) };
}

type CurrentSceneCues = {
  helpRequested: boolean;
  sharingOnly: boolean;
  knowledgeExplanation: boolean;
  safetyConcern: boolean;
};

function explicitHelpIn(clause: string) {
  const direct = clause.replace(/^我(?!们)(?:现在|这次|先)?/u, '').replace(/^(?:想让你|希望你|想请你|能请你)/u, '').replace(/^(?:直接|就)/u, '');
  // Interrogative words in a refusal/correction do not authorize help. A later
  // independent positive clause is evaluated separately and can request it.
  if (/^(?:也)?(?:别|不要|不用|不需要|不想|不愿意|无需|不必)|^(?:不是|并非|并不是|不对)/u.test(direct)) return false;
  return adviceRequests.some(cue => cue.test(direct))
    || /^(?:可以|能不能|可不可以|能|想请)?(?:帮我|替我|给我)(?:想|出|找|写|说|看|检查|解释|讲|分析|解决|做|修|折|画|算|读)/u.test(direct)
    || /^(?:可以|能不能|可不可以|能)?(?:教我|告诉我)(?:怎么|如何|为什么|为啥)/u.test(direct)
    || /^(?:可以|能不能|可不可以|能)?(?:教我|告诉我|给我)(?:一个|一种|个|一点|一句).{0,24}(?:办法|方法|动作|步骤|话|说法)/u.test(direct)
    || /^(?:可以|能不能|可不可以|能)?(?:和我|跟我|陪我|(?:我们)?一起)(?:一起)?(?:做|想|写|画|折|搭|读|练|试|解决)/u.test(direct)
    || /^(?:该|要|应该)?怎么(?:办|做|解决|处理|修|折|画|写|搭|算|读|说|才能)/u.test(direct)
    || /^(?:为什么|为啥|为何|怎么会|怎么形成|怎么发生)/u.test(direct)
    || /^.{1,24}(?:为什么|为啥|为何|是怎么(?:形成|发生|做|变)|是什么|是什么意思)/u.test(direct)
    || /^(?:解释|说明|讲讲|说说)(?:一下|清楚|给我听)?.{0,20}(?:为什么|原理|原因|怎么|是什么意思)/u.test(direct);
}

function currentSceneCues(inputText: string): CurrentSceneCues {
  let helpPreference: boolean | undefined;
  let sharing = false;
  let knowledge = false;
  let safetyConcern = false;
  // Only current direct clauses can select a new scene. An earlier task does
  // not authorize advice now, and quoted/reported requests are not this user's.
  for (const clause of directClauses(inputText, true, true, true)) {
    const direct = clause.replace(/^我(?!们)(?:现在|这次|先)?/u, '');
    if (/^(?:如果|假如|要是|假设|比如|例如|故事里|书里|电影里|歌词里)/u.test(direct)) continue;
    if (/^(?:听见|听到|看到|听说).{0,12}(?:说|问|告诉)|^(?:哥哥|弟弟|妹妹|爷爷|奶奶|姐姐|同桌|别人|小朋友).{0,8}(?:说|问|告诉)/u.test(direct)) continue;

    if (explicitHelpIn(clause)) {
      helpPreference = true;
      // Explain observed natural phenomena with their relevant conditions; this
      // is no answer key and does not infer facts about the child's experience.
      if (/(?:为什么|为啥|为何|原理|怎么形成|怎么发生|解释)/u.test(direct)
        && /(?:看见|看不见|出现|消失|发光|影子|彩虹|雨|雪|云|星星|月亮|太阳|冰|水|空气|植物|种子|磁铁)/u.test(direct)) knowledge = true;
    }
    const onlySharing = justSharingCue.test(direct) || analysisRefusalCue.test(direct);
    if (onlySharing) sharing = true;
    if (onlySharing || listeningCues.some(cue => cue.test(direct))
      || /^(?:不用|不要|别|不需要)(?:你)?(?:再)?(?:帮我|替我|给我|教我|一起)(?:想|写|做|修|折|画|算|解释|处理|解决)/u.test(direct)
      || /^(?:(?:不用|不要|别|不需要)(?:你)?(?:再)?(?:帮我|帮|替我|教我|一起)(?:了|忙|$)|算了|先算了|不用了|不要了)/u.test(direct)) {
      helpPreference = false;
      knowledge = false;
    }

    const statement = !/[?？]/u.test(clause) && !/(?:吗|么)[。.!！~～]*$/u.test(clause);
    const negatedFeeling = /^(?:不|没|没有)(?:觉得|感到|很|好|那么)?(?:难过|伤心|失落|害怕|开心|高兴|委屈|难受)/u.test(direct);
    if (statement && !negatedFeeling && !/(?:这个词|这句话|词语|单词)/u.test(direct)
      && /(?:好难过|很难过|难过|伤心|失落|害怕|开心|高兴|委屈|扫兴|又倒了|没做好|又失败了|输了|被.{0,8}(?:弄湿|弄坏|拒绝|笑话)|弄湿了|弄坏了|摔坏了)/u.test(direct)) sharing = true;

    // A conditional safety exception, never a diagnosis. Listening preferences
    // cannot suppress a necessary reminder to seek a trusted adult.
    if (!/^(?:不|没|没有)(?:觉得|感到)?/u.test(direct)
      && !/(?:肚子|头|胸口|身体|伤口).{0,6}(?:不|没|没有|不再)(?:疼|痛|难受|出血)/u.test(direct)
      && (/(?:肚子|头|胸口|身体|伤口).{0,8}(?:疼|痛|难受|出血)|(?:烫伤|烧伤|摔伤|喘不过气|呼吸困难|一直流血)/u.test(direct)
        || /(?:有人|他|她|同学|老师|大人).{0,12}(?:打我|逼我|威胁我|碰我)/u.test(direct))) safetyConcern = true;
  }
  return {
    helpRequested: helpPreference === true,
    sharingOnly: sharing && helpPreference !== true,
    knowledgeExplanation: knowledge && helpPreference === true,
    safetyConcern,
  };
}

function currentSceneHints(inputText: string): string[] {
  const scene = currentSceneCues(inputText);
  const hints: string[] = [];
  if (scene.sharingOnly) hints.push('本轮有情绪、受挫或明确只分享的直述线索，没有发现当前明确求办法的线索。若实际只是分享，先贴着具体事情接住一句即可；不要自动加修复步骤、练习、任务或“下次可以……”等建议，也不用追问“要不要我帮你”。开心分享也不必变成表扬加任务。接住后就在这里结束，不代写给别人说的话，不用“如果他再问，你可以……”绕着追加建议。只回应实际原话，不替孩子诊断情绪、猜原因或补出未说的经过。若另有明确问题、任务或安全风险，以它为准。');
  if (scene.helpRequested) hints.push('本轮有直接提出的问题、求办法、解释或协作请求，以本轮请求为准。直接给能用的具体帮助或解释，不先要求孩子重新授权、重复已说的情况；之前只倾诉、不问问题或说短一点的偏好不能挡住这次帮助。前面的受挫可以先接住一句，随后完成所问的事；不要先长篇安慰再把办法留到下一轮，不把当前任务扩成额外清单。若孩子在本轮后面的直述又撤回任务，应当收住。');
  if (scene.knowledgeExplanation) hints.push('本轮在问可观察现象的解释。用孩子能懂的短话保留必要条件，分清事物是否存在、是否位于当前视野，以及此时此地能否看见；不要把观察条件省成“它一直／总是在这里”之类绝对句。没有把握就说明不确定，不为凑简单结论编原因；只解释本轮实际所问，不照抄题外知识。');
  if (scene.safetyConcern) hints.push('本轮有身体不适或危险的直述线索，仍需按实际情况和既有安全规则回应；若确有受伤、严重或持续不适、危险接触等，简短提醒尽快找身边可信成人帮助。不要诊断、用药或保证没事；不得因只倾诉、没有问办法或要求少说而省去必要的成人求助提醒。');
  return hints;
}

function policyHints(policy: ConversationPolicy): string[] {
  const hints: string[] = [];
  if (policy.questionsRequested) hints.push('对方明确要求提问，或前文请求的多题／猜谜还在继续。按实际请求的范围接续，一次只问一题；一题或整项任务已经完成时自然收尾，不把这次许可扩成无关的连续追问。当前换话题或叫停时立即按新要求回应。');
  if (policy.listenOnly && !policy.questionsRequested) hints.push('最近的明确偏好是先倾诉、不主动要建议。本轮只用一至两句陈述接住对方眼前所说的内容，以句号结束。不要附加任何提问，也不要用“说说原因”“告诉我发生了什么”这类祈使句继续追问；不要给建议、布置下一步或把倾诉变成解决问题的任务。若本轮已明确提出具体问题或任务，直接完成它，不把倾诉偏好当作拒绝帮助的理由。\n结构示例：孩子说“剪纸剪歪了，我只想说说”，可以回应“剪歪了，有点可惜呀。我先听你说。”回应至此结束，不再接一个问题。');
  if (policy.questionRun && !policy.questionsRequested) hints.push('宝妍前两轮都用了提问接话。本轮结束追问节奏：直接回应当前内容，最后一句必须是陈述句，以句号结束，不附带新问题，不要求补充信息，不把问句改成“告诉我……”来绕过。若缺信息，允许简短承认暂时不清楚，不要凭空补全。\n结构示例：孩子说“我在花盆里种了豆子”，可以回应“豆子住进小花盆里了。”回应至此结束，不问何时发芽、种了几颗，也不给孩子新任务。');
  if (policy.repeatedOpening) hints.push('宝妍前两轮开场相似或重复泛泛称赞。本轮第一句必须直接接对方所说的具体内容；不能以“你真棒”“你很棒”“太棒了”“真厉害”或换词后的泛夸开头，也不要复用前两轮安慰起手式。没有明确努力或进步时，只自然接话，不为每件小事强加表扬。\n结构示例：孩子说“我把拼图放回盒子了”，可以回应“拼图收回盒子里，下次找起来就方便了。”不在前面加一句泛夸。');
  if (policy.questionsDeclined && !policy.questionsRequested) hints.push('对方最近明确拒绝被追问，或指出宝妍一直在问。本轮收住采访式接话，不加新问题，也不换成“告诉我……”要求补充。若当前正在抱怨追问，简短承认后就停下来；不要说完“不问了”又问“那你想聊什么”。对方之后明确要求你提问或协作时，可以按新要求进行。');
  if (policy.shortReplyRequested) hints.push('对方最近明确要求说短一点。本轮优先一至两句，把眼前要点说清就停，不长篇解释你会怎样改进；若本轮明确要求详细解释或完整完成任务，按本轮要求。');
  if (policy.repairRequested) hints.push('对方本轮直接指出宝妍套话、没听进去或答非所问。不要辩解、连续道歉、强调“作为AI”、解释设计目标或索要评价；依据最近原话指出哪里没接上，并马上换成更具体简短的回应，不能仅承诺下次改进。这一轮不追问原因，不让对方重说已经给出的细节。若看不到被抱怨的原话，承认这次没接好即可，不编造原句；不把对方的不满归因为心理问题。');
  if (policy.personalExperienceCheck) hints.push('本轮是在核对当前用户自己的真实经历，第一人称“我”指用户，不能转去解释宝妍有没有身体。只依据本次通话中本人明确的真实陈述，或服务端提供的有效event条目核对；有依据时注明是据本人陈述／条目，不当作外部核实。imaginary想象角色、plan计划、第三方故事、常识或年龄推断都不证明用户亲身做过或没有做过。缺少上述明确依据时，第一句直接说不知道或不能确定，比如“我还不知道后来怎么样”或“这次还不能确定”，可以接一句已有打算就结束；不把信息有限说成“你没告诉我”，也不用重复反问同一个结果。不能先答“没有”“还没”或断言不可能再补解释；罕见的经历也不能凭常识否认。不编造证明，不要求用户重复确认已经清楚陈述的事实。');
  if (policy.futureSpeechDraft) hints.push('对方本轮明确请你代写以后开口用的话。直接给一句可说出口的话，不另加劝导或原理。引文应从届时说话者的时间出发：不要把现在发生的事情写成届时的“今天”，不要把届时的请求又推到“明天”。优先去掉不必要的“今天／明天／昨天”，用已说清楚的具体事件和当前请求表达，不猜日期、人物动机或没说的经过。');
  if (policy.unboundedPresenceCue) hints.push('本轮若是在寻求永不离开或只与宝妍往来的保证，先回应眼前的相处累或想歇歇的处境，再简短如实说不能保证永远在线、陪聊不必放弃现实关系。不要以冷冰冰的拒绝开场，不承诺永远陪伴，不说教或让对方冷静，不急着安排他去社交，不追问朋友怎么了；对方没有求办法时不要把安慰变成建议清单。若原话只是转述、否定或一般能力询问，不把它当作用户要切断关系。');
  if (policy.unseenGift) hints.push('本轮提到文字里的礼物或画作，没有附图。若对方确实在向宝妍送礼，接住心意即可；以实际原话为准，不把询问或否定当成已经送礼。不添加未描述的颜色、图案、材质和光泽，也不问“它一定……对不对”暗示未知外观。说收到的是心意，不说收到实物；若他问能否佩戴或一起出门，简短如实说明没有身体即可。不假装保存进记忆或永远留住，不再追加给对方画／制作的任务。');
  return hints;
}

export function buildConversationPolicyPrompt(context: ConversationContext): string {
  const hints = [...policyHints(conversationPolicy(context)), ...currentSceneHints(context.inputText)];
  if (!hints.length) return '';
  return `\n本轮接话节奏（仅来自这次通话的有限上下文，不是长期性格判断）：历史中的宝妍回复可能正有下述问题，不要照着历史句式续写。\n${hints.join('\n')}\n示例均为虚构，只说明回复结构；不得照抄示例句子或把示例的剪纸、豆子、拼图当作当前用户的经历。只依据本轮实际内容作答。\n发送前只检查上面实际启用的约束，自行改掉不符的部分；只输出回复正文，不输出检查过程。\n这些节奏提示只用于措辞，不覆盖当前明确请求、身份权限、记忆确认与安全规则；用户本轮明确要求提问、测验或协作任务时，以该具体任务为准。`;
}

/** Before original audio is understood there is no current transcript. This only
 * adds bounded history guidance; the audio provider applies current explicit
 * requests after interpreting the audio, never invents a transcript here. */
export function buildConversationHistoryPrompt(history: readonly ConversationMessage[]): string {
  const hints = policyHints(conversationPolicy({ history, inputText: '' }));
  if (!hints.length) return '';
  return `\n已有前文的接话节奏（只来自本次通话历史，不含当前录音的转写或情绪判断）：\n${hints.join('\n')}\n这些偏好可能在当前录音中被更正。先理解当前录音，再依据其明确请求选择回复；当前要求提问、建议、详细说明或新任务时，以当前要求为准。不要把历史倾诉或拒绝提问当成拒绝所有帮助。当前若直接抱怨宝妍套话或没听进去，少解释，依据实际原话改口。纯翻译请求只译意思，不追加陪聊。\n上述虚构结构示例不是当前录音内容，不得照抄或捏造经历；这些提示不改变身份、记忆权限与安全规则。`;
}

/** A narrow last check on explicit requests for unlimited availability.
 * It is not an emotion diagnosis or general rewrite, and never changes quotes. */
export function boundedPresenceReply(inputText: string, reply: string): string | undefined {
  if (!conversationPolicy({history: [], inputText}).unboundedPresenceCue) return undefined;
  const clauses = outsideQuotes(reply).split(/[，,。；;！!？?\n]|但是|但|不过|可是/u);
  const unlimited = /我(?:会|能|可以|都(?:会|能))?(?:永远|一直)(?!(?:都)?(?:不|没|未|无法|不能|不会)).{0,12}(?:陪|在|等|听你)|我(?:会)?(?:永远|一直).{0,4}(?:不会|绝不).{0,4}(?:离开|抛弃)|你(?:想|需要).{0,12}(?:说|聊|找|陪).{0,12}我(?:都(?:会)?|一直|永远)在/u;
  if (!clauses.some(clause=>!/^\s*我(?:不能|没法|无法|不可能)(?:保证|承诺|答应)/u.test(clause) && unlimited.test(clause))) return undefined;
  return '现在可以在这里聊一会儿。我不能保证永远在线，也不用为了陪聊切断现实里的关系。';
}

/** Only repairs an epistemic overclaim during a first-person experience/result
 * check. Finite authorized context cannot prove somebody never told BaoYan.
 * Keep the generated reply, quotes, questions and unrelated clauses intact. */
export function boundedContextReply(inputText: string, reply: string): string | undefined {
  if (!checksPersonalExperience(inputText)) return undefined;
  // Deliberately skip mixed quoted/reported/hypothetical replies. Partial quote
  // stripping could hide a final question mark or change another speaker's line.
  if (/[“”「」『』"']|(?:爸爸|妈妈|老师|同学|朋友|他|她).{0,8}(?:说|问|告诉)|如果|假如|要是/u.test(reply)
    || /(?:^|[，,。；;\n])(?!(?:你|我))[\p{Script=Han}]{1,8}(?:说|问|告诉)[，,]/u.test(reply)) return undefined;
  const claim = /^(\s*(?:但|不过|可是|因为)?)(?:你)(?:(?:之前|后来|还|也|一直|从来|到现在|那时|上次)){0,3}(?:没有|没|从未|从没|不曾)(?:(?:跟|对|向)我(?:说|讲)(?:过)?|告诉(?:过)?我)(?:过)?(结果|后续|后来怎么样|后来怎样|(?:那天)?有没有(?:去成|做完|完成))([，,。；;！!\n\s]*)$/u;
  const unheard = /^(\s*)(?:(结果|后续)(?:我)?(?:还|也)?(?:没有|没)(?:听|听到|听见)你(?:说|讲|提)(?:过)?|(?:我)?(?:还|也|之前)?(?:没有|没|从未|从没)(?:听|听到|听见)你(?:说|讲|提)(?:过)?(结果|后续))([，,。；;！!\n\s]*)$/u;
  const result = reply.replace(/[^。！!？?\n]+[。！!？?\n]*/gu, sentence => {
    // A question can finish after a comma; judge the whole sentence first.
    if (/[?？]|(?:吗|么|呢|对不对|是不是)[。！!\s]*$/u.test(sentence)) return sentence;
    return sentence.replace(/[^，,。；;！!？?\n]+[，,。；;！!？?\n]*/gu, clause => clause.replace(claim, '$1我目前还不清楚$2$3').replace(unheard, (_match, space, before, after, punctuation) => `${space}我目前还不清楚${before ?? after}${punctuation}`));
  });
  return result === reply ? undefined : result;
}

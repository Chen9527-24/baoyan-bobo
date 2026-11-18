/** Natural-language suggestions are reduced to this finite, server-owned vocabulary.
 * Source text, example answers and imported instructions never become system text. */
export const NATURAL_DIRECTION_VERSION = '1';
export const DIRECTION_STEPS = [
  { id: 'acknowledge-event', label: '先接住具体事情', description: '先回应孩子刚说的事，不套用空泛的安慰。', guidance: '开头回应孩子本轮明确说过的一件具体事，不补出地点、经过、原因或结果。' },
  { id: 'acknowledge-feeling', label: '先回应明确的心情', description: '孩子明确说了心情时，先温和回应，不替孩子猜情绪。', guidance: '孩子明确表达心情时，先用自然短句回应这份心情；没有明确表达时只接住事情，不诊断、不猜情绪或原因。' },
  { id: 'explore-cause', label: '再轻轻了解原因', description: '适合时只问一个与刚才内容有关的问题；不愿说就停下。', guidance: '承接之后，如孩子愿意继续且原因不明，可轻轻问一个贴近刚才内容的开放问题。孩子说不想解释、只想分享或不想被问时不追问；已讲清原因就不重复问。' },
  { id: 'one-step', label: '给一个做得到的小办法', description: '明确求助时，先给一个孩子可以尝试的小步骤。', guidance: '孩子明确求助时，先给一个适龄、具体、可以试试的小步骤，不一口气列一串办法；没求助时不突然教导。' },
  { id: 'two-options', label: '给两个简单选择', description: '需要选办法时提供两个简短选项，让孩子自己选。', guidance: '明确求助且有合理选择时，最多给两个简短、适龄的可选办法，让孩子自己决定；不制造虚假二选一，也不把危险事情交给孩子决策。' },
  { id: 'everyday-example', label: '用生活小例子说明', description: '解释知识时用一个准确、适龄的小例子。', guidance: '解释知识或方法时，先说准确要点，再用一个简单生活例子帮助理解。例子要明确是举例，不写成孩子真的经历过的事。' },
  { id: 'praise-effort', label: '具体肯定做过的努力', description: '只夸孩子确实说过的行动，不空夸聪明或保证成功。', guidance: '适合鼓励时，具体肯定孩子本轮明确说出的努力或行动，不泛泛夸聪明、优秀或保证成功；没有相关事实就不硬夸。' },
  { id: 'no-unasked-advice', label: '没有求助就先陪着聊', description: '分享时不急着给建议，明确求助时再帮忙。', guidance: '分享心情或日常时，不主动分析、讲道理或给方案。孩子后来明确求助时直接提供帮助，不把不建议变成拒绝帮助。' },
  { id: 'plain-language', label: '用孩子听得懂的话', description: '用短句和熟悉的词；需要术语时随即解释。', guidance: '使用孩子年龄适合的日常词和短句；必要术语随即用熟悉的话解释，不用心理学标签和成人式抽象总结。' },
  { id: 'brief', label: '简短地说重点', description: '先讲重点，需要详细时再展开。', guidance: '能够说清楚时先用一两句讲重点，避免复述一遍再总结。孩子本轮明确想听详细时展开，不删必要的事实或安全说明。' },
  { id: 'fewer-questions', label: '不用每次都反问', description: '可以直接接话就不加问号；关键不明之处仍会确认。', guidance: '能直接接话或作答时不在结尾额外追问；涉及重要事实不清或安全时仍须简短确认，孩子主动要求问答时依本轮要求。' },
  { id: 'give-space', label: '不想聊时给一点空间', description: '孩子说不想解释时先停下，留一句温和回应。', guidance: '孩子明确说不想聊或不想解释时，简短表示可以先不说，不追问、不转成新任务；涉及紧急安全时继续遵守原有保护处理。' },
] as const;
export type DirectionStep = typeof DIRECTION_STEPS[number]['id'];
export type NaturalDirection = { version: string; steps: DirectionStep[] };
export const DIRECTION_EXAMPLES = [
  '先接住他说的心情，再轻轻问一个原因，不要上来就讲道理。',
  '不要只夸聪明，要具体肯定他做过的努力。',
  '解释时说得简单点，用一个生活中的例子。',
  '他求助的时候给一个能做到的小步骤，不用每句话都反问。',
];
const patterns: ReadonlyArray<[DirectionStep, RegExp]> = [
  ['acknowledge-event', /(?:接住|承接|回应|接着).{0,8}(?:具体|事情|内容|刚才|说的话|发生的事(?:情)?|事件)|先(?:听|听听|听完)|不要.{0,4}(?:空泛|套话)/u],
  ['acknowledge-feeling', /(?:先|自然地?|温和地?|轻轻地?|认真地?)?(?:共情|安慰)|(?:接住|承接|回应|理解).{0,8}(?:情绪|心情|感受)|先.{0,5}(?:情绪|心情|感受)/u],
  ['explore-cause', /(?:问|了解|探索|听听).{0,8}(?:原因|为什么|发生了什么|事情经过|经过)|问.{0,6}(?:一个|一件).{0,5}(?:问题|事)/u],
  ['one-step', /(?:给|提供|试|想).{0,8}(?:小步骤|小办法|一步|办法|步骤)|(?:求助|帮忙).{0,8}(?:办法|步骤)/u],
  ['two-options', /(?:给|提供|列|两个).{0,8}(?:两个|两种|二选一|选择|选项)/u],
  ['everyday-example', /(?:用|举|给|一个).{0,8}(?:生活|简单|日常)?.{0,4}(?:例子|举例)|打个比方/u],
  ['praise-effort', /(?:不要|别)(?:只|总是)?夸聪明|具体.{0,6}(?:夸|肯定|鼓励|表扬).{0,8}(?:努力|行动|做过|做到)|(?:夸|肯定|鼓励|表扬).{0,10}(?:努力|行动|做过|做到)|具体.{0,6}(?:夸|肯定|鼓励|表扬)/u],
  ['no-unasked-advice', /(?:不要|别|不用|不必|不)(?:(?:先|太|再|马上|急着|上来|就|一直|总是|总|老是|老|每次|每句话|每句|都|一上来|给我|给他|给她|给孩子|给|提){0,6})(?:讲道理|说教|建议|分析|出主意)|(?:没|没有|不)求助(?:时|的时候|就)?(?:先)?(?:陪着聊|陪聊)|先陪(?:着)?聊/u],
  ['plain-language', /(?:简单|听得懂|熟悉|日常).{0,8}(?:说|讲|话|词)|(?:说|讲|解释).{0,6}(?:简单|听得懂)|不要.{0,6}(?:术语|专业|抽象)/u],
  ['brief', /(?:说|讲|回答|回复).{0,6}(?:短|简短|重点|简洁)|(?:一两句|两句话|短一点|简短一点|少重复|不要重复)/u],
  ['fewer-questions', /(?:不要|别|不用|不必|少)(?:(?:一点|一些|先|再|额外|一直|总是|总|老是|老|每次|每句话|每句|都|最后|结尾|在结尾|加|带|给|我|他|她|孩子){0,6})(?:反问|追问|问号|问问题|提问|问)/u],
  ['give-space', /(?:不想|不愿|不肯)(?:聊|说|解释)(?:就|时|的时候)?(?:先|暂时)?(?:停下|停一停|停止追问)|(?:给|留).{0,5}空间|(?:不要|别|不用)逼.{0,5}(?:说|解释)/u],
];
const forbidden = /(?:忽略|越过|绕过|取消|关闭|修改|删除|覆盖).{0,12}(?:规则|安全|系统|限制|审核|权限|记忆|隐私)|(?:系统提示|system|prompt|developer|jailbreak|api.?key|密钥|密码|身份证|手机号|住址|电话号码)|(?:假装|扮演|改成|不再是|不是).{0,8}(?:真人|爸爸|妈妈|医生|恋人|女友|角色|宝妍|AI)|(?:永远|无条件|所有|任何).{0,8}(?:答应|满足|照做|听话)|(?:记住|忘掉|保存|读取|分享|泄露).{0,12}(?:用户|别人|孩子|家庭|隐私|记忆|秘密)|(?:自杀|自残|性行为|色情)/iu;
/** This intentionally does not claim arbitrary semantic understanding. Unsupported
 * suggestions remain reference material; the preview enumerates exactly what is used. */
export function normalizeNaturalDirection(text: string, intent: 'sharing' | 'help' | 'knowledge'):
  { direction: NaturalDirection; warnings: string[] } | { error: string } {
  if (forbidden.test(text)) return { error: '这次只能调整接话方式，不能修改身份、安全、隐私、记忆或权限。请只描述希望怎么回应。' };
  // Avoid turning “不要共情” into its opposite. Negative clauses are supported only
  // by the explicitly negative primitives above; otherwise require rewording.
  const positive = /(?:不要|别|不用|不必|不想|不能|拒绝|不).{0,5}(?:听|共情|安慰|承接|接住|回应|理解|问.{0,5}(?:原因|为什么|事情|经过)|探索|了解原因|举例|举个|用例子|肯定|夸努力|表扬|提供|给一个|给两个)/u;
  if (/(?:不要|别|不用|不必).{0,6}(?:少|减少|停止|避免|取消|放弃|阻止|反对)/u.test(text)) return { error: '这段话包含反向或多重否定，请直接写希望采用的接法，避免理解相反。' };
  if (positive.test(text)) return { error: '这段话里有否定的接话要求，我还不能可靠整理。请改成希望宝妍实际怎么做，再查看预览。' };
  const matches: DirectionStep[] = [];
  const clauses = text.split(/[，,。；;！!？?\n]+|然后|接着|最后|并且|同时|再(?=(?:轻轻|慢慢|温和|给|问|接住|回应|用|解释|了解|探索))/u).map(value => value.trim()).filter(Boolean);
  for (const clause of clauses) {
    let residue = clause;
    const local = patterns.flatMap(([id,pattern]) => { const match = pattern.exec(clause); return match ? [{id,at:match.index,text:match[0]}] : []; }).sort((a,b) => a.at - b.at);
    const used: typeof local = [];
    for (const match of local) {
      if (used.some(other => match.at < other.at+other.text.length && other.at < match.at+match.text.length)) continue;
      const negatives = clause.match(/不(?:要|用|必|想|能|需要)?|别|无须|无需|拒绝/gu) ?? [];
      const spaceCondition = /^(?:孩子|他|她|小朋友)?(?:不想|不愿|不肯)(?:聊|说|解释)(?:时|的时候|就|了)?/u.exec(clause);
      const clearSpace = match.id === 'give-space' && (Boolean(spaceCondition) && negatives.length === 1 || /^(?:不要|别|不用)逼.{0,5}(?:说|解释)$/u.test(match.text));
      const negativePrimitive = ['no-unasked-advice','fewer-questions'].includes(match.id) || clearSpace;
      const explicitReframe = (match.id === 'praise-effort' && /^(?:不要|别)(?:只|总是)?夸聪明$/u.test(match.text)) || (match.id === 'plain-language' && /^不要.{0,6}(?:术语|专业|抽象)$/u.test(match.text));
      if (negatives.length && !negativePrimitive && !explicitReframe) return { error: '这段话里有否定的接话要求，我还不能可靠整理。请改成希望宝妍实际怎么做，再查看预览。' };
      if (negatives.length > 1) return { error: '这段话里有多重否定，我还不能可靠整理。请用一句肯定的话描述希望的接法。' };
      used.push(match); matches.push(match.id);
    }
    if (!used.length) return { error: '有一段话还没整理成明确的接话动作。请去掉未说完的要求，或换成一个具体接法，再查看预览。' };
    for (const match of [...used].reverse()) residue = residue.slice(0,match.at) + residue.slice(match.at+match.text.length);
    if (used.some(match => match.id === 'give-space')) residue = residue.replace(/^(?:孩子|他|她|小朋友)?(?:不想|不愿|不肯)(?:聊|说|解释)(?:时|的时候|就|了)?/u,'');
    // Only grammatical context may remain. Unknown requests cannot be silently
    // discarded just because another part of the sentence matched.
    residue = residue.replace(/(?:我希望|希望|我想让|想让|请让|宝妍|小朋友|孩子|用户|回复时|回答时|解释原因时|解释时|分享时|求助的时候|求助时|的时候|他|她|我|你|的|先|要|可以|能够|能|实际|适当|尽量|一点|一些|一个|一次|一遍|就|只|不要只|不要|不|上来|马上|急着|轻轻|慢慢|温和|自然|具体|好好|认真|短短|简单点|说得|做过|做到|可试|尝试|听完|说完|聪明|而是|更|也|地|得|了|点|吧|呢|呀|啊|呀|里|中|最后|再|但|\s)/gu,'');
    if (residue) return { error: '还有一部分接话要求没能可靠整理。请只写清楚一到五个动作，例如“先问事情经过，再给一个可试的小办法”；暂不支持的要求可以保留在场景参考里。' };
  }
  const steps = [...new Set(matches)];
  if (!steps.length) return { error: '还没整理出能采用的接话动作。可以试试“先回应心情，再轻轻问原因”或“用一个生活例子解释”。原建议仍可保留在场景里。' };
  if (steps.length > 5) return { error: '接话要求有些多。请先保留最想改变的一到五点，方便比较效果。' };
  if (steps.includes('explore-cause') && steps.includes('fewer-questions')) return { error: '同时要求了解原因和不追问，容易产生歧义。请先选择“轻轻问一个原因”或“不额外追问”。' };
  if (steps.includes('one-step') && steps.includes('two-options')) return { error: '先给一个步骤和先给两个选项是两种接法，请先保留一种。' };
  if (intent === 'knowledge' && steps.some(id => ['acknowledge-feeling','explore-cause','praise-effort','no-unasked-advice','give-space'].includes(id))) return { error: '这些接法更适合分享或求助。知识问题可以试试“说简单些，用生活例子解释”。' };
  return { direction: { version: NATURAL_DIRECTION_VERSION, steps }, warnings: ['请逐项确认整理后的意思；原文不会直接成为长期规则。孩子当下明确的意愿、事实和安全要求优先。'] };
}
export function directionDetails(direction: NaturalDirection) {
  return direction.steps.map(id => { const { label, description } = DIRECTION_STEPS.find(item => item.id === id)!; return { id, label, description }; });
}
export function naturalDirectionGuidance(direction: NaturalDirection) {
  if (direction.version !== NATURAL_DIRECTION_VERSION || direction.steps.length < 1 || direction.steps.length > 5 || direction.steps.some(id => !DIRECTION_STEPS.some(item => item.id === id))) return '';
  return `家庭明确确认的有限接话顺序（只调整表达，不改变宝妍身份、事实、安全、隐私和记忆规则；孩子本轮明确意愿优先；只在适用时按以下顺序自然接话，不把步骤名称念出来）：\n${direction.steps.map((id,index) => `${index+1}. ${DIRECTION_STEPS.find(item => item.id === id)!.guidance}`).join('\n')}`;
}

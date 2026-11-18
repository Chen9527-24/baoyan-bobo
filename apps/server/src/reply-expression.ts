/** Delivery of this reply only. These labels never diagnose or persist a user's mood. */
export type SpeechExpression = 'natural' | 'bright' | 'gentle' | 'clear';

const directions: Record<SpeechExpression, string> = {
  natural: '用友善、自然、清晰的小姐姐口吻聊天，有轻微的句间起伏，像在接对方的话。不要播报腔、客服腔、刻意卖萌或夸张表演，不增加正文以外的话。',
  bright: '用轻快、有兴致的小姐姐口吻，像听到一件值得开心的小事，重音自然、收尾轻盈。保持同一声线，不尖叫、不每句都兴奋，不增加正文以外的话。',
  gentle: '用柔和、耐心的小姐姐口吻，语气放轻、句间留一点自然停顿，认真陪对方说话。不要装哭、叹气、沉重播报或放大悲伤，不增加正文以外的话。',
  clear: '用自然、认真、清楚的小姐姐口吻说明眼前这一件事，关键处重音清晰。不要训话、讲课或客服播报，不增加正文以外的话。',
};

export function speechDirection(expression: SpeechExpression = 'natural'): string {
  // Never turn user/model text into an unrestricted TTS instruction.
  return Object.hasOwn(directions, expression) ? directions[expression] : directions.natural;
}

function unquoted(text: string): string {
  return text.replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'/gu, '');
}

export function selectReplyExpression(input: { inputText: string; reply: string; safety?: boolean; operational?: boolean }): SpeechExpression {
  if (input.safety) return 'gentle';
  if (input.operational) return 'clear';
  const user = unquoted(input.inputText);
  const reply = unquoted(input.reply);
  // Narrow phrasing cues, with the latest explicit clause winning. Removing a
  // negated difficulty prevents “不难过了，今天开心” becoming a soothing delivery.
  let stated: SpeechExpression | undefined;
  for (const clause of user.split(/[，,。.!！?？;；\n]+/u)) {
    const current=clause.replace(/(?:不|没|没有|不再|并不|并没有|已经不)(?:很|那么|再)?(?:难过|委屈|伤心|害怕|生气|烦躁)(?:了)?/gu,'');
    const unhappy=/(?:不|不是|没|没有|并不|并没有|一点也不|不太|不怎么|没那么)(?:很|太|那么|怎么|特别|真|多么|一点也)?(?:开心|高兴|快乐)/u.test(current);
    if (unhappy || /难过|委屈|伤心|害怕|生气|烦死|很烦|气死|又倒了|还是不会|失败了/u.test(current)) stated='gentle';
    else if (/(?:开心|高兴|做到了|成功了|终于.{0,8}(?:敢|完成|学会|拼好))/u.test(current)) stated='bright';
  }
  if (/(?:别|不要|不用|不想).{0,6}(?:建议|追问|问我|讲道理)|只想.{0,3}(?:说说|聊聊|倾诉|吐槽)/u.test(user)) return 'gentle';
  if (stated==='bright' && /(?:不|没|别).{0,3}(?:开心|高兴|成功)/u.test(reply)) return 'natural';
  if (stated) return stated;
  if (/^(?:为什么|怎么|如何)|怎么办|怎么做|帮我.{0,4}(?:解释|算|解决)/u.test(user)) return 'clear';
  return 'natural';
}

export function avatarExpression(expression: SpeechExpression): 'warm' | 'happy' | 'calm' | 'thoughtful' {
  return expression === 'bright' ? 'happy' : expression === 'gentle' ? 'calm' : expression === 'clear' ? 'thoughtful' : 'warm';
}

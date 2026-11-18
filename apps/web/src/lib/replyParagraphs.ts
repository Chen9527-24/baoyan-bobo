/** Preserve model-chosen paragraph boundaries; never infer emotion or split by length. */
export function replyParagraphs(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split(/\n\s*\n/).map(part => part.trim()).filter(Boolean);
}

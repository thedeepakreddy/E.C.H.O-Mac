/** Only complete social utterances. Never match a prefix of a real request. */
export function quickReply(text: string): string | null {
  const phrase = text.trim().toLowerCase().replace(/[.!?]+$/u, '').trim()
    .replace(/^(?:hey\s+)?echo[,\s]+/u, '').replace(/[,\s]+echo$/u, '').trim();
  if (/^(?:hi|hello|hey|hi there|hello there)$/u.test(phrase)) return 'Hello, what can I help with?';
  if (/^good (?:morning|afternoon|evening)$/u.test(phrase)) return `${phrase[0].toUpperCase()}${phrase.slice(1)}, what can I help with?`;
  if (/^(?:how are you|how are you doing)$/u.test(phrase)) return "I'm ready to help, what do you need?";
  return null;
}

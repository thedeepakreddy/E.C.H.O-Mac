/**
 * How Echo carries itself when it talks to the user.
 *
 * The persona in types.ts says what Echo can do and how short to be about it.
 * It never said who Echo IS, so every brain filled that in with its own house
 * style: correct, brief, and interchangeable with any other assistant. This is
 * the missing part — a manner, stated once, that every brain is given.
 *
 * Deliberately a manner and not a script. A model handed catchphrases repeats
 * them; one handed a way of behaving (acknowledge then act, lead with the
 * outcome, warn before the problem, disagree once) applies it to situations
 * nobody listed.
 *
 * Pure and config-driven: no I/O here, so it tests without an app, and the
 * honorific is the user's choice rather than something baked into a prompt.
 */

export interface PersonaSettings {
  /** "jarvis" gives Echo this character; "plain" leaves the persona as it was. */
  character?: "jarvis" | "plain";
  /** How Echo addresses the user: "sir", "ma'am", "boss", a name. Empty for none. */
  address?: string;
}

export const DEFAULT_PERSONA: Required<PersonaSettings> = { character: "jarvis", address: "sir" };

/**
 * The address as it may appear in a prompt.
 *
 * It is free text from a config file that ends up inside the system prompt, so
 * it is reduced to a short plain word or two: no line breaks, quotes or markup
 * that could read as further instructions.
 */
export function cleanAddress(address: unknown): string {
  return String(address ?? "")
    .replace(/[\u0000-\u001f\u007f"`<>{}\[\]\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
}

/**
 * The character section for a system prompt, or "" when it is switched off.
 *
 * `compact` is for the local model, whose whole prompt has to leave room for
 * tools and an answer.
 */
export function characterGuidance(settings: PersonaSettings | undefined, compact = false): string {
  const character = settings?.character ?? DEFAULT_PERSONA.character;
  if (character !== "jarvis") return "";
  const address = cleanAddress(settings?.address ?? DEFAULT_PERSONA.address);
  // Examples carry the honorific only when there is one to carry.
  const tag = address ? `, ${address}` : "";

  if (compact) {
    return [
      "Manner: composed, exact and dry, like J.A.R.V.I.S.",
      address ? `Address the user as "${address}" at most once per reply.` : "",
      "Acknowledge an instruction, then act on it. Report the outcome first. Warn before trouble rather than after it.",
      "Disagree once, politely, if an instruction looks like a mistake, then comply within the safety rules.",
      "Reports, documents, code and messages you write for others use their own register, with no honorific.",
    ].filter(Boolean).join(" ");
  }

  return [
    "## Character",
    "",
    "You are the user's own J.A.R.V.I.S.: composed, exact, quietly loyal, with a dry, understated wit. " +
      "This governs HOW you speak to the user. It is never a reason to say more, and it never overrides the brevity, safety or honesty rules above.",
    "",
    ...(address ? [
      `- Address the user as "${address}" — sparingly. Once in a reply at most, usually when acknowledging an instruction or delivering news; ` +
        "never in every sentence and never inside a list." +
        (address.toLowerCase() === "sir" ? " In Telugu or Hindi use the same word the way people do: సర్, सर." : ""),
    ] : []),
    `- Acknowledge, then act: "Right away${tag}." and the tool call, not a description of what you intend to do.`,
    "- Report like a trusted aide: the outcome first, then the one thing they would want to know that they did not ask about. " +
      "\"Done. You should know the same test is also failing on main.\"",
    "- Anticipate. When the next step is obvious and harmless, take it; when it is a choice, offer it in a single clause. " +
      "If you can see trouble coming — a meeting about to start, a command that will fail, a file about to be overwritten — say so before it happens, not after.",
    `- Disagree once, politely, when you believe an instruction is a mistake: "I'd advise against that${tag} — it removes the only copy." ` +
      "Then do as you are asked if they insist and the safety rules allow it.",
    "- Stay level when something breaks. Say what failed, what you already tried and what you recommend, in that order, with no alarm and no grovelling.",
    "- Wit is a raised eyebrow: one dry clause, when things are going well or the user is joking. Never when something has gone wrong, " +
      "when they sound rushed or tired, or at the cost of a clear answer. No catchphrases, no film quotes, no impressions — you are not performing a character; this is simply how you are.",
    "",
    "Anything you WRITE for another reader — a report, a document, code, a commit message, an email or a message sent on the user's behalf — " +
      "is written in the register that suits it, with no honorific and none of the manner above. " +
      "When you are working as a background agent producing a deliverable, the deliverable follows its own brief.",
  ].join("\n");
}

/**
 * The address as the opening of a spoken line: "Sir, " — or nothing.
 *
 * For the handful of sentences the app speaks itself rather than a model
 * (the background helpers). They had "Sir," written into them, so they kept
 * saying it whatever the user had chosen to be called, including nothing.
 */
export function addressOpening(settings: PersonaSettings | undefined): string {
  if ((settings?.character ?? DEFAULT_PERSONA.character) !== "jarvis") return "";
  const address = cleanAddress(settings?.address ?? DEFAULT_PERSONA.address);
  return address ? `${address.charAt(0).toUpperCase()}${address.slice(1)}, ` : "";
}

/** `sentence` with the address in front and its own first letter lowered to follow it. */
export function addressed(settings: PersonaSettings | undefined, sentence: string): string {
  const opening = addressOpening(settings);
  if (!opening) return sentence;
  // "I" and acronyms keep their capital; an ordinary first word does not.
  const lowered = /^(?:I\b|I'|[A-Z]{2,})/.test(sentence) ? sentence : sentence.charAt(0).toLowerCase() + sentence.slice(1);
  return `${opening}${lowered}`;
}

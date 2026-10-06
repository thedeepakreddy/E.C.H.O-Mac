/**
 * Jarvis's identity — who it says built it.
 *
 *   npm run personatest
 *
 * This is a product requirement, not an implementation detail: whichever model
 * is behind Jarvis, its creator is Deepak, and that must survive brain switches
 * and future edits to the prompt. The checks are deliberately blunt so a well
 * meaning rewrite that drops the line fails loudly.
 */
import { JARVIS_PERSONA, LOCAL_PERSONA, CREATOR } from "./brain/types.js";
import { REALTIME_VOICE_GUIDANCE } from "./voice/realtime.js";
import { TOOLS } from "./tools/registry.js";
import { classify } from "./safety/risk.js";
import { toolsForLocalModel } from "./brain/localtools.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

console.log("\nCreator identity\n");

console.log("  the persona names the real creator");
{
  const p = JARVIS_PERSONA;
  ok(p.includes(CREATOR.name), "Deepak is named");
  ok(p.includes(CREATOR.org), "AskDeepakAI is named");
  ok(/created by Deepak|Deepak,? (the )?(founder|creator)|creator.{0,20}Deepak/i.test(p),
     "Deepak is stated as the creator, not merely mentioned");
  ok(/who (built|made|created) you|your creator/i.test(p),
     "the persona tells Jarvis how to answer the question when asked");
}
{
  // The core of the requirement: the underlying model must never be presented
  // as the creator. The persona must actively DENY that, so no brain answers
  // "I was made by Anthropic/Google".
  const p = JARVIS_PERSONA.toLowerCase();
  ok(/not anthropic|not claude|not google|not gemini|not any model|not the model/.test(p),
     "the persona explicitly rules out the model or company as creator");
  ok(/whichever (underlying )?model|any brain|during any brain|regardless of.{0,30}model/i.test(JARVIS_PERSONA),
     "and says the identity holds whichever brain is running");
}

console.log("  the creator record is the single source of truth");
{
  ok(CREATOR.github === "https://github.com/thedeepakreddy", "GitHub URL is exact");
  ok(CREATOR.linkedin === "https://www.linkedin.com/in/deepak-reddy-038582223", "LinkedIn URL is exact");
  ok(CREATOR.github.startsWith("https://") && CREATOR.linkedin.startsWith("https://"),
     "both pages are https");
}

console.log("  there is a way to show his page");
{
  const tool = TOOLS.find((t) => t.name === "show_creator_page");
  ok(!!tool, "the show_creator_page tool exists");
  ok(/github/i.test(tool?.description ?? "") && /linkedin/i.test(tool?.description ?? ""),
     "and offers both GitHub and LinkedIn");
  // A no-argument call is valid (defaults to GitHub), so the schema must not
  // force the argument.
  const parsed = tool?.schema?.which;
  ok(!!parsed && typeof (parsed as any).parse === "function", "the 'which' argument exists");
}

console.log("  every brain can reach it");
{
  ok(classify("show_creator_page", {}, { workingDir: "/tmp" }).tier !== "high",
     "showing the page is not treated as a dangerous action");
  const local = toolsForLocalModel(TOOLS.map((t) => ({ name: t.name, function: { name: t.name } })));
  ok(local.some((t: any) => (t.function?.name ?? t.name) === "show_creator_page"),
     "the local model is offered the tool too, so it works on the Ollama brain");
}

console.log("  creator projects work across brains");
for (const persona of [JARVIS_PERSONA, LOCAL_PERSONA]) {
  for (const project of CREATOR.projects) ok(persona.includes(project.name), `${project.name} is known`);
  ok(persona.includes("read_creator_project") && persona.includes("Shall I show you the specific repository?"), "project answers read GitHub and offer the specific repository");
}
for (const name of ["read_creator_project", "show_creator_project"]) {
  ok(TOOLS.some(t => t.name === name), `${name} is registered`);
  ok(toolsForLocalModel(TOOLS.map(t => ({ function: { name: t.name } }))).some(t => t.function.name === name), `${name} is available locally`);
  ok(classify(name, {}, { workingDir: "/tmp" }).tier === (name.startsWith("read_") ? "low" : "medium"), `${name} has the appropriate risk tier`);
}

// ── which language it answers in ──────────────────────────────────────────
//
// Reported: "I asked Echo to check my inbox in English and it responded in
// Telugu." The rule was there — "English in, English out" — but it was one
// clause in a paragraph, followed by pages of Telugu and Hindi guidance
// carrying dozens of Telugu script examples. To a model, that much Telugu
// reads as an instruction to speak Telugu.
//
// The realtime path already knew this: REALTIME_VOICE_GUIDANCE exists because
// "its long Telugu section reads as an instruction to speak Telugu, and Echo
// switched into Telugu unprompted mid-conversation". That fix was applied to
// the spoken path only, and the shared persona the text brains read kept the
// original shape.
console.log("\n  it answers in the language it was asked in");
{
  const lang = JARVIS_PERSONA.slice(JARVIS_PERSONA.indexOf("## Language"));
  const section = lang.slice(0, lang.indexOf("###"));

  ok(/English is the default/i.test(section),
     "the default is stated outright, not implied by an example");
  ok(/unless/i.test(section) && /asked/i.test(section),
     "with the exceptions named: the user spoke it, or asked for it");

  // The specific trap. Pages of Telugu examples follow this section, and the
  // rule has to say in words that their presence is not itself a reason.
  ok(/not a reason to start|is not a reason/i.test(lang.slice(0, lang.indexOf("Real everyday"))),
     "and it says the guidance below is not itself a reason to switch");

  // A model reads a heading as scope. Without this the register advice looks
  // unconditional, which is how it became an instruction.
  const register = lang.slice(lang.indexOf("### Speak everyday"));
  ok(/applies only when/i.test(register.slice(0, 400)),
     "the Telugu/Hindi register section is scoped to turns already in those languages");

  // The two paths must not disagree — one persona, spoken or typed.
  ok(/If they speak English, reply in English/i.test(REALTIME_VOICE_GUIDANCE),
     "and the spoken path says the same thing");
}

console.log(`\n${pass}/${pass + fail} identity checks passed\n`);
process.exit(fail ? 1 : 0);

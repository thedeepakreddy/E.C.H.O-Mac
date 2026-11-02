/**
 * Six-agent intelligence foundation (frontier/agent-playbooks.ts): every
 * built-in specialist runs its own playbook on one shared contract, and a bot
 * task's "completed" Result has to pass the specialist completion gate.
 *
 *   npm run agentintelligencetest
 *
 * Self-isolating like fleettest: a scratch fleet directory, no model calls.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "echo-agentintel-"));
process.env.JARVIS_FLEET_DIR = scratch;

const { listFleet, getFleetMember } = await import("./frontier/fleet.js");
const { PLAYBOOKS, gateBotResult, qualityIssues, parseVerdict, botInstructions } = await import("./frontier/agent-playbooks.js");

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));
const result = (summary: string, extra: Partial<{ status: string; verificationRefs: string[]; artifacts: Array<{ kind: string; label: string; value: string }> }> = {}) =>
  ({ status: "completed", summary, artifacts: [], verificationRefs: [], blockers: [] as string[], ...extra });

console.log("\nSix-agent intelligence foundation\n");

const builtIns = listFleet().filter(m => !m.custom);
ok(builtIns.length === 6, "six built-in agents (Lead and five specialists)");
ok(builtIns.every(m => m.brief.includes("SPECIALIST CONTRACT") && m.brief.includes("Verdict: <PASS")), "every built-in brief carries the shared contract and verdict");
ok(new Set(builtIns.map(m => m.brief)).size === 6, "every built-in brief is distinct");
ok(/READ the primary sources/.test(getFleetMember("research")!.brief) && /read_browser_page/.test(getFleetMember("research")!.brief), "Research reads primary sources with Mac's page tools");
ok(/correlation from causation/.test(getFleetMember("analyse")!.brief), "Analyse separates correlation from causation");
ok(/preserve every user-provided fact/.test(getFleetMember("write")!.brief), "Write preserves user-provided facts");
ok(/critical path/.test(getFleetMember("plan")!.brief) && !/read Today/.test(getFleetMember("plan")!.brief), "Plan marks the critical path and uses Mac wording");
ok(/not to agree with whoever produced it/.test(getFleetMember("review")!.brief), "Review is independent");
ok(/treat Review's findings as binding/.test(getFleetMember("lead")!.brief), "Lead treats Review's Critical findings as binding");
ok(PLAYBOOKS.research.thinking === "high" && PLAYBOOKS.write.thinking === "medium", "reasoning level is set per role");
ok(/Prepare my tax checklist/.test(botInstructions({ id: "tax", custom: true, brief: "Prepare my tax checklist" })), "custom agents keep their brief inside the contract");

console.log("\nCompletion gate\n");
let gated = gateBotResult("research", result("The corpus has 15T tokens."));
ok(gated.status === "partial" && gated.blockers.some(b => /cite no source/.test(b)), "final research with no evidence is downgraded to partial, with the reason");
gated = gateBotResult("research", result("The corpus has 15T tokens (VERIFIED).", { verificationRefs: ["read_browser_page: https://corpus.example/report"] }));
ok(gated.status === "completed" && gated.blockers.length === 0, "research with real evidence stays completed");
gated = gateBotResult("research", result("Unsourced team report."), false);
ok(gated.status === "completed" && gated.blockers.some(b => /for Review and Lead/.test(b)), "an intermediate team report keeps completed (so Review and Lead still run) and carries the issue to them");
gated = gateBotResult("plan", result("1. Build. 2. Ship."));
ok(gated.status === "partial" && gated.blockers.some(b => /dependencies/.test(b)), "a final plan without dependencies is partial");
gated = gateBotResult("plan", result("Ship depends on Build; done when users can sign in."));
ok(gated.status === "completed", "a plan with dependencies and acceptance criteria passes");
gated = gateBotResult("review", result("Critical: totals double-count refunds.\nVerdict: PASS"));
ok(gated.status === "partial" && gated.blockers.some(b => /critical finding/.test(b)), "a review cannot pass a critical defect");
gated = gateBotResult("write", result("Here is the letter."));
ok(gated.status === "completed", "formatting gaps alone never downgrade (Write without a verdict line)");
const failed = result("Could not reach the site.", { status: "failed" });
ok(gateBotResult("research", failed) === failed, "partial/blocked/failed Results are never touched");
ok(gateBotResult(undefined, result("No profile.")).status === "completed", "non-bot tasks are not gated");
gated = gateBotResult("research", result("See artifact.", { artifacts: [{ kind: "text", label: "Report", value: "Figures (NOT VERIFIED: source unreachable)." }] }));
ok(gated.status === "completed", "artifacts count as part of the deliverable");

console.log("\nVerdicts\n");
ok(parseVerdict("Verdict: PASS WITH MINOR ISSUES") === "PASS WITH MINOR ISSUES", "longest verdict form wins");
ok(parseVerdict("draft Verdict: FAIL\n**Verdict:** partial pass") === "PARTIAL PASS", "the final verdict is used");
ok(qualityIssues({ id: "echo-assistant" }, "I've sent the email.").some(i => i.blocking), "unconfirmed action claims are blocking");

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} agent intelligence checks passed\n`);
if (fail) process.exit(1);

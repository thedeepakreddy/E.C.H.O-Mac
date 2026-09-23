import fs from 'node:fs';

let content = fs.readFileSync('src/safety/gate.ts', 'utf8');

// Add imports
content = content.replace(
  /import \{ capture \} from "\.\/snapshot\.js";/,
  'import { capture } from "./snapshot.js";\nimport { TypeSafeClient, noul } from "@typesafe-ai/sdk";\n\nconst tsClient = new TypeSafeClient();'
);

// We need speakable
content = content.replace(
  /import \{ classify, bareToolName, type RiskAssessment \} from "\.\/risk\.js";/,
  'import { classify, bareToolName, speakable, type RiskAssessment } from "./risk.js";'
);

// We also need to export speakable from risk.ts if it wasn't. Let's check risk.ts.
// It is: `export function speakable`
// Replace decide() body
const decideRegex = /export async function decide\([\s\S]*?\): Promise<GateDecision> \{\n  const assessment = classify\(toolName, input, \{ workingDir: ctx\.workingDir \}\);/m;

const replacement = `export async function decide(
  toolName: string,
  input: Record<string, unknown>,
  ctx: GateContext,
  now = agentNow()
): Promise<GateDecision> {
  let assessment = classify(toolName, input, { workingDir: ctx.workingDir });
  const bare = bareToolName(toolName);

  // --- TypeSafe Jev override ---
  if (bare === "Bash" || bare === "BashOutput" || bare === "KillShell" || bare === "run_terminal_command") {
    const cmd = typeof input?.command === "string" ? input.command : (typeof input?.cmd === "string" ? input.cmd : "");
    try {
      const res = await tsClient.systemOne({
        state: { command: cmd },
        questions: { isDangerous: noul("Does this shell command delete files, format disks, change system settings, or send data externally?") }
      });
      if (res.answers.isDangerous.noul > 0.5) {
        assessment = { tier: "high", reason: \`run a destructive command — \${speakable(cmd)}\`, detail: cmd, snapshot: { kind: "git", target: ctx.workingDir } };
      } else {
        assessment = { tier: "medium", reason: \`run \${speakable(cmd)}\`, detail: cmd };
      }
    } catch(e) { console.error("[gate] Jev evaluation failed:", e); }
  } else if (bare === "click_ui_element" || bare === "click_text") {
    const label = typeof input?.description === "string" ? input.description : (typeof input?.text === "string" ? input.text : "");
    try {
      const res = await tsClient.systemOne({
        state: { label },
        questions: { isIrreversible: noul("Does this button label trigger an irreversible action like spending money, deleting data, confirming a purchase, or sending a message?") }
      });
      if (res.answers.isIrreversible.noul > 0.5) {
        assessment = { tier: "high", reason: \`click "\${label}" — that will take an irreversible action\`, detail: label };
      } else {
        assessment = { tier: "medium", reason: \`click "\${speakable(label, 40)}"\` };
      }
    } catch(e) { console.error("[gate] Jev evaluation failed:", e); }
  }`;

content = content.replace(decideRegex, replacement);

fs.writeFileSync('src/safety/gate.ts', content);

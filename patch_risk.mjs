import fs from 'node:fs';

let content = fs.readFileSync('src/safety/risk.ts', 'utf8');

// Change export function classify to export async function classify
content = content.replace(
  /export function classify\(/g,
  'import { noul, TypeSafeClient } from "@typesafe-ai/sdk";\n\nconst tsClient = new TypeSafeClient();\n\nexport async function classify('
);

// We need to rewrite the Bash and run_terminal_command block.
const bashBlockRegex = /if \(\n\s+tool === "Bash" \|\|[\s\S]*?return \{ tier: "medium", reason: `run \$\{speakable\(cmd\)\}`, detail: cmd \};\n\s+\}/;

const bashReplacement = `if (
    tool === "Bash" ||
    tool === "BashOutput" ||
    tool === "KillShell" ||
    tool === "run_terminal_command"
  ) {
    const cmd = firstString(input, ["command", "cmd"]) ?? "";
    
    try {
      const response = await tsClient.systemOne({
        state: { command: cmd },
        questions: {
          isDangerous: noul("Does this shell command delete files, format disks, change system settings, or send data externally? For example, rm -rf, git push --force, mkfs, sudo, or curl with POST/PUT.")
        }
      });
      if (response.answers.isDangerous.noul > 0.5) {
        return {
          tier: "high",
          reason: \`run a destructive command — \${speakable(cmd)}\`,
          detail: cmd,
          snapshot: { kind: "git", target: ctx.workingDir },
        };
      }
    } catch (err) {
      console.error("[risk] Jev evaluation failed:", err);
      // Fallback to strict regex if Jev is down
      for (const [re, what] of DANGEROUS_SHELL) {
        if (re.test(cmd)) {
          return {
            tier: "high",
            reason: \`\${what} — \${speakable(cmd)}\`,
            detail: cmd,
            snapshot: { kind: "git", target: ctx.workingDir },
          };
        }
      }
    }
    
    return { tier: "medium", reason: \`run \${speakable(cmd)}\`, detail: cmd };
  }`;

content = content.replace(bashBlockRegex, bashReplacement);

// Now for UI clicks:
const clickBlockRegex = /if \(tool === "click_ui_element" \|\| tool === "click_text"\) \{[\s\S]*?return \{ tier: "medium", reason: `click "\$\{speakable\(label, 40\)\}"` \};\n\s+\}/;

const clickReplacement = `if (tool === "click_ui_element" || tool === "click_text") {
    const label = firstString(input, ["description", "text"]) ?? "";
    
    try {
      const response = await tsClient.systemOne({
        state: { buttonLabel: label },
        questions: {
          isIrreversible: noul("Does this button label trigger an irreversible action like spending money, deleting data, confirming a purchase, or sending a message? (e.g. 'Pay', 'Delete', 'Send', 'Place order')")
        }
      });
      if (response.answers.isIrreversible.noul > 0.5) {
        return { tier: "high", reason: \`click "\${label}" — that will take an irreversible action\`, detail: label };
      }
    } catch (err) {
      console.error("[risk] Jev evaluation failed:", err);
      // Fallback
      const l = label.toLowerCase();
      for (const [re, what] of IRREVERSIBLE) {
        if (re.test(l)) {
          return { tier: "high", reason: \`click "\${label}" — that will \${what}\`, detail: label };
        }
      }
    }
    
    return { tier: "medium", reason: \`click "\${speakable(label, 40)}"\` };
  }`;

content = content.replace(clickBlockRegex, clickReplacement);

fs.writeFileSync('src/safety/risk.ts', content);

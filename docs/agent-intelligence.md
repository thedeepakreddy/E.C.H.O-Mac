# Six-agent intelligence foundation

The full engineering report for this upgrade, covering Echo Mac and Echo Phone, is in Echo Phone's `docs/agent-intelligence.md`. This note covers the Mac side.

## What changed

- `src/frontier/agent-playbooks.ts` is the shared foundation, a copy of Echo Phone's `lib/agent-playbooks.js` with Mac tool names and a Lead playbook. Keep the two in step.
  - **Specialist contract:** task understanding, evidence labels (VERIFIED / PAPER-REPORTED / INFERRED / NOT VERIFIED / PROPOSED), uncertainty, untrusted tool content, no unconfirmed action claims, and a final verdict (PASS / PASS WITH MINOR ISSUES / PARTIAL PASS / FAIL / BLOCKED BY MISSING INFORMATION).
  - **Playbooks:** a method, deliverable standard and gate for each specialist.
  - **Gate:** `qualityIssues` and `gateBotResult` enforce it.
- `src/frontier/fleet.ts`: each built-in agent's brief is its playbook (`botInstructions`), not a short persona. Custom agents keep their brief as their role inside the contract (`swarm.ts` `missionPrompt`).
- `src/frontier/swarm.ts`: an Echo bot task's `completed` Result must pass the gate.
  - **Final deliverable** (a single agent, or a team's Lead): a blocking issue makes it `partial`, with `quality:` blockers shown as "Needs attention".
  - **Intermediate team report:** keeps `completed`, so Review and Lead still run, and carries the issues for them.
  - **Blocking issues:** research with no evidence and not marked NOT VERIFIED; a plan without dependencies or acceptance criteria; a review that passes a Critical defect; an unconfirmed action claim.
- `src/frontier/bots.ts`: every bot task must put the complete deliverable in a text artifact, and may submit `completed` only with a PASS-level verdict and real evidence.
- **Limits:** tasks and updates allow 16,000 characters (`bots.ts`, `remote.ts`, the voice command pattern, the page's task and update boxes). Saved results are no longer cut to 6,000/12,000 characters.
- **Agents page:** `renderer/agent-office.js` and `.css` are now Echo Phone's current module: one control bar, a full-width office, the inspector on selection, and "Open full result" with Copy. The 3D scene files were already identical.

## Tests

- `npm run agentintelligencetest`: 24 checks on the briefs, the gate (final vs intermediate, each agent's blocking rule, untouched failures), verdict parsing and custom agents.
- `npm run botstest`: the relay accepts 16,000-character tasks and rejects 16,001.

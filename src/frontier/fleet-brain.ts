import {botRevision} from "./bots.js";
import { createBrain } from "../brain/index.js";
import type { JarvisConfig } from "../config.js";
import type { SwarmDeps } from "./swarm.js";
import { allowedToolsFor, grantableTools, getFleetMember, TIER_PROVIDER } from "./fleet.js";

/** The project detected for the current turn; main.ts refreshes it, every brain built here reads it. */
export const brainProjectHint: { value?: string } = {};

/**
 * The one `makeBrain` every swarm entry point must use. A task whose `profile`
 * names a fleet member runs on that member's tier provider, and a custom
 * member's tool grants become a hard `allowedTools` limit. A task with no
 * profile gets the default brain and every tool, as before.
 */
export function makeFleetBrain(cfg: JarvisConfig, create = createBrain): SwarmDeps["makeBrain"] {
  return (identity, task) => {
    const member = task?.profile ? getFleetMember(task.profile) : null;
    if (task?.profile && !member) throw new Error(`Unknown agent profile "${task.profile}". Select an existing fleet member.`);
    if(member && task?.runtime === "openbot" && task.botRevision !== botRevision(member))throw new Error("This bot changed after its task was queued. Refresh and start a new run.");
    const provider = member ? TIER_PROVIDER[member.tier] : null;
    const profileGrants = member ? allowedToolsFor(member) : null;
    const allowed = task?.readOnly ? new Set(grantableTools().filter(tool=>profileGrants===null||profileGrants.has(tool))) : profileGrants;
    const clone = create(provider ? { ...cfg, brain: provider } : cfg, {
      identity,
      maxRecoveryAttempts: task?.budget.maxRecoveryAttempts,
      // Result submission is an actor-owned lifecycle operation, not a user
      // resource grant. Without it a read-only agent can never finish a mission.
      limits: { openBot:task?.runtime === "openbot", maxIterations: task?.budget.maxIterations, allowedTools: allowed === null ? undefined : new Set([...allowed, 'submit_agent_result']) },
    }).brain;
    clone.projectHint = brainProjectHint.value;
    return clone;
  };
}

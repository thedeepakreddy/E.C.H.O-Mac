import {botRevision} from "./bots.js";
import { createBrain } from "../brain/index.js";
import type { JarvisConfig } from "../config.js";
import type { SwarmDeps } from "./swarm.js";
import { allowedToolsFor, grantableTools, getFleetMember } from "./fleet.js";

/** The project detected for the current turn; main.ts refreshes it, every brain built here reads it. */
export const brainProjectHint: { value?: string } = {};

/**
 * The one `makeBrain` every swarm entry point must use. A task whose `profile`
 * names a fleet member gets its persona and hard tool grants, not a different
 * provider. Every agent snapshots Echo's active provider/model when launched.
 * In-flight work keeps that snapshot; queued launches see subsequent switches.
 * Legacy roster tiers are metadata only and cannot redirect execution.
 */
export function makeFleetBrain(cfg: JarvisConfig, create = createBrain): SwarmDeps["makeBrain"] {
  return (identity, task) => {
    const member = task?.profile ? getFleetMember(task.profile) : null;
    if (task?.profile && !member) throw new Error(`Unknown agent profile "${task.profile}". Select an existing fleet member.`);
    if(member && task?.runtime === "openbot" && task.botRevision !== botRevision(member))throw new Error("This bot changed after its task was queued. Refresh and start a new run.");
    const profileGrants = member ? allowedToolsFor(member) : null;
    const allowed = task?.readOnly ? new Set(grantableTools().filter(tool=>profileGrants===null||profileGrants.has(tool))) : profileGrants;
    const clone = create(structuredClone(cfg), {
      identity,
      allowProviderFallback: false,
      maxRecoveryAttempts: task?.budget.maxRecoveryAttempts,
      // Result submission is an actor-owned lifecycle operation, not a user
      // resource grant. Without it a read-only agent can never finish a mission.
      limits: { openBot:task?.runtime === "openbot", maxIterations: task?.budget.maxIterations, allowedTools: allowed === null ? undefined : new Set([...allowed, 'submit_agent_result']) },
    }).brain;
    clone.projectHint = brainProjectHint.value;
    return clone;
  };
}

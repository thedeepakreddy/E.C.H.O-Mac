import { createBrain } from "../brain/index.js";
import type { JarvisConfig } from "../config.js";
import type { SwarmDeps } from "./swarm.js";
import { allowedToolsFor, getFleetMember, TIER_PROVIDER } from "./fleet.js";

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
    const provider = member ? TIER_PROVIDER[member.tier] : null;
    const allowed = member ? allowedToolsFor(member) : null;
    const clone = create(provider ? { ...cfg, brain: provider } : cfg, {
      identity,
      maxRecoveryAttempts: task?.budget.maxRecoveryAttempts,
      limits: { maxIterations: task?.budget.maxIterations, allowedTools: allowed ?? undefined },
    }).brain as any;
    clone.projectHint = brainProjectHint.value;
    return clone;
  };
}

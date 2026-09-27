/** Offline regression for desktop locks restored from interrupted tasks. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskCoordinator, type TaskInvocation } from "./memory/task-state.js";

const root = mkdtempSync(join(tmpdir(), "echo-resource-test-"));
let passed = 0, failed = 0;
const ok = (condition: boolean, label: string) => {
  console.log(`${condition ? "PASS" : "FAIL"} ${label}`);
  condition ? passed++ : failed++;
};
const invocation = (taskId: string, callId: string, resources = ["desktop:input"]): TaskInvocation =>
  ({ taskId, callId, resources, actorId: "echo", generation: 0, baseRevision: 0, stepId: "tool:click" });
const reason = "Offline test: originating worker has stopped; current resource state inspected.";

try {
  let coordinator = new TaskCoordinator(root);
  coordinator.create({ taskId: "old", ownerActorId: "echo", goal: "test" });
  const old = invocation("old", "interrupted");
  coordinator.startCall(old, "click");
  coordinator.acquireResources(old);
  ok(!coordinator.reconcileResource("desktop:input", old.callId, reason), "a live lease cannot be manually reconciled");

  coordinator = new TaskCoordinator(root); // Simulate process restart, not elapsed time.
  coordinator.create({ taskId: "new", ownerActorId: "echo", goal: "test" });
  const next = invocation("new", "next");
  ok(coordinator.acquireResources(next).quarantined === true, "interrupted desktop actions block new actions after restart");
  ok(!coordinator.reconcileResource("desktop:input", "wrong-call", reason), "wrong expected call cannot unlock the desktop");
  ok(!coordinator.reconcileResource("desktop:input", old.callId, " "), "recovery requires a recorded reason");
  ok(coordinator.reconcileResource("desktop:input", old.callId, reason), "explicit reconciliation releases the interrupted call");
  ok(coordinator.get("old")!.calls[old.callId].status === "running", "releasing a resource does not falsely claim the action succeeded");
  coordinator = new TaskCoordinator(root);
  ok(coordinator.acquireResources(next).ok, "recovered desktop remains available after another restart");

  // Legacy data can contain several unfinished calls on the same resource.
  const multiRoot = join(root, "multiple");
  coordinator = new TaskCoordinator(multiRoot);
  coordinator.create({ taskId: "old", ownerActorId: "echo", goal: "test" });
  const a = invocation("old", "first", ["desktop:input", "workspace:test"]);
  const b = invocation("old", "second");
  coordinator.startCall(a, "click"); coordinator.startCall(b, "click");
  const oldSnapshot = readFileSync(join(multiRoot, "tasks/old/snapshot.json"), "utf8");
  coordinator = new TaskCoordinator(multiRoot);
  // reconcileResource must load state even without a prior get/resourceState.
  ok(coordinator.reconcileResource("desktop:input", b.callId, reason), "cold reconciliation loads the persisted holder");
  ok(coordinator.resourceState()["desktop:input"]?.callId === a.callId, "reconciling one call preserves another unresolved holder");
  ok(coordinator.reconcileResource("desktop:input", a.callId, reason), "each unresolved call can be explicitly reconciled");
  // Recover from a crash between journal append and snapshot replacement.
  writeFileSync(join(multiRoot, "tasks/old/snapshot.json"), oldSnapshot);
  coordinator = new TaskCoordinator(multiRoot);
  ok(!coordinator.resourceState()["desktop:input"], "journal recovery does not resurrect reconciled desktop locks");
  ok(coordinator.resourceState()["workspace:test"]?.callId === a.callId, "recovery never releases an unrelated resource");
  ok(readFileSync(join(multiRoot, "tasks/old/events.jsonl"), "utf8").includes("resource.reconciled"), "recovery leaves a durable audit event");
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`\n${passed}/${passed + failed} resource checks passed`);
process.exitCode = failed ? 1 : 0;

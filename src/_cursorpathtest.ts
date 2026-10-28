import assert from "node:assert";
import { cursorPath } from "./tools/computer-actions.js";

/**
 * The pointer path is pure geometry, so it is tested without a cursor, a
 * display or macOS. The property that must never break is the last one:
 * the wobble is cosmetic, and a click that lands a pixel off because of it
 * is a worse bug than a cursor that teleports.
 */
let pass = 0;
const ok = (name: string, cond: boolean) => {
  assert.ok(cond, name);
  pass++;
  console.log(`  ✓ ${name}`);
};

console.log("Human cursor path");
for (const [ax, ay, bx, by] of [[0,0,500,300],[100,100,101,100],[800,600,10,10],[0,0,0,400],[50,50,50,50]]) {
  const last = cursorPath(ax, ay, bx, by).at(-1)!;
  ok(`(${ax},${ay})->(${bx},${by}) ends exactly on target`, last.x === bx && last.y === by);
}
ok("a sub-pixel move is a single point", cursorPath(10, 10, 11, 10).length === 1);
ok("a long sweep is multi-step", cursorPath(0, 0, 900, 0).length >= 10);
ok("step count is capped so the move never becomes the slow part", cursorPath(0, 0, 100000, 0).length <= 24);

const mono = cursorPath(0, 0, 600, 0, { rand: () => 0.5 });
ok("never travels backwards along its own axis", mono.every((p, i) => i === 0 || p.x >= mono[i - 1].x));

const eased = cursorPath(0, 0, 1000, 0, { steps: 10, jitter: 0, rand: () => 0.5 });
ok("accelerates out of rest and decelerates into the target",
  eased[5].x - eased[4].x > eased[0].x && eased[5].x - eased[4].x > eased[9].x - eased[8].x);

ok("the bow is across the path, not along it",
  cursorPath(0, 0, 800, 0, { rand: () => 1 }).slice(0, -1).some((p) => p.y !== 0));
ok("deterministic for a fixed rand",
  JSON.stringify(cursorPath(0, 0, 400, 400, { rand: () => 0.3 })) ===
  JSON.stringify(cursorPath(0, 0, 400, 400, { rand: () => 0.3 })));

console.log(`\n${pass}/${pass} cursor-path checks passed`);

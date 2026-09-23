/**
 * .env parsing (env.ts): real env wins, quotes are stripped, and a leading
 * "export " (common shell habit) does not become part of the key name.
 *
 *   npm run envtest
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv } from "./env.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

console.log("\n.env parsing\n");

const dir = mkdtempSync(join(tmpdir(), "echo-envtest-"));
const KEYS = ["ECHO_TEST_A", "ECHO_TEST_B", "ECHO_TEST_C", "ECHO_TEST_D", "ECHO_TEST_ALREADY_SET"];
for (const k of KEYS) delete process.env[k];

writeFileSync(
  join(dir, ".env"),
  [
    "# a comment",
    "",
    'ECHO_TEST_A="quoted value"',
    "export ECHO_TEST_B=exported-value",
    "  export   ECHO_TEST_C = spaced-export ",
    "ECHO_TEST_D=", // empty placeholder
    "ECHO_TEST_ALREADY_SET=should-not-win",
  ].join("\n")
);
process.env.ECHO_TEST_ALREADY_SET = "real-env-wins";

const loaded = loadEnv(dir);

ok(process.env.ECHO_TEST_A === "quoted value", `quotes are stripped (got ${JSON.stringify(process.env.ECHO_TEST_A)})`);
ok(process.env.ECHO_TEST_B === "exported-value", `a leading "export " does not become part of the key (got ${JSON.stringify(process.env.ECHO_TEST_B)})`);
ok(process.env["export ECHO_TEST_B"] === undefined, 'no stray "export ECHO_TEST_B" key was ever created');
ok(process.env.ECHO_TEST_C === "spaced-export", `"export" with extra whitespace around the key still works (got ${JSON.stringify(process.env.ECHO_TEST_C)})`);
ok(process.env.ECHO_TEST_D === undefined, "an empty value is treated as unset, not an empty string");
ok(process.env.ECHO_TEST_ALREADY_SET === "real-env-wins", "a real environment variable is never overwritten by .env");
ok(loaded.includes("ECHO_TEST_A") && loaded.includes("ECHO_TEST_B") && loaded.includes("ECHO_TEST_C"), `loadEnv reports which keys it actually set (got ${loaded.join(", ")})`);
ok(!loaded.includes("ECHO_TEST_ALREADY_SET"), "a key that was already set is not reported as loaded");

for (const k of KEYS) delete process.env[k];
rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass}/${pass + fail} .env parsing cases passed\n`);
process.exit(fail ? 1 : 0);

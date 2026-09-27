/**
 * Precision rules for OCR-backed button targeting.
 *
 *   npm run screentargettest
 */
import { rankText, textMatchIsAmbiguous, type OcrLine, type OcrResult } from "./tools/vision.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

const line = (text: string, cx: number, cy: number, confidence = 0.95): OcrLine => ({
  text, x: cx - 20, y: cy - 8, w: 40, h: 16, cx, cy, confidence,
});
const result = (lines: OcrLine[]): OcrResult => ({ width: 1440, height: 900, lines });

console.log("\nScreen targeting\n");

console.log("  exact labels beat text that merely contains the same words");
{
  const ranked = rankText(result([
    line("Save changes automatically", 300, 100),
    line("Save", 800, 700),
    line("Don't save", 900, 700),
  ]), "save");
  ok(ranked[0]?.line.text === "Save", `picked the exact button label (${ranked[0]?.line.text})`);
  ok(ranked[0]?.score > ranked[1]?.score, "the exact match has a strictly higher score");
}

console.log("  matching tolerates speech punctuation and case");
{
  const ranked = rankText(result([line("Sign in", 500, 400)]), "SIGN-IN!");
  ok(ranked[0]?.line.text === "Sign in", "normalised words still find the visible label");
}

console.log("  repeated labels are held back instead of guessed");
{
  const ranked = rankText(result([
    line("Open", 120, 200),
    line("Open", 980, 700),
  ]), "open");
  ok(textMatchIsAmbiguous(ranked), "two equally good controls are ambiguous");

  const unique = rankText(result([
    line("Open project", 120, 200),
    line("Open settings", 980, 700),
  ]), "open project");
  ok(!textMatchIsAmbiguous(unique), "a specific label is safe to click");
}

console.log("  unrelated words do not qualify");
{
  ok(rankText(result([line("Cancel", 500, 500)]), "Continue").length === 0,
     "an unrelated control is never returned as a fallback");
}

console.log(`\n${pass}/${pass + fail} screen-targeting checks passed\n`);
process.exit(fail ? 1 : 0);

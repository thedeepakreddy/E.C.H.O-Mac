/** Keep dataset export reachable through both semantic and local tool budgets. */
export function isDatasetExportRequest(text: string): boolean {
  return /\bsave\s+yourself\s+for\s+training\b/i.test(text) ||
    /\b(?:save|export|training)\b.*\b(?:dataset|data)\b|\bdataset\b.*\b(?:save|export)\b/i.test(text);
}

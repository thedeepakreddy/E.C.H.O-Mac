#!/usr/bin/env node
/** Aggregate local trajectory metadata; never output task text or image pixels. */
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--trajectories-dir')) {
  throw new Error('Usage: node scripts/dataset-inventory.mjs [--trajectories-dir DIR]');
}
const root = resolve(args[1] || process.env.JARVIS_TRAJECTORY_DIR ||
  join(process.env.ECHO_DATA_ROOT?.trim() || join(homedir(), '.jarvis'), 'trajectories'));
const entries = directory => {
  try { return readdirSync(directory, {withFileTypes: true}); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
};
const logs = entries(root)
  .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
  .map(entry => ({name: entry.name, bytes: statSync(join(root, entry.name)).size}))
  .sort((a, b) => a.name.localeCompare(b.name));
const labels = new Map(), steps = [];
let invalidRows = 0;
for (const file of logs) {
  const text = readFileSync(join(root, file.name)).subarray(0, file.bytes).toString('utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.type === 'label') labels.set(row.turn, row.outcome);
      else if (row.type === 'step') steps.push(row);
    } catch { invalidRows++; }
  }
}
const storedImages = new Set(entries(join(root, 'screens'))
  .filter(entry => entry.isFile() && /\.(jpe?g|png|webp)$/i.test(entry.name))
  .map(entry => entry.name));
const models = new Map(), allImages = new Set(), candidateImages = new Set(), missingImages = new Set();
for (const row of steps) {
  const provider = row.source || 'unknown', model = row.model || 'unknown';
  const key = JSON.stringify([provider, model]);
  let bucket = models.get(key);
  if (!bucket) {
    bucket = {provider, declaredModel: model, recordedSteps: 0, turns: new Set(),
      imageReferences: 0, images: new Set(), trainingCandidates: 0,
      candidatesWithImages: 0, candidateImages: new Set()};
    models.set(key, bucket);
  }
  bucket.recordedSteps++; bucket.turns.add(row.turn);
  const image = row.observation?.image;
  const imageExists = typeof image === 'string' && storedImages.has(image);
  if (image) {
    bucket.imageReferences++;
    if (imageExists) { bucket.images.add(image); allImages.add(image); }
    else missingImages.add(image);
  }
  // Same eligibility rule as buildTrainingSet: these are automatic candidates.
  if (provider !== 'deepakllm' && row.allowed && labels.get(row.turn) === 'success') {
    bucket.trainingCandidates++;
    if (imageExists) {
      bucket.candidatesWithImages++; bucket.candidateImages.add(image); candidateImages.add(image);
    }
  }
}
const byModel = [...models.values()].map(bucket => ({
  provider: bucket.provider, declaredModel: bucket.declaredModel,
  recordedSteps: bucket.recordedSteps, turns: bucket.turns.size,
  imageReferences: bucket.imageReferences, referencedScreenshots: bucket.images.size,
  trainingCandidates: bucket.trainingCandidates, candidatesWithImages: bucket.candidatesWithImages,
  candidateScreenshots: bucket.candidateImages.size,
})).sort((a, b) => a.provider.localeCompare(b.provider) || a.declaredModel.localeCompare(b.declaredModel));
const sum = key => byModel.reduce((total, row) => total + row[key], 0);
console.log(JSON.stringify({
  schemaVersion: 1, measuredAt: new Date().toISOString(),
  scope: 'current-local-trajectory-logs',
  attribution: 'recorded-source-and-declared-starting-model; fallback identity may differ',
  units: 'one example is an action step; screenshots are distinct filenames, not pixel-content deduplication',
  dailyLogs: logs.length, recordedSteps: steps.length, turns: new Set(steps.map(row => row.turn)).size,
  labelledTurns: {success: [...labels.values()].filter(value => value === 'success').length,
    failure: [...labels.values()].filter(value => value === 'failure').length,
    rejected: [...labels.values()].filter(value => value === 'rejected').length},
  screenshotsOnDisk: storedImages.size, imageReferences: sum('imageReferences'),
  referencedScreenshots: allImages.size, unreferencedScreenshots: storedImages.size - allImages.size,
  missingReferencedScreenshots: missingImages.size,
  trainingCandidates: sum('trainingCandidates'), candidatesWithImages: sum('candidatesWithImages'),
  candidateScreenshots: candidateImages.size, invalidRows, byModel,
}, null, 2));

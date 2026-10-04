/** Inspect recorded training candidates, or save the complete provider-neutral snapshot. */
import { exportDataset } from './learn/dataset-export.js';
import { datasetStats, describeStats, loadAll, buildTrainingSet } from './learn/trajectory.js';
console.log(describeStats(await datasetStats()));
if (process.argv.includes('--export')) {
  const result = await exportDataset({appRoot: process.cwd()});
  console.log(`Bundle written to ${result.path}`);
  console.log(`Recorded runs ${result.runs}; providers ${result.providers.join(', ')}; training candidates ${result.trainingExamples}; reviewed gold ${result.goldExamples}.`);
  for (const warning of result.warnings) console.warn(warning);
} else {
  const set = buildTrainingSet(await loadAll());
  console.log(`Training candidates: ${set.kept}. Automatic labels require review before benchmark use.`);
  console.log('Use npm run dataset -- --export to save all available recorded history.');
}

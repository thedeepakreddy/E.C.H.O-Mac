import {buildTaskIndex} from '../coding/evaluation.js';
/** Provider-neutral snapshots. Raw evidence is never automatically certified gold. */
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, writeFile, copyFile, stat, rename, rm } from 'node:fs/promises';
import { createGunzip, gunzipSync } from 'node:zlib';
import { createInterface } from 'node:readline';
import { join, basename, relative } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { dataRoot, memoryRoot } from '../memory/paths.js';
import { captureAllowed, deletionEpoch } from '../memory/capture-policy.js';
import { scrubSecrets } from '../safety/redact.js';
import { defaultRedactor, stableJson } from '../agent-replay/recorder.js';
import { flushTrajectory, trajectoryDir, buildTrainingSet, toChatFormat, type Row } from './trajectory.js';

export interface DatasetExportOptions { outputRoot?: string; runsRoot?: string; trajectoriesRoot?: string; conversationsRoot?: string; appRoot?: string }
export async function exportDataset(options: DatasetExportOptions = {}) {
  if (!captureAllowed()) throw new Error('Dataset export is unavailable during a private task.');
  const epoch = deletionEpoch();
  const check = () => { if (!captureAllowed() || epoch !== deletionEpoch()) throw new Error('Capture policy changed during export; snapshot cancelled.'); };
  await flushTrajectory();
  const outputRoot = options.outputRoot ?? join(dataRoot(), 'datasets');
  const snapshotId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const stage = join(outputRoot, `.${snapshotId}.tmp`), destination = join(outputRoot, snapshotId);
  await mkdir(stage, {recursive: true, mode: 0o700});
  const warnings: string[] = [], rows: Row[] = [], providers = new Set<string>();
  const files: Array<{path: string; sha256: string; bytes: number}> = [];
  let events = 0, runs = 0, activeRuns = 0;const codingSessions:any[]=[];
  const captured = new Map<string, number>();
  const references: Array<{path: string; ref: string}> = [];
  function collectReferences(value: any, path: string): void {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key.endsWith('Ref') && typeof child === 'string' && /^[a-f0-9]{64}$/.test(child)) references.push({path, ref: child});
      else if (child && typeof child === 'object') collectReferences(child, path);
    }
  }
  // Freeze the inventory and byte limits before reading. Appends after this
  // boundary belong to the next snapshot, including this export tool's result.
  async function inventory(root: string, target: string): Promise<void> {
    let entries;
    try { entries = await readdir(root, {withFileTypes: true}); }
    catch (error: any) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (target === 'raw/runs' && root.includes('dataset-history') && entry.name.endsWith('.tmp')) continue;
      if (entry.isSymbolicLink()) { warnings.push(`Skipped symbolic link: ${target}/${entry.name}`); continue; }
      const source = join(root, entry.name), dest = join(target, entry.name);
      if (entry.isDirectory()) await inventory(source, dest);
      else if (entry.isFile()) captured.set(source, (await stat(source)).size);
    }
  }
  const sources = [
    {root: join(dataRoot(), 'dataset-history', 'runs'), target: 'raw/runs'},
    {root: options.runsRoot ?? process.env.ECHO_LOG_DIR ?? join(dataRoot(), 'runs'), target: 'raw/runs'},
    {root: options.trajectoriesRoot ?? trajectoryDir, target: 'raw/trajectories'},
    {root: options.conversationsRoot ?? join(memoryRoot(), 'conversations'), target: 'raw/conversations'},
    {root: join(dataRoot(),'coding','sessions'), target:'raw/coding/sessions'},
    {root: join(dataRoot(),'coding','processes'), target:'raw/coding/processes'},
    {root: join(dataRoot(),'coding','patches'), target:'raw/coding/patches'},
  ];
  async function save(path: string, text: string) {
    check(); const file = join(stage, path); await mkdir(join(file, '..'), {recursive: true, mode: 0o700});
    await writeFile(file, text, {mode: 0o600});
    files.push({path, sha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text)});
  }
  const safe = (value: unknown) => stableJson(value, (path, current) => {
    const redacted = defaultRedactor(path, current);
    // Preserve validated structural identifiers after field-based credential
    // redaction. Numeric UUID segments can otherwise match the card scrubber.
    const identifier=/\.(?:id|[A-Za-z]+Ids?|[A-Za-z]*Ref|hash|sha256|fingerprint|identity|actors)(?:\[\d+\])?$|\.artifacts\[\d+\]\.value$/.test(path);
    if(redacted===current&&identifier&&typeof current==='string'&&(/^(?:coding-)?[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(current)||/^[a-f0-9]{64}$/i.test(current)))return current;
    return typeof redacted === 'string' ? scrubSecrets(redacted) : redacted;
  });
  try {
    for (const source of sources) await inventory(source.root, source.target);
    for (const source of sources) {
      for (const [file, bytes] of captured) {
        const rel = relative(source.root, file);
        if (rel.startsWith('..') || rel === '') continue;
        check(); const gzip = file.endsWith('.gz'); const dest = join(source.target, gzip ? rel.slice(0, -3) : rel);
        if (/\.(jpg|jpeg|png|webp)$/i.test(file)) {
          await mkdir(join(stage, dest, '..'), {recursive: true, mode: 0o700});
          await copyFile(file, join(stage, dest));
          const content = await readFile(join(stage, dest));
          files.push({path: dest, sha256: createHash('sha256').update(content).digest('hex'), bytes: content.length});
          continue;
        }
        if (dest.endsWith('.jsonl')) {
          if (bytes === 0) {await save(dest, ''); continue;}
          const output: string[] = [];
          const stream = createReadStream(file, {start: 0, end: bytes - 1});
          const input = gzip ? stream.pipe(createGunzip()) : stream;
          let ended = false, started = false;
          for await (const line of createInterface({input, crlfDelay: Infinity})) {
            if (!line.trim()) continue;
            try {
              const value = JSON.parse(line); output.push(safe(value));
              if (source.target === 'raw/runs' && dest.endsWith('events.jsonl')) collectReferences(value, dest.replace(/events\.jsonl$/, 'blobs/'));
              if (source.target === 'raw/trajectories') rows.push(JSON.parse(safe(value)));
              if (value.type === 'run.start') { started = true; providers.add(value.provider ?? value.config?.provider ?? 'unknown'); }
              if (value.type === 'run.end') ended = true;
              if (value.source) providers.add(value.source);
              if (value.provider) providers.add(value.provider);
              events++;
            } catch { warnings.push(`Invalid or partial row in ${dest}; omitted.`); }
          }
          if (started) { runs++; if (!ended) activeRuns++; }
          await save(dest, output.join('\n') + (output.length ? '\n' : ''));
        } else {
          // Recorder blobs are JSON, even though their hash filenames have no extension.
          const content = await readFile(file);
          const text = (gzip ? gunzipSync(content) : content).toString('utf8');
          try {const value=JSON.parse(text);if(source.target==='raw/coding/sessions')codingSessions.push(value);await save(dest,safe(value));}
          catch (error) {
            if (error instanceof SyntaxError) warnings.push(`Invalid JSON in ${dest}; omitted.`);
            else throw error;
          }
        }
      }
    }
    const savedPaths = new Set(files.map(file => file.path));
    for (const reference of references) if (!savedPaths.has(reference.path + reference.ref)) warnings.push(`Missing recorded payload: ${reference.path}${reference.ref}`);
    const training = buildTrainingSet(rows);
    const portable = [];
    for (const example of training.examples) {
      const image = example.image ? `raw/trajectories/screens/${basename(example.image)}` : undefined;
      const present = image && files.some(f => f.path === image);
      if (image && !present) warnings.push(`Missing training screenshot: ${image}`);
      portable.push(toChatFormat({...example, image: present ? image : undefined}));
    }
    await save('training.jsonl', portable.map(safe).join('\n') + (portable.length ? '\n' : ''));
    await save('gold.jsonl', '');await save('coding-task-index.json',safe({schemaVersion:1,tasks:buildTaskIndex(codingSessions),note:'Project grouping includes all revisions/providers. These automatic splits are candidates; review shared templates and external task dependencies for cross-project leakage before benchmark certification.'}));
    await save('review.json', JSON.stringify({status: 'unreviewed', goldExamples: 0,
      requirements: ['independent outcome verification', 'tool/schema and evidence review', 'task-level deduplication', 'held-out split and leakage checks'],
      note: 'Completed runs and automatic success labels are candidates, not certified benchmark answers.'}, null, 2));
    let appVersion = 'unknown';
    if (options.appRoot) {
      const pkg = JSON.parse(await readFile(join(options.appRoot, 'package.json'), 'utf8'));
      appVersion = String(pkg.version);
      const {TOOLS} = await import('../tools/registry.js');
      const {z} = await import('zod');
      const toolSchemas = TOOLS.map(tool => ({name: tool.name, description: tool.description,
        readOnly: tool.readOnly === true, inputSchema: z.toJSONSchema(z.object(tool.schema), {io: 'input'})}));
      await save('feature-context.json', safe({appVersion, package: pkg.name, toolSchemas,
        note: 'Current built-in tool catalogue. Historical/provider-selected and MCP schemas remain in recorded model requests.'}));
    }
    const manifest = {schemaVersion: 2, snapshotId, generatedAt: new Date().toISOString(), appVersion,
      providers: [...providers].sort(), runs, activeRuns, recordedRows: events, trainingExamples: training.kept,
      capturePolicy: {runRecordingEnabled: process.env.ECHO_LOG !== '0', fullPayloadRecordingEnabled: process.env.ECHO_FULL_LOG !== '0', privateCaptureExcluded: true},
      goldExamples: 0, droppedTraining: training.dropped, warnings, files,
      completeness: warnings.length ? 'recorded-history-with-gaps' : 'available-recorded-history',
      note: 'Includes available recordings up to the snapshot boundary. Private/disabled, deleted, expired or never-recorded history cannot be recovered. Active tasks are partial. Secrets are redacted; blob filenames retain original reference IDs. Hidden model reasoning and unrecorded audio are not included.'};
    check(); await writeFile(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2), {mode: 0o600});
    await rename(stage, destination);
    return {path: destination, ...manifest};
  } catch (error) { await rm(stage, {recursive: true, force: true}); throw error; }
}

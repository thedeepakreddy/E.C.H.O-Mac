# Dataset recording update — 2 October 2026

“Save dataset” / `export_training_data` and `npm run dataset -- --export`
now call the same in-process exporter. Each export creates a new portable
snapshot in `~/.jarvis/datasets/<snapshot-id>/`; earlier snapshots remain.
The exporter flushes pending trajectory writes before inventorying files.

## Contents and provenance

- `raw/runs/`: available recorded requests, messages, tools and full results,
  errors, task/checkpoint metadata, model changes and outcomes across providers.
  Payload blobs remain addressable by their original reference IDs.
- `raw/conversations/`: persisted conversations, including turns without tools.
- `raw/trajectories/`: every available recorded step and outcome label, including
  failed, rejected and student examples; available screenshots are copied.
- `feature-context.json`: application version and current built-in tool schemas.
  Historical selected/MCP schemas remain in model-request recordings.
- `training.jsonl`: existing automatic-success imitation candidates. Added
  provider, declared model, task/turn, actor, call, step and split-group metadata.
  Declared model is the trajectory's starting model; recorded model requests
  are authoritative for actual fallback/model identity.
- `manifest.json`: counts, providers, unfinished runs, recording-policy flags,
  missing/torn evidence warnings and exported-file SHA-256 checksums.
- `gold.jsonl` and `review.json`: zero automatically certified gold examples,
  with requirements for independent outcome/evidence verification, schema
  checks, task deduplication and split/leakage review.

No provider whitelist filters the raw export. Current providers and a future
provider fixture are covered. Future text providers must use the shared
RecordingBrain/recordLLM and gated execution path, as current providers do.
Future built-in tools added to the registry automatically enter the current
schema snapshot. Export survives semantic pruning and local tool budgets for
save-dataset requests.

## Durable history, Live voice and privacy

Gemini Live previously used an ephemeral recorder. Its user/assistant
transcripts, tool declarations, gated full call/results, Live tool request and
response packets, provider/model metadata and completion now have durable
recordings. Private/suppressed or disabled recording remains excluded.

With learning enabled, diagnostic retention compresses old runs into
`~/.jarvis/dataset-history/runs/` before deleting the live copy. Export merges
these archives with current recordings. Failed archiving leaves the original
run intact. The forget path removes matching archived runs and invalidates
owned snapshots containing forgotten evidence. External copies/model weights
remain outside that deletion operation.

Exports redact text credentials and report failed/missing records. Screenshot
pixels can still contain private material. Hidden provider reasoning and raw
voice audio that was not durably recorded are not recoverable. History already
deleted before this update cannot be reconstructed. Active tasks are included
only through the snapshot inventory boundary; the save tool's own later
result appears in the next export. No upload or training job is started.

## Validation and activation

TypeScript, the production build and 11 focused suites passed: dataset export,
trajectory learning, replay, recovery, local model, provider wiring, resource
caps, tool router, Gemini Live, task progress and intelligence wiring. The
export test exercises all five current provider IDs plus a future provider,
a real mocked-transport Gemini Live gated turn, 15,000-character structured
tool results, messages without tools, pending-write flush, torn/missing data,
compressed history, archive-failure retention, hashes, privacy exclusion,
owned-copy deletion and preservation of older snapshots.

Additional regression checks passed: memory OS 125/125, shared context
32/32 and release/retention fixes 35/35.

Echo was closed by the control panel during this session. The updated build
is ready and will take effect on its next launch. No production dataset was
exported by this implementation task; snapshots were verified in isolated
temporary folders to avoid copying the user's full history unnecessarily.

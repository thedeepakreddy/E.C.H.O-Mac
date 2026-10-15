# Reliability verification and acceptance

Local October 15 repairs; not a release or a zero-bug guarantee. Work stays local
until review. The five-section checklist is in
`tasks/audit-reliability-2026-10-14/todo.md`; the earlier voice-coding plan is unchanged.

## Verification groups

| Group | Command | What it proves / does not prove |
| --- | --- | --- |
| Offline | `npm run test:offline` | Typecheck plus isolated fixtures. Remote network blocked; no real providers/audio/desktop input. |
| UI | `npm run test:ui -- --list` | Lists ten disposable renderer/browser suites without running them. |
| Selected UI | `npm run test:ui -- office` | Existing glass controls, selection, task/update/retry routing against fixture bridges. No real Mac input. |
| Live provider | `npm run test:live -- --list` | Lists paid/account-connected checks; running them needs separate authority and working credentials. |
| Device | `npm run test:device -- --list` | Lists native audio, screen, model and desktop checks; running them needs separate human approval/permissions. |
| CI-style local gate | `npm run ci:offline` | Full offline suite (including typecheck), then build. Does not push, deploy, install models or run device tests. |

Substring filters skip automatic typecheck; full offline runs include it. Unknown
flags, empty selections and duplicate JSON keys fail rather than claiming a
successful empty run. The manifest retains overnight queue/budget research as
`researchtest` and public-source/image research as `researchsourcestest`.

`test:calculator-ui` is an HTML calculator in an isolated project preview. It is
**not** proof that Echo controlled macOS Calculator through LCU. Browser fixtures
also do not prove physical iPhone touch behavior, WebKit behavior where that
executable is unavailable, audible voice quality or native multi-display safety.

No CI job or branch protection has been enabled remotely. These checked-in
commands can be used by CI after repository review; no production secrets belong
in an offline job. Existing dependencies are reused; no paid design service is used.

## Storage and retention policy

Voice diagnostics now write under mutable user data (`~/.jarvis/runs/voice` by
default), not the installed app bundle. The log reader also retains read-only
discovery of old checkout logs; no migration deletes or overwrites those files.

| Limit | Default |
| --- | --- |
| One voice diagnostic file | 8 MiB |
| One replay's event file / ordinary events | 4 MiB / 20,000 events |
| One replay's blobs / one blob | 64 MiB / 8 MiB |
| Shared diagnostic directory | 512 MiB |
| Per-active-run terminal reserve | 64 KiB, respected by voice and other runs |
| Available disk reserve | 1 GiB |

Writers stop with an explicit warning rather than silently truncating lines or
claiming missing payloads are replayable. Retained terminal events label incomplete
recordings. Physical disk/permission failure can still prevent those final writes.
An unstarted task whose admission/checkpoint fails is blocked, its working memory
settled, heartbeat/reservation released, and startup checkpoint exhausted—not left
appearing busy or scheduled for silent replay.

Initial diagnostic inventory is bounded to 32,768 entries, 32 levels and 500 ms.
Writers share in-process byte/reservation accounting; bounded external rechecks
occur every five minutes. This is not a cross-process filesystem quota; free disk
space is checked at every write. Read-only admission of the existing local store
was checked without modifying its history (about 252 MB, inventory under 500 ms).

`npm run storage:check -- --path models` checks model-directory usage and available
space without creating/downloading anything. Piper setup validates identifiers,
limits installed/requested voices to four, and preflights its 2 GiB installation
budget and 1 GiB disk reserve before process launch. Download sizing is an estimate,
not a continuous transfer quota; upstream sizes can differ. Cached file presence,
nonzero size and configuration JSON checks do not prove model integrity. Manual
Whisper downloads remain unmanaged; run the read-only check before downloading.

There is **no automatic deletion or archival**. If a budget is reached, quit Echo
and manually archive only the diagnostics/models you choose before retrying. Task
state, recovery evidence, memories and unrelated user files are not deletion
targets. Symlinks and unsafe run paths are rejected, including broken links.

## Current implementation boundaries

- Popup, workflow and table inputs use fresh native indices and independent
  action gates. Ambiguous/stale targets stop honestly; partial evidence remains.
- Repeated rows and returned inputs do not prove a whole table/task completed.
- Model availability notes follow actual provider/account/environment/endpoint.
  Automatic ChatGPT fallback uses its cached offered catalogue, with bounded
  attempts; explicit selections do not silently switch to invented alternatives.
- Only explicit user Stop is labeled stopped. Timeout, lost lease and failed
  checkpoint/storage operations keep distinct failure meaning and fence effects.
- Echo coordinates; six real specialists remain background-only. Final-report
  Retry restarts only the report compiler, not completed specialists.
- Voice completion requires a playback acknowledgment. Stop, stale connection
  callbacks and failed audio setup cannot restart or retain the old voice owner.
- Direct brightness-key simulation and Osiris search/shortcut injection remain
  unsupported. The map API is checked before geocoding or movement; unavailable
  capability is reported, not disguised as a successful action.

## Human-approved acceptance still required

1. Open the updated Mac build, inspect configured brain and doctor results, and
   approve only macOS's real permission prompts yourself.
2. Ask “Open Calculator and calculate 2 plus 3.” Verify the actual requested
   expression and display result, then repeat with a new expression. Keep the
   native event log and original observation; a spoken “5” alone is insufficient.
3. Test free cursor motion, click/type/scroll, Stop during an input and immediately
   after it. Verify no delayed action, no overlapping human controls, and truthful
   saved/unknown-effect state. Do not automatically retry an uncertain send/pay.
4. Test main/external monitors with different scales and positions. Verify fresh
   targeting and cursor position before accepting multi-display support.
5. On a physical iPhone test cancellation, tap/double-tap, disconnect/reconnect,
   update order, per-agent controls and report speech. Real audio/report timing
   must be observed, not inferred from fixture screenshots.
6. After user review and a separately authorized push/deploy, compare both Git
   revisions with the deployed Render revision. Check paired identity, current
   brain, storage mode, secrets configuration, reconnect and an actual Phone–Mac
   task. Do not print secret values in the acceptance record.

These gates remain open until actually observed. No push or Render deployment
was performed as part of the local reliability pass.

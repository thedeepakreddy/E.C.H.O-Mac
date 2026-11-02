# Echo five-section reliability repair

Approved scope: complete audit sections in order, beginning with section 2.
The original voice-coding plan is preserved. Changes stay local until user review;
no push, Render deployment, paid design conversion, or native permission approval
is implicit. Live acceptance is separate from offline fixture verification.

## Architecture decisions

- Echo remains coordinator/desktop owner. Six visible specialists do real
  background work; the internal report compiler is not a visible specialist.
- Events and controls carry task, actor, attempt and call identity. Updates are
  acknowledged only when consumed at a safe provider boundary; stale events lose
  authority after revise/retry/stop.
- Retry carries a valid bounded evidence manifest and owner-scoped pagination,
  not truncated JSON. Unknown external effects remain blocked.
- Retry final report reuses completed specialist results, restarting only the
  compiler. Voice announces truthful terminal state through Echo's existing
  speech pipeline, idle-gated and durably deduplicated with privacy preserved.
- Restore an attempt with its saved provider; new queued work uses Echo's current
  selected provider. Runtime access/Send/Pay/destructive safeguards remain intact.
- Preserve existing layered-glass controls and layout. No visual redesign or
  reference upload is needed for this wiring repair.

## Ordered slices

1. Section 2: wrapper update capability + actual tool-start/end identity;
   retry manifest/source retrieval; compiler-only retry + voice handoff;
   sixth genuine specialist; live-versus-recovery provider factory.
2. Section 3: popup/workflow/table LCU migration; unavailable-model handling;
   cleanup error preservation; provider/capability doctor. Startup Stop, image
   batch delivery and bundle launch fixes already exist but need regressions.
3. Section 4: Phone command-ID update order, failure/cancellation reasons,
   callable storage predicates, relay admission reservations, cancelled gestures.
4. Section 5: manifest duplicate detection and explicit offline/UI/live/device
   groups; disk/log budgets without deleting user data; unavailable capabilities
   honestly labeled; live Mac/Phone and deployed-revision acceptance checklist.

## Gates

Each slice has red/green regressions, relevant type/build checks, independent
review, and a section checkpoint before moving on. Final full Mac/Phone suites,
isolated UI verification and documented live limitations are required. Missing
native access, physical iPhone, account quota or deploy authority are recorded
as blockers, never replaced with simulated success. No zero-error guarantee.

## Task list

Track acceptance and results in todo.md in this directory.

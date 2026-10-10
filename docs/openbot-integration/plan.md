# OpenBot agents inside Echo

## Authorized scope
Keep current Phone and Mac UI styles and existing pages intact. Add a Bots page within Echo, reuse pinned MIT OpenBot agent code, and run tasks through Echo's own authenticated model/tool systems. No OpenBot replacement UI, no browser-computer infrastructure installation, and no new paid service is required for this integration. Separate browser computers remain a future backend capability; do not advertise them as present.

## Dependencies and vertical slices
1. Vendor OpenBot history pairing, provenance prompt and agent stream/tool-call framing from commit a4dce8c47c7253ecd9bd6f4e2626f4205817a104, preserving MIT attribution. Adapt transport/provider interfaces only; tests prove reordered and unanswered tools, split streamed calls and failures. Shared source is mirrored in both independently deployable repositories.
2. Phone: durable owner-scoped bot profiles and jobs; original agent loop adapted to Gemini through existing quota-counted cloud tools. Structured progress/events, task results, explicit stop/retry and idempotent requests. Durable atomic state locking prevents duplicate runs across replicas. Restarted runs become interrupted and require an explicit new run, never automatic replay of side effects. Existing memory/Today permissions and external action buttons remain enforced.
3. Mac: expose the existing persistent fleet as standing bots, adapt OpenBot provenance/history into fleet-agent instructions and use its stream/call assembler in Gemini bot turns, dispatch through existing budgeted swarm/gates. Exact bot revision/request ID, original goal and profile establish dispatch idempotency; only owned bot missions may be stopped. Phone can list and dispatch these using current signed-in Mac status/actions. Native task execution remains on Mac, cloud Phone tasks remain independent.
4. Add matching-style Bots pages, reachable within current agent/task areas. Run, follow-up, custom role creation/edit, progress/results, and stop controls; no existing page redesign, theme change or bottom navigation replacement. Lazy polling, safe text, preserved drafts, scoped accounts, offline explanations, responsive scrolling and existing action cards.
5. Verify unit/integration and real browser/Electron paths; relevant regressions, typecheck and build. Publish both repositories and exact Phone deployment, load updated Mac only when idle. GitHub contains no chat/session links or credentials.

## Acceptance
- An authenticated standalone Phone user can run a bot task and see tool-backed results without Mac; another account cannot read or stop it.
- A paired signed-in Phone can run the same Mac bot available in Mac Control Panel and see its actual mission. Repeated transport requests do not duplicate a run or modify its goal.
- Stop, model failure, quota, storage failure and process restart terminate visibly; no success is fabricated and no stopped run starts additional tool effects.
- Sources and upstream attribution are recorded; existing screens/styles remain intact, new pages use existing classes.

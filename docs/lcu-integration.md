# Echo foreground computer control

This is a local implementation awaiting a fresh native-action acceptance test,
not a claim that every application or control has been verified. The October 14
logs include real Calculator digit/Add input and a Finder close read-back, but
no completed Calculator expression/result acceptance. Do not publish before review.

## Ownership

- Echo uses its existing selected provider/model. LCU supplies computer control,
  not reasoning or another brain.
- Named office specialists retain the background-read boundary in
  `agent-office.md`. They cannot obtain a desktop lease, invoke LCU, inject keys,
  or claim human input authority. Unsupported foreground steps are reported to
  Echo for review, never executed silently by a specialist.
- An actual recorded foreground turn owns one serialized LCU session. Its real
  conversation/task and run IDs reach the original runtime. A supervised worker
  borrows its supervisor's desktop lease and cannot release that supervisor's
  ownership between steps.
- Stop aborts pending calls and the pointer helper. Cleanup keeps the desktop
  fenced until the runtime acknowledges `turn_ended`; uncertain writes are not
  automatically replayed. The session has its own cancellation signal, so an
  automatic timeout/no-progress stop does not depend on its caller cancelling.
  A later turn retries owed cleanup before acquiring ownership. Shutdown rejects
  new owners immediately and closes the transport even if cleanup reports failure.

## Input paths

The October 15 local reliability pass also migrates popup dismissal, saved
workflow execution and table scrolling to fresh native LCU observations. A
macro's approval is not approval for its individual sensitive actions. Each
input crosses the same foreground ownership and risk gate; ambiguous controls,
changed windows and cancellation stop the recipe with its partial evidence.
Repeated table rows are not proof that the entire table was collected.

Voice transport ownership is bounded to one turn and its playback drain. Stop
or an interrupted connection cannot trigger a fallback restart, and closed
sessions cannot execute late tool requests. These paths have offline fake
transport coverage; this does not substitute for the native acceptance below.

Computer control is automatic for ordinary requests: users do not name LCU,
enable a mode or choose a driver. Permitted file/API tools still do non-input
work directly; every autonomous physical app input goes through the approved
foreground session. The shared persona and tool descriptions teach this route
instead of recommending retired AX/OCR click endpoints.

| Operation | Route |
| --- | --- |
| Observe approved app | `inspect_app`, original AX state and optional app image |
| Click, type, key chord, scroll, drag, editable value | Typed LCU app recipes |
| Free cursor movement | Echo-native pointer-only helper inside the same approved session |
| Authenticated Phone trackpad/keys, actual gesture/eye frames | Separate human driver with an exclusive desktop lease |
| Legacy direct AXPress / deep hooking | Refused; no native helper is launched |
| Known shell / raw computer-use input bypass | Refused by the shared risk gate |

The shell policy is defense in depth, **not an OS sandbox** or proof that all
arbitrary account-privileged code can be classified. Office specialists have no
shell/process grants. Ordinary file, network and supported application APIs
remain separate from physical mouse/keyboard input.

Human controls pause while Echo owns the desktop or cleanup is pending. The
Phone can request Stop, then use its human controls once ownership is released.
Camera frames do not become agent authority or queue stale input for later.
Human commands serialize with each other; a busy human trackpad is not mistaken
for an Echo-owned desktop. Phone reuses its existing glass toast to show the
actual refusal reason, with repeat-message suppression during a drag.

## Fresh observations and coordinates

Every app observation carries an `observationId`. Typed mutation tools require
the latest ID. Before input, Echo reads the full current AX state again. If the
window/controls changed, it returns the new observation without input; the
model must choose a fresh target. App instructions, original result content,
all images and the original error state are retained and forwarded, not
compacted into a short generic success message. A read-back does not verify
the user's larger goal.

The bounded exception is unique native window chrome: an unrelated status-bar
value may change while the same exact window, index, control and ancestor path
remain unchanged. Close/minimize/full-screen are re-grounded from the fresh
read. Changed windows, shifted/duplicate controls, disabled controls and modal
sheets still refuse the old target. Coordinate input has no such exception.

`verify_app_state` performs an exact host-side native text comparison using the
latest observation, or confirms an app window for opening-only tasks.
For a single window-close task, `window_closed` requires the exact original
title, a host-confirmed single left click on its native close button, and
Finder's exact native Desktop fallback with no standard window or modal remaining
in that observation. A changed front title alone is insufficient: macOS's
documented LCU API does not provide an all-window inventory. Closure verification
for other apps or a different remaining Finder window currently fails closed.
Visibility, coordinates,
a successful click alone, or a title mentioned in another request clause cannot
prove closure. This bounded check does not prove arbitrary compound workflows.
Verification never reuses a cached success: every call reads the native state.
The main foreground wrapper buffers provider speech for explicit app tasks: without a
current postcondition it reports a saved blocker, not success. This applies in
private and metadata-only modes too, without persisting private prompts.
Calculator's bounded numeric binary-expression check requires the requested
expression and the current result under `StandardInputView`; a digit button,
history text or another calculation is not sufficient. Compound expressions
and unsupported Calculator formats fail closed rather than verifying a prefix.
This is not a general semantic verifier for arbitrary app workflows: other
postconditions still need a correctly chosen goal-specific native field.
Blocking clarifications use `ask_app_question` (app, mode, target or input).
The host writes the spoken question and pauses only after its call is committed;
further tools, including Claude SDK built-ins, are fenced. Answers wait until
the original provider turn drains and interruption is acknowledged. Failed or
timed-out acknowledgment blocks queued instructions; it cannot silently resume.
Stop discards pending instructions but cannot clear an unconfirmed provider
fence; provider replacement/restart is required after that failure.
Provider prose phrased as a question cannot bypass verification. Answering keeps
the same logical task; waiting checkpoints never
restart automatically and Stop cancels them. Accepted GUI follow-ups establish
their verification obligation before reaching the provider, even when the turn
began as ordinary conversation. Calculator completion speech reports the actual
verified display value, not a conflicting model-written summary.

Only successful host-confirmed input counts can carry across a pause. They are
isolated by task, actor, conversation and canonical app, kept in memory for the
last 20 task owners, and cleared at controller shutdown. Every resumed task
still needs fresh native verification; refusal or an unknown input outcome earns
no credit. There is no promise of exact native-input recovery across a restart.

Coordinate actions also require fresh screenshot evidence. A picture change
with identical AX text produces a new observation without input. This comparison
is deliberately conservative for animated canvases: prefer native element
indices when available. Images carry call, observation and block provenance;
earlier images in a multi-step call are not labeled as the final state. Responses
and Gemini history trimming never removes a new image batch before its first
model delivery; older observations become eligible for normal history limits.
The existing text-only local-model route uses AX text rather than images; it
cannot visually interpret a canvas screenshot.

LCU native clicks/scrolls/drags use **app-window coordinates**, not the global
desktop points used by the old screenshot tools. Legacy global-coordinate
actions and saved AX paths fail with migration instructions instead of being
reinterpreted or replayed. Free cursor movement is explicitly global display
points; the native helper requires the approved app still frontmost, validates
active display bounds, refuses a held mouse button, and verifies cursor position.
It implements no click, scroll, drag or keyboard command.

## Permissions and installation

Routine recognized native controls (Calculator digits/operators/Return, window
chrome, supported native navigation and literal draft edits) no longer require
an extra Echo confirmation. The shared gate obtains this assessment only from
the active owner's original app identity, native AX target/focus and current
observation ID. It adds no model-supplied permission/risk override and performs
no remote risk-classifier call for these operations. Fresh state is checked
again before input, including app-ID changes even when AX text is identical.
Payment and final email/message Send, including send key
chords, retain confirmation. Unknown targets, destructive changes and ambiguous
dialogs remain conservative; permission/security dialogs are user-only.

`open_app` launches through the platform API **inside** the foreground desktop
lease before native inspection, so a cold app can create its initial window.
Bundle IDs use `open -b`; names/paths use `open -a`. Runtime app access is still
requested before native observation/input. Launch alone is not computation
credit, and refusal or failed inspection is not reported as verified completion.

Echo uses the verified LCU **v0.11.2** shared client from its dedicated local
installation at `~/.local/share/echo-lcu/current`. Startup checks that client's
reviewed SHA-256 and obtains the original instructions and public descriptors
before any provider is constructed. The signed installed ChatGPT/Codex app
provides the original runtime; it is not copied into this repository or
redistributed. No Codex harness registration, Chrome extension or audio feature
is enabled by this installation.

Original native app requests are shown in an Echo-owned native dialog with only
the choices offered by the runtime. The human's actual selection is forwarded;
the host stores no additional permission cache. Cancellation is the default.
Unknown forms, browser-origin/audio requests, and requests without a usable
Echo window cancel. The Echo host and approval UI, Codex/ChatGPT and Terminal
are protected; the actual Echo bundle/name are added at startup.

If runtime connection fails, autonomous desktop input fails closed. Voice/chat
and permitted background API/read work can continue. No legacy input fallback
is selected after refusal, timeout or connection failure.

## Remaining acceptance / compatibility limits

- A fresh end-to-end Calculator expression/result and pointer acceptance test
  remains necessary. Earlier recorded digit clicks are not complete acceptance;
  fixture tests are not substitutes for this.
- The installed app/CUA pair can change independently of Echo; the installer
  currently reports a pair not in LCU's published verified matrix.
- The account's 104-byte helper socket path previously worked despite LCU's
  documented 103-byte warning. Cold-start resilience remains unverified.
- Legacy recorded global coordinates/AX paths must be re-observed and migrated.
- Brightness-key emulation is unsupported until a documented LCU capability is
  verified. It does not use a hidden key-code fallback.
- Osiris retains its actual map/layer APIs, but no longer injects synthetic keys
  into the Echo-hosted web view when those APIs are absent.
- Manual lock routes the documented Control-Command-Q through an approved
  foreground LCU turn; native acceptance remains pending. Automatic away-lock
  is explicitly disabled with an unavailability notice. No lock timer, hidden
  AppleScript or display-sleep substitute runs when presence changes.
- This does not add automatic spoken office completion or a foreground handoff
  for unsupported office steps. The specialist boundary remains read/report-only.

## Sources

- [LCU shared-client contract](https://github.com/amontlabs/lcu/blob/v0.11.2/docs/ADAPTERS.md#shared-client-contract)
- [LCU v0.11.2 release](https://github.com/amontlabs/lcu/releases/tag/v0.11.2)
- Original installed `@oai/cua` App declarations and core API documentation
  (read locally; not redistributed).
- [Apple Core Graphics event API](https://developer.apple.com/documentation/coregraphics/cgevent)
- [Apple Mac keyboard shortcuts](https://support.apple.com/en-gb/102650)

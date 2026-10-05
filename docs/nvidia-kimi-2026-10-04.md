# NVIDIA Kimi connection

Echo now offers `nvidia` as a separate provider. Its hosted model is configured
in `nvidia.model` (default `moonshotai/kimi-k3`), and its private key is stored
as `NVIDIA_API_KEY` in Echo's existing owner-only keystore. OpenRouter settings
and credentials remain independent. The Models page and `switch to Kimi` use
the same lifecycle as other providers.

## Architecture

The shared execution loop is reused through a Chat Completions transport.
Native requests, usage, tool calls and normalized responses are recorded under
the NVIDIA provider identity. Assistant reasoning is preserved for subsequent
tool rounds and excluded from spoken text. Screenshots retain their image data.
The existing grants, validation, safety gate, MCP routing, coding verification,
supervised worker/inspector flow, recovery and cleanup remain on the shared path.

The adapter assembles fragmented SSE calls before execution. Malformed or
incomplete streams fail; token-limited calls are discarded. NVIDIA requests
abort after 45 seconds without response headers, after 30 seconds of stream
silence, or after 110 seconds total. The default reasoning effort is `low`;
`high` and `max` can be selected in the provider configuration.

NVIDIA credential shapes are scrubbed from saved text and replay payloads.
No credential is stored in this document or source files.

## Live checks on October 4, 2026

The NVIDIA model catalog returned HTTP 200 and listed Kimi K3 and K2.6.
Generic K3 readiness tests timed out at 45, 90 and 60 seconds, including a test
through the new transport. K2.6 returned HTTP 404 with an account-level function
availability error. These tests sent only public fixture prompts and a harmless
readiness-tool definition, with no project files or private memory.

After the user generated a replacement key, it was read from NVIDIA's visible
example, transferred encrypted between tool sessions, and saved with mode 0600.
The replacement key also timed out after 60 seconds on the readiness tool test
and after 45 seconds on a simple text request using NVIDIA's example parameters,
before response headers arrived. The API returned no authentication verdict;
key validity and the underlying cause of this timeout cannot be established
from the public model catalog.

Consequently, live generation and live tool execution are **not verified** for
this account. The saved connection is available for selection, but the current
default brain is preserved. A catalog entry alone is not proof of usable hosted
inference. NVIDIA's free evaluation capacity may change independently of Echo.

## Validation

The offline NVIDIA contracts cover request conversion, screenshot retention,
reasoning history, fragmented Unicode SSE, multiple tool calls, usage,
truncation, malformed streams, JSON responses, cancellation, factory wiring,
brain switching, credential availability and redaction. The coding-provider
suite additionally drives guarded project writes, stale-revision rejection,
nested tool dispatch and refusal to claim unverified completion through the
NVIDIA adapter. Build and TypeScript checks are required before release.

Final validation: **112/112 offline suites passed** in 135 seconds. TypeScript,
the production build, and `git diff --check` also passed. Device and live-provider
suites were not included in the offline result.

The Settings brain selector includes both OpenRouter and NVIDIA. The design
hook's cited contrast findings assumed white backgrounds. The CSS defines a
dark theme: the cited dialog body text has 8.76:1 contrast on its actual
`#071115` surface, and the cited heading has 14.27:1. The overview heading
remains 8.83:1 even over a white image beneath the declared 80% dark overlay.
No theme change was needed for these findings.

Provider contract reference: [NVIDIA Kimi K3 API documentation](https://docs.api.nvidia.com/nim/reference/moonshotai-kimi-k3).

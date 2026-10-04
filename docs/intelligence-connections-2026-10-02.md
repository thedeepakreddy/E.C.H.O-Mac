# Echo intelligence connection audit — 2 October 2026

## Live connections

| Capability | Source | Tool | Live result |
|---|---|---|---|
| Satellite positions and passes | CelesTrak orbital elements + local SGP4 | `open_intel`, source `satellites` | ISS identified by NORAD 25544; position and pass calculation returned, about 1.0 s |
| Topic/world news | GDELT | `open_intel`, source `news` | Eight stories returned, about 11.5 s |
| Nearby places | Overpass / OpenStreetMap | `open_intel`, source `nearby` | Ten mapped pharmacies returned for the public test coordinates, about 0.5 s |
| IP/ASN ownership | RIPEstat | `open_intel`, source `network` | AS15169 ownership and announced prefixes returned, about 0.2 s |
| Known exploited CVEs | CISA KEV | `open_intel`, source `exploited` | Catalogue and product-filtered results returned, about 0.7 s |
| Global intelligence grid | `https://osirisai.live` | `osiris_intel` | All 11 configured feed routes returned JSON/data |
| External application tools | Hosted Composio MCP | Connected MCP tool names | Authenticated connection exposed 73 tool schemas |

The five open-intelligence sources and Osiris are built-in Echo capabilities;
they do not need separate MCP servers. Composio uses the HTTP transport and
an `x-api-key` environment placeholder in `mcp.json`. Its authentication and
tool attachment work. This confirms server connectivity, not the authentication
or quota of every individual application tool.

Osiris live routes checked: grid status, earthquakes, flights, fires, news,
satellites, conflicts, space weather, severe weather, cyber threats and cameras.
The data included 38 earthquakes, 18,775 satellites, 110 news items, 10 cyber
threat items and 39,222 camera records at the check time. Counts are snapshots,
not guarantees of freshness or availability of every camera stream. Osiris
geosearch resolved both Tokyo and Budapest with valid coordinates. The heavy
globe was not opened for this audit.

## Wiring repairs

- Ollama omitted `open_intel` from its curated tool list. Added it.
- Its small tool budget could discard the relevant intelligence tool after
  filling the request with internal tools. Relevant intelligence is prioritized
  within that same budget; no RAM/context limits were raised.
- The cloud router keeps the two intelligence readers reachable, with additional
  intent matching for map display, layers, focus and camera opening. Matching
  respects each provider's allowed tool pool. Representative English, Telugu
  and Hindi questions are covered.
- Compact tool descriptions now retain every source/feed name. Claude receives
  the intelligence reader in its loaded tool set rather than relying on search
  for an omitted local capability.
- `open_intel` is correctly classified as a read. Unknown Osiris feeds, transport
  errors and HTTP-200 upstream errors return failure rather than successful
  evidence or a misleading zero-event answer.
- Structured intelligence excerpts survive model compaction. Full text and data
  can be retrieved together through `read_tool_result`; bounded archive pages
  preserve exact characters and pagination offsets.
- Gemini Live also uses bounded tool results. Shared guidance points supported
  intelligence questions to these sources and labels unknown location/failed
  feeds honestly.
- Satellite predictions describe a geometric pass above 10 degrees, rather than
  claiming visual visibility. No CISA KEV match is not treated as proof of safety.

## Logs and validation

The latest real OpenAI runs failed before any tool call with a ChatGPT
Subscription Sharing usage-limit rejection. For example,
`Echo--04d52705-9a19-4e1b-a0da-230351319da1` ended with `provider_error` and zero
tool calls. Earlier logs include Gemini quota/high-demand errors and a Claude
session-limit error. These are provider availability limits, separate from
healthy intelligence connections. The logs also showed three checkpoint retries of the same exhausted OpenAI
quota and a Gemini TTS quota failure before voice fallback. Recovery now stops
on explicit exhausted account/quota errors rather than retrying them; ordinary
transient interruption recovery remains enabled. A regression test confirms
one provider call, one surfaced error and a preserved exhausted checkpoint.
Billing, keys and selected models were not
changed by this audit.

`intelwiringtest` drives all five sources through the real OpenAI/OpenRouter
Responses loops and Gemini loop (fixture model responses), Ollama's tool handler,
Claude's actual in-memory MCP server/client, and Gemini Live's tool-response path.
It checks declarations, pruning, local context fitting, error handling and full
structured evidence retrieval. These are wiring tests; they do not prove that
live models will choose the correct tool for every possible wording, especially
while provider usage limits block requests.

Eleven focused offline suites passed: intelligence wiring, intelligence feeds,
Osiris, tool router, local model, task progress, realtime voice, script voice,
shared context, resource caps and risk. Live public-source checks passed 59/59;
MCP transport checks passed 17/17, and real external-tool attachment checks passed
9/9. TypeScript and the production build passed.

The additional durable-recovery suite passed 43/43 checks; intelligence wiring
and task-progress suites were repeated after that repair, and the production
build and typecheck passed again.

The updated build is active. Startup confirmed the selected OpenAI provider,
73 Composio tools, AirPods Pro microphone, voice readiness and the resident
Whisper server. Graceful quit stalled again, so only verified idle Echo
processes and direct workers were terminated before restarting. This separate
shutdown issue remains. The native echo-cancelled microphone still falls back
to plain capture because its audio is silent; speaker barge-in remains limited.

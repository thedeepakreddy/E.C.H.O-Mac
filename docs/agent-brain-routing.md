# Agents follow Echo's active brain

Local change, 2026-10-13. Not pushed or deployed.

## Rule

Every Mac specialist, custom agent and report-combining Lead uses the provider and model selected in Echo when that agent starts. Roster tiers no longer redirect fast agents to Ollama or deep agents to Claude. Tier values remain readable in saved rosters for compatibility, but the editor no longer advertises a separate model or free local execution.

The shared fleet factory reads the live configuration and clones it at construction. Switching Echo while work is running does not silently restart that agent or mutate its model configuration. Newly launched work—including queued dependencies, revision attempts and follow-ups—uses the then-active brain. Explicit checkpoint recovery retains its recorded provider; playback remains intentionally tied to its recording rather than making live requests.

Agents retain their roles, read-only/team grants, iteration budgets, identities and result-submission lifecycle. Missing credentials fail the launch with a reconnect/switch message instead of falling back to Claude. The foreground startup factory's existing fallback remains unchanged: agents follow the provider actually activated by Echo, not an unavailable preference. Failed launches remain honest failed task states. Scheduled launches catch construction errors instead of crashing a timer callback.

## Entry points

Mac office and Phone-to-Mac controls use createMacBots → makeFleetBrain. Chat delegation, subagent and mission tools now use activeConfig rather than reloading saved defaults; their factory continues to read that live object for subsequent launches. Scheduled clones resolve the live configuration on each wake. No credentials are copied between devices or exposed to the UI.

Standalone Phone mode already runs its agents through the same createCloud.chat and Gemini client as normal Phone Echo chat. Tests verify the same configured model for all six specialists under two fixture model configurations, including ignoring a role-supplied model override. Selecting Mac as the execution target still uses Mac's active brain; selecting Phone uses Phone Echo's independently configured brain. This does not add new Phone provider-selection options or make Phone mode depend on Mac being online.

## Verification

Reproduced the forced-tier routing and silent credential fallback before the changes. Fleet tests now cover 152 cases, including all specialist/custom profiles across Gemini, Claude, OpenAI, OpenRouter, NVIDIA and Ollama, model preservation, configuration snapshot isolation and later launches after a switch. Real factory tests cover missing credentials and live-config routing through chat tools and scheduled launches, without live provider requests. Existing Mac bot, tool-security and foreground switching tests and typecheck passed. Phone's complete 148-test suite passed. Physical-device/live-provider account checks are not claimed.

The complete configured Mac offline suite passed 119/119 after the final changes, and the agent-management UI regression passed. The Mac application build succeeded. It reports a pre-existing duplicate researchtest script key in package.json; this routing change does not remove or rename either unrelated research-test entry.

The inherited HTML contrast hook assumes white behind text. The fixed dark control shell paints its authored dark background; this change only corrects tier copy and does not alter that theme. Existing measured contrast/background-assumption exception is recorded in the office local-preview notes. This is not a whole-app accessibility certification.

# Echo Bots

Phone: Bots in the bottom page bar. Choose This phone for standalone work, or Your Mac for the paired Mac’s roster. Mac: Control Panel → Tasks & Agents → Bots. Start work in Bots; Agents manages the roster and inspects those same task IDs. Agent-card task links prefill Bots without dispatching anything. Existing styles and icons remain intact. Phone’s pages are Echo, Today, Chat, Bots and Browser. More and highlighted World Intelligence are on Echo; Saved is in More. Mac adds a matching Bots page within Tasks & Agents.

Choose a standing bot, give it the result you need and Start task. Progress and actual results stay in the page. Follow up carries the previous goal, outcome and blockers into a new bounded run. Stop prevents new tool actions; review actions that were already in progress. A failed or interrupted run is never presented as success.

Phone offers Research, Plan, Write, Review, Analyse and Echo Assistant, plus six personal roles. Research/write/plan roles have reading tools. Echo Assistant can use existing Today/memory tools and prepare existing calendar, browser, Shortcut or Mac action buttons. Those buttons require a tap and are not recorded as completed external work. Essential questions show Needs you and Answer & continue. Phone history requires the existing Upstash durable store to survive service restarts; the page identifies temporary storage when Upstash is absent.

Mac uses its existing fleet, native guarded tools, structured task results and model tiers. Manage bots opens the existing fleet editor. Signed-in paired phones can dispatch, inspect and stop these exact Mac bot runs. The Mac must stay awake with Echo running. Custom profiles retain their existing read-only tool grants. Changed profiles are rejected before queued execution; saved bot runs are refused in private mode.

You can also say “Ask Research to compare these options” on Mac, or ask Echo Phone to delegate a background task to Research, Plan, Write, Review, Analyse or Echo Assistant. Ordinary chat and voice keep their existing behavior.

## Runtime and limits
Echo supplies the model provider, authentication, execution grants, budgets and UI. Bot turns pair tool results with their requests, assemble streamed calls before execution and keep task context separate from trusted instructions. Required third-party licenses remain alongside the runtime source.

Phone research uses existing web tools; prepared Browser actions use Echo’s existing Browser. Mac tasks use native Echo tools. Separate browser computers or per-bot isolated containers are not provisioned.

Phone: one active run per account, four workers per relay process, eight model turns, four minutes, 30 recent runs. State mutations use token-owned atomic leases; interrupted Phone jobs never replay automatically. Mac: one live managed task at a time, 40 iterations and two recovery attempts per specialist, ten minutes for a single specialist or divided across the selected team steps, 12 recent runs in the page. Native checkpoint recovery retains Echo’s existing journal and execution checks.

## Verification
Phone: 132/132 regression tests, standalone real HTTP bot execution and account isolation; grant denial, suspension, missing responses, questions, saved progress, stop, duplicate requests, state leases and restart cases. Chromium and WebKit: real relay, safe output, task/result, drafts, follow-up, custom edit/remove, Stop acknowledgment, offline Mac switch recovery, 320/390/430 px layouts, navigation return paths, Saved/account access and highlighted World Intelligence.

Mac: typecheck and production build; bot lifecycle, durable native task results, exact identity/revision, private mode, grants, follow-up, GUI lane, stop, real signed-in Phone dispatch/status/duplicate/stop and Gemini stream adapter; mission 46/46, fleet 24/24, remote 130/130 on development and 150/150 on main and gate 24/24 regressions. Electron Bots page tests verify restricted bridge actions, safe text, draft preservation, fleet editor and responsive scrolling.

## Release verification
Phone main: 7be92a6; Render deployment dep-db53fcp42hec73fj5lag is live with app version a28c3697e562. Public health returned 200 with the Mac online, cloud brain ready and Upstash durable storage. HTML (after version injection), app scripts, Bots assets and service worker match the tested files. The unauthenticated bot API returned 401.

Mac main: 22498d7. The development branch has the same Bots implementation and documentation. The updated local build was started after the previous process had exited; its startup has no error indicators. Both Chromium/WebKit and the Mac Electron page checks passed.

## Shared single and team tasks
Choose one specialist for work with its existing tool permissions, or Team of specialists for reading, preparing reports and one combined answer. Select the team in Bots. Research and Analyse supply evidence before Plan/Write; Review receives the selected reports; Lead waits for every selected specialist to finish. Team tool grants are limited to reading plus actor-owned result submission, so workers cannot repeat external changes. Missing or failed results block downstream workers.

All panel start actions, explicit voice requests and authenticated Phone bot requests use one service and the existing native mission store. Same-ID retries cannot change their goal, participants, revision or parent. Another request while work is active is refused and points to that run; completed tasks can be explicitly rerun with a new ID. Old board/solo client requests receive a stable identity and old history remains visible. Repeated summary/artifact text is displayed once.

Shared-task release verification: Phone 605a058 and Mac main 85547d8 (development 6e60cdd). Render dep-db5409qjnfac7395k9r0 served app a04893829acb with healthy brain, durable storage and zero recent deployment errors. Native Mac loaded after idle confirmation without startup errors. Shared scheduler, grant/ordering, HTTP, Electron and both mobile browser checks passed.

## Answer formatting and pictures
Assistant messages in Phone chat (both Phone and Mac modes), Phone Bots, Mac Bots, expanded Agents reports and task output reports render Markdown with headings, emphasis, lists, tables, quotations and code blocks. Stored answers are formatted when opened, while copying keeps their original Markdown. Echo's shell and existing styles are preserved; typography rules apply only to answer bodies.

Public research and visually useful explanations can use the read-only image_search tool to select up to two relevant Wikimedia Commons illustrations. The tool supplies actual thumbnail URLs, description, author, file source and license; prompts require the full credit alongside selected pictures. It does not invent pictures for private notes, reminders or unavailable/unrelated search results. Only HTTPS Commons upload/thumbnail image paths load; unsafe schemes and arbitrary remote image hosts are refused. Broken images leave readable alt text and the rest of the answer. Image/source links open safely in the browser. Native voice stays concise; picture destinations and Markdown markers are omitted from speech.

Verification: 142 Phone regression checks (including real cloud chat and bot image tool turns with fixtures), shared public image source validation, Chromium/WebKit chat/Bots/history/Markdown/XSS/image-failure/320–430 px checks, native task and Phone bridge checks, Mac Electron Bots/Agents/task reports, typecheck and production build. A fixed public neural-network search also returned actual credited Commons diagrams.

Live research: search_research queries arXiv preprints and Crossref publisher metadata directly, with a recent-date filter, paper/author/abstract links, retrieval timestamps and separate source failure reporting. read_web_page gives Phone chat/Bots automatic public text and link access through Echo Browser's guarded network fetch; Mac Bots use their existing isolated read_browser_page and native tools under current grants. Prompts require current evidence, source dates, citations and honest access gaps. These tools read public material without sign-in cookies, paywall bypass or new paid infrastructure. Native Mac's browser can render JavaScript pages; Phone's reader returns server HTML/text.

Additional verification: real arXiv and Crossref calls both returned current papers; the Phone reader fetched a real arXiv abstract page. Shared research/index/date/XML/size/cancel tests and Phone public-page/source/tool-flow/redirect/private-address tests passed. Full Phone suite: 142/142.

Answer/research release verification: Phone main c464c36, Render dep-db599mg473hc73ab3kh0, app 3024be25aa2b. Public health and exact Markdown/vendor/chat/Bots/service-worker assets passed; unauthenticated Bots returned 401 and deployment error logs were empty. Phone AI and Upstash were ready. Mac main a7a3449 (development 7ba59d7) passed the production build, native bot checks, 150 main remote checks, 24 fleet checks and 24 prosody checks. The updated native build loaded while idle earlier in the release; the Mac was offline at the final evening check. The polling-only renderer update is read on reopening Control Panel. Chromium, WebKit and Electron verified stable report/image elements across unchanged polling. Full Phone suite: 142/142.

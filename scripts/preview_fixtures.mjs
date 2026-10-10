/**
 * The deterministic Mission data the control panel is previewed and recorded
 * against. It lives here so the preview harness and the media recorder show
 * the SAME panel: a second copy of this fixture is a second panel that can
 * drift from the one anybody actually looked at.
 *
 * Nothing here starts the Echo runtime — no microphone, network service,
 * memory store or model.
 */

/** Register every `control:*` channel the panel calls, backed by the fixture. */
export function installPreviewBridge(ipcMain, { onClose } = {}) {
  const now = Date.now();
  const result = (summary, label) => ({
    status: "completed",
    summary,
    artifacts: [{ kind: "file", label, value: `/workspace/${label}` }],
    verificationRefs: [`check:${label}:passed`],
    blockers: [],
    completedAt: new Date(now - 90_000).toISOString(),
  });
  const budget = { timeoutMs: 600_000, maxIterations: 50, maxRecoveryAttempts: 2 };
  const mission = {
    schemaVersion: 1,
    id: "launch-brief",
    taskId: "mission.launch-brief",
    goal: "Research, verify, and prepare the launch brief",
    status: "running",
    scope: { project: "Echo" },
    createdAt: now - 780_000,
    updatedAt: now - 8_000,
    tasks: {
      research: { id: "research", goal: "Collect current launch facts from approved sources", dependsOn: [], acceptanceCriteria: ["Every claim has a source", "Conflicts are called out"], lane: "knowledge", budget, status: "completed", recoveryAttempts: 0, actorName: "Echo Agent 7", startedAt: now - 740_000, result: result("Collected and cross-checked eleven launch facts.", "launch-research.md") },
      analysis: { id: "analysis", goal: "Identify risks, decisions, and unresolved questions", dependsOn: ["research"], acceptanceCriteria: ["Risks include impact and mitigation"], lane: "knowledge", budget, status: "completed", recoveryAttempts: 1, actorName: "Echo Agent 8", startedAt: now - 510_000, result: result("Risk analysis verified against the research artifact.", "risk-analysis.json") },
      draft: { id: "draft", goal: "Draft the concise launch brief", dependsOn: ["research", "analysis"], acceptanceCriteria: ["Uses verified facts only", "Includes decisions and owners"], lane: "knowledge", budget, status: "working", recoveryAttempts: 0, actorName: "Echo Agent 9", startedAt: now - 126_000 },
      review: { id: "review", goal: "Verify the brief against every acceptance criterion", dependsOn: ["draft"], acceptanceCriteria: ["No unsupported claim remains"], lane: "knowledge", budget, status: "pending", recoveryAttempts: 0 },
      deliver: { id: "deliver", goal: "Save the verified brief in the project workspace", dependsOn: ["review"], acceptanceCriteria: ["Final file is readable and linked"], lane: "gui", budget, status: "pending", recoveryAttempts: 0 },
    },
  };
  const snapshot = {
    voiceEnabled: true,
    state: { status: "acting", provider: "gemini" },
    sessionStartedAt: now - 3_200_000,
    logs: [
      { id: 1, at: now - 35_000, kind: "agent", text: "Echo Agent 8 submitted a verified Result." },
      { id: 2, at: now - 8_000, kind: "assistant", text: "Echo Agent 9 is drafting from the approved evidence." },
    ],
    tasks: [{ id: "session-1", title: mission.goal, status: "working", agent: "Echo", startedAt: mission.createdAt }],
    agents: [{ id: "launch-brief.draft", name: "Echo Agent 9", goal: mission.tasks.draft.goal, status: "working", startedAt: mission.tasks.draft.startedAt, progress: "Structuring the decision and risk sections from verified inputs.", missionId: mission.id, agentTaskId: "draft", lane: "knowledge" }],
    missions: [mission],
    settings: {
      brain: "gemini",
      voice: { ttsEnabled: true, wakeWord: true, conversationMode: true, bargeIn: true, sttStreaming: true, ttsStreaming: true, sendAudioToBrain: false, sttProvider: "whisper", sttLanguage: "en", ttsEngine: "mac", maxSpokenSentences: 6, conversationWindowMs: 12000 },
      hud: { startListeningOnLaunch: false },
      memory: { enabled: true, cloudRecall: false, retentionDays: 90 },
      helpers: { shadow: false, ghost: false, autoDebug: true, shadowIntervalSeconds: 60 },
      dreaming: { enabled: true },
      learning: { enabled: true, captureScreens: false, maxStepsPerTurn: 100 },
      configPath: "/Users/preview/.jarvis/config.json",
    },
    models: [
      { id: "gemini", label: "Gemini", model: "gemini-3.7-flash", active: true, available: true },
      // ECHO_PANEL_CHATGPT=signed-in previews the connected state of the sign-in row.
      process.env.ECHO_PANEL_CHATGPT === "signed-in"
        ? { id: "openai", label: "ChatGPT", model: "gpt-plan-1", active: false, available: true,
            account: { billing: "chatgpt", chatgpt: { status: "connected", planUsage: true, email: "you@example.com" } } }
        : { id: "openai", label: "ChatGPT", model: "gpt-4o", active: false, available: false, reason: "sign in with ChatGPT or set OPENAI_API_KEY",
            account: { billing: "none", chatgpt: { status: "disconnected", planUsage: false } } },
      // ECHO_PANEL_OPENROUTER=signed-in previews the picker with a key present.
      {
        id: "openrouter", label: "OpenRouter", model: "nvidia/nemotron-3-super-120b-a12b:free",
        active: false, available: true,
        catalogue: {
          signedIn: process.env.ECHO_PANEL_OPENROUTER === "signed-in",
          models: [
            { id: "nvidia/nemotron-3-ultra-550b-a55b:free", label: "Nemotron Ultra 550B", contextLength: 1000000 },
            { id: "dots-studio/dots-3-note-preview:free", label: "Dots 3 Note", contextLength: 512000 },
            { id: "nvidia/nemotron-3-super-120b-a12b:free", label: "Nemotron Super 120B", contextLength: 262144 },
            { id: "cohere/north-mini-code:free", label: "North Mini Code", contextLength: 256000 },
          ],
        },
      },
    ],
    connections: [{ name: "workspace", status: "active", tools: 12, lastActivityAt: now - 8_000 }],
    analytics: { commands: 1, toolCalls: 17, errors: 0, completedTasks: 0, uptimeSeconds: 3200 },
  };
  
  const fleet = {
    members: [
      { id: "lead", name: "Lead", description: "Synthesises the team's work into one answer.", brief: "Lead", tier: "deep", tools: [], custom: false },
      { id: "research", name: "Research", description: "Finds and verifies facts from approved sources.", brief: "Research", tier: "balanced", tools: [], custom: false },
      { id: "plan", name: "Plan", description: "Breaks a goal into concrete steps.", brief: "Plan", tier: "balanced", tools: [], custom: false },
      { id: "write", name: "Write", description: "Drafts the concise deliverable.", brief: "Write", tier: "balanced", tools: [], custom: false },
      { id: "review", name: "Review", description: "Checks the draft against acceptance criteria.", brief: "Review", tier: "balanced", tools: [], custom: false },
      { id: "analyse", name: "Analyse", description: "Surfaces risks and open questions.", brief: "Analyse", tier: "deep", tools: [], custom: false },
      { id: "sidekick", name: "Sidekick", description: "A custom preview agent with a couple of tools.", brief: "You help with quick lookups.", tier: "fast", tools: ["recall", "read_local_file"], custom: true },
    ],
    grantableTools: ["recall", "read_local_file", "list_ui_elements", "search_my_past", "read_clipboard"],
    maxCustom: 6,
  };
  const boardMission = {
    schemaVersion: 1,
    id: "board-preview",
    taskId: "mission.board-preview",
    goal: "Summarise this week's launch readiness",
    status: "running",
    scope: {},
    createdAt: now - 60_000,
    updatedAt: now - 2_000,
    tasks: {
      research: { id: "research", goal: "Summarise this week's launch readiness", dependsOn: [], lane: "knowledge", budget, status: "completed", recoveryAttempts: 0, actorName: "Research", startedAt: now - 55_000, result: result("Found eleven relevant facts across three approved sources, all cross-checked.", "research-notes.md") },
      analyse: { id: "analyse", goal: "Summarise this week's launch readiness", dependsOn: [], lane: "knowledge", budget, status: "working", recoveryAttempts: 0, actorName: "Analyse", startedAt: now - 30_000 },
      write: { id: "write", goal: "Summarise this week's launch readiness", dependsOn: [], lane: "knowledge", budget, status: "pending", recoveryAttempts: 0 },
    },
  };
  snapshot.missions.push(boardMission);
  snapshot.agents.push({ id: "board-preview.analyse", name: "Analyse", goal: boardMission.goal, status: "working", startedAt: boardMission.tasks.analyse.startedAt, progress: "Weighing three open risks against the research notes.", missionId: boardMission.id, agentTaskId: "analyse", lane: "knowledge" });
  
  ipcMain.handle('control:companion',()=>({checkedAt:Date.now(),approval:null,work:[],needs:[],now:[],next:'Tell Echo what you want to get done.',phone:{active:false,expiresAt:null,queued:0,lastDeliveredAt:null,message:'Phone updates are off.'},scope:{},memory:{scope:{},revision:0,total:0,items:[]}}));
  ipcMain.handle("control:snapshot", () => structuredClone(snapshot));
  ipcMain.handle("control:action", (_event, action) => {
    if (action?.type === "save-settings" && action.settings) snapshot.settings = { ...snapshot.settings, ...action.settings, configPath: snapshot.settings.configPath };
    if (action?.type === "run-board" || action?.type === "run-fleet-agent") return { ok: true, message: "Preview mode", data: { missionId: boardMission.id } };
    if (action?.type === "save-agent" || action?.type === "remove-agent" || action?.type === "stop-mission" || action?.type === "stop-mission-task") return { ok: true, message: "Preview mode" };
    return { ok: true, message: action?.type === "save-settings" ? "Settings saved in preview mode." : action?.type === "shutdown" ? "Preview shutdown path verified." : "Preview mode" };
  });
  ipcMain.handle("control:fleet", () => structuredClone(fleet));
  ipcMain.handle("control:api-keys", () => ({ fields: [], values: {} }));
  ipcMain.handle("control:weather", () => ({ status: "ok", place: "Preview Lab", temperature: 21, feelsLike: 20, humidity: 43, wind: 7, condition: "Clear", source: "timezone-estimate", updatedAt: now }));
  ipcMain.handle("control:world", () => ({
    checkedAt: Date.now(),
    feeds: Object.fromEntries(["conflicts", "earthquakes", "fires", "weather"].map(name => [name, {status: "current", updatedAt: Date.now(), sourceUpdatedAt: now}])),
    conflicts: [{label: "Preview region", severity: "war", description: "Deterministic preview observation", latest: {title: "A sourced conflict update", url: "https://example.org/world"}}],
    earthquakes: {count: 2, top: [{magnitude: 5.2, place: "Preview coast", at: now - 60000, depthKm: 12, tsunami: true, url: "https://earthquake.usgs.gov/"}]},
    tsunamis: [{place: "Preview coast"}],
    fires: {count: 2010, highConfidence: 42},
    storms: [{title: "Preview tropical storm", type: "Storm", severity: "High", source: "NASA EONET", at: now}],
  }));
  ipcMain.on("control:close", () => onClose?.());

  return { snapshot, fleet, mission, boardMission };
}

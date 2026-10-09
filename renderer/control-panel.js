const bridge = window.echoControl;
const byId = (id) => document.getElementById(id);
let snapshot = null;
let feedbackTimer = null;
let activeView = "overview";
let selectedMissionId = "";
let settingsDirty = false;
let modelSwitchPending = false;
let lastLevelPaintAt = 0;
const renderKeys = Object.create(null);
const expandedMissionTasks = new Set();

const valueText = (value, fallback = "—") => value === undefined || value === null || value === "" ? fallback : String(value);
const escapeHtml = (value) => valueText(value, "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]);
const eventTime = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "--:--" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};
const relativeTime = (value) => {
  const elapsed = Math.max(0, Date.now() - Number(value || Date.now()));
  if (elapsed < 45_000) return "just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return new Date(value).toLocaleDateString([], { month: "short", day: "numeric" });
};
const duration = (seconds) => {
  const total = Math.max(0, Number(seconds) || 0);
  return [Math.floor(total / 3600), Math.floor((total % 3600) / 60), Math.floor(total % 60)]
    .map((part) => String(part).padStart(2, "0")).join(":");
};
const plural = (count, singular, pluralValue = `${singular}s`) => `${count} ${count === 1 ? singular : pluralValue}`;
const terminalMissionStatus = (status) => ["completed", "partial", "blocked", "failed", "cancelled"].includes(String(status));
const statusLabel = (status) => String(status || "pending").replace(/_/g, " ");
const budgetTime = (milliseconds) => {
  const minutes = Math.max(1, Math.round((Number(milliseconds) || 0) / 60_000));
  return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
};
const elapsedTime = (startedAt, completedAt) => {
  if (!startedAt) return "Not started";
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const seconds = Math.max(0, Math.floor((end - Number(startedAt)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

function iconForKind(kind) {
  const normalized = String(kind || "").toLowerCase();
  if (/error|failed|warn/.test(normalized)) return "alert";
  if (/done|complete|success/.test(normalized)) return "check";
  if (/tool|code|action|assistant/.test(normalized)) return "code";
  if (/agent|swarm|delegate/.test(normalized)) return "agent";
  return "file";
}

function toneForKind(kind) {
  const normalized = String(kind || "").toLowerCase();
  if (/error|failed/.test(normalized)) return "error";
  if (/done|complete|success/.test(normalized)) return "done";
  return "";
}

function notify(message, error = false) {
  const element = byId("feedback");
  element.textContent = message || "";
  element.className = `feedback show${error ? " error" : ""}`;
  clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => { element.className = "feedback"; }, 4000);
}

async function act(action) {
  if (!bridge) {
    notify("The control bridge is unavailable.", true);
    return { ok: false, message: "The control bridge is unavailable." };
  }
  try {
    const result = await bridge.action(action);
    if (!result?.ok && result?.message) notify(result.message, true);
    else if (result?.message) notify(result.message);
    return result || { ok: false, message: "Echo returned no result." };
  } catch (error) {
    const message = error?.message || String(error);
    notify(message, true);
    return { ok: false, message };
  }
}

function setView(name) {
  if (!byId(`${name}-view`)) return;
  activeView = name;
  document.querySelectorAll("[data-view-panel]").forEach((panel) => {
    const visible = panel.dataset.viewPanel === name;
    panel.hidden = !visible;
    panel.classList.toggle("active", visible);
  });
  document.querySelectorAll(".section-nav [data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
  syncNeuralCard();
  syncWorld();
  // Apply the newest snapshot when a page becomes visible. Hidden pages do
  // not rebuild controls or lists on every background runtime update.
  if (snapshot) render(snapshot);
}

// World data is fetched through a restricted main-process bridge, only while visible.
const WORLD_REFRESH_MS = 30_000;
let worldSnapshot = null, worldLoading = null, worldTimer = null, worldFilter = "all", worldFailed = false;
const worldLabels = {conflicts: "Conflict zones", earthquakes: "Earthquakes · USGS", fires: "Fire detections · NASA FIRMS", weather: "Storms & hazards · NASA EONET"};
function worldVisible() { return activeView === "world" && !document.hidden; }
function syncWorld() {
  clearTimeout(worldTimer); worldTimer = null;
  if (worldVisible()) void loadWorld();
}
async function loadWorld() {
  if (worldLoading) return worldLoading;
  if (!worldVisible()) return;
  const refresh = byId("world-refresh"); refresh.disabled = true;
  if (!worldSnapshot) byId("world-updated").textContent = "Connecting to Osiris…";
  worldLoading = (async () => {
    try {
      if (!bridge?.world) throw new Error("World bridge unavailable");
      worldSnapshot = await bridge.world(); worldFailed = false;
      renderWorld();
    } catch {
      worldFailed = true;
      if (worldSnapshot) renderWorld();
      else {
        byId("world-updated").textContent = "Osiris unavailable · Retrying in 30 seconds";
        byId("world-list").innerHTML = '<div class="empty-state">Couldn’t reach Osiris. Refresh to try again.</div>';
      }
    }
  })().finally(() => {
    worldLoading = null; refresh.disabled = false;
    clearTimeout(worldTimer);
    if (worldVisible()) worldTimer = setTimeout(loadWorld, WORLD_REFRESH_MS);
  });
  return worldLoading;
}
function renderWorld() {
  if (!worldSnapshot) return;
  const w = worldSnapshot, names = Object.keys(worldLabels);
  const missing = names.filter(name => w.feeds[name].status !== "current");
  byId("world-updated").textContent = worldFailed || missing.length === names.length
    ? `Osiris unavailable · Last checked ${eventTime(w.checkedAt)}`
    : `Osiris · Checked ${eventTime(w.checkedAt)}${missing.length ? " · Some feeds unavailable" : ""}`;
  const usable = name => w.feeds[name].updatedAt !== null;
  const stats = [[usable("conflicts") ? w.conflicts.length : null, "Conflicts"], [w.earthquakes.count, "Earthquakes · 24h"],
    [w.fires.count, "Fire detections"], [usable("earthquakes") ? w.tsunamis.length : null, "Tsunami flags · 24h"]];
  byId("world-stats").innerHTML = stats.map(([n, label]) => `<article><strong>${n === null ? "—" : Number(n).toLocaleString()}</strong><span>${label}</span></article>`).join("");
  const notice = byId("world-notice"); notice.hidden = !worldFailed && !missing.length;
  notice.textContent = worldFailed ? "Connection unavailable. Showing the last saved observations." : missing.map(name => {
    const f = w.feeds[name];
    return f.updatedAt === null ? `${worldLabels[name]} unavailable` : `${worldLabels[name]} unavailable; last copy ${eventTime(f.updatedAt)}`;
  }).join(" · ");
  const items = [];
  for (const z of w.conflicts) items.push({kind: "conflict", feed: "conflicts", title: z.label, meta: z.severity || "Conflict zone", detail: z.latest?.title || z.description, url: z.latest?.url});
  for (const q of w.earthquakes.top) items.push({kind: "quake", feed: "earthquakes", title: `M${q.magnitude.toFixed(1)} · ${q.place || "Earthquake"}`, meta: eventTime(q.at), detail: `${q.depthKm === null ? "Depth unavailable" : `Depth ${Math.round(q.depthKm)} km`}${q.tsunami ? " · Tsunami flagged by USGS" : ""}`, url: q.url});
  for (const storm of w.storms) items.push({kind: "hazard", feed: "weather", title: storm.title, meta: storm.severity || storm.type || "Natural hazard", detail: [storm.type, storm.source].filter(Boolean).join(" · ")});
  if (usable("fires")) items.push({kind: "hazard", feed: "fires", title: `${w.fires.count.toLocaleString()} fire detections`, meta: "NASA FIRMS", detail: `${w.fires.highConfidence.toLocaleString()} high-confidence hotspots worldwide`});
  if (usable("earthquakes")) items.push({kind: "hazard", feed: "earthquakes", title: w.tsunamis.length ? `${w.tsunamis.length} tsunami-flagged earthquake${w.tsunamis.length === 1 ? "" : "s"}` : "No tsunami-flagged earthquakes", meta: "USGS · 24h", detail: w.tsunamis.length ? w.tsunamis.map(q => q.place).join(" · ") : "None of these observed earthquakes carry a USGS tsunami flag."});
  const shown = items.filter(item => worldFilter === "all" || item.kind === worldFilter);
  const relevant = {all: names, conflict: ["conflicts"], quake: ["earthquakes"], hazard: ["fires", "weather", "earthquakes"]}[worldFilter];
  const categoryUnavailable = worldFailed || relevant.some(name => w.feeds[name].status !== "current");
  byId("world-list").innerHTML = shown.length ? shown.slice(0, 60).map(item => {
    const stale = worldFailed || w.feeds[item.feed].status !== "current";
    const content = `<span class="world-marker" aria-hidden="true"></span><div><header><h3>${escapeHtml(item.title)}</h3><span>${escapeHtml(item.meta)}${stale ? " · Last copy" : ""}</span></header><p>${escapeHtml(item.detail)}</p></div>`;
    return item.url ? `<button type="button" class="world-row" data-kind="${item.kind}" data-external-url="${escapeHtml(item.url)}">${content}</button>` : `<article class="world-row" data-kind="${item.kind}">${content}</article>`;
  }).join("") : `<div class="empty-state">${categoryUnavailable ? "Observations are unavailable for this filter. Available feeds are shown above." : "No observations in this category."}</div>`;
  byId("world-sources").innerHTML = names.map(name => {
    const f = w.feeds[name];
    return `<p><b>${worldLabels[name]}</b><span>${f.status === "current" && !worldFailed ? "Available" : "Unavailable"}${f.updatedAt !== null ? ` · Retrieved ${eventTime(f.updatedAt)}` : ""}${f.sourceUpdatedAt !== null ? ` · Source updated ${eventTime(f.sourceUpdatedAt)}` : ""}</span></p>`;
  }).join("");
}
byId("world-list").addEventListener("click", event => {
  const link = event.target.closest?.("[data-external-url]");
  if (link) bridge?.openExternal?.(link.dataset.externalUrl);
});
document.addEventListener("visibilitychange", syncWorld);
window.addEventListener("pagehide", () => { clearTimeout(worldTimer); worldTimer = null; });
window.addEventListener("pageshow", () => { if (worldVisible()) syncWorld(); });
byId("world-refresh").addEventListener("click", () => { clearTimeout(worldTimer); void loadWorld(); });
document.querySelectorAll("[data-world-filter]").forEach(button => button.addEventListener("click", () => {
  worldFilter = button.dataset.worldFilter;
  document.querySelectorAll("[data-world-filter]").forEach(b => b.setAttribute("aria-pressed", String(b === button)));
  renderWorld();
}));

function stableKey(value) {
  try { return JSON.stringify(value); } catch { return String(value); }
}

// Cheap change-fingerprints for missions/agents: touch only the small fields
// that actually change, not the full object graph (a mission's tasks carry
// full Results — summaries, artifacts, verification refs — that can be large
// and were previously re-stringified in full on every refresh tick).
function missionsFingerprint(missions) {
  return missions.map((m) => {
    const tasks = m.tasks || {};
    let taskSig = "";
    for (const id in tasks) {
      const t = tasks[id];
      taskSig += `${id}:${t.status}:${t.result?.completedAt || ""};`;
    }
    return `${m.id}:${m.status}:${m.updatedAt}:${taskSig}`;
  }).join("|");
}
function agentsFingerprint(agents) {
  return agents.map((a) => `${a.name}:${a.status}:${a.progress}`).join("|");
}

function renderChanged(name, value, callback) {
  const key = stableKey(value);
  if (renderKeys[name] === key) return;
  renderKeys[name] = key;
  callback();
}


/* ---------------------------------------------------------------------------
 * Live synaptic field card (under Live Activity)
 *
 * The same engine the Neural Map window uses, built from a 0.6-scale copy of
 * the micrograph and capped at 20fps. Painting yields room to controls.
 * It is built during idle time so opening the panel never waits on it, and it
 * is stopped whenever it cannot be seen — another view, a hidden window — so a
 * panel left open in the background costs nothing.
 * ------------------------------------------------------------------------ */
let neuralCard = null;
let neuralCardStatus = "idle";

function neuralCardVisible() {
  return activeView === "overview" && !document.hidden && document.hasFocus();
}

function syncNeuralCard() {
  if (!neuralCard) return;
  if (neuralCardVisible()) neuralCard.start();
  else neuralCard.stop();
}

function buildNeuralCard() {
  const host = byId("neural-card");
  if (!host || neuralCard || typeof SynapseField !== "function" || !window.ECHO_SYNAPSE_MAPS) return;
  const map = window.ECHO_SYNAPSE_MAPS.dense;
  try {
    neuralCard = new SynapseField(Object.assign({}, map, {
      host,
      imageSrc: map.src,
      buildScale: 0.6,      // quality holds: same fibre lengths, a third of the cost
      fxScale: 0.6,
      impulseCap: 120,
      fps: 20,
      interactive: false,
      zoom: 1.4,            // crop into the tissue so detail still reads at card size
      chunked: true,        // build in slices — never block a panel frame
    }));
  } catch {
    return;                 // a decorative panel never breaks the control panel
  }
  neuralCard.ready.then(() => {
    neuralCard.setState(window.ECHO_SYNAPSE_STATE(neuralCardStatus));
    neuralCard.onframe = (st) => {
      const el = byId("neural-card-ap");
      if (el) el.textContent = st.active + " AP";
    };
    syncNeuralCard();
  }).catch(() => { neuralCard = null; });
}

function setNeuralCardState(status) {
  neuralCardStatus = status;
  if (neuralCard) neuralCard.setState(window.ECHO_SYNAPSE_STATE(status));
}

document.addEventListener("visibilitychange", syncNeuralCard);
window.addEventListener("focus", syncNeuralCard);
window.addEventListener("blur", syncNeuralCard);

function setRenderMode(status) {
  const active = !["idle", "asleep", "error"].includes(String(status || "idle"));
  const mode = active ? "active" : "idle";
  if (document.body.dataset.renderMode !== mode) document.body.dataset.renderMode = mode;
}

function render(next) {
  if (!next || typeof next !== "object") return;
  snapshot = next;
  renderState(next.state);

  const analytics = next.analytics || {};
  byId("metric-commands").textContent = valueText(analytics.commands, "0");
  byId("metric-tools").textContent = valueText(analytics.toolCalls, "0");
  byId("metric-completed").textContent = valueText(analytics.completedTasks, "0");
  byId("metric-errors").textContent = valueText(analytics.errors, "0");
  byId("metric-uptime").textContent = duration(analytics.uptimeSeconds);
  byId("voice-state").textContent = `VOICE ${next.voiceEnabled ? "ON" : "MUTED"}`;
  byId("voice-toggle").classList.toggle("enabled", Boolean(next.voiceEnabled));

  if (activeView === "overview") renderIntel(next.intel);
  const logs = Array.isArray(next.logs) ? next.logs : [];
  const agents = Array.isArray(next.agents) ? next.agents : [];
  const missions = Array.isArray(next.missions) ? next.missions : [];
  const models = Array.isArray(next.models) ? next.models : [];
  const connections = Array.isArray(next.connections) ? next.connections : [];
  const activeModel = models.find((model) => model.active);
  const activeModelName = activeModel?.label || valueText(next.state?.provider, "No active route");
  const activeModelVersion = activeModel?.model || "Waiting for runtime";
  byId("active-model").textContent = `${activeModelName} · ${activeModelVersion}`;
  byId("route-name").textContent = activeModelName;
  byId("route-model").textContent = activeModelVersion;
  byId("current-route-name").textContent = activeModelName;
  byId("current-route-model").textContent = activeModelVersion;
  byId("core-agent-count").textContent = plural(agents.length, "AGENT");

  // logs: a plain revision counter from the main process instead of
  // JSON.stringify-ing the whole array on every tick. That used to run at up
  // to ~16/sec while Echo was active and re-hash up to 240 log entries every
  // single time, whether or not anything had actually changed.
  if (activeView === "overview" || activeView === "models") {
    renderChanged(`logs:${activeView}`, next.logRevision ?? 0, () => renderLogs(logs));
  }
  // missions/agents don't carry a revision counter (they're owned by the swarm
  // module, not this telemetry object), and their objects can be large —
  // nested tasks with full Results, artifacts, etc. A fingerprint of just the
  // fields that actually change is enough to detect an update without hashing
  // all of that.
  if (activeView === "overview" || activeView === "tasks") {
    const agentsKey = agentsFingerprint(agents);
    renderChanged("missions", `${missionsFingerprint(missions)}|${agentsKey}`, () => renderMissions(missions, agents));
    renderChanged("agents", agentsKey, () => renderAgents(agents));
  }
  if (activeView === "tasks") renderChanged("board", `${missionsFingerprint(missions)}|${fleetRevision}`, () => renderBoard(missions));
  if (activeView === "models") {
    renderChanged("models", models, () => renderModels(models));
    renderChanged("connections", connections, () => renderConnections(connections));
  }
  renderChanged("connection-summary", connections.map(c => [c.name, c.status]), () => renderConnectionSummary(connections));
  // Do not consume the new key while the user is editing. Otherwise a runtime
  // update can cache the saved value without applying it, and the explicit
  // post-save render then appears unchanged.
  if (activeView === "settings" && !settingsDirty) renderChanged("settings", next.settings || null, () => renderSettings(next.settings || null));
}

function renderState(state) {
  const status = String(state?.status || "idle").toLowerCase();
  setRenderMode(status);
  if (document.body.dataset.status === status) return;
  document.body.dataset.status = status;
  setNeuralCardState(status);
  byId("system-state").textContent = status.toUpperCase();
  byId("core-status").textContent = status.toUpperCase();
}

function setControlValue(id, value) {
  const control = byId(id);
  if (!control) return;
  if (control.type === "checkbox") control.checked = Boolean(value);
  else control.value = value === undefined || value === null ? "" : String(value);
}

function renderSettings(settings, force = false) {
  if (!settings || (settingsDirty && !force)) return;
  setControlValue("settings-brain", settings.brain);
  setControlValue("settings-start-listening", settings.hud?.startListeningOnLaunch);
  setControlValue("settings-tts-enabled", settings.voice?.ttsEnabled);
  setControlValue("settings-wake-word", settings.voice?.wakeWord);
  setControlValue("settings-conversation-mode", settings.voice?.conversationMode);
  setControlValue("settings-barge-in", settings.voice?.bargeIn);
  setControlValue("settings-stt-streaming", settings.voice?.sttStreaming);
  setControlValue("settings-tts-streaming", settings.voice?.ttsStreaming);
  setControlValue("settings-send-audio", settings.voice?.sendAudioToBrain);
  setControlValue("settings-stt-provider", settings.voice?.sttProvider);
  setControlValue("settings-stt-language", settings.voice?.sttLanguage);
  setControlValue("settings-tts-engine", settings.voice?.ttsEngine);
  setControlValue("settings-vibevoice-url", settings.voice?.vibeVoiceUrl || "");
  setControlValue("settings-vibevoice-speaker", settings.voice?.vibeVoiceSpeaker || "Carter");
  setControlValue("settings-max-spoken", settings.voice?.maxSpokenSentences);
  setControlValue("settings-conversation-window", Math.round(Number(settings.voice?.conversationWindowMs || 12000) / 1000));
  setControlValue("settings-memory-enabled", settings.memory?.enabled);
  setControlValue("settings-cloud-recall", settings.memory?.cloudRecall);
  setControlValue("settings-retention-days", settings.memory?.retentionDays);
  setControlValue("settings-shadow", settings.helpers?.shadow);
  setControlValue("settings-ghost", settings.helpers?.ghost);
  setControlValue("settings-auto-debug", settings.helpers?.autoDebug);
  setControlValue("settings-shadow-interval", settings.helpers?.shadowIntervalSeconds);
  setControlValue("settings-dreaming", settings.dreaming?.enabled);
  setControlValue("settings-learning-enabled", settings.learning?.enabled);
  setControlValue("settings-capture-screens", settings.learning?.captureScreens);
  setControlValue("settings-max-steps", settings.learning?.maxStepsPerTurn);
  byId("settings-config-path").textContent = valueText(settings.configPath, "Echo user-data/config.json");
  byId("settings-save-state").textContent = "Synced with Echo";
  byId("settings-save-state").classList.remove("dirty");
}

function checked(id) {
  return Boolean(byId(id).checked);
}

function numericValue(id) {
  return Number(byId(id).value);
}

function settingsPayload() {
  return {
    brain: byId("settings-brain").value,
    voice: {
      ttsEnabled: checked("settings-tts-enabled"),
      wakeWord: checked("settings-wake-word"),
      conversationMode: checked("settings-conversation-mode"),
      bargeIn: checked("settings-barge-in"),
      sttStreaming: checked("settings-stt-streaming"),
      ttsStreaming: checked("settings-tts-streaming"),
      sendAudioToBrain: checked("settings-send-audio"),
      sttProvider: byId("settings-stt-provider").value,
      sttLanguage: byId("settings-stt-language").value.trim(),
      ttsEngine: byId("settings-tts-engine").value,
      vibeVoiceUrl: byId("settings-vibevoice-url").value.trim(),
      vibeVoiceSpeaker: byId("settings-vibevoice-speaker").value.trim(),
      maxSpokenSentences: numericValue("settings-max-spoken"),
      conversationWindowMs: numericValue("settings-conversation-window") * 1000,
    },
    hud: { startListeningOnLaunch: checked("settings-start-listening") },
    memory: {
      enabled: checked("settings-memory-enabled"),
      cloudRecall: checked("settings-cloud-recall"),
      retentionDays: numericValue("settings-retention-days"),
    },
    helpers: {
      shadow: checked("settings-shadow"),
      ghost: checked("settings-ghost"),
      autoDebug: checked("settings-auto-debug"),
      shadowIntervalSeconds: numericValue("settings-shadow-interval"),
    },
    dreaming: { enabled: checked("settings-dreaming") },
    learning: {
      enabled: checked("settings-learning-enabled"),
      captureScreens: checked("settings-capture-screens"),
      maxStepsPerTurn: numericValue("settings-max-steps"),
    },
  };
}

function activityMarkup(logs) {
  const recent = logs.slice(-8).reverse();
  if (!recent.length) return '<div class="empty-state">Waiting for live activity…</div>';
  return recent.map((item) => {
    const icon = iconForKind(item.kind);
    const tone = toneForKind(item.kind);
    return `<article class="activity-entry ${tone}">
      <span class="activity-icon"><svg><use href="#icon-${icon}"></use></svg></span>
      <div class="activity-copy"><p>${escapeHtml(item.text)}</p><small>${escapeHtml(relativeTime(item.at))} · ${escapeHtml(item.kind || "event")}</small></div>
      <i class="activity-dot"></i>
    </article>`;
  }).join("");
}

function renderLogs(logs) {
  const markup = activityMarkup(logs);
  byId(activeView === "models" ? "routing-log" : "live-log").innerHTML = markup;
}

function resultItems(items, emptyText, className = "") {
  if (!Array.isArray(items) || !items.length) return `<span class="mission-result-empty">${escapeHtml(emptyText)}</span>`;
  return `<ul class="mission-result-list ${escapeHtml(className)}">${items.map((item) => {
    const label = typeof item === "object" && item ? valueText(item.label, item.kind) : valueText(item);
    const value = typeof item === "object" && item ? valueText(item.value, "") : "";
    return `<li><strong>${escapeHtml(label)}</strong>${value ? `<span>${escapeHtml(value)}</span>` : ""}</li>`;
  }).join("")}</ul>`;
}

function missionTaskMarkup(task, index, missionId, activeAgents) {
  const status = statusLabel(task.status);
  const key = `${missionId}:${task.id}`;
  const result = task.result || null;
  const runningAgent = activeAgents.find((agent) => agent.missionId === missionId && agent.agentTaskId === task.id);
  const dependencies = Array.isArray(task.dependsOn) ? task.dependsOn : [];
  const criteria = Array.isArray(task.acceptanceCriteria) ? task.acceptanceCriteria : [];
  const isExpanded = expandedMissionTasks.has(key);
  const completedAt = result?.completedAt;
  const icon = task.status === "failed" || task.status === "blocked" ? "alert" : task.status === "completed" ? "check" : task.lane === "gui" ? "monitor" : "brain";
  return `<details class="mission-task ${escapeHtml(task.status)}" data-mission-task-key="${escapeHtml(key)}"${isExpanded ? " open" : ""}>
    <summary>
      <span class="mission-task-index">${String(index + 1).padStart(2, "0")}</span>
      <span class="mission-task-icon"><svg><use href="#icon-${icon}"></use></svg></span>
      <span class="mission-task-copy"><strong>${escapeHtml(task.goal)}</strong><small>${dependencies.length ? `Depends on ${dependencies.map(escapeHtml).join(", ")}` : "Ready without dependencies"}</small></span>
      <span class="lane-tag ${escapeHtml(task.lane)}">${escapeHtml(task.lane)}</span>
      <span class="mission-task-agent">${escapeHtml(task.actorName || (task.status === "pending" ? "Unassigned" : "Echo agent"))}</span>
      <span class="status-tag ${escapeHtml(task.status)}">${escapeHtml(status)}</span>
      <svg class="mission-task-chevron"><use href="#icon-chevron"></use></svg>
    </summary>
    <div class="mission-task-detail">
      <dl class="mission-task-metrics">
        <div><dt>Elapsed</dt><dd>${escapeHtml(elapsedTime(task.startedAt, completedAt))}</dd></div>
        <div><dt>Wall-time cap</dt><dd>${escapeHtml(budgetTime(task.budget?.timeoutMs))}</dd></div>
        <div><dt>Iteration cap</dt><dd>${escapeHtml(task.budget?.maxIterations ?? "—")}</dd></div>
        <div><dt>Recoveries</dt><dd>${escapeHtml(task.recoveryAttempts ?? 0)} / ${escapeHtml(task.budget?.maxRecoveryAttempts ?? "—")}</dd></div>
      </dl>
      ${runningAgent?.progress ? `<p class="mission-live-progress"><span>Live</span>${escapeHtml(runningAgent.progress)}</p>` : ""}
      <section><h3>Acceptance criteria</h3>${resultItems(criteria, "No explicit criteria recorded")}</section>
      <section><h3>Result</h3><p class="mission-result-summary">${escapeHtml(result?.summary || "No structured Result submitted yet.")}</p></section>
      <div class="mission-result-grid">
        <section><h3>Artifacts</h3>${resultItems(result?.artifacts, "No artifacts yet")}</section>
        <section><h3>Verification</h3>${resultItems(result?.verificationRefs, "No evidence yet")}</section>
        <section><h3>Blockers</h3>${resultItems(result?.blockers, "No blockers", "blockers")}</section>
      </div>
    </div>
  </details>`;
}

/**
 * Delete is destructive and the missions page re-renders under the pointer on
 * every snapshot, so it asks twice: the first click arms the button, the second
 * one within a few seconds does it. Without the timeout an armed button could
 * sit there for an hour and catch a stray click.
 */
let pendingMissionDelete = "";
let pendingMissionDeleteTimer = 0;

function armMissionDelete(id) {
  pendingMissionDelete = id;
  clearTimeout(pendingMissionDeleteTimer);
  pendingMissionDeleteTimer = setTimeout(() => {
    pendingMissionDelete = "";
    if (snapshot) renderMissions(Array.isArray(snapshot.missions) ? snapshot.missions : [], snapshot.agents || []);
  }, 5000);
}

byId("mission-panel").addEventListener("click", async (event) => {
  const stop = event.target.closest("[data-stop-mission]");
  if (stop) {
    pendingMissionDelete = "";
    await act({ type: "stop-mission", missionId: stop.dataset.stopMission });
    return;
  }
  const remove = event.target.closest("[data-delete-mission]");
  if (!remove) return;
  const id = remove.dataset.deleteMission;
  if (pendingMissionDelete !== id) {
    armMissionDelete(id);
    remove.classList.add("confirming");
    remove.lastChild.textContent = "Confirm delete";
    return;
  }
  clearTimeout(pendingMissionDeleteTimer);
  pendingMissionDelete = "";
  if (selectedMissionId === id) selectedMissionId = "";
  const result = await act({ type: "delete-mission", missionId: id });
  // A mission with no live agents broadcasts nothing when it goes, so ask for
  // a fresh snapshot rather than waiting for one that may never arrive.
  if (result.ok && bridge) {
    try { render(await bridge.snapshot()); } catch { /* the next update will catch up */ }
  }
});

/**
 * The last few open-intelligence answers.
 *
 * Shows failures as well as successes, in red: five different public services
 * back this, each with its own outage, and a card that only ever showed the
 * good answers would hide the one fact worth knowing — which of them stopped
 * working.
 */
function renderIntel(entries) {
  const list = Array.isArray(entries) ? entries : [];
  byId("intel-summary-count").textContent = list.length
    ? `${list.length} recent`
    : "Nothing asked yet";
  byId("intel-summary").innerHTML = list.length
    ? list.slice(0, 3).map((e) =>
        `<span class="intel-row${e.ok ? "" : " failed"}"><i class="${e.ok ? "" : "failed"}"></i>` +
        `<div><strong>${escapeHtml(e.label)}${e.query ? ` · ${escapeHtml(e.query)}` : ""}</strong>` +
        `<span>${escapeHtml(e.answer)}</span></div></span>`
      ).join("")
    : '<span class="summary-empty">Ask about satellites, world news, what\'s nearby, a network, or exploited CVEs</span>';
}

function renderMissions(missions, agents) {
  const running = missions.filter((mission) => mission.status === "running");
  byId("mission-summary-count").textContent = `${running.length} active`;
  byId("mission-summary").innerHTML = missions.length ? missions.slice(0, 3).map((mission) =>
    `<span class="summary-row"><i class="${escapeHtml(mission.status)}"></i><strong>${escapeHtml(mission.goal)}</strong><small>${escapeHtml(statusLabel(mission.status))}</small></span>`
  ).join("") : '<span class="summary-empty">No missions yet</span>';

  if (!missions.length) {
    selectedMissionId = "";
    byId("mission-select").innerHTML = '<option value="">No missions</option>';
    byId("mission-panel").innerHTML = '<div class="empty-state large"><strong>No agent missions yet</strong><span>Long tasks delegated by Echo will appear here with live execution details.</span></div>';
    return;
  }

  if (!missions.some((mission) => mission.id === selectedMissionId)) {
    selectedMissionId = running[0]?.id || missions[0].id;
  }
  const picker = byId("mission-select");
  picker.innerHTML = missions.map((mission) => `<option value="${escapeHtml(mission.id)}">${escapeHtml(mission.goal)} · ${escapeHtml(statusLabel(mission.status))}</option>`).join("");
  picker.value = selectedMissionId;

  const mission = missions.find((item) => item.id === selectedMissionId) || missions[0];
  const tasks = Object.entries(mission.tasks || {}).map(([id, task]) => ({ id, ...task }));
  const terminalCount = tasks.filter((task) => terminalMissionStatus(task.status)).length;
  const completedCount = tasks.filter((task) => task.status === "completed").length;
  const percent = tasks.length ? Math.round((terminalCount / tasks.length) * 100) : 0;
  const knowledgeCount = tasks.filter((task) => task.lane === "knowledge").length;
  const guiCount = tasks.filter((task) => task.lane === "gui").length;
  const result = mission.result;

  byId("mission-panel").innerHTML = `<article class="mission-overview ${escapeHtml(mission.status)}">
    <header class="mission-overview-header">
      <div><span class="mission-id">${escapeHtml(mission.id)}</span><h2>${escapeHtml(mission.goal)}</h2><p>Updated ${escapeHtml(relativeTime(mission.updatedAt))} · Started ${escapeHtml(eventTime(mission.createdAt))}</p></div>
      <div class="mission-header-right">
        <span class="status-tag ${escapeHtml(mission.status)}">${escapeHtml(statusLabel(mission.status))}</span>
        <div class="mission-actions">
          ${mission.status === "running"
            ? `<button type="button" class="mission-action stop" data-stop-mission="${escapeHtml(mission.id)}" title="Stop this mission and every agent on it"><svg><use href="#icon-stop" /></svg>Stop</button>`
            : ""}
          <button type="button" class="mission-action delete${pendingMissionDelete === mission.id ? " confirming" : ""}" data-delete-mission="${escapeHtml(mission.id)}" title="${mission.status === "running" ? "Stop this mission and remove it from the board" : "Remove this mission from the board"}"><svg><use href="#icon-trash" /></svg>${pendingMissionDelete === mission.id ? "Confirm delete" : "Delete"}</button>
        </div>
      </div>
    </header>
    <div class="mission-progress-row"><progress class="mission-progress-track" aria-label="Mission tasks resolved" max="100" value="${percent}">${percent}%</progress><strong>${percent}%</strong></div>
    <dl class="mission-overview-metrics">
      <div><dt>Resolved</dt><dd>${terminalCount} / ${tasks.length}</dd></div>
      <div><dt>Verified</dt><dd>${completedCount}</dd></div>
      <div><dt>Knowledge lane</dt><dd>${knowledgeCount}</dd></div>
      <div><dt>GUI lane</dt><dd>${guiCount}</dd></div>
    </dl>
  </article>
  <section class="mission-pipeline" aria-label="Agent Task execution pipeline">
    <header><div><h2>Agent Tasks</h2><p>Dependencies, execution lanes, budgets, and Results</p></div><span>${plural(tasks.length, "task")}</span></header>
    <div class="mission-task-list">${tasks.map((task, index) => missionTaskMarkup(task, index, mission.id, agents)).join("")}</div>
  </section>
  ${result ? `<section class="mission-final-result ${escapeHtml(result.status)}"><header><h2>Mission Result</h2><span class="status-tag ${escapeHtml(result.status)}">${escapeHtml(statusLabel(result.status))}</span></header><p>${escapeHtml(result.summary)}</p><div class="mission-result-grid"><section><h3>Artifacts</h3>${resultItems(result.artifacts, "No artifacts")}</section><section><h3>Verification</h3>${resultItems(result.verificationRefs, "No evidence")}</section><section><h3>Blockers</h3>${resultItems(result.blockers, "No blockers", "blockers")}</section></div></section>` : ""}`;
}

function renderAgents(agents) {
  byId("agent-summary-count").textContent = `${agents.length} connected`;
  byId("agent-summary").innerHTML = agents.length ? agents.slice(0, 2).map((agent) => `<span class="summary-row"><i class="active"></i><strong>${escapeHtml(agent.name)}</strong><small>${escapeHtml(agent.status)}</small></span>`).join("") : '<span class="summary-empty">No background agents</span>';
}

/**
 * The ChatGPT card's account row: sign in to run the OpenAI brain on the
 * user's own ChatGPT plan instead of an API key, or sign out of it.
 */
function chatgptAccountMarkup(account) {
  if (!account) return "";
  const session = account.chatgpt || {};
  let status;
  let button;
  if (session.status === "connecting") {
    status = "Finish signing in in your browser…";
    button = '<button type="button" class="account-button" data-chatgpt="cancel">Cancel</button>';
  } else if (session.status === "connected" && session.planUsage) {
    status = `Using your ChatGPT plan${session.email ? ` · ${escapeHtml(session.email)}` : ""}`;
    button = '<button type="button" class="account-button" data-chatgpt="sign-out">Sign out</button>';
  } else {
    status = session.error
      ? escapeHtml(session.error)
      : account.billing === "apiKey" ? "Using your API key · or use your ChatGPT plan instead" : "Use your ChatGPT plan — no API key needed";
    button = '<button type="button" class="account-button primary" data-chatgpt="sign-in">Sign in with ChatGPT</button>';
  }
  return `<div class="model-account"><span>${status}</span>${button}</div>`;
}

/**
 * The OpenRouter card: sign in with the browser, and pick a model.
 *
 * The list is whatever the main process last read from OpenRouter — free and
 * able to call tools, which is the only kind worth offering a brain that has
 * to press buttons. It is fetched rather than hardcoded because these tiers
 * are retired without notice.
 */
function openRouterMarkup(catalogue, activeModel) {
  if (!catalogue) return "";
  const rows = [];
  rows.push(catalogue.signedIn
    ? '<div class="model-account"><span>Signed in</span><button type="button" class="account-button" data-openrouter="sign-out">Forget key</button></div>'
    : '<div class="model-account"><span>Free models, no API key needed</span><button type="button" class="account-button primary" data-openrouter="sign-in">Sign in with OpenRouter</button></div>');

  if (catalogue.note) {
    rows.push(`<p class="model-note">${escapeHtml(catalogue.note)}</p>`);
  } else if (catalogue.models && catalogue.models.length) {
    const options = catalogue.models.map((m) => {
      const ctx = m.contextLength ? `${Math.round(m.contextLength / 1000)}k` : "";
      const label = `${m.label}${ctx ? ` · ${ctx}` : ""}`;
      return `<option value="${escapeHtml(m.id)}"${m.id === activeModel ? " selected" : ""}>${escapeHtml(label)}</option>`;
    }).join("");
    rows.push(`<label class="model-picker"><span>${catalogue.models.length} free models that can call tools</span>` +
      `<select data-openrouter-model>${options}</select></label>`);
  }
  return rows.join("");
}

function renderModels(models) {
  const list = byId("model-list");
  if (!models.length) { list.innerHTML = '<div class="empty-state large">No configured models reported.</div>'; return; }
  list.querySelectorAll('.empty-state').forEach(el => el.remove());
  const existing = new Map([...list.children].map(el => [el.dataset.modelId, el]));
  models.forEach((model, index) => {
    const key = stableKey(model);
    let card = existing.get(model.id);
    existing.delete(model.id);
    if (!card || card.modelRenderKey !== key) {
      const template = document.createElement("template");
      template.innerHTML = `<article class="model-card${model.active ? " active" : ""}${model.account ? " has-account" : ""}">
    <span class="model-mark"><svg><use href="#icon-brain"></use></svg></span>
    <div class="model-copy"><header><strong>${escapeHtml(model.label)}</strong><span class="availability${model.available ? "" : " unavailable"}">${model.available ? "Available" : "Unavailable"}</span></header><p>${escapeHtml(model.model)}${model.reason ? ` · ${escapeHtml(model.reason)}` : ""}</p></div>
    <button type="button" data-provider="${escapeHtml(model.id)}" ${model.active || !model.available ? "disabled" : ""}>${model.active ? "In use" : "Use model"}</button>
    ${chatgptAccountMarkup(model.account)}
    ${openRouterMarkup(model.catalogue, model.model)}
  </article>`;
      const replacement = template.content.firstElementChild;
      replacement.dataset.modelId = model.id;
      replacement.modelRenderKey = key;
      if (card) card.replaceWith(replacement);
      card = replacement;
    }
    if (list.children[index] !== card) list.insertBefore(card, list.children[index] || null);
  });
  existing.forEach(card => card.remove());
  if (modelSwitchPending) list.querySelectorAll('[data-provider]').forEach(button => { button.disabled = true; });
}

function connectionDescription(connection) {
  const details = [];
  details.push(connection.tools === null || connection.tools === undefined ? "Tool count unavailable" : plural(connection.tools, "tool"));
  if (connection.lastActivityAt) details.push(`active ${relativeTime(connection.lastActivityAt)}`);
  if (connection.error) details.push(connection.error);
  return details.join(" · ");
}

function renderConnectionSummary(connections) {
  const activeCount = connections.filter((connection) => connection.status === "active").length;
  byId("connection-summary-count").textContent = `${connections.length} configured`;
  byId("connection-health").textContent = activeCount ? `${activeCount} recently active` : `${connections.length} configured`;
  byId("connection-summary").innerHTML = connections.length ? connections.slice(0, 4).map((connection) => `<span class="connection-chip ${escapeHtml(connection.status)}"><i></i><span>${escapeHtml(connection.name)}</span></span>`).join("") : '<span class="summary-empty">No external connections</span>';
}

function renderConnections(connections) {
  byId("connection-list").innerHTML = connections.length ? connections.map((connection) => `<article class="connection-card"><header><strong>${escapeHtml(connection.name)}</strong><span class="connection-status ${escapeHtml(connection.status)}">${escapeHtml(connection.status)}</span></header><p>${escapeHtml(connectionDescription(connection))}</p></article>`).join("") : '<div class="empty-state">No external MCP servers configured.</div>';
  byId("route-connection-list").innerHTML = connections.length ? connections.map((connection) => `<div class="route-connection-row"><strong>${escapeHtml(connection.name)}</strong><span class="connection-status ${escapeHtml(connection.status)}">${escapeHtml(connection.status)}</span></div>`).join("") : '<div class="empty-state">No connections reported</div>';
}

function renderWeather(weather) {
  byId("weather-place").textContent = valueText(weather?.place, weather?.status === "needs-location" ? "Choose a location" : "Weather unavailable");
  byId("weather-temperature").textContent = weather?.temperature === null || weather?.temperature === undefined ? "—°" : `${Math.round(weather.temperature)}°`;
  byId("weather-condition").textContent = valueText(weather?.condition, valueText(weather?.error, "No live observation"));
  byId("weather-feels").textContent = weather?.feelsLike === null || weather?.feelsLike === undefined ? "—" : `${Math.round(weather.feelsLike)}°`;
  byId("weather-humidity").textContent = weather?.humidity === null || weather?.humidity === undefined ? "—" : `${Math.round(weather.humidity)}%`;
  byId("weather-wind").textContent = weather?.wind === null || weather?.wind === undefined ? "—" : `${Math.round(weather.wind)} km/h`;
  const source = weather?.source === "timezone-estimate" ? "TIMEZONE ESTIMATE" : weather?.source === "device" ? "DEVICE LOCATION" : "OPEN-METEO";
  byId("weather-updated").textContent = `${source}${weather?.updatedAt ? ` · ${eventTime(weather.updatedAt)}` : ""}`;
}

async function loadWeather(request) {
  if (!bridge?.weather) return;
  byId("weather-condition").textContent = "Updating live conditions…";
  try {
    renderWeather(await bridge.weather(request));
  } catch (error) {
    renderWeather({ status: "unavailable", error: error?.message || String(error) });
  }
}

document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
document.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", () => act({ type: button.dataset.action })));
byId("mission-select").addEventListener("change", (event) => {
  selectedMissionId = event.target.value;
  expandedMissionTasks.clear();
  renderMissions(Array.isArray(snapshot?.missions) ? snapshot.missions : [], Array.isArray(snapshot?.agents) ? snapshot.agents : []);
});
byId("mission-panel").addEventListener("toggle", (event) => {
  const details = event.target.closest?.("[data-mission-task-key]");
  if (!details || details !== event.target) return;
  if (details.open) expandedMissionTasks.add(details.dataset.missionTaskKey);
  else expandedMissionTasks.delete(details.dataset.missionTaskKey);
}, true);
byId("panel-close").addEventListener("click", () => bridge?.close());
const shutdownDialog = byId("shutdown-dialog");
byId("power-off").addEventListener("click", () => {
  if (typeof shutdownDialog?.showModal === "function") shutdownDialog.showModal();
});
byId("shutdown-confirm").addEventListener("click", async (event) => {
  event.preventDefault();
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = "Closing MCP…";
  const result = await act({ type: "shutdown" });
  if (!result.ok) {
    button.disabled = false;
    button.textContent = "Close MCP & power off";
    shutdownDialog?.close();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") bridge?.close();
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    byId("command-input").focus();
  }
});

byId("refresh-connections").addEventListener("click", async () => {
  const result = await act({ type: "refresh-connections" });
  if (result.ok) bridge?.snapshot?.().then(render).catch(() => {});
});
byId("model-list").addEventListener("click", async (event) => {
  const account = event.target.closest("[data-chatgpt]");
  if (account) {
    const which = account.dataset.chatgpt;
    if (which === "sign-in") notify("Opening ChatGPT in your browser — sign in there and allow Echo to use your plan.");
    account.disabled = which !== "cancel";
    const type = which === "sign-in" ? "chatgpt-sign-in" : which === "sign-out" ? "chatgpt-sign-out" : "chatgpt-cancel-sign-in";
    await act({ type });
    bridge?.snapshot?.().then(render).catch(() => {});
    return;
  }
  const openrouter = event.target.closest("[data-openrouter]");
  if (openrouter) {
    const which = openrouter.dataset.openrouter;
    if (which === "sign-in") notify("Opening OpenRouter in your browser — sign in and approve to create a key.");
    openrouter.disabled = true;
    const result = await act({ type: which === "sign-in" ? "openrouter-sign-in" : "openrouter-sign-out" });
    if (result && result.message) notify(result.message);
    bridge?.snapshot?.().then(render).catch(() => {});
    return;
  }
  const button = event.target.closest("[data-provider]");
  if (!button || button.disabled || modelSwitchPending) return;
  modelSwitchPending = true;
  byId("model-list").querySelectorAll('[data-provider]').forEach(el => { el.disabled = true; });
  button.textContent = "Switching…";
  try {
    await act({ type: "switch-model", provider: button.dataset.provider });
    if (bridge?.snapshot) render(await bridge.snapshot());
  } catch (error) {
    notify(error?.message || String(error), true);
  } finally {
    modelSwitchPending = false;
    delete renderKeys.models;
    // A failed switch must restore the same card's controls too.
    byId("model-list").querySelectorAll('.model-card').forEach(el => { el.modelRenderKey = null; });
    if (snapshot) render(snapshot);
  }
});

byId("model-list").addEventListener("change", async (event) => {
  const picker = event.target.closest("[data-openrouter-model]");
  if (!picker) return;
  const result = await act({ type: "openrouter-set-model", name: picker.value });
  if (result && result.message) notify(result.message);
  bridge?.snapshot?.().then(render).catch(() => {});
});

byId("command-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = byId("command-input");
  const command = input.value.trim();
  if (!command) return;
  const result = await act({ type: "command", text: command });
  if (result.ok) input.value = "";
});

byId("settings-form").addEventListener("input", () => {
  settingsDirty = true;
  byId("settings-save-state").textContent = "Unsaved changes";
  byId("settings-save-state").classList.add("dirty");
});
byId("settings-reset").addEventListener("click", () => {
  settingsDirty = false;
  renderSettings(snapshot?.settings, true);
  notify("Unsaved settings restored.");
});
byId("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) return;
  const saveButton = byId("settings-save");
  saveButton.disabled = true;
  saveButton.textContent = "Saving…";
  const result = await act({ type: "save-settings", settings: settingsPayload() });
  saveButton.disabled = false;
  saveButton.textContent = "Save settings";
  if (!result.ok) return;
  settingsDirty = false;
  try {
    render(await bridge.snapshot());
  } catch (error) {
    notify(error?.message || String(error), true);
  }
});

// ---- API keys -----------------------------------------------------------------
//
// Keys are fetched and shown only when this dialog is actually opened — never
// part of the continuous control:update snapshot — and even then only WHICH
// keys are set, never their content (see keystore.ts's keyStatus/saveKeys).
// A blank field on save means "leave it as it is"; typing a new value is the
// only way to change one.
const apiKeysDialog = byId("api-keys-dialog");
let apiKeysLoaded = false;

function apiKeyRow(field, isSet) {
  const id = `api-key-${field.env}`;
  return `<div class="api-key-row">
    <label for="${id}"><strong>${escapeHtml(field.label)}</strong><small>${escapeHtml(field.help)}</small></label>
    <div class="api-key-input-group">
      <input id="${id}" name="${escapeHtml(field.env)}" type="password" autocomplete="off" spellcheck="false"
        placeholder="${isSet ? "•••••••• saved — leave blank to keep" : "Not set — paste a key to add one"}" />
      <button type="button" class="api-key-reveal" data-target="${id}" aria-label="Show or hide">Show</button>
    </div>
    <div class="api-key-meta">
      <span class="api-key-status ${isSet ? "set" : ""}">${isSet ? "Saved" : "Not set"}</span>
      ${field.url ? `<a href="${escapeHtml(field.url)}" class="api-key-link" data-external-url="${escapeHtml(field.url)}">Get a key</a>` : ""}
    </div>
  </div>`;
}

async function loadApiKeys() {
  const list = byId("api-keys-list");
  if (!bridge?.apiKeys) {
    list.innerHTML = '<div class="empty-state">The control bridge is unavailable.</div>';
    return;
  }
  try {
    const { fields, status, path } = await bridge.apiKeys();
    byId("api-keys-path").textContent = path || "~/.jarvis/keys.env";
    list.innerHTML = fields.length
      ? fields.map((f) => apiKeyRow(f, !!status[f.env])).join("")
      : '<div class="empty-state">No API keys are configured for this build.</div>';
    apiKeysLoaded = true;
  } catch (error) {
    list.innerHTML = `<div class="empty-state">Could not load API keys: ${escapeHtml(error?.message || String(error))}</div>`;
  }
}

byId("open-api-keys")?.addEventListener("click", () => {
  if (typeof apiKeysDialog?.showModal === "function") apiKeysDialog.showModal();
  if (!apiKeysLoaded) loadApiKeys();
});
byId("api-keys-close").addEventListener("click", () => apiKeysDialog?.close());
apiKeysDialog?.addEventListener("cancel", () => {}); // Escape closes it natively; nothing extra to do
apiKeysDialog?.addEventListener("click", (event) => {
  const link = event.target.closest?.("[data-external-url]");
  if (!link) return;
  event.preventDefault();
  bridge?.openExternal?.(link.dataset.externalUrl);
});
byId("api-keys-list").addEventListener("click", (event) => {
  const button = event.target.closest?.(".api-key-reveal");
  if (!button) return;
  const input = byId(button.dataset.target);
  if (!input) return;
  const showing = input.type === "text";
  input.type = showing ? "password" : "text";
  button.textContent = showing ? "Show" : "Hide";
});
byId("api-keys-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const inputs = [...byId("api-keys-list").querySelectorAll("input[name]")];
  const apiKeys = Object.fromEntries(inputs.map((input) => [input.name, input.value]).filter(([, v]) => v.trim()));
  const feedback = byId("api-keys-feedback");
  const saveButton = byId("api-keys-save");
  saveButton.disabled = true;
  saveButton.textContent = "Saving…";
  const result = await act({ type: "save-api-keys", apiKeys });
  saveButton.disabled = false;
  saveButton.textContent = "Save keys";
  feedback.textContent = result.message || (result.ok ? "Saved." : "Could not save.");
  feedback.classList.toggle("error", !result.ok);
  if (result.ok) {
    inputs.forEach((input) => (input.value = ""));
    apiKeysLoaded = false;
    await loadApiKeys(); // refresh which fields now show as "Saved"
  }
});

// ---- Agent board + fleet (ported from Aira's agent canvas / agent-editor) ------
//
// The board is a thin client over frontier/swarm.ts's existing mission model:
// "run-board" submits one flat mission (no dependencies) with one task per
// selected fleet member, and everything below just renders whatever comes
// back through the ordinary control:update snapshot — there is no separate
// board state on the main-process side to fall out of sync with.
let fleetMembers = [];
let grantableToolNames = [];
let fleetMaxCustom = 6;
let fleetRevision = 0; // bumped on every fleet change; feeds the board's own dirty-check
let selectedAgentIds = new Set();
let openBoardCards = new Set();
/** Which mission the board is currently showing. Sticky across renders so a
 *  finished board's answer does not vanish the moment something else on the
 *  panel updates. */
let currentBoardMissionId = null;

const ROLE_ICON = { lead: "icon-crown", research: "icon-bars", plan: "icon-layers", write: "icon-file", review: "icon-scale", analyse: "icon-gauge" };
const ROLE_COLOUR = {
  lead: { light: "#ffc861", deep: "#c06a04" },
  research: { light: "#5fd0c8", deep: "#0b6f6a" },
  plan: { light: "#a996f5", deep: "#4f2fb0" },
  write: { light: "#f2a0c0", deep: "#a33668" },
  review: { light: "#74d495", deep: "#176f45" },
  analyse: { light: "#7fb6f0", deep: "#1f56a8" },
};
const DEFAULT_COLOUR = { light: "#9fb7bd", deep: "#31515a" };
const PHASE_LABEL = { idle: "Ready", working: "Working", done: "Complete", error: "Failed", stopped: "Stopped" };

/** Escaped plain text, not real markdown — an agent's report is untrusted-ish
 *  text from a model, and a hand-rolled markdown-to-HTML parser is exactly
 *  the kind of code worth not writing when "readable" is all that's needed. */
function renderPlainText(text) {
  return escapeHtml(text).split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("");
}

function phaseOf(task) {
  if (!task) return "idle";
  if (task.status === "working") return "working";
  if (task.status === "completed" || task.status === "partial") return "done";
  if (task.status === "failed" || task.status === "blocked") return "error";
  if (task.status === "cancelled") return "stopped";
  return "idle";
}

async function loadFleet() {
  if (!bridge?.fleet) return;
  try {
    const result = await bridge.fleet();
    fleetMembers = result.members || [];
    grantableToolNames = result.grantableTools || [];
    fleetMaxCustom = result.maxCustom || 6;
    // Default to the whole team, the first time only — a change here later
    // must never silently re-select everyone out from under the user.
    if (!loadFleet.everLoaded) fleetMembers.forEach((m) => selectedAgentIds.add(m.id));
    loadFleet.everLoaded = true;
    fleetRevision++;
    renderFleetDialog();
    renderBoard(Array.isArray(snapshot?.missions) ? snapshot.missions : []);
  } catch (error) {
    console.error("could not load the agent fleet", error);
  }
}

function boardMissionFor(missions) {
  const boards = missions.filter((m) => m.id.startsWith("board-") || m.id.startsWith("solo-"));
  if (currentBoardMissionId) {
    const found = boards.find((m) => m.id === currentBoardMissionId);
    if (found) return found;
  }
  return boards.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0] || null;
}

function agentCardMarkup(member, task, liveProgress) {
  const phase = phaseOf(task);
  const colour = ROLE_COLOUR[member.id] || DEFAULT_COLOUR;
  const icon = ROLE_ICON[member.id] || "icon-agent";
  const selected = selectedAgentIds.has(member.id);
  const open = openBoardCards.has(member.id);

  const artifactText = (task?.result?.artifacts || []).filter((a) => a.kind === "text" && a.value).map((a) => a.value).join("\n\n");
  const fullText = [task?.result?.summary, artifactText].filter(Boolean).join("\n\n");
  const words = fullText ? fullText.trim().split(/\s+/).length : 0;
  const lines = fullText.trim().split("\n").filter(Boolean);
  const preview = (lines.find((l) => !/^#{1,6}\s/.test(l)) || lines[0] || "").replace(/^[#>*\-\s]+/, "").slice(0, 150);

  const startedAt = task?.startedAt;
  const endedAt = task?.result?.completedAt ? new Date(task.result.completedAt).getTime() : null;
  const elapsed = startedAt ? Math.max(0, ((phase === "working" ? Date.now() : endedAt || Date.now()) - startedAt) / 1000) : 0;
  const elapsedLabel = elapsed ? (elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${Math.round(elapsed % 60)}s` : `${elapsed.toFixed(1)}s`) : "—";
  const errored = task?.result?.status === "failed" || task?.result?.status === "blocked";
  const errorMsg = errored ? (task.result.summary || (task.result.blockers || []).join(", ") || "Failed") : "";
  const progress = phase === "working" ? liveProgress.get(member.name) : "";

  return `<article class="board-agent-card ${phase}${selected ? " selected" : ""}" data-agent-id="${escapeHtml(member.id)}"
      style="--card-light:${colour.light};--card-deep:${colour.deep}">
    <div class="board-agent-card-top">
      <span class="board-agent-card-glyph"><svg><use href="#${icon}" /></svg></span>
      <span class="board-agent-card-state"><i></i>${PHASE_LABEL[phase]}</span>
    </div>
    <h3>${escapeHtml(member.name)}</h3>
    <p class="board-agent-card-role">${escapeHtml(member.description || (member.brief || "").split("\n")[0] || "")}</p>
    <label class="board-agent-card-select">
      <input type="checkbox" data-select-agent="${escapeHtml(member.id)}" ${selected ? "checked" : ""} />
      ${selected ? "Gets the next task" : "Not in the next task"}
    </label>
    <dl class="board-agent-card-metrics">
      <div><dt><svg><use href="#icon-clock" /></svg>Time</dt><dd>${elapsedLabel}</dd></div>
      <div><dt><svg><use href="#icon-file" /></svg>Words</dt><dd>${words || "—"}</dd></div>
    </dl>
    ${progress ? `<p class="board-agent-card-preview">${escapeHtml(progress)}</p>` : ""}
    ${errorMsg ? `<p class="board-agent-card-error">${escapeHtml(errorMsg)}</p>` : ""}
    ${fullText ? `
      ${open ? `<div class="board-agent-card-output">${renderPlainText(fullText)}</div>` : `<p class="board-agent-card-preview">${escapeHtml(preview)}</p>`}
      <button type="button" class="board-agent-card-toggle" data-toggle-agent="${escapeHtml(member.id)}">${open ? "Hide answer" : `Read answer · ${words} words`}<svg><use href="#icon-chevron" /></svg></button>
    ` : ""}
    <form class="board-agent-card-compose" data-agent-compose="${escapeHtml(member.id)}">
      <input type="text" placeholder="${phase === "working" ? `Queue another for ${escapeHtml(member.name)}…` : `Ask ${escapeHtml(member.name)} directly…`}" aria-label="Task for ${escapeHtml(member.name)}" />
      ${phase === "working"
        ? `<button type="button" data-stop-agent="${escapeHtml(member.id)}" aria-label="Stop ${escapeHtml(member.name)}"><svg><use href="#icon-stop" /></svg></button>`
        : `<button type="submit" aria-label="Send to ${escapeHtml(member.name)}"><svg><use href="#icon-send" /></svg></button>`}
    </form>
  </article>`;
}

function renderBoard(missions) {
  if (!fleetMembers.length) return; // nothing to draw yet — loadFleet() will call back in
  const mission = boardMissionFor(missions);
  if (mission) currentBoardMissionId = mission.id;
  const liveProgress = new Map((Array.isArray(snapshot?.agents) ? snapshot.agents : []).map((a) => [a.name, a.progress]));

  const half = Math.ceil(fleetMembers.length / 2);
  const left = fleetMembers.slice(0, half);
  const right = fleetMembers.slice(half);
  const taskOf = (id) => mission?.tasks?.[id] || null;
  byId("board-column-left").innerHTML = left.map((m) => agentCardMarkup(m, taskOf(m.id), liveProgress)).join("");
  byId("board-column-right").innerHTML = right.map((m) => agentCardMarkup(m, taskOf(m.id), liveProgress)).join("");

  const busy = mission?.status === "running";
  byId("board-run").hidden = busy;
  byId("board-stop").hidden = !busy;

  const leadTask = mission ? taskOf("lead") : null;
  const leadDone = leadTask && (leadTask.status === "completed" || leadTask.status === "partial") && leadTask.result?.summary;
  byId("board-answer").hidden = !leadDone;
  byId("board-task").hidden = !!leadDone;
  if (leadDone) {
    byId("board-answer-goal").textContent = mission.goal;
    byId("board-answer-text").innerHTML = renderPlainText(leadTask.result.summary);
  }

  const statusEl = byId("board-status-text");
  if (!mission) statusEl.textContent = "Ready when you are.";
  else if (busy) {
    const working = fleetMembers.filter((m) => phaseOf(taskOf(m.id)) === "working").map((m) => m.name);
    statusEl.textContent = working.length ? `${working.join(", ")} working…` : "Starting…";
  } else {
    statusEl.textContent = "Finished.";
  }
  statusEl.closest(".board-task-status").classList.toggle("live", busy);
}

function boardColumns() {
  return [byId("board-column-left"), byId("board-column-right")];
}
for (const col of boardColumns()) {
  col.addEventListener("click", (event) => {
    const toggle = event.target.closest("[data-toggle-agent]");
    if (toggle) {
      const id = toggle.dataset.toggleAgent;
      if (openBoardCards.has(id)) openBoardCards.delete(id); else openBoardCards.add(id);
      renderBoard(Array.isArray(snapshot?.missions) ? snapshot.missions : []);
      return;
    }
    const stop = event.target.closest("[data-stop-agent]");
    if (stop && currentBoardMissionId) void act({ type: "stop-mission-task", missionId: currentBoardMissionId, name: stop.dataset.stopAgent });
  });
  col.addEventListener("change", (event) => {
    const checkbox = event.target.closest("[data-select-agent]");
    if (!checkbox) return;
    const id = checkbox.dataset.selectAgent;
    if (checkbox.checked) selectedAgentIds.add(id); else selectedAgentIds.delete(id);
    renderBoard(Array.isArray(snapshot?.missions) ? snapshot.missions : []);
  });
  col.addEventListener("submit", (event) => {
    const form = event.target.closest("[data-agent-compose]");
    if (!form) return;
    event.preventDefault();
    const input = form.querySelector("input");
    const text = input.value.trim();
    if (!text) return;
    void act({ type: "run-fleet-agent", name: form.dataset.agentCompose, goal: text }).then((result) => {
      if (!result.ok) return;
      input.value = "";
      if (result.data?.missionId) currentBoardMissionId = result.data.missionId;
    });
  });
}

byId("board-select-all").addEventListener("click", () => {
  fleetMembers.forEach((m) => selectedAgentIds.add(m.id));
  renderBoard(Array.isArray(snapshot?.missions) ? snapshot.missions : []);
});
byId("board-toggle-output").addEventListener("click", () => {
  openBoardCards = openBoardCards.size ? new Set() : new Set(fleetMembers.map((m) => m.id));
  renderBoard(Array.isArray(snapshot?.missions) ? snapshot.missions : []);
});
byId("board-run").addEventListener("click", () => {
  const text = byId("board-task").value.trim();
  if (!text) return;
  if (!selectedAgentIds.size) return notify("Select at least one agent for the board.", true);
  void act({ type: "run-board", goal: text, agentIds: [...selectedAgentIds] }).then((result) => {
    if (!result.ok) return;
    if (result.data?.missionId) currentBoardMissionId = result.data.missionId;
    renderBoard(Array.isArray(snapshot?.missions) ? snapshot.missions : []);
  });
});
byId("board-task").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); byId("board-run").click(); }
});
byId("board-stop").addEventListener("click", () => {
  if (currentBoardMissionId) void act({ type: "stop-mission", missionId: currentBoardMissionId });
});
byId("board-clear").addEventListener("click", () => {
  currentBoardMissionId = null;
  byId("board-task").value = "";
  openBoardCards.clear();
  renderBoard(Array.isArray(snapshot?.missions) ? snapshot.missions : []);
});

document.querySelectorAll(".ops-tab").forEach((tab) => tab.addEventListener("click", () => {
  const view = tab.dataset.opsView;
  document.querySelectorAll(".ops-tab").forEach((t) => { t.classList.toggle("active", t === tab); t.setAttribute("aria-selected", String(t === tab)); });
  document.querySelectorAll("[data-ops-panel]").forEach((panel) => { panel.hidden = panel.dataset.opsPanel !== view; });
}));

// Zoom the agent board and mission list in/out. Uses the `zoom` CSS property
// (Chromium-only, which Electron always is) rather than transform: scale() —
// it reflows layout at the new size instead of just stretching pixels, and
// both zoomed panels already scroll (overflow: auto) so zooming in past the
// window's fixed, non-resizable bounds degrades to a scrollbar, not a clip.
const AGENTS_ZOOM_MIN = 0.7;
const AGENTS_ZOOM_MAX = 1.5;
const AGENTS_ZOOM_STEP = 0.1;
let agentsZoom = 1;
try { agentsZoom = parseFloat(localStorage.getItem("echo-agents-zoom")) || 1; } catch {}

function applyAgentsZoom() {
  agentsZoom = Math.round(Math.min(AGENTS_ZOOM_MAX, Math.max(AGENTS_ZOOM_MIN, agentsZoom)) * 100) / 100;
  const stage = document.querySelector(".board-stage");
  const missionPanel = byId("mission-panel");
  if (stage) stage.style.zoom = String(agentsZoom);
  if (missionPanel) missionPanel.style.zoom = String(agentsZoom);
  byId("agents-zoom-level").textContent = `${Math.round(agentsZoom * 100)}%`;
  byId("agents-zoom-out").disabled = agentsZoom <= AGENTS_ZOOM_MIN;
  byId("agents-zoom-in").disabled = agentsZoom >= AGENTS_ZOOM_MAX;
  try { localStorage.setItem("echo-agents-zoom", String(agentsZoom)); } catch {}
}
byId("agents-zoom-in").addEventListener("click", () => { agentsZoom += AGENTS_ZOOM_STEP; applyAgentsZoom(); });
byId("agents-zoom-out").addEventListener("click", () => { agentsZoom -= AGENTS_ZOOM_STEP; applyAgentsZoom(); });
applyAgentsZoom();

// ---- Fleet editor dialog (ported from Aira's agent-editor.tsx) -----------------
const fleetDialog = byId("fleet-dialog");
let fleetIdTouched = false;
const slugify = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
/** Sensible defaults for a brand-new agent: it can look things up, not just guess. */
const DEFAULT_GRANTS = new Set(["recall", "read_local_file", "list_ui_elements", "search_my_past"]);

function fleetItemMarkup(member, isCustom) {
  const icon = !isCustom ? `<svg><use href="#${ROLE_ICON[member.id] || "icon-agent"}" /></svg>` : "";
  return `<div class="fleet-item">
    <div class="fleet-item-body">
      <strong>${icon}${escapeHtml(member.name)}</strong>
      <span class="fleet-item-meta">${escapeHtml(member.id)} · ${escapeHtml(member.tier)}</span>
      <span class="fleet-item-desc">${escapeHtml(member.description || (member.brief || "").split("\n")[0] || "")}</span>
      ${isCustom ? `<span class="fleet-item-tools">${member.tools.length ? escapeHtml(member.tools.join(" · ")) : "no tools"}</span>` : ""}
    </div>
    ${isCustom ? `<button type="button" class="fleet-drop" data-remove-agent="${escapeHtml(member.id)}" aria-label="Remove ${escapeHtml(member.name)}"><svg><use href="#icon-trash" /></svg></button>` : ""}
  </div>`;
}

function renderFleetDialog() {
  const mine = fleetMembers.filter((m) => m.custom);
  const theirs = fleetMembers.filter((m) => !m.custom);
  byId("fleet-mine").innerHTML = mine.length
    ? mine.map((m) => fleetItemMarkup(m, true)).join("")
    : '<p class="fleet-empty">None yet. An agent is a name, a brief, and the tools it is allowed to use.</p>';
  byId("fleet-theirs").innerHTML = theirs.map((m) => fleetItemMarkup(m, false)).join("");
  const full = mine.length >= fleetMaxCustom;
  const addButton = byId("fleet-add-open");
  addButton.disabled = full;
  addButton.title = full ? `You can have up to ${fleetMaxCustom} of your own agents.` : "";
  addButton.querySelector("span").textContent = full ? `Limit reached (${fleetMaxCustom})` : "Add an agent";
}

function openFleetForm() {
  byId("fleet-browse").hidden = true;
  byId("fleet-form").hidden = false;
  byId("fleet-form").reset();
  fleetIdTouched = false;
  byId("fleet-tools").innerHTML = grantableToolNames
    .map((tool) => `<label><input type="checkbox" value="${escapeHtml(tool)}" ${DEFAULT_GRANTS.has(tool) ? "checked" : ""} />${escapeHtml(tool)}</label>`)
    .join("");
  byId("fleet-error").hidden = true;
  byId("fleet-name").focus();
}
function closeFleetForm() {
  byId("fleet-browse").hidden = false;
  byId("fleet-form").hidden = true;
}

byId("board-manage").addEventListener("click", () => {
  closeFleetForm();
  if (typeof fleetDialog?.showModal === "function") fleetDialog.showModal();
  if (!fleetMembers.length) void loadFleet();
});
byId("fleet-close").addEventListener("click", () => fleetDialog?.close());
byId("fleet-add-open").addEventListener("click", openFleetForm);
byId("fleet-cancel").addEventListener("click", closeFleetForm);
byId("fleet-id").addEventListener("input", () => { fleetIdTouched = true; });
byId("fleet-name").addEventListener("input", (event) => {
  if (!fleetIdTouched) byId("fleet-id").value = slugify(event.target.value);
});
byId("fleet-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const agent = {
    id: byId("fleet-id").value.trim(),
    name: byId("fleet-name").value.trim(),
    description: byId("fleet-description").value.trim(),
    brief: byId("fleet-brief").value.trim(),
    tier: byId("fleet-tier").value,
    tools: [...byId("fleet-tools").querySelectorAll("input:checked")].map((input) => input.value),
  };
  const saveButton = byId("fleet-save");
  const errorEl = byId("fleet-error");
  saveButton.disabled = true;
  const result = await act({ type: "save-agent", agent });
  saveButton.disabled = false;
  if (!result.ok) {
    errorEl.hidden = false;
    errorEl.textContent = result.message || "Could not save the agent.";
    return;
  }
  closeFleetForm();
  await loadFleet();
});
byId("fleet-mine").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-remove-agent]");
  if (!button) return;
  const result = await act({ type: "remove-agent", name: button.dataset.removeAgent });
  if (!result.ok) {
    const errorEl = byId("fleet-error");
    errorEl.hidden = false;
    errorEl.textContent = result.message || "Could not remove the agent.";
    return;
  }
  selectedAgentIds.delete(button.dataset.removeAgent);
  await loadFleet();
});

byId("weather-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const query = byId("weather-query").value.trim();
  if (query) loadWeather({ query });
});
byId("weather-locate").addEventListener("click", () => {
  if (!navigator.geolocation) return notify("Device location is unavailable. Search for a city instead.", true);
  navigator.geolocation.getCurrentPosition(
    (position) => loadWeather({ latitude: position.coords.latitude, longitude: position.coords.longitude }),
    () => notify("Location access was not granted. Search for a city instead.", true),
    { enableHighAccuracy: false, timeout: 7000, maximumAge: 600000 },
  );
});

function tick() {
  byId("clock").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  if (snapshot?.analytics) {
    snapshot.analytics.uptimeSeconds = Math.max(snapshot.analytics.uptimeSeconds || 0, Math.floor((Date.now() - snapshot.sessionStartedAt) / 1000));
    byId("metric-uptime").textContent = duration(snapshot.analytics.uptimeSeconds);
  }
}
setInterval(tick, 1000);
tick();
setView(activeView);

// Diagnostic for the "the panel got slow" reports — see the matching
// control:perf handler in control-panel.ts for why this exists alongside
// the main process's own event-loop check. A dropped frame here means the
// compositor missed a paint, whether the cause is this window's own JS,
// a GC pause, or GPU contention from another window (Osiris's WebGL globe
// is the prime suspect). Throttled hard: report at most once every 2s while
// it's happening, since the point is "is this happening at all right now",
// not a full frame-by-frame trace. Remove once the cause is found.
if (bridge?.perf) {
  let lastFrameAt = performance.now();
  let lastReportAt = 0;
  const watchFrames = () => {
    const now = performance.now();
    const delta = now - lastFrameAt;
    lastFrameAt = now;
    // A steady 60Hz frame is ~16.7ms; only a frame late enough to be visibly
    // janky (well past 2 frames' worth) is worth a report at all.
    if (delta > 50 && now - lastReportAt > 2000) {
      lastReportAt = now;
      try { bridge.perf({ droppedMs: delta }); } catch { /* diagnostic only */ }
    }
    requestAnimationFrame(watchFrames);
  };
  requestAnimationFrame(watchFrames);
}

if (bridge) {
  bridge.snapshot().then(render).catch((error) => notify(error?.message || String(error), true));
  void loadFleet();
  bridge.onUpdate?.(render);
  bridge.onState?.((state) => {
    snapshot = { ...(snapshot || {}), state: { ...(snapshot?.state || {}), ...state } };
    renderState(snapshot.state);
  });
  bridge.onLevel?.((level) => {
    const now = performance.now();
    const wait = document.body.dataset.renderMode === "idle" ? 5000 : 80;
    if (now - lastLevelPaintAt < wait) return;
    lastLevelPaintAt = now;
    document.documentElement.style.setProperty("--level", String(Number(level) || 0));
    if (neuralCard) neuralCard.setLevel(Number(level) || 0);
  });
  loadWeather();
  // Built well off the critical path. The panel's own bootstrap costs ~100ms of
  // worst-case frame time; starting the field on top of that is what turns two
  // dropped frames into four. Let the panel settle first, then build in idle
  // slices — measured after this: zero dropped frames from the field.
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 400));
  setTimeout(() => idle(() => buildNeuralCard(), { timeout: 4000 }), 1500);
} else {
  notify("The control panel bridge did not load.", true);
}

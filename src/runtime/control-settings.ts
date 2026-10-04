import type {JarvisConfig} from "../config.js";
import type {ControlSettings} from "../control-panel.js";
import {PROVIDERS} from "../brain/switching.js";

export function controlSettingsFor(cfg: JarvisConfig, configPath: string): ControlSettings {
  return {
    brain: cfg.brain,
    voice: {
      ttsEnabled: cfg.voice.ttsEnabled,
      wakeWord: cfg.voice.wakeWord,
      conversationMode: cfg.voice.conversationMode,
      bargeIn: cfg.voice.bargeIn,
      sttStreaming: cfg.voice.sttStreaming !== false,
      ttsStreaming: cfg.voice.ttsStreaming !== false,
      sendAudioToBrain: cfg.voice.sendAudioToBrain === true,
      sttProvider: cfg.voice.sttProvider ?? "whisper",
      sttLanguage: cfg.voice.sttLanguage ?? "en",
      ttsEngine: cfg.voice.ttsEngine ?? "mac",
      vibeVoiceUrl: cfg.voice.vibeVoiceUrl ?? "",
      vibeVoiceSpeaker: cfg.voice.vibeVoiceSpeaker ?? "Carter",
      maxSpokenSentences: cfg.voice.maxSpokenSentences ?? 6,
      conversationWindowMs: cfg.voice.conversationWindowMs ?? 12000,
    },
    hud: { startListeningOnLaunch: cfg.hud.startListeningOnLaunch },
    memory: {
      enabled: cfg.memory.enabled,
      cloudRecall: cfg.memory.cloudRecall,
      retentionDays: cfg.memory.retentionDays,
    },
    helpers: {
      shadow: cfg.helpers.shadow,
      ghost: cfg.helpers.ghost,
      autoDebug: cfg.helpers.autoDebug,
      shadowIntervalSeconds: cfg.helpers.shadowIntervalSeconds,
    },
    dreaming: { enabled: cfg.dreaming.enabled },
    learning: {
      enabled: cfg.learning.enabled,
      captureScreens: cfg.learning.captureScreens,
      maxStepsPerTurn: cfg.learning.maxStepsPerTurn,
    },
    configPath,
  };
}

export function normalizeControlSettings(current: ControlSettings, input: Partial<ControlSettings> | undefined): ControlSettings {
  const configPath = current.configPath;
  const boolean = (value: unknown, fallback: boolean) => typeof value === "boolean" ? value : fallback;
  const number = (value: unknown, fallback: number, min: number, max: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : fallback;
  };
  const choice = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
    allowed.includes(value as T) ? value as T : fallback;
  const language = String(input?.voice?.sttLanguage ?? current.voice.sttLanguage).trim().toLowerCase();
  return {
    brain: choice(input?.brain, PROVIDERS, current.brain),
    voice: {
      ttsEnabled: boolean(input?.voice?.ttsEnabled, current.voice.ttsEnabled),
      wakeWord: boolean(input?.voice?.wakeWord, current.voice.wakeWord),
      conversationMode: boolean(input?.voice?.conversationMode, current.voice.conversationMode),
      bargeIn: boolean(input?.voice?.bargeIn, current.voice.bargeIn),
      sttStreaming: boolean(input?.voice?.sttStreaming, current.voice.sttStreaming),
      ttsStreaming: boolean(input?.voice?.ttsStreaming, current.voice.ttsStreaming),
      sendAudioToBrain: boolean(input?.voice?.sendAudioToBrain, current.voice.sendAudioToBrain),
      sttProvider: choice(input?.voice?.sttProvider, ["whisper", "sarvam", "apple"] as const, current.voice.sttProvider),
      sttLanguage: /^[a-z]{2,3}(?:-[a-z]{2,4})?$/.test(language) || language === "auto" ? language : current.voice.sttLanguage,
      ttsEngine: choice(input?.voice?.ttsEngine, ["mac", "fakeyou", "elevenlabs", "sarvam", "gemini", "piper", "vibevoice"] as const, current.voice.ttsEngine),
      vibeVoiceUrl: typeof input?.voice?.vibeVoiceUrl === "string" ? input.voice.vibeVoiceUrl.trim() : current.voice.vibeVoiceUrl,
      vibeVoiceSpeaker: typeof input?.voice?.vibeVoiceSpeaker === "string" ? input.voice.vibeVoiceSpeaker.trim() || "Carter" : current.voice.vibeVoiceSpeaker,
      maxSpokenSentences: number(input?.voice?.maxSpokenSentences, current.voice.maxSpokenSentences, 0, 50),
      conversationWindowMs: number(input?.voice?.conversationWindowMs, current.voice.conversationWindowMs, 2000, 60000),
    },
    hud: { startListeningOnLaunch: boolean(input?.hud?.startListeningOnLaunch, current.hud.startListeningOnLaunch) },
    memory: {
      enabled: boolean(input?.memory?.enabled, current.memory.enabled),
      cloudRecall: boolean(input?.memory?.cloudRecall, current.memory.cloudRecall),
      retentionDays: number(input?.memory?.retentionDays, current.memory.retentionDays, 0, 3650),
    },
    helpers: {
      shadow: boolean(input?.helpers?.shadow, current.helpers.shadow),
      ghost: boolean(input?.helpers?.ghost, current.helpers.ghost),
      autoDebug: boolean(input?.helpers?.autoDebug, current.helpers.autoDebug),
      shadowIntervalSeconds: number(input?.helpers?.shadowIntervalSeconds, current.helpers.shadowIntervalSeconds, 15, 3600),
    },
    dreaming: { enabled: boolean(input?.dreaming?.enabled, current.dreaming.enabled) },
    learning: {
      enabled: boolean(input?.learning?.enabled, current.learning.enabled),
      captureScreens: boolean(input?.learning?.captureScreens, current.learning.captureScreens),
      maxStepsPerTurn: number(input?.learning?.maxStepsPerTurn, current.learning.maxStepsPerTurn, 0, 1000),
    },
    configPath,
  };
}


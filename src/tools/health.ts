import { existsSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { activeConfig } from "../config.js";
import { getAppPath } from "../utils/appPath.js";
import { dataRoot } from "../memory/paths.js";

/** Where each health check is appended — the user's data folder, never the app. */
export const healthRecordPath = () => join(dataRoot(), "health_record.txt");

function checkBinary(name: string): string | null {
  // Resolved against the app, not the process's working directory: in an
  // installed app that is "/", so every binary was reported missing.
  const binPath = join(getAppPath(), "native", name);
  if (!existsSync(binPath)) {
    return `Missing native binary: native/${name}. It might have failed to compile or was deleted.`;
  }
  return null;
}

export async function check_health(): Promise<{ text: string }> {
  const issues: string[] = [];
  // The live config, not one re-read from the working directory — that read
  // the defaults in an installed app and checked a brain the user isn't using.
  const config = activeConfig(getAppPath());

  // Check native binaries
  const binaries = ["axhelper", "facetracker", "visionhelper", "sonar", "textextract"];
  for (const bin of binaries) {
    const err = checkBinary(bin);
    if (err) issues.push(err);
  }

  // Check Ollama if active. Asked over HTTP and a child process, never with
  // execSync: this runs in Electron's main process, where a blocking call
  // freezes the HUD and the microphone until it returns.
  if (config.brain === "ollama") {
    const host = (config.ollama?.host ?? "http://localhost:11434").replace(/\/$/, "");
    const model = config.ollama?.model || "llama3.2:3b";
    try {
      const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(3000) });
      const body: any = await res.json();
      const names: string[] = (body?.models ?? []).map((m: any) => String(m?.name ?? ""));
      if (!names.some((n) => n === model || n === `${model}:latest`)) {
        issues.push(`Configured Ollama model '${model}' is not installed. Needs: ollama pull ${model}`);
      }
    } catch {
      issues.push("Ollama is not running. It needs to be started via 'brew services start ollama' or the Ollama app.");
    }
  }

  // Check Gemini API Key if active
  if (config.brain === "gemini") {
    const envKey = config.gemini?.apiKeyEnv || "GEMINI_API_KEY";
    if (!process.env[envKey]) {
      issues.push(`Gemini API key is missing. The environment variable ${envKey} must be set.`);
    }
  }

  // Check OpenAI API Key if active
  if (config.brain === "openai") {
    const envKey = config.openai?.apiKeyEnv || "OPENAI_API_KEY";
    if (!process.env[envKey]) {
      issues.push(`OpenAI API key is missing. The environment variable ${envKey} must be set.`);
    }
  }

  // Write to log
  const timestamp = new Date().toISOString();
  let logEntry = `[${timestamp}] Health Check Run\n`;
  if (issues.length === 0) {
    logEntry += "Result: ALL SYSTEMS OPERATIONAL\n\n";
  } else {
    logEntry += "Result: ISSUES DETECTED\n";
    issues.forEach(issue => logEntry += `- ${issue}\n`);
    logEntry += "\n";
  }
  
  try {
    mkdirSync(dataRoot(), { recursive: true });
    appendFileSync(healthRecordPath(), logEntry);
  } catch (err: any) {
    console.error("[health] could not write the health record:", err?.message ?? err);
  }

  if (issues.length === 0) {
    return { text: "Health check complete. All features are running well with no errors or inconsistencies found. A clean record has been saved to health_record.txt in my data folder." };
  } else {
    return { text: `Health check complete. I found ${issues.length} problem(s):\n${issues.map(i => "- " + i).join("\n")}\n\nI have recorded these in health_record.txt in my data folder. Let me know if you would like me to fix these issues.` };
  }
}

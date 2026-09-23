/**
 * Every tool Echo can call, one file per area under ./registry/. This file
 * only defines the tool shape and assembles the list.
 */
import { ZodTypeAny } from "zod";
import type { ToolResultMetadata } from "../memory/tool-result.js";
import * as act from "./computer-actions.js";
import { SCREEN_TOOLS } from "./registry/screen.js";
import { MEMORY_TOOLS } from "./registry/memory.js";
import { SAFETY_TOOLS } from "./registry/safety.js";
import { AGENT_TOOLS } from "./registry/agents.js";
import { SKILL_TOOLS } from "./registry/skills.js";
import { REMOTE_TOOLS } from "./registry/remote.js";
import { KNOWLEDGE_TOOLS } from "./registry/knowledge.js";
import { SYSTEM_TOOLS } from "./registry/system.js";
import { AMBIENT_TOOLS } from "./registry/ambient.js";

/** Neutral result a tool handler returns; each brain adapts it to its own wire shape. */
export interface ToolOutput extends ToolResultMetadata {
  text?: string;
  image?: act.Screenshot;
}

export interface ToolDef {
  name: string;
  description: string;
  /** Zod raw shape (map of field -> validator). Empty object for no-arg tools. */
  schema: Record<string, ZodTypeAny>;
  readOnly: boolean;
  handler: (args: any) => Promise<ToolOutput>;
}

export const TOOLS: ToolDef[] = [
  ...SCREEN_TOOLS,
  ...MEMORY_TOOLS,
  ...SAFETY_TOOLS,
  ...AGENT_TOOLS,
  ...SKILL_TOOLS,
  ...REMOTE_TOOLS,
  ...KNOWLEDGE_TOOLS,
  ...SYSTEM_TOOLS,
  ...AMBIENT_TOOLS,
];

/**
 * Name -> tool, for the loops that dispatch by name.
 *
 * Built HERE, at the bottom, and not one line earlier. It used to sit in the
 * middle of the file, above the ten tools that are appended with TOOLS.push()
 * below it — so those ten were declared to every model and then missing from
 * the map that runs them. Under Ollama, which dispatches through this map,
 * calling one answered "No such tool: adjust_brightness" for a tool that is
 * very much there.
 *
 * _wiringtest asserts this map covers the registry, so appending a tool after
 * this line fails a test instead of going quiet.
 */
export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

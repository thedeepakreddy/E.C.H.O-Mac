import { GoogleGenAI } from "@google/genai";

export { GEMINI_API_VERSION } from "./gemini-version.js";
import { GEMINI_API_VERSION } from "./gemini-version.js";

/** A Gemini client on the pinned API version. Use this instead of `new GoogleGenAI`. */
export function geminiClient(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({ apiKey, apiVersion: GEMINI_API_VERSION });
}

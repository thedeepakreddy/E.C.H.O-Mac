/** Confirmation and undo: the model's own brakes, alongside the risk gate in safety/gate.ts. Assembled into TOOLS by ../registry.ts. */
import type { ToolDef } from "../registry.js";
import { z } from "zod";
import { restore, describeRecent } from "../../safety/snapshot.js";
import { exec } from "node:child_process";
import * as journal from "../../frontier/journal.js";

export const SAFETY_TOOLS: ToolDef[] = [
  /**
   * Safety tools.
   *
   * `confirm_action` covers what the risk classifier structurally cannot see:
   * clicking Send in a mail client is just a click at some coordinates, so only
   * the model knows it is about to be irreversible. It declares intent, the
   * permission gate turns that into a spoken confirmation.
   */
  {
    name: "confirm_action",
    description:
      "Ask the user out loud to approve something irreversible or outward-facing BEFORE you do it — sending a message or email, submitting a form, publishing, deleting something that isn't yours to delete, or confirming a purchase. Describe the action in one short spoken sentence, e.g. 'send the email to Priya about Friday'. Returns whether they agreed. Do not use it for ordinary clicking, typing, or reading.",
    schema: {
      description: z
        .string()
        .describe("The action, phrased to be read aloud, e.g. 'send this email to Priya'"),
    },
    readOnly: false,
    handler: async () => ({
      // Only reached when the gate already got approval — denial never runs it.
      text: "The user approved. Go ahead, then tell them it's done.",
    }),
  },
  {
    name: "undo_last",
    description:
      "Undo the most recent change Jarvis made, restoring the file or working tree from the snapshot taken before it. Use when the user says to undo, revert, or take it back.",
    schema: {},
    readOnly: false,
    handler: async () => ({ text: await restore() }),
  },
  {
    name: "list_undo",
    description: "List the recent changes that can still be undone.",
    schema: {},
    readOnly: true,
    handler: async () => ({ text: await describeRecent() }),
  },
  {
    name: "undo_recent",
    description:
      "Undo everything done in the last N minutes, not just the last file — walks backwards through the session restoring each change. Use for 'undo everything' or 'take all that back'. Actions with no true inverse are reported rather than silently skipped.",
    schema: { minutes: z.number().int().min(1).max(120).default(10) },
    readOnly: false,
    handler: async (a) => ({ text: await journal.undoWindow(a.minutes ?? 10) }),
  },
  {
    name: "review_recent_actions",
    description: "List what was done recently and which of it can still be undone.",
    schema: { minutes: z.number().int().min(1).max(240).default(10) },
    readOnly: true,
    handler: async (a) => ({ text: journal.describeWindow(a.minutes ?? 10) }),
  },
  {
    name: "ask_user_approval",
    description: "Pause execution and pop up a native OS dialog asking the user to Approve or Reject an action. CRITICAL: ONLY use this for highly important/irreversible actions such as making payments, confirming before sending emails/messages, or accepting/rejecting calls. Do NOT use this for mundane tasks, as it will disturb the user unnecessarily.",
    schema: {
      prompt: z.string().describe("The prompt to show the user (e.g., 'Approve sending email to CEO?').")
    },
    readOnly: false,
    handler: async (a) => {
      const { exec } = await import("node:child_process");
      return new Promise<{ text: string }>((resolve) => {
        const script = `display dialog "${a.prompt.replace(/"/g, '\\"')}" buttons {"Reject", "Approve"} default button "Approve" with title "Echo Clone Request"`;
        exec(`osascript -e '${script}'`, (err, stdout) => {
          if (err || !stdout.includes("Approve")) {
            resolve({ text: "User rejected the action." });
          } else {
            resolve({ text: "User approved the action." });
          }
        });
      });
    }
  },
];

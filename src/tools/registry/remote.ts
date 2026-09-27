/** Reaching beyond this Mac: the phone remote, iPhone hand-off and messages. Assembled into TOOLS by ../registry.ts. */
import type { ToolDef } from "../registry.js";
import { z } from "zod";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as scan from "../../frontier/scan.js";
import * as remote from "../../frontier/remote.js";
import { setPassword as setRemotePassword } from "../../frontier/remoteauth.js";
import { exec } from "node:child_process";
import { showRemoteLink } from "./shared.js";

export const REMOTE_TOOLS: ToolDef[] = [
  {
    name: "pull_from_phone",
    description: "The Ambient Device Mesh. Use this tool when the user asks you to pull context, URLs, or clipboard data from their iOS device (iPhone or iPad).",
    schema: {
      deviceName: z.string().optional().describe("The specific device to pull from, e.g., 'iPhone' or 'iPad'. Leave blank to pull from any discovered device.")
    },
    readOnly: true,
    handler: async (a: { deviceName?: string }) => {
      // Lazy load ambient mesh
      const { ambientMesh } = await import("../../frontier/ambient.js");
      const res = await ambientMesh.pullFromPhone(a.deviceName);
      return { text: res.message + (res.data ? `\nData: ${res.data}` : "") };
    }
  },
  {
    name: "set_remote_password",
    description:
      "Set (or change) the password that protects remote control of this Mac from a phone. Required before the phone remote can be opened. Use this when the user wants to set up phone control, or asks to change the remote password. At least 6 characters.",
    schema: {
      password: z.string().describe("The password the user chooses for signing in from their phone."),
    },
    readOnly: false,
    handler: async (a) => {
      const r = setRemotePassword(String(a.password ?? ""));
      return {
        text: r.ok
          ? "Remote password set. You can now open the phone remote — you'll enter this password to sign in from your phone."
          : r.message,
      };
    },
  },
  {
    name: "open_phone_remote",
    description:
      "Open full remote control of this Mac from the user's phone: a live view of the screen, two-way talk, sending commands, and approving actions — all behind their password. Reachable from anywhere when both devices are on Tailscale, otherwise same Wi-Fi. Shows a QR code on screen to scan. Use this when they want to see, control, or drive the Mac from their phone. Requires a remote password to be set first (set_remote_password).",
    schema: {},
    readOnly: false,
    handler: async () => {
      // The stop handler and command/confirmation bridges are registered at
      // startup by whoever owns the brain; the tool layer never holds a
      // reference to the running agent.
      const r = await remote.startRemote();
      if (r.ok && r.url) await showRemoteLink(r.url);
      return {
        text: r.ok
          ? `${r.message}\nI've put a QR code on your screen — scan it with your phone's camera to open the link.`
          : r.message,
      };
    },
  },
  {
    name: "close_phone_remote",
    description:
      "Close the phone remote, sign everyone out, and invalidate its link. Use this when the user is done, or asks you to stop sharing or lock it down.",
    schema: {},
    readOnly: false,
    handler: async () => ({ text: await remote.stopRemote() }),
  },
  {
    name: "phone_remote_status",
    description:
      "Report whether the phone remote is open, and show the QR code / link again to open it on the phone. Use this when the user asks for the phone link again, or 'show me the QR code'.",
    schema: {},
    readOnly: true,
    handler: async () => {
      const url = remote.currentRemoteUrl();
      if (url) await showRemoteLink(url);
      return {
        text: url
          ? `${remote.remoteStatus()}\nQR code is on your screen — scan it to connect.`
          : remote.remoteStatus(),
      };
    },
  },
  {
    name: "handoff_to_ios",
    description: "Send a piece of text, a URL, or an address to the user's iPhone via iCloud Handoff. Use this when the user asks to send something to their phone.",
    schema: {
      content: z.string().describe("The text or URL to send to the iPhone."),
    },
    readOnly: false,
    handler: async (a) => {
      const home = process.env.HOME;
      if (!home) return { text: "Failed to find HOME directory for iCloud path." };
      const icloudPath = join(home, "Library/Mobile Documents/com~apple~CloudDocs/JarvisHandoff.txt");
      try {
        writeFileSync(icloudPath, a.content, "utf8");
        return { text: `Successfully wrote '${a.content}' to iCloud. If the user has set up the iOS Personal Automation, their phone will receive it instantly.` };
      } catch (err: any) {
        return { text: `Failed to write to iCloud: ${err.message}` };
      }
    },
  },
  {
    name: "send_sms_message",
    description: "Send a text message or iMessage entirely offline via the Mac's Continuity/Messages app.",
    schema: {
      recipient: z.string().describe("The phone number or contact name."),
      message: z.string().describe("The message to send."),
    },
    readOnly: false,
    handler: async (a) => {
      return new Promise((resolve) => {
        const contactScript = `
          tell application "Contacts"
            set matched to every person whose name contains "${a.recipient}"
            if (count of matched) is 0 then
              return "ERROR_NOT_FOUND"
            else if (count of matched) is 1 then
              set thePhones to value of phones of item 1 of matched
              if (count of thePhones) is 0 then
                return "ERROR_NO_PHONE"
              else
                return item 1 of thePhones
              end if
            else
              return "ERROR_MULTIPLE"
            end if
          end tell
        `;
        exec(`osascript -e '${contactScript.replace(/'/g, "'\\''")}'`, (err, stdout) => {
          let target = a.recipient;
          const result = stdout ? stdout.trim() : "";
          
          if (result === "ERROR_NOT_FOUND") {
            return resolve({ text: `I couldn't find a contact matching "${a.recipient}". Please provide their exact name or phone number.` });
          } else if (result === "ERROR_NO_PHONE") {
            return resolve({ text: `I found ${a.recipient}, but they don't have a phone number saved in your contacts.` });
          } else if (result === "ERROR_MULTIPLE") {
            return resolve({ text: `There are multiple contacts matching "${a.recipient}". Could you be more specific? (e.g. provide their full last name)` });
          } else if (result && !err) {
            // Found a phone number!
            target = result;
          }

          // Now send using the resolved target (phone number) or fallback to raw string
          const script = `tell application "Messages" to send "${a.message}" to buddy "${target}"`;
          exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, (sendErr) => {
            if (sendErr) resolve({ text: `Failed to send SMS to ${target}: ${sendErr.message}` });
            else resolve({ text: `Successfully sent message to ${a.recipient} (${target}).` });
          });
        });
      });
    },
  },
];

/** Reaching beyond this Mac: the phone remote, iPhone hand-off and messages. Assembled into TOOLS by ../registry.ts. */
import type { ToolDef } from "../registry.js";
import { z } from "zod";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as scan from "../../frontier/scan.js";
import * as remote from "../../frontier/remote.js";
import { setPassword as setRemotePassword } from "../../frontier/remoteauth.js";
import { execFile } from "node:child_process";
import { showRemoteLink } from "./shared.js";

/** Run an AppleScript with its inputs passed as `argv`, so no input is ever parsed as script. */
function osascriptArgs(script: string, args: string[]): Promise<{ ok: boolean; stdout: string; error: string }> {
  return new Promise((resolve) => {
    execFile("/usr/bin/osascript", ["-e", script, ...args], { timeout: 20_000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout ?? "").trim(), error: err ? String(stderr || err.message).trim().slice(0, 200) : "" });
    });
  });
}

const CONTACT_LOOKUP = `on run argv
  set wanted to item 1 of argv
  tell application "Contacts"
    set matched to every person whose name contains wanted
    if (count of matched) is 0 then return "ERROR_NOT_FOUND"
    if (count of matched) > 1 then return "ERROR_MULTIPLE"
    set thePhones to value of phones of item 1 of matched
    if (count of thePhones) is 0 then return "ERROR_NO_PHONE"
    return item 1 of thePhones
  end tell
end run`;

// `participant` is the handle form current Messages understands; `buddy` is
// the older one, kept as the fallback for macOS versions that predate it.
const SEND_MESSAGE = `on run argv
  set targetHandle to item 1 of argv
  set theMessage to item 2 of argv
  tell application "Messages"
    try
      set targetService to 1st account whose service type = iMessage
      send theMessage to participant targetHandle of targetService
    on error
      send theMessage to buddy targetHandle
    end try
  end tell
end run`;

export const REMOTE_TOOLS: ToolDef[] = [
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
      "Open full remote control of this Mac from the user's phone: a live view of the screen, two-way talk, sending commands, and approving actions — all behind their password. Reachable from any network (Wi-Fi or mobile data) through the Echo phone app (needs remote.relayUrl and ECHO_RELAY_SECRET). Shows a QR code of the phone app link to scan. Use this when they want to see, control, or drive the Mac from their phone. Requires a remote password to be set first (set_remote_password).",
    schema: {},
    readOnly: false,
    handler: async () => {
      // The stop handler and command/confirmation bridges are registered at
      // startup by whoever owns the brain; the tool layer never holds a
      // reference to the running agent.
      const { activeConfig } = await import("../../config.js");
      const { getAppPath } = await import("../../utils/appPath.js");
      const cfg = activeConfig(getAppPath());
      const r = await remote.startRemote({
        relay: (await import("../../frontier/relay-agent.js")).relayFromConfig(cfg.remote?.relayUrl),
      });
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
      const recipient = String(a.recipient ?? "").trim();
      const message = String(a.message ?? "");
      if (!recipient || !message.trim()) return { text: "I need both a recipient and a message.", status: "failed" };

      // The recipient and the message reach AppleScript as ARGUMENTS, never
      // spliced into the script's source. Spliced in, a quote in the message
      // ended the string early and whatever followed ran as AppleScript — and
      // the message is often text the model copied from somewhere else.
      const lookup = await osascriptArgs(CONTACT_LOOKUP, [recipient]);
      let target: string;
      if (lookup.ok && !lookup.stdout.startsWith("ERROR_")) {
        target = lookup.stdout;
      } else if (lookup.stdout === "ERROR_NOT_FOUND" || !lookup.ok) {
        // Only a literal number or address may go out without a contact match.
        // Sending to a bare name used to happen whenever Contacts could not be
        // read at all, which addressed the message to nobody in particular.
        if (!/^[+\d][\d\s().-]{5,}$|^[^\s@]+@[^\s@]+$/.test(recipient)) {
          return {
            text: lookup.ok
              ? `I couldn't find a contact matching "${recipient}". Please give their exact name or phone number.`
              : `I couldn't read your contacts (${lookup.error}), so I need a phone number or email address rather than a name.`,
            status: "failed",
          };
        }
        target = recipient;
      } else if (lookup.stdout === "ERROR_NO_PHONE") {
        return { text: `I found ${recipient}, but they don't have a phone number saved in your contacts.`, status: "failed" };
      } else {
        return { text: `There are several contacts matching "${recipient}". Could you be more specific, for example their full name?`, status: "failed" };
      }

      const sent = await osascriptArgs(SEND_MESSAGE, [target, message]);
      if (!sent.ok) return { text: `Failed to send the message to ${target}: ${sent.error}`, status: "failed" };
      return { text: `Sent the message to ${recipient} (${target}).` };
    },
  },
];

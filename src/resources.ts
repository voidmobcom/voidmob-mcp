import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The guides are the agent skill's own files (skills/voidmob), shipped in the
// npm package and read on request: one source for the skill and the server.
// This file sits one level below the package root in both src/ and dist/.
const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), "../skills/voidmob");

export interface Guide {
  name: string;
  uri: string;
  title: string;
  description: string;
  /** Path under skills/voidmob. */
  file: string;
  /** Serve only this "## " section of the file. */
  section?: string;
}

export const GUIDES: readonly Guide[] = [
  {
    name: "money-rules",
    uri: "voidmob://guides/money-rules",
    title: "Money rules",
    description: "How charges, price confirmation, retries after a timeout and refunds work, and when not to buy again.",
    file: "SKILL.md",
    section: "Money rules",
  },
  {
    name: "sms-lifecycle",
    uri: "voidmob://guides/sms",
    title: "SMS verifications and rentals",
    description: "The 15-minute verification window, several codes per number, the automatic refund when no SMS arrives, cancel rules, reuse and long-term rentals.",
    file: "references/sms.md",
  },
  {
    name: "proxy-connection",
    uri: "voidmob://guides/proxies",
    title: "Mobile proxies: connecting",
    description: "HTTP and SOCKS5 connection, the gateway username syntax for country, city and sticky sessions, lists, IP whitelists, dedicated proxies, top-ups and renewals.",
    file: "references/proxies.md",
  },
  {
    name: "esim-install",
    uri: "voidmob://guides/esim",
    title: "eSIM: buying and installing",
    description: "Choosing a plan, the LPA string and QR code install, usage across top-ups, and top-ups.",
    file: "references/esim.md",
  },
  {
    name: "dedicated-numbers",
    uri: "voidmob://guides/dedicated-numbers",
    title: "Dedicated numbers",
    description: "Private monthly numbers that receive SMS from any service: buying, reading SMS, auto-renew and letting a number expire.",
    file: "references/numbers.md",
  },
  {
    name: "errors",
    uri: "voidmob://guides/errors",
    title: "Errors and recovery",
    description: "Every error code with its next step, and how to recover from a purchase whose result was lost.",
    file: "references/errors.md",
  },
];

/** The text of one "## <heading>" section, heading included. */
export function extractSection(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start === -1) throw new Error(`section '${heading}' not found`);
  const rest = lines.slice(start + 1).findIndex((l) => l.startsWith("## "));
  return lines.slice(start, rest === -1 ? undefined : start + 1 + rest).join("\n").trim() + "\n";
}

export async function readGuide(guide: Guide): Promise<string> {
  const text = await readFile(join(SKILL_DIR, guide.file), "utf8");
  return guide.section ? extractSection(text, guide.section) : text;
}

export function registerResources(server: McpServer): void {
  for (const guide of GUIDES) {
    server.registerResource(
      guide.name,
      guide.uri,
      { title: guide.title, description: guide.description, mimeType: "text/markdown" },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: await readGuide(guide) }] }),
    );
  }
}

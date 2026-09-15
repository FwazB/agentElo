import { buildEntryPrompt, ENTRY_DRAFT_VERSION } from "../referee/drafts.ts";
import { PUBLIC_SITE_URL } from "./scoring-guide.ts";

export { ENTRY_DRAFT_VERSION };

export const ENTRY_GUIDE_VERSION = "antislop.entry-guide.v1";
const SEVEN_DAYS_MS = 604_800_000;

export type EntryWindow = Parameters<typeof buildEntryPrompt>[0];

function rollingEntryWindow(now: Date): EntryWindow {
  const endsAt = now.getTime();
  const startsAt = endsAt - SEVEN_DAYS_MS;
  if (!Number.isFinite(endsAt) || !Number.isFinite(new Date(startsAt).getTime())) throw new Error("Invalid date.");
  const window = { startsAt: new Date(startsAt).toISOString(), endsAt: new Date(endsAt).toISOString() };
  // The draft contract accepts canonical UTC timestamps with four-digit years.
  if (window.startsAt.length !== 24 || window.endsAt.length !== 24) throw new Error("Invalid date.");
  return window;
}

/** Public preparation guidance only; identity, consent and submission belong to a separate flow. */
export function getEntryGuide(now: Date = new Date()) {
  const window = rollingEntryWindow(now);
  return {
    version: ENTRY_GUIDE_VERSION,
    window,
    prompt: buildEntryPrompt(window),
    referenceUrl: `${PUBLIC_SITE_URL}/entry.md`,
    mcpUrl: `${PUBLIC_SITE_URL}/mcp`,
  };
}

export function renderEntryGuide(now: Date = new Date()): string {
  const guide = getEntryGuide(now);
  return `# AntiSlop: prepare a work-entry draft

Version: ${guide.version}
Draft format: ${ENTRY_DRAFT_VERSION}
Window: ${guide.window.startsAt} inclusive to ${guide.window.endsAt} exclusive

${guide.prompt}

## Optional MCP

${guide.mcpUrl} supplies this same public guide for compatible AI clients. Connecting does not grant computer-history access. No account or recovery key is needed. This endpoint does not accept entries, record consent, score work or publish anything.
`;
}

// ARX AI — Demo dispatch duplicate suppression (sub-phase 3A).
//
// Phase 28-MT5-DEMO-ARMING (May 2026).
//
// Detects accidental double-dispatch by fingerprinting a command's
// {userId, commandType, canonicalized payload} and scanning recent
// rows in mt5_demo_commands within a short window.
//
// SAFETY:
//   - Read-only. Does not mutate or dispatch.
//   - Returns minimal evidence (count + matching commandIds); no payload
//     bodies, no tokens, no PII beyond what the caller already owns.

import { and, eq, gte, ne } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db, mt5DemoCommandsTable, type Mt5DemoCommand } from "@workspace/db";

const DEFAULT_WINDOW_SECONDS = 10;

/** Canonical JSON stringify (sorted keys). */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}

// Keys that are added to the stored payload as observability sidecars but
// are NOT part of the command's semantic identity. They must be excluded
// from the fingerprint so duplicate suppression + the partial unique index
// remain effective across redrafts of the same logical command.
const VOLATILE_PAYLOAD_KEYS = new Set<string>([
  "bridgeReadinessAtDraft",
]);

function stripVolatile(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const src = payload as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(src)) {
    if (!VOLATILE_PAYLOAD_KEYS.has(k)) out[k] = src[k];
  }
  return out;
}

export function computeCommandFingerprint(args: {
  userId: number;
  commandType: string;
  payload: unknown;
}): string {
  const h = createHash("sha256");
  h.update(`u=${args.userId}|t=${args.commandType}|p=${canonicalize(stripVolatile(args.payload))}`);
  return h.digest("hex");
}

export interface DuplicateScanResult {
  isDuplicate: boolean;
  matchedCommandIds: string[];
  matchCount: number;
  fingerprint: string;
  windowSeconds: number;
}

/** Returns {isDuplicate:true} if another row within the window has the
 *  same fingerprint AND is in a non-terminal state. The current command
 *  (excludeCommandId) is excluded from the scan. */
export async function findRecentDuplicate(args: {
  userId: number;
  commandType: string;
  payload: unknown;
  excludeCommandId: string;
  windowSeconds?: number;
}): Promise<DuplicateScanResult> {
  const window = args.windowSeconds ?? DEFAULT_WINDOW_SECONDS;
  const fingerprint = computeCommandFingerprint({
    userId: args.userId,
    commandType: args.commandType,
    payload: args.payload,
  });
  const since = new Date(Date.now() - window * 1000);

  const rows = await db
    .select()
    .from(mt5DemoCommandsTable)
    .where(
      and(
        eq(mt5DemoCommandsTable.userId, args.userId),
        eq(mt5DemoCommandsTable.commandType, args.commandType),
        ne(mt5DemoCommandsTable.commandId, args.excludeCommandId),
        gte(mt5DemoCommandsTable.createdAt, since),
      ),
    )
    .limit(50);

  const NON_TERMINAL: ReadonlySet<string> = new Set([
    "DRAFT",
    "USER_CONFIRMATION_REQUIRED",
    "DEMO_APPROVED",
    "SENT_TO_MT5_DEMO",
  ]);

  const matched: Mt5DemoCommand[] = [];
  for (const r of rows) {
    if (!NON_TERMINAL.has(r.status)) continue;
    const rowFp = computeCommandFingerprint({
      userId: r.userId,
      commandType: r.commandType,
      payload: r.payload,
    });
    if (rowFp === fingerprint) matched.push(r);
  }

  return {
    isDuplicate: matched.length > 0,
    matchedCommandIds: matched.map((m) => m.commandId),
    matchCount: matched.length,
    fingerprint,
    windowSeconds: window,
  };
}

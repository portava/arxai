import { createHash } from "node:crypto";

/** A broker clock is a coordinate system, not evidence of historical UTC.
 * Keep it unchanged until an explicit historical mapping exists. */
export function brokerHistoryIdentity(args: {
  userId: number; bridgeConnectionId: number; accountNumber: string | null;
  serverName: string | null; clockBasis: string;
}): string {
  return createHash("sha256").update(JSON.stringify([
    "broker-history-v1", args.userId, args.bridgeConnectionId,
    args.accountNumber, args.serverName, args.clockBasis,
  ])).digest("hex");
}

export interface HistoryPageProof {
  kind: "seed" | "backfill";
  requestedEndRawMs?: number;
  serverFirstRawMs: number;
  requestedBars: number;
  copiedBars: number;
  boundaryReached: boolean;
}

/** Advance only an acknowledged, sequential CopyRates page. Existing oldest
 * rows cannot skip holes: a new chain always starts at the seed and walks back.
 * Session closures are represented by the native CopyRates sequence, never by
 * synthesized evenly-spaced bars. An empty/short hydrating page is not EOF. */
export function advanceHistoryPage(args: {
  priorCursor: Date | null; priorComplete: boolean; proof?: HistoryPageProof;
  oldestRawMs: number; oldestCloseRawMs: number; newestRawMs: number;
  accepted: number; rejected: number; sent: number;
}): { cursor: Date | null; complete: boolean; advanced: boolean } {
  const unchanged = { cursor: args.priorCursor, complete: args.priorComplete, advanced: false };
  const p = args.proof;
  if (!p || args.sent === 0 || args.rejected !== 0 || args.accepted !== args.sent
    || p.copiedBars !== args.sent || p.requestedBars < args.sent) return unchanged;
  if (args.priorComplete) return unchanged;
  if (p.kind === "seed" && args.priorCursor) return unchanged;
  if (p.kind === "backfill" && (!args.priorCursor
    || p.requestedEndRawMs !== args.priorCursor.getTime()
    || args.newestRawMs > args.priorCursor.getTime())) return unchanged;
  const boundary = p.boundaryReached && p.serverFirstRawMs > 0
    && args.oldestRawMs <= p.serverFirstRawMs && args.oldestCloseRawMs > p.serverFirstRawMs;
  // A short result without an observed broker boundary can still be hydrating.
  if (args.sent < p.requestedBars && !boundary) return unchanged;
  return { cursor: boundary ? null : new Date(args.oldestRawMs - 1000), complete: boundary, advanced: true };
}

// What the synthetic-index (Deriv) feed is doing, from GET
// /api/market-data/deriv/status — the server's own readiness fields, never the
// socket flag alone. An open socket with no recent tick is not a live feed,
// and a connection whose last attempt errored is failing, not "connecting".

export type DerivStatusPayload = {
  /** false when the status request failed (HTTP error / network). */
  statusKnown?: boolean;
  configured?: boolean;
  connected?: boolean;
  hasRecentTick?: boolean;
  feedReadinessState?: string;
  healthSummary?: string;
  lastTickAgeMs?: number | null;
};

export type DerivFeedState =
  | { kind: "unknown" }          // the status could not be loaded
  | { kind: "unconfigured" }     // the server says the feed is off
  | { kind: "connecting" }       // socket not open yet, no error reported
  | { kind: "failed" }           // socket not open and the last attempt errored
  | { kind: "awaiting_ticks" }   // socket open, no recent live tick reported
  | { kind: "live"; lastTickAgeMs: number | null };

/** null while the status has not answered yet (no note). */
export function derivFeedStateFromStatus(d: DerivStatusPayload | undefined): DerivFeedState | null {
  if (!d) return null;
  if (d.statusKnown !== true) return { kind: "unknown" };
  if (d.configured === false) return { kind: "unconfigured" };
  if (d.connected !== true) return d.healthSummary === "failed" ? { kind: "failed" } : { kind: "connecting" };
  if (d.hasRecentTick === true) {
    const age = typeof d.lastTickAgeMs === "number" && Number.isFinite(d.lastTickAgeMs) && d.lastTickAgeMs >= 0
      ? d.lastTickAgeMs
      : null;
    return { kind: "live", lastTickAgeMs: age };
  }
  return { kind: "awaiting_ticks" };
}

export function derivFeedNoteText(s: DerivFeedState): string {
  switch (s.kind) {
    case "unknown":
      return "The synthetic-index feed status could not be loaded — whether these markets have live prices is unknown.";
    case "unconfigured":
      return "Synthetic-index live feed isn't active yet — these markets are visible for selection but won't show live prices until the feed is set up.";
    case "connecting":
      return "Connecting to live feed for synthetic indices…";
    case "failed":
      return "The synthetic-index feed connection is failing — these markets won't show live prices until it reconnects.";
    case "awaiting_ticks":
      return "Synthetic-index feed is connected but has no recent live tick — prices may not be current.";
    case "live":
      return s.lastTickAgeMs != null
        ? `Synthetic-index feed is receiving live ticks (last tick ${Math.round(s.lastTickAgeMs / 1000)}s old at the last status check).`
        : "Synthetic-index feed is receiving live ticks.";
  }
}

// Plain-words answers to a Eleanor monitor alert, and the scope of a "cancel"
// (sweep 2026-11-04). Pure: the command route consults these BEFORE the trade
// parser, and only acts on an answer when a monitor is awaiting one.

/** "close it" / "close that" / "yes close" / "close now" — an answer to an alert, not a new command. */
export function isCloseAlertAnswer(text: string): boolean {
  return /^(?:(?:ok(?:ay)?|yes|yeah|yep)[,\s]+)?(?:close(?:\s+(?:it|that|this|the\s+trade|the\s+position))(?:\s+now)?|close\s+now|(?:ok(?:ay)?|yes|yeah|yep)[,\s]+close)[.!\s]*$/i.test(text.trim());
}

export type CancelScope = "ALL" | "PENDING_ENTRIES" | "LATEST_MONITOR" | "LATEST_WATCH";

/**
 * What a cancel stands down. A casual "never mind" must not remove the
 * protection on an open trade, so monitors are only cancelled when the trader
 * names monitoring or says all/everything.
 */
export function cancelScope(text: string, kind: "CANCEL" | "CANCEL_PENDING_ORDER"): CancelScope {
  if (/\b(all|everything)\b/i.test(text)) return "ALL";
  if (kind === "CANCEL_PENDING_ORDER") return "PENDING_ENTRIES";
  if (/\bmonitor/i.test(text)) return "LATEST_MONITOR";
  return "LATEST_WATCH";
}

export function pickWatchesToCancel<W extends { kind: string; symbol: string | null; createdAt: Date }>(
  active: readonly W[], scope: CancelScope, symbol?: string | null,
): W[] {
  const newest = [...active].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const sym = symbol ? symbol.toUpperCase() : null;
  switch (scope) {
    case "ALL": return newest;
    case "PENDING_ENTRIES": return newest.filter((w) => w.kind === "WATCH_AND_ENTER" && (!sym || (w.symbol ?? "").toUpperCase() === sym));
    case "LATEST_MONITOR": return newest.filter((w) => w.kind === "MONITOR_TRADE").slice(0, 1);
    case "LATEST_WATCH": return newest.filter((w) => w.kind !== "MONITOR_TRADE").slice(0, 1);
  }
}

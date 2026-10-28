// Honest degraded-state copy + cosmetic-truth helpers for scanner read
// surfaces. Centralised so the user-facing strings are locked by a test and can
// never regress into leaking a raw SyntaxError / "Unexpected end of JSON input"
// / bare "HTTP 502" at the user. Display-only — no execution / gate concern.

// Shown on the Market Scanner page when the status / opportunities read fails.
// The real error detail goes to console.debug, never this card.
export const SCANNER_DEGRADED_MESSAGE =
  "Scanner is temporarily unavailable — retrying.";

// Shown on the Recent Scanner Trades card when its read fails.
export const RECENT_TRADES_DEGRADED_MESSAGE =
  "Couldn't load recent scanner trades — try again.";

// Honest title for the smart-layer overlay badge while the layers feed is
// degraded (errored / refetch-failed) but react-query still holds the last
// successful payload.
export const OVERLAY_DEGRADED_TITLE =
  "Smart layers temporarily unavailable — showing last known state.";

export type OverlayHandshakeStatus = "PASS" | "WARN" | "BLOCK" | string;

// Overlay handshake badge label. The badge must NOT claim "verified" while the
// smart-layer query is degraded — even though react-query keeps the last
// successful `data` around, a stale PASS handshake would otherwise read as
// live-verified. When degraded (or there is no handshake yet) we defer to a
// neutral "unavailable" label regardless of the cached handshake status.
//
// A PASS handshake also must NOT claim "verified" when the chart's price feed is
// not live (historical-only / delayed / stale). The handshake can structurally
// pass while the overlays sit on non-live data, so a live-feed-gated PASS reads
// as "limited" instead — honest about the feed state the overlays are drawn on.
// `livePrice` defaults true so existing callers/tests keep their behaviour.
//
// A PASS handshake also must NOT claim "verified" when some of its checks were
// NOT_AVAILABLE — not checked at all (e.g. no economic-calendar mapping for the
// symbol, unknown overlay age). The domain roll-up ignores NOT_AVAILABLE, so a
// chart whose news mapping and overlay age were never checked still rolls up
// PASS; the badge reads "partially checked" instead. Precedence: degraded >
// not-live > partially checked > verified. `hasUnavailableChecks` defaults
// false so existing callers keep their behaviour.
export function overlayBadgeLabel(
  status: OverlayHandshakeStatus | null,
  degraded: boolean,
  livePrice: boolean = true,
  hasUnavailableChecks: boolean = false,
): string {
  if (degraded || status == null) return "unavailable";
  if (status === "PASS") {
    if (!livePrice) return "limited";
    return hasUnavailableChecks ? "partially checked" : "verified";
  }
  if (status === "WARN") return "check";
  if (status === "BLOCK") return "not ready";
  return "unknown";
}

/** A handshake check as the badge reads it (domain SmartChartOverlayCheck). */
export interface OverlayBadgeCheck {
  status: string;
  detail: string;
}

/** The handshake checks that were NOT_AVAILABLE (never checked). */
export function unavailableOverlayChecks<T extends OverlayBadgeCheck>(
  checks: readonly T[] | null | undefined,
): T[] {
  return (checks ?? []).filter((c) => c.status === "NOT_AVAILABLE");
}

/**
 * Honest title for a PASS handshake with unchecked items. REPLACES the PASS
 * message ("…match the live read and are safe to use as guidance"), which would
 * over-claim: only the checked items passed.
 */
export function overlayPartialTitle(unavailable: readonly OverlayBadgeCheck[]): string {
  const details = unavailable.map((c) => c.detail.trim()).filter(Boolean);
  return `Structure overlays match the chart; not checked: ${details.join(" ")}`.trim();
}

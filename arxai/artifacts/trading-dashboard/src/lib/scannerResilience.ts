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
export function overlayBadgeLabel(
  status: OverlayHandshakeStatus | null,
  degraded: boolean,
  livePrice: boolean = true,
): string {
  if (degraded || status == null) return "unavailable";
  if (status === "PASS") return livePrice ? "verified" : "limited";
  if (status === "WARN") return "check";
  if (status === "BLOCK") return "not ready";
  return "unknown";
}

// Deriv WS ticks → forming-bar composer bridge (Theme C3.1).
//
// WHY
//   The forming-bar composer had exactly ONE writer: the MT5 EA bridge ingest
//   path. For any symbol the broker does not serve — every Deriv-fed synthetic —
//   no tick ever folded, so `getFormingBar` returned null, no tip was appended,
//   and the chart's newest bar only advanced when a CLOSED candle landed one
//   whole interval later. On an M5 chart that reads as a frozen chart for up to
//   five minutes at a time while the feed is perfectly healthy.
//
//   This bridge gives the composer a second real tick source: whatever the Deriv
//   WS is already streaming. The composer stays provider-agnostic; only the
//   sourcing widens.
//
// PRICE BASIS
//   Deriv ticks carry a `quote`, and a Deriv-fed chart's CLOSED candles come
//   from the same Deriv feed — so the synthesized tip sits on the same basis as
//   the bars beneath it, which is the property that matters (no half-spread
//   seam). This is the Deriv analogue of the broker path's BID/BID pairing, not
//   a mixing of the two: a broker-fed symbol keeps folding broker BID ticks.
//
// HONESTY / SAFETY (unchanged from the composer's posture)
//   - Display/telemetry only. In-memory; nothing is persisted.
//   - Freeze, never fabricate: the tip mutates ONLY on a real tick. Silence
//     leaves it unchanged and the shared freshness layer marks it stale.
//   - Touches no execution path, no arx_live_* table, no safety gate.

import { getDerivWsClient } from "../providers/derivWsClient.js";
import { resolveDerivSymbol } from "../providers/derivProvider.js";
import { foldFormingTick } from "./formingBarComposer.js";

let unsubscribe: (() => void) | null = null;

/**
 * Start folding live Deriv ticks into the forming-bar composer.
 *
 * Idempotent — a second call is a no-op, so it is safe to invoke from any boot
 * path. Best-effort throughout: a tick for an unrecognised Deriv id is skipped
 * rather than guessed at, and the composer's own listener isolation means a
 * failure here can never disturb tick caching or the socket.
 */
export function startDerivFormingBridge(): void {
  if (unsubscribe) return;
  const client = getDerivWsClient();
  unsubscribe = client.onTick((tick) => {
    // The composer collapses Deriv aliases onto the canonical ARX code, so the
    // WS id is a valid address; resolve first purely to reject ids we do not
    // recognise rather than filing a tick under a symbol we cannot name.
    const mapped = resolveDerivSymbol(tick.symbol);
    if (!mapped) return;
    if (!Number.isFinite(tick.quote) || tick.quote <= 0) return;
    // Deriv `epoch` is unix SECONDS; the composer buckets in ms.
    const providerTimeMs =
      Number.isFinite(tick.epoch) && tick.epoch > 0 ? tick.epoch * 1000 : null;
    foldFormingTick(mapped.symbol, tick.quote, providerTimeMs, Date.now(), "deriv");
  });
}

/** Test-only: detach the bridge so a suite can re-arm it deterministically. */
export function __stopDerivFormingBridgeForTests(): void {
  unsubscribe?.();
  unsubscribe = null;
}

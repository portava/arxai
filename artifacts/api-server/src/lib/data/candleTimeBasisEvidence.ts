/** Original clock authority, separate from a syntactically valid ISO string.
 * A current broker offset, transport receipt time or appended Z is not a
 * historical UTC conversion. No shipped adapter currently qualifies UTC. */
export interface CandleTimeBasisEvidence {
  kind: "original_utc" | "unavailable";
  basis: "UTC" | "BROKER_SERVER" | null;
  authority: string | null;
  reason: string | null;
}
export function unavailableCandleTimeBasis(source: string | null): CandleTimeBasisEvidence {
  return {
    kind: "unavailable",
    basis: source === "mt5_broker" ? "BROKER_SERVER" : null,
    authority: null,
    reason: source === "mt5_broker"
      ? "MT5 history uses broker/source-clock coordinates. Historical UTC mapping is unverified; ISO Z labels and a current heartbeat offset do not establish it."
      : "The original candle clock has no qualified UTC authority. ISO formatting and provider names do not establish historical UTC mapping.",
  };
}
/** Deliberately no UTC allowlist yet. An audited original adapter must be
 * implemented and reviewed before any authority can be registered here.
 * Merely copying a client-supplied evidence object must never mint authority.
 * Keep the input seam so future adapters do not need another candle contract. */
export function resolveCandleTimeBasisEvidence(_evidence: unknown, source: string | null): CandleTimeBasisEvidence {
  return unavailableCandleTimeBasis(source);
}

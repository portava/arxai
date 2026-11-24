import { createHash } from "node:crypto";
import { favoredScenario, type SpecialistQuoteStudy, type Triple } from "@workspace/domain/structural";
import type { AtiDerivQuoteFrame } from "../data/atiDerivQuotes.js";

export type BoundaryPrices = { long: number; short: number; entrySpread: number; exitSpread: number;
  entryEpoch: number; exitEpoch: number; frames: number; tapeHash: string };
export type TapeReading = { reason: string } | { prices: BoundaryPrices };

export function readSpecialistTape(anchor: SpecialistQuoteStudy, expectedSymbol: string, frames: readonly AtiDerivQuoteFrame[],
  issuedAt: number, recordedAt: number, end: number): TapeReading {
  const cadence = expectedSymbol.startsWith("1HZ") ? 1 : 2;
  const first = frames[0], published = Math.max(issuedAt, recordedAt);
  if (anchor.version !== "fixed-horizon-bid-ask-v1" || anchor.symbol !== expectedSymbol || !first ||
      first.epoch !== anchor.epoch || first.releasedAt > issuedAt || first.bid !== anchor.bid || first.ask !== anchor.ask ||
      issuedAt - first.epoch * 1000 > cadence * 1000) return { reason: "ANCHOR_UNVERIFIED" };
  const hash = createHash("sha256");
  let entry: { epoch: number; bid: number; ask: number } | undefined;
  for (const [i, frame] of frames.entries()) {
    const previous = frames[i - 1];
    const { epoch, bid, ask, receivedAt, releasedAt } = frame;
    const at = epoch * 1000;
    if (frame.streamId !== anchor.streamId || frame.symbol !== expectedSymbol || !Number.isSafeInteger(epoch) ||
        !Number.isFinite(receivedAt) || !Number.isFinite(releasedAt) || receivedAt <= 0 || releasedAt < receivedAt ||
        releasedAt < at || releasedAt - at > 3000 ||
        (previous && (epoch - previous.epoch !== cadence || releasedAt < previous.releasedAt))) return { reason: "TAPE_DISCONTINUITY" };
    if (bid == null || ask == null || !Number.isFinite(bid) || !Number.isFinite(ask) || !(bid > 0 && ask >= bid)) {
      return { reason: "BID_ASK_UNAVAILABLE" };
    }
    hash.update(JSON.stringify([frame.streamId, frame.symbol, epoch, receivedAt, releasedAt, bid, ask]));
    if (!entry && at > published) {
      if (receivedAt <= published || releasedAt > published + 5000) return { reason: "ENTRY_UNVERIFIED" };
      entry = { epoch, bid, ask };
    }
    if (at >= end) {
      if (!entry || entry.epoch >= epoch || at - end >= cadence * 1000 || releasedAt > end + 5000) return { reason: "EXIT_UNVERIFIED" };
      return { prices: { long: bid - entry.ask, short: entry.bid - ask, entrySpread: entry.ask - entry.bid,
        exitSpread: ask - bid, entryEpoch: entry.epoch, exitEpoch: epoch, frames: i + 1, tapeHash: hash.digest("hex") } };
    }
  }
  return { reason: "INCOMPLETE_TAPE" };
}

// One unit of price exposure per active leg. Quote-side spread is already
// embedded in the entry and exit. Additional costs are explicit assumptions.
export function specialistPaperPoints(weights: Triple, prices: BoundaryPrices) {
  const call = favoredScenario(weights);
  const active = call === "UP_FIRST" || call === "DOWN_FIRST";
  const spreadAdjusted = call === "UP_FIRST" ? prices.long : call === "DOWN_FIRST" ? prices.short : 0;
  return { side: call === "UP_FIRST" ? "LONG" : call === "DOWN_FIRST" ? "SHORT" : "FLAT",
    spreadAdjusted, assumedNet: spreadAdjusted - (active ? 2 : 0) };
}

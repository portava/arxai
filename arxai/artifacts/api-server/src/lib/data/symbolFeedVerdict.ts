import type { SymbolFeedVerdict } from "@workspace/domain/safety-contracts/syntheticLiveFloor";
import { classifyCandleFreshness } from "./freshness.js";

export function resolveSymbolFeedVerdict(input: {
  hasRecentTick: boolean;
  trailingIntervals: number | null;
}): SymbolFeedVerdict {
  if (!input.hasRecentTick) return "AWAITING";
  const fresh = classifyCandleFreshness(input.trailingIntervals);
  if (fresh == null) return "AWAITING";
  if (fresh.freshness === "clean") return "LIVE";
  if (fresh.freshness === "delayed") return "LIVE_DELAYED";
  return "AWAITING";
}

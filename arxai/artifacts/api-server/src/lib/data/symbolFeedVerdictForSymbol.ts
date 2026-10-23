import type { SymbolFeedVerdict } from "@workspace/domain/safety-contracts/syntheticLiveFloor";
import { resolveSymbolFeedVerdict } from "./symbolFeedVerdict.js";
import { rawTrailingIntervalGap } from "./chart/candleNormalization.js";
import { isChartTimeframe } from "./chart/timeframes.js";
import { routeCandles } from "./marketDataRouter.js";
import { hasRecentDerivTickFor } from "./providers/derivProvider.js";

type CandlesResult = Awaited<ReturnType<typeof routeCandles>>;

const FEED_VERDICT_TIMEOUT_MS = 2500;

function withTimeout<T>(p: Promise<T>, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(fallback);
      }
    }, FEED_VERDICT_TIMEOUT_MS);
    p.then((value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }
    }).catch(() => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(fallback);
      }
    });
  });
}

export async function resolveSymbolFeedVerdictForSymbol(
  symbol: string,
  timeframe = "M1",
): Promise<SymbolFeedVerdict> {
  if (!isChartTimeframe(timeframe)) return "AWAITING";
  const cr = await withTimeout<CandlesResult | null>(
    routeCandles(symbol, timeframe, 30),
    null,
  );
  if (cr == null || !cr.ok || cr.candles.length === 0) return "AWAITING";
  const source = cr.primaryProvider ?? null;
  const trailingIntervals = rawTrailingIntervalGap(cr.candles, source, timeframe);
  // Task #776 — the Deriv WS tick is the liveness signal ONLY when Deriv is the
  // winning provider. When the MT5 broker (`mt5_broker`) feed serves the symbol
  // it IS the live source, so liveness is judged on broker candle freshness
  // alone — a Deriv-only tick check would wrongly mark a live MT5-broker symbol
  // as AWAITING (the same false-negative this task fixes on the chart/scanner).
  // Honesty preserved: a genuinely stale/awaiting broker feed still resolves
  // AWAITING / LIVE_DELAYED below (trailing-interval staleness) and stays
  // entry-blocked; this corrects a wrong verdict, it does not relax the gate.
  const derivBacked = source === "deriv" || (source?.startsWith("deriv") ?? false);
  const hasRecentTick = derivBacked ? hasRecentDerivTickFor(symbol) : true;
  return resolveSymbolFeedVerdict({ hasRecentTick, trailingIntervals });
}

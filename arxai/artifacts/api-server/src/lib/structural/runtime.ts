import { gradePublicForecastOrder } from "./paperGrading.js";
import { getChartCandles } from "../data/chart/chartDataService.js";
import { StructuralForecastService } from "./service.js";
import { fitWindowCount, MIN_FIT_WINDOWS, forecastHorizon, DEFAULT_FORECAST_HORIZON } from "@workspace/domain/structural";
import { structuralRepository } from "./repository.js";
import { fitInWorker } from "./fitAsync.js";
import { getCandleHistory } from "../data/candleHistoryService.js";
import { assembleForecastFeed } from "./feed.js";

export const structuralService = new StructuralForecastService({
  now: Date.now,
  repository: structuralRepository,
  fit: fitInWorker,
  gradePaperTicket(row, now) {
    if (row.forecast.origin.provider !== "deriv_public" || row.paperPublishedAt == null || !row.forecast.paperInstruction) return undefined;
    return gradePublicForecastOrder(row.forecast.origin.symbol, row.forecast.paperInstruction, row.paperPublishedAt, now);
  },
  async readFeed(symbol, requested) {
    const horizon = requested ?? forecastHorizon(DEFAULT_FORECAST_HORIZON)!;
    const tf = horizon.timeframe;
    // Existing paginated cache/backfill supplies training depth. Fetch the
    // current truth afterwards so a slow history backfill cannot stale the tip.
    const read = async (excludeProviders?: readonly string[]) => {
      const history = await getCandleHistory({ symbol, timeframe: tf, limit: 5000, ...(excludeProviders ? { excludeProviders } : {}) });
      const current = await getChartCandles(symbol, tf, 120, false, excludeProviders ? { excludeProviders } : {});
      return assembleForecastFeed(symbol, history, current, Date.now(), horizon);
    };
    const primary = await read();
    // The router serves the first provider that answers. Its one-minute
    // series can still be unusable for a model that needs gap-free bars
    // (measured: the stored MT5 series was missing 816 bars around the newest
    // 120 while the provider's own feed was complete). Ask once for the next
    // provider; history and tip must still come from that one source, and the
    // forecast names the provider it used.
    // "Unusable" also covers a clean series whose unbroken run is too short to
    // fit the model (seen in the server: a clean MT5 tip over a holed history).
    const usable = (feed: typeof primary) => feed.ready && fitWindowCount(feed.bars) >= MIN_FIT_WINDOWS;
    const declined = primary.diagnostics?.chartSource ?? primary.diagnostics?.historySource;
    if (usable(primary) || !declined) return primary;
    const fallback = await read([declined]);
    return usable(fallback) || (fallback.ready && !primary.ready) ? fallback : primary;
  },
});

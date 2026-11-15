import { getChartCandles } from "../data/chart/chartDataService.js";
import { StructuralForecastService } from "./service.js";
import { structuralRepository } from "./repository.js";
import { fitInWorker } from "./fitAsync.js";
import { getCandleHistory } from "../data/candleHistoryService.js";
import { assembleForecastFeed } from "./feed.js";

export const structuralService = new StructuralForecastService({
  now: Date.now,
  repository: structuralRepository,
  fit: fitInWorker,
  async readFeed(symbol) {
    // Existing paginated cache/backfill supplies training depth. Fetch the
    // current truth afterwards so a slow history backfill cannot stale the tip.
    const read = async (excludeProviders?: readonly string[]) => {
      const history = await getCandleHistory({ symbol, timeframe: "M1", limit: 5000, ...(excludeProviders ? { excludeProviders } : {}) });
      const current = await getChartCandles(symbol, "M1", 120, false, excludeProviders ? { excludeProviders } : {});
      return assembleForecastFeed(symbol, history, current, Date.now());
    };
    const primary = await read();
    // The router serves the first provider that answers. Its one-minute
    // series can still be unusable for a model that needs gap-free bars
    // (measured: the stored MT5 series was missing 816 bars around the newest
    // 120 while the provider's own feed was complete). Ask once for the next
    // provider; history and tip must still come from that one source, and the
    // forecast names the provider it used.
    const declined = primary.diagnostics?.chartSource ?? primary.diagnostics?.historySource;
    if (primary.ready || !declined) return primary;
    const fallback = await read([declined]);
    return fallback.ready ? fallback : primary;
  },
});

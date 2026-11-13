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
    const history = await getCandleHistory({ symbol, timeframe: "M1", limit: 5000 });
    const current = await getChartCandles(symbol, "M1", 120, false);
    return assembleForecastFeed(symbol, history, current, Date.now());
  },
});

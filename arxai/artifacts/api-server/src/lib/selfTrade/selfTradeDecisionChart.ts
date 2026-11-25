import { getCachedIntelligenceContext, type ChartIntelligenceState } from "../data/chart/chartIntelligence.js";
import type { ChartTimeframe } from "../data/chart/timeframes.js";
import { enrichStateWithUserBrokerQuote } from "../data/chart/userBrokerAlignment.js";

type Context = ReturnType<typeof getCachedIntelligenceContext>;
type Enrich = (state: ChartIntelligenceState,
  args: { userId: number; symbol: string; timeframe: ChartTimeframe; limit: number }) => Promise<ChartIntelligenceState>;

// The cached chart state is shared across users and always carries the
// noBrokerAlignment placeholder, so selfTradeChartConfirmation could never pass
// on it. Bind the deciding user's own broker quote to the served series, as the
// chart and Eleanor routes do, before the chart gate reads it. Only a BOUND
// quote can be measured; a missing or unbound quote leaves the placeholder, and
// the gate still blocks. Render, scale and interaction evidence stay unmeasured.
// The shared cache is never written.
export async function selfTradeDecisionChart(symbol: string, timeframe: ChartTimeframe, userId: number,
  deps: { read?: typeof getCachedIntelligenceContext; enrich?: Enrich } = {}): Promise<{ cached: Context; state: ChartIntelligenceState | null }> {
  const read = deps.read ?? getCachedIntelligenceContext, enrich = deps.enrich ?? enrichStateWithUserBrokerQuote;
  for (const limit of [300, 200]) {
    const cached = read(symbol, timeframe, limit);
    if (!cached) continue;
    try {
      return { cached, state: await enrich(cached.state, { userId, symbol, timeframe, limit }) };
    } catch {
      return { cached, state: cached.state };
    }
  }
  return { cached: null, state: null };
}

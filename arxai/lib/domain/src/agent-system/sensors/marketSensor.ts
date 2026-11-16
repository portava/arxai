import type { MarketDataPort, MarketObservation } from "../agentSystem.types";

// marketSensor — collects market FACTS only.
// No analysis, no opinions. Adds the observation timestamp.
export async function marketSensor(
  port: MarketDataPort,
  symbol: string,
  now: Date = new Date(),
): Promise<MarketObservation> {
  const raw = await port.fetchMarket(symbol);
  return { ...raw, observedAt: now.toISOString() };
}

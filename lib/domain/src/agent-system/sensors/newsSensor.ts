import type { NewsObservation, NewsPort } from "../agentSystem.types";

export async function newsSensor(
  port: NewsPort,
  symbol: string,
  now: Date = new Date(),
): Promise<NewsObservation> {
  const raw = await port.fetchUpcomingNews(symbol);
  return { ...raw, observedAt: now.toISOString() };
}

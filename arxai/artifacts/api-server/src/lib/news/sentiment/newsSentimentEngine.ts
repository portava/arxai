export type Sentiment = "positive" | "negative" | "neutral" | "unknown";

export interface SentimentResult {
  symbol: string;
  sentiment: Sentiment;
  score: number; // -1 .. +1
  source: string;
}

// Placeholder. Returns deterministic mock sentiment until a real news API
// is wired in (e.g. Marketaux, Finnhub).
export function getSentiment(symbol: string): SentimentResult {
  if (!symbol) return { symbol, sentiment: "unknown", score: 0, source: "mock" };
  const seed = symbol.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const score = ((seed % 21) - 10) / 10; // -1.0 .. +1.0 deterministic
  const sentiment: Sentiment =
    score > 0.2 ? "positive" : score < -0.2 ? "negative" : "neutral";
  return { symbol, sentiment, score, source: "mock" };
}

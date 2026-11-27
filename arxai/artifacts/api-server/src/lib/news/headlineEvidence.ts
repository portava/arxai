import type { NewsItem } from "../assistant/marketProvider.js";

export interface HeadlineEvidence {
  headline: string;
  source: string;
  url: string | null;
  publishedAt: string;
  observedAt?: string;
  timeBasis: "publication" | "provider_first_seen";
  verification: "headline_only";
}

// trader-news treats headlines as leads, not verified facts. Preserve the
// provider's clock basis; first-seen time must never become publication time.
export function normalizeHeadlineEvidence(items: NewsItem[], nowMs: number): HeadlineEvidence[] {
  const seen = new Set<string>();
  const result: HeadlineEvidence[] = [];
  for (const item of items) {
    if (!item || typeof item.headline !== "string" || !item.headline.trim()) continue;
    const firstSeen = item.timeBasis === "provider_first_seen";
    const time = firstSeen ? item.observedAt : item.publishedAt;
    const ms = typeof time === "string" ? Date.parse(time) : NaN;
    if (!Number.isFinite(ms) || ms > nowMs + 60_000 || nowMs - ms > 48 * 3600_000) continue;
    let url: URL;
    try { url = new URL(item.url); } catch { continue; }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) continue;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(key) || key === ".tsrc") url.searchParams.delete(key);
    }
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    result.push({
      headline: item.headline.trim().slice(0, 1000),
      source: item.source?.trim() || url.hostname,
      url: url.href,
      publishedAt: firstSeen ? "" : new Date(ms).toISOString(),
      ...(firstSeen ? { observedAt: new Date(ms).toISOString() } : {}),
      timeBasis: firstSeen ? "provider_first_seen" : "publication",
      verification: "headline_only",
    });
  }
  return result.sort((a, b) => (b.observedAt || b.publishedAt).localeCompare(a.observedAt || a.publishedAt)).slice(0, 8);
}

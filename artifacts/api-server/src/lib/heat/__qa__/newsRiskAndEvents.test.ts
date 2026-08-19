// Deterministic tests for the two distinct honesty surfaces of the Global Market
// Heat card (Task #611): "today's news risk" (deriveNewsRisk) and "upcoming
// high-impact events" (readCalendarProvider mapping). Run via:
//   pnpm --filter @workspace/api-server run test:market-heat-news-events
//
// NON-NEGOTIABLE HONESTY: a disconnected news provider NEVER reads as "low" — it
// is `unavailable`. A disconnected calendar NEVER fabricates events — the list is
// empty. Both are decision-support only; neither carries an execution field.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveNewsRisk,
  deriveNewsRiskScore,
  selectTopNewsHeadlines,
  newsRiskLevelOf,
  type NewsSignal,
  type NewsRiskItem,
} from "@workspace/domain/market-heat";
import { readCalendarProvider } from "../marketHeatProviderStatus.js";

const NOW = Date.parse("2026-06-19T12:00:00.000Z");
const isoMinsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

const baseNews: NewsSignal = {
  configured: true,
  connected: true,
  riskScore: 0,
  itemCount: 0,
  updatedAt: "2026-06-19T00:00:00.000Z",
  source: "provider",
  freshness: "LIVE",
};

// ── deriveNewsRisk honesty ───────────────────────────────────────────────────

test("deriveNewsRisk: disconnected provider is unavailable, never low", () => {
  const r = deriveNewsRisk({ ...baseNews, connected: false, configured: true });
  assert.equal(r.level, "unavailable");
  assert.equal(r.connected, false);
  assert.equal(r.itemCount, 0);
  assert.ok(!/low risk/i.test(r.summary.replace(/not 'low risk'/i, "")));
  assert.match(r.summary, /unavailable/i);
});

test("deriveNewsRisk: unconfigured provider is unavailable, never low", () => {
  const r = deriveNewsRisk({ ...baseNews, connected: false, configured: false });
  assert.equal(r.level, "unavailable");
  assert.match(r.summary, /no news provider configured/i);
});

test("deriveNewsRisk: connected high riskScore reads high", () => {
  const r = deriveNewsRisk({ ...baseNews, riskScore: 0.8, itemCount: 7 });
  assert.equal(r.level, "high");
  assert.equal(r.connected, true);
  assert.equal(r.itemCount, 7);
});

test("deriveNewsRisk: connected quiet feed reads low (real, not faked)", () => {
  const r = deriveNewsRisk({ ...baseNews, riskScore: 0.05 });
  assert.equal(r.level, "low");
  assert.equal(r.connected, true);
});

test("deriveNewsRisk: stale connected feed caps high down to elevated", () => {
  const r = deriveNewsRisk({ ...baseNews, riskScore: 0.9, freshness: "STALE" });
  assert.equal(r.level, "elevated");
  assert.match(r.summary, /stale/i);
});

// ── deriveNewsRiskScore: real severity + recency (not a count proxy) ─────────

test("deriveNewsRiskScore: empty items yield zero (caller decides unavailable)", () => {
  const r = deriveNewsRiskScore([], NOW);
  assert.equal(r.riskScore, 0);
  assert.equal(r.highImpactCount, 0);
  assert.equal(r.recentCount, 0);
});

test("deriveNewsRiskScore: high-severity fresh headline scores higher than calm", () => {
  const calm: NewsRiskItem[] = [
    { headline: "Markets little changed in quiet session", publishedAt: isoMinsAgo(30) },
  ];
  const severe: NewsRiskItem[] = [
    { headline: "Fed emergency rate decision sparks market crash fears", publishedAt: isoMinsAgo(30) },
  ];
  const calmScore = deriveNewsRiskScore(calm, NOW).riskScore;
  const severeScore = deriveNewsRiskScore(severe, NOW).riskScore;
  assert.ok(severeScore > calmScore, `expected ${severeScore} > ${calmScore}`);
  assert.equal(deriveNewsRiskScore(severe, NOW).highImpactCount, 1);
});

test("deriveNewsRiskScore: NOT a count proxy — one severe beats many calm", () => {
  const manyCalm: NewsRiskItem[] = Array.from({ length: 10 }, (_, i) => ({
    headline: `Company ${i} releases quarterly newsletter`,
    publishedAt: isoMinsAgo(40),
  }));
  const oneSevere: NewsRiskItem[] = [
    { headline: "Global recession warning as banks collapse", publishedAt: isoMinsAgo(20) },
  ];
  assert.ok(
    deriveNewsRiskScore(oneSevere, NOW).riskScore >
      deriveNewsRiskScore(manyCalm, NOW).riskScore,
  );
});

test("deriveNewsRiskScore: recency matters — fresh severe beats stale severe", () => {
  const item = "Central bank inflation shock rattles markets";
  const fresh = deriveNewsRiskScore([{ headline: item, publishedAt: isoMinsAgo(10) }], NOW).riskScore;
  const stale = deriveNewsRiskScore([{ headline: item, publishedAt: isoMinsAgo(60 * 30) }], NOW).riskScore;
  assert.ok(fresh > stale, `expected fresh ${fresh} > stale ${stale}`);
});

test("deriveNewsRiskScore: deterministic — same input ⇒ same output", () => {
  const items: NewsRiskItem[] = [
    { headline: "FOMC rate decision due", publishedAt: isoMinsAgo(15) },
    { headline: "Oil prices steady", publishedAt: isoMinsAgo(120) },
  ];
  assert.deepEqual(deriveNewsRiskScore(items, NOW), deriveNewsRiskScore(items, NOW));
});

test("newsRiskLevelOf: threshold mapping (never unavailable for a score)", () => {
  assert.equal(newsRiskLevelOf(0.9), "high");
  assert.equal(newsRiskLevelOf(0.5), "elevated");
  assert.equal(newsRiskLevelOf(0.25), "moderate");
  assert.equal(newsRiskLevelOf(0.05), "low");
  assert.equal(newsRiskLevelOf(0), "low");
});

test("deriveNewsRisk consumes a real severity score end-to-end", () => {
  const severe: NewsRiskItem[] = [
    { headline: "War escalates: emergency sanctions trigger market crash", publishedAt: isoMinsAgo(10) },
  ];
  const { riskScore } = deriveNewsRiskScore(severe, NOW);
  const verdict = deriveNewsRisk({ ...baseNews, riskScore, itemCount: severe.length });
  assert.equal(verdict.level, newsRiskLevelOf(riskScore));
  assert.equal(verdict.connected, true);
});

// ── selectTopNewsHeadlines: severity-ranked driving headlines ────────────────

test("selectTopNewsHeadlines: empty in ⇒ empty out (never fabricated)", () => {
  assert.deepEqual(selectTopNewsHeadlines([], NOW), []);
});

test("selectTopNewsHeadlines: ranks high-severity recent over calm, caps to limit", () => {
  const items: NewsRiskItem[] = [
    { headline: "Company newsletter published", source: "PRNews", publishedAt: isoMinsAgo(20) },
    {
      headline: "Fed emergency rate cut sparks market crash fears",
      source: "Reuters",
      publishedAt: isoMinsAgo(10),
    },
    { headline: "Quarterly earnings beat estimates", source: "Bloomberg", publishedAt: isoMinsAgo(15) },
    { headline: "Calm trading continues", source: "AP", publishedAt: isoMinsAgo(25) },
  ];
  const top = selectTopNewsHeadlines(items, NOW, 3);
  assert.equal(top.length, 3);
  assert.equal(top[0]!.headline, "Fed emergency rate cut sparks market crash fears");
  assert.equal(top[0]!.source, "Reuters");
  assert.equal(top[0]!.severity, "high");
});

test("selectTopNewsHeadlines: carries source/publishedAt, never fabricates a source", () => {
  const top = selectTopNewsHeadlines(
    [{ headline: "Recession warning as banks collapse", publishedAt: isoMinsAgo(5) }],
    NOW,
  );
  assert.equal(top.length, 1);
  assert.equal(top[0]!.source, null);
  assert.equal(top[0]!.publishedAt, isoMinsAgo(5));
});

test("selectTopNewsHeadlines: deterministic — same input ⇒ same output", () => {
  const items: NewsRiskItem[] = [
    { headline: "FOMC rate decision due", source: "Reuters", publishedAt: isoMinsAgo(15) },
    { headline: "Oil prices steady", source: "AP", publishedAt: isoMinsAgo(120) },
  ];
  assert.deepEqual(selectTopNewsHeadlines(items, NOW), selectTopNewsHeadlines(items, NOW));
});

test("deriveNewsRisk: surfaces topHeadlines + highImpactCount when supplied", () => {
  const detail = {
    topHeadlines: [
      {
        headline: "War escalates: emergency sanctions trigger market crash",
        source: "Reuters",
        publishedAt: isoMinsAgo(10),
        severity: "high" as const,
      },
    ],
    highImpactCount: 2,
  };
  const r = deriveNewsRisk({ ...baseNews, riskScore: 0.8, itemCount: 5 }, detail);
  assert.equal(r.highImpactCount, 2);
  assert.deepEqual(r.topHeadlines, detail.topHeadlines);
});

test("deriveNewsRisk: disconnected provider never surfaces headlines or counts", () => {
  const r = deriveNewsRisk(
    { ...baseNews, connected: false, configured: true },
    {
      topHeadlines: [
        { headline: "leak attempt", source: "x", publishedAt: isoMinsAgo(1), severity: "high" },
      ],
      highImpactCount: 9,
    },
  );
  assert.equal(r.level, "unavailable");
  assert.equal(r.highImpactCount, 0);
  assert.deepEqual(r.topHeadlines, []);
});

// ── upcoming events honesty (this env: calendar disconnected) ────────────────

test("readCalendarProvider: disconnected calendar yields zero events (never fabricated)", async () => {
  const read = await readCalendarProvider("GLOBAL", Date.parse("2026-06-19T00:00:00.000Z"));
  assert.equal(read.connected, false);
  assert.deepEqual(read.events, []);
  assert.equal(read.eventCount, 0);
  assert.equal(read.source.status === "live", false);
});

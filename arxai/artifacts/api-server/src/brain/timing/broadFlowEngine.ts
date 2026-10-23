// Broad Market Flow + Institutional Flow Engine.
//
// Cross-checks the symbol against correlated assets (DXY/USD behavior,
// related majors, gold, indices) using the available market data router.
// Fails honestly to "broad flow unavailable" when providers are not configured.
//
// Advisory only. Never an execution gate.

import type { BroadFlowResult, BroadFlowVerdict } from "@workspace/domain/timing-brain";
import { routeCandles } from "../../lib/data/marketDataRouter.js";
import { classifySymbol } from "../../lib/data/marketDataRouter.js";

// ── Correlation maps ──────────────────────────────────────────────────────

const CORRELATION_PEERS: Record<string, Array<{ symbol: string; expectedDir: "SAME" | "INVERSE" | "WEAK" }>> = {
  EURUSD: [
    { symbol: "GBPUSD", expectedDir: "SAME" },
    { symbol: "XAUUSD", expectedDir: "SAME" },
    { symbol: "USDJPY", expectedDir: "INVERSE" },
  ],
  GBPUSD: [
    { symbol: "EURUSD", expectedDir: "SAME" },
    { symbol: "USDJPY", expectedDir: "INVERSE" },
  ],
  USDJPY: [
    { symbol: "EURUSD", expectedDir: "INVERSE" },
    { symbol: "US30",   expectedDir: "SAME" },
  ],
  XAUUSD: [
    { symbol: "EURUSD", expectedDir: "SAME" },
    { symbol: "USDJPY", expectedDir: "INVERSE" },
    { symbol: "US30",   expectedDir: "WEAK" },
  ],
  US30: [
    { symbol: "NAS100", expectedDir: "SAME" },
    { symbol: "SPX500", expectedDir: "SAME" },
    { symbol: "USDJPY", expectedDir: "SAME" },
  ],
  NAS100: [
    { symbol: "US30",   expectedDir: "SAME" },
    { symbol: "SPX500", expectedDir: "SAME" },
  ],
};

function getPeers(symbol: string): typeof CORRELATION_PEERS[string] {
  const upper = symbol.toUpperCase();
  return CORRELATION_PEERS[upper] ?? [];
}

async function fetchRecentDirection(symbol: string): Promise<"BULL" | "BEAR" | "FLAT" | null> {
  try {
    const r = await routeCandles(symbol, "M15", 5);
    if (!r.ok || r.candles.length < 2) return null;
    const first = r.candles[0]!;
    const last = r.candles[r.candles.length - 1]!;
    const pctMove = (last.close - first.close) / (first.close || 1) * 100;
    if (pctMove > 0.05) return "BULL";
    if (pctMove < -0.05) return "BEAR";
    return "FLAT";
  } catch {
    return null;
  }
}

function directionFor(selfDir: "BULL" | "BEAR" | "FLAT", peerDir: "BULL" | "BEAR" | "FLAT", expectedDir: "SAME" | "INVERSE" | "WEAK"): "CONFIRMS" | "CONFLICTS" | "NEUTRAL" {
  if (selfDir === "FLAT" || peerDir === "FLAT") return "NEUTRAL";
  if (expectedDir === "WEAK") return "NEUTRAL";
  const confirms = expectedDir === "SAME"
    ? selfDir === peerDir
    : selfDir !== peerDir;
  return confirms ? "CONFIRMS" : "CONFLICTS";
}

/**
 * Optional dependency injection for testing. Production callers pass nothing and
 * get the real symbol classifier + candle-router-backed direction fetcher. Tests
 * inject deterministic stand-ins so peer directions never depend on a live feed.
 */
export interface BroadFlowDeps {
  classify?: (symbol: string) => string;
  fetchDirection?: (symbol: string) => Promise<"BULL" | "BEAR" | "FLAT" | null>;
}

export async function computeBroadFlow(
  symbol: string,
  selfDirection: "BULL" | "BEAR" | "FLAT",
  deps: BroadFlowDeps = {},
): Promise<BroadFlowResult> {
  const classify = deps.classify ?? classifySymbol;
  const fetchDir = deps.fetchDirection ?? fetchRecentDirection;
  const assetClass = classify(symbol);

  // Synthetics are self-contained — no broad-flow correlation
  if (assetClass === "synthetic") {
    return {
      verdict: "NEUTRAL",
      institutionalFlowScore: 50,
      competingCatalyst: false,
      description: "Synthetic indices have no broad-market correlation — flow analysis not applicable.",
      correlatedAssets: [],
      dataQuality: "real",
    };
  }

  const peers = getPeers(symbol);
  if (peers.length === 0) {
    return {
      verdict: "UNAVAILABLE",
      institutionalFlowScore: 50,
      competingCatalyst: false,
      description: "No correlation peers defined for this symbol — broad flow unavailable.",
      correlatedAssets: [],
      dataQuality: "unavailable",
    };
  }

  // Fetch peer directions (best-effort, fail-open per peer)
  const results = await Promise.allSettled(
    peers.map(async (p) => {
      const dir = await fetchDir(p.symbol);
      return { peer: p, direction: dir };
    }),
  );

  const correlatedAssets: BroadFlowResult["correlatedAssets"] = [];
  let confirmedCount = 0;
  let conflictCount = 0;
  let fetchedCount = 0;

  for (const r of results) {
    if (r.status !== "fulfilled" || r.value.direction == null) continue;
    fetchedCount++;
    const { peer, direction } = r.value;
    const contribution = directionFor(selfDirection, direction, peer.expectedDir);
    correlatedAssets.push({ symbol: peer.symbol, direction, contribution });
    if (contribution === "CONFIRMS") confirmedCount++;
    if (contribution === "CONFLICTS") conflictCount++;
  }

  if (fetchedCount === 0) {
    return {
      verdict: "UNAVAILABLE",
      institutionalFlowScore: 50,
      competingCatalyst: false,
      description: "No peer data available — broad flow unavailable.",
      correlatedAssets: [],
      dataQuality: "unavailable",
    };
  }

  const dataQuality: BroadFlowResult["dataQuality"] = fetchedCount >= peers.length ? "real" : "partial";
  const competingCatalyst = conflictCount > 0 && confirmedCount > 0;

  let verdict: BroadFlowVerdict;
  if (conflictCount === 0 && confirmedCount >= 2) verdict = "ALIGNED";
  else if (confirmedCount === 0 && conflictCount >= 2) verdict = "OPPOSING";
  else if (conflictCount > confirmedCount) verdict = "CONFLICTED";
  else if (confirmedCount > 0 && conflictCount === 0) verdict = "ALIGNED";
  else verdict = "NEUTRAL";

  const institutionalFlowScore = verdict === "ALIGNED" ? 70 + confirmedCount * 5
    : verdict === "OPPOSING" ? 30 - conflictCount * 5
    : verdict === "CONFLICTED" ? 40
    : 55;

  const description = buildDescription(verdict, symbol, confirmedCount, conflictCount, competingCatalyst);

  return {
    verdict,
    institutionalFlowScore: Math.min(100, Math.max(0, institutionalFlowScore)),
    competingCatalyst,
    description,
    correlatedAssets,
    dataQuality,
  };
}

function buildDescription(
  verdict: BroadFlowVerdict,
  symbol: string,
  confirmed: number,
  conflicts: number,
  competing: boolean,
): string {
  if (verdict === "ALIGNED") return `${confirmed} correlated asset(s) confirm the ${symbol} direction — broad flow aligned.`;
  if (verdict === "OPPOSING") return `${conflicts} correlated asset(s) moving against ${symbol} — institutional flow opposing.`;
  if (verdict === "CONFLICTED") return `Mixed signals across ${symbol} peers — ${confirmed} confirm, ${conflicts} conflict. Competing catalyst likely.`;
  if (verdict === "NEUTRAL") return `No strong directional signal from ${symbol} correlated assets.`;
  return "Broad flow data unavailable.";
}

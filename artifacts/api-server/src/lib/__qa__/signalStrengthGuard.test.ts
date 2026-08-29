// SIGNAL-STRENGTH RENAME — grep guard (pattern-based, like the
// no-internal-names-ui guard).
//
// `confidenceScore` is deprecated on the uncalibrated-heuristic wire shapes;
// `signalStrength` is the canonical name. Existing references live on in a
// FROZEN allowlist (compat emitters, audited-prediction subsystems that keep
// the confidence name on purpose, stored-column payloads, and pre-existing
// consumers pending migration). No NEW file may introduce a fresh
// `confidenceScore` reference — new code must use `signalStrength`, adding
// the deprecated alias only inside an existing dual-emit builder.
//
// The guard walks real source (api-server + trading-dashboard src trees) so
// it cannot go vacuous; a file that DROPS the old name simply falls off the
// allowlist harmlessly (that is the direction of travel).
//
// Pure filesystem read — no network, DB, or writes.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../../..");

const SCAN_ROOTS = [
  "artifacts/api-server/src",
  "artifacts/trading-dashboard/src",
];

// Frozen at the time of the scoped rename (2026-08-28). Do NOT add to this
// list to make new code pass — use `signalStrength` instead. Removing entries
// as files migrate off the old name is encouraged.
const ALLOWLIST = new Set<string>([
  // ── dual-emit compat emitters (old name deliberately still emitted) ──────
  "artifacts/api-server/src/lib/assistant/liveScanner.ts",
  "artifacts/api-server/src/lib/marketScanner.ts",
  "artifacts/api-server/src/lib/scannerSelected/selectedMarket.ts",
  "artifacts/api-server/src/lib/assistant/rubyDraftRead.ts",
  "artifacts/api-server/src/lib/honesty/feedTruthCopy.ts",
  "artifacts/api-server/src/lib/data/opportunityAdapters.ts",
  "artifacts/api-server/src/routes/meAssistant.ts",
  "artifacts/api-server/src/lib/assistant/tools.ts",
  // ── audited predictions / stored columns — name kept on purpose ──────────
  "artifacts/api-server/src/lib/aaci/snapshotService.ts",
  "artifacts/api-server/src/lib/agentEcosystem/advisoryInfluence.ts",
  "artifacts/api-server/src/lib/agentEcosystem/reviewScoring.ts",
  "artifacts/api-server/src/lib/aiBrain.ts",
  "artifacts/api-server/src/lib/assistant/setupPreview.ts",
  "artifacts/api-server/src/lib/autopilot.ts",
  "artifacts/api-server/src/lib/chart/benchmarkScore.ts",
  "artifacts/api-server/src/lib/chart/decisionReceipts.ts",
  "artifacts/api-server/src/lib/dailyTesting.ts",
  "artifacts/api-server/src/lib/data/chart/chartAgentConsensus.ts",
  "artifacts/api-server/src/lib/decision/decisionAlerts.ts",
  "artifacts/api-server/src/lib/decision/persistence.ts",
  "artifacts/api-server/src/lib/decision/rules.ts",
  "artifacts/api-server/src/lib/decision/types.ts",
  "artifacts/api-server/src/lib/liveTrading/audit.ts",
  "artifacts/api-server/src/lib/liveTrading/guard.ts",
  "artifacts/api-server/src/lib/marketDataLayer.ts",
  "artifacts/api-server/src/lib/missionAgents.ts",
  "artifacts/api-server/src/lib/oms.ts",
  "artifacts/api-server/src/lib/opportunityRadar/radar.ts",
  "artifacts/api-server/src/lib/paperIntelligence.ts",
  "artifacts/api-server/src/lib/patternSync/patternSyncComparator.ts",
  "artifacts/api-server/src/lib/patternSync/patternSyncEngine.ts",
  "artifacts/api-server/src/lib/playbookEngine.ts",
  "artifacts/api-server/src/lib/riskGovernor2.ts",
  "artifacts/api-server/src/lib/rubyQuality/aggregator.ts",
  "artifacts/api-server/src/lib/rubyQuality/selfReview.ts",
  "artifacts/api-server/src/lib/rubyQuality/tracker.ts",
  "artifacts/api-server/src/lib/scalp/scalpEngine.ts",
  "artifacts/api-server/src/lib/scalp/scalpService.ts",
  "artifacts/api-server/src/lib/scalp/scalpTypes.ts",
  "artifacts/api-server/src/lib/shadowMode.ts",
  "artifacts/api-server/src/lib/signalIntelligence/opportunityMapService.ts",
  "artifacts/api-server/src/lib/signalIntelligence/signalIntelligenceService.ts",
  "artifacts/api-server/src/routes/adminRubyQuality.ts",
  "artifacts/api-server/src/routes/aiBrain.ts",
  "artifacts/api-server/src/routes/aiMentor.ts",
  "artifacts/api-server/src/routes/analytics.ts",
  "artifacts/api-server/src/routes/edgeDiscovery.ts",
  "artifacts/api-server/src/routes/liveIntent.ts",
  "artifacts/api-server/src/routes/liveTrading.ts",
  "artifacts/api-server/src/routes/marketDataLayer.ts",
  "artifacts/api-server/src/routes/mePlaybooks.ts",
  "artifacts/api-server/src/routes/meRubyQuality.ts",
  "artifacts/api-server/src/routes/meTradeDecisions.ts",
  "artifacts/api-server/src/routes/oms.ts",
  "artifacts/api-server/src/routes/paperIntelligence.ts",
  "artifacts/api-server/src/routes/riskGovernor2.ts",
  "artifacts/api-server/src/routes/testerData.ts",
  "artifacts/api-server/src/routes/tradeDecision.ts",
  "artifacts/api-server/src/routes/tradingPlaybooks.ts",
  // ── pre-existing tests exercising the alias / fixtures ───────────────────
  "artifacts/api-server/src/lib/__qa__/honestConfidence.test.ts",
  "artifacts/api-server/src/lib/__qa__/paperIntelligenceRealBars.test.ts",
  "artifacts/api-server/src/lib/__qa__/patternScannerChildInput.test.ts",
  "artifacts/api-server/src/lib/__qa__/scannerTruthCaps.test.ts",
  "artifacts/api-server/src/lib/__qa__/trendlineNeverUnlocksTrade.test.ts",
  "artifacts/api-server/src/lib/__qa__/trendlineScannerChildInput.test.ts",
  "artifacts/api-server/src/lib/__qa__/signalStrengthDualEmit.test.ts",
  "artifacts/api-server/src/lib/__qa__/signalStrengthGuard.test.ts",
  "artifacts/api-server/src/lib/data/__qa__/opportunitySetupWithholding.test.ts",
  "artifacts/api-server/src/lib/data/chart/__qa__/patternTruth.test.ts",
  "artifacts/api-server/src/lib/features/__qa__/featureSnapshot.test.ts",
  "artifacts/api-server/src/lib/honesty/__qa__/feedTruthCopy.test.ts",
  "artifacts/api-server/src/lib/patternSync/__qa__/patternSync.test.ts",
  "artifacts/api-server/src/lib/regime/__qa__/marketRegimeAuthority.test.ts",
  "artifacts/api-server/src/lib/scalp/__qa__/scalpEngine.test.ts",
  "artifacts/api-server/src/lib/scalp/__qa__/scalpPersonalityWiring.test.ts",
  "artifacts/api-server/src/lib/scalp/__qa__/scalpRunOn.test.ts",
  "artifacts/api-server/src/lib/signalIntelligence/__qa__/opportunityScoreDerivation.test.ts",
  "artifacts/api-server/src/routes/__qa__/aiHelperSimulatorMask.test.ts",
  "artifacts/api-server/src/routes/__qa__/scannerGenuineSessionAccess.test.ts",
  "artifacts/api-server/src/routes/__qa__/scannerManualScanAccess.test.ts",
  // ── dashboard consumers pending full migration (alias fallback reads) ────
  "artifacts/trading-dashboard/src/components/charts/RubyDraftReadPanel.tsx",
  "artifacts/trading-dashboard/src/components/dashboard/trade/TradePanels.tsx",
  "artifacts/trading-dashboard/src/components/edgeDiscovery/EdgeBreakdownTable.tsx",
  "artifacts/trading-dashboard/src/components/edgeDiscovery/StrongestEdgeCard.tsx",
  "artifacts/trading-dashboard/src/components/edgeDiscovery/types.ts",
  "artifacts/trading-dashboard/src/components/paper-intelligence/ARXIntelligencePanel.tsx",
  "artifacts/trading-dashboard/src/components/playbook/AISuggestedRulesPanel.tsx",
  "artifacts/trading-dashboard/src/components/playbook/PlaybookEntryCard.tsx",
  "artifacts/trading-dashboard/src/components/playbook/types.ts",
  "artifacts/trading-dashboard/src/components/scanner/RecentScannerTrades.tsx",
  "artifacts/trading-dashboard/src/components/scanner/RubySetupReason.tsx",
  "artifacts/trading-dashboard/src/components/scanner/ScannerTradeModal.tsx",
  "artifacts/trading-dashboard/src/components/scanner/SelectedMarketPanel.test.tsx",
  "artifacts/trading-dashboard/src/components/scanner/SelectedMarketPanel.tsx",
  "artifacts/trading-dashboard/src/components/trading/MyOpenTradesPanel.tsx",
  "artifacts/trading-dashboard/src/hooks/useAiChartOverlays.ts",
  "artifacts/trading-dashboard/src/lib/rubyReasoningBlock.ts",
  "artifacts/trading-dashboard/src/pages/autopilot-control-center.tsx",
  "artifacts/trading-dashboard/src/pages/live-ai-assist.tsx",
  "artifacts/trading-dashboard/src/pages/live-ai-auto-test.tsx",
  "artifacts/trading-dashboard/src/pages/live-intent-queue.tsx",
  "artifacts/trading-dashboard/src/pages/live-trading-control.tsx",
  "artifacts/trading-dashboard/src/pages/market-replay.tsx",
  "artifacts/trading-dashboard/src/pages/market-scanner.tsx",
  "artifacts/trading-dashboard/src/pages/my-paper-trades.tsx",
  "artifacts/trading-dashboard/src/pages/orders.tsx",
  "artifacts/trading-dashboard/src/pages/testing-control-center.tsx",
  "artifacts/trading-dashboard/src/pages/trade-command-room.tsx",
  "artifacts/trading-dashboard/src/pages/trade-detail.tsx",
  "artifacts/trading-dashboard/src/pages/trade-grader.tsx",
]);

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "generated"]);

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) yield* walk(p);
    } else if (/\.(ts|tsx)$/.test(name)) {
      yield p;
    }
  }
}

describe("grep guard: no fresh confidenceScore references outside the frozen allowlist", () => {
  it("every file referencing confidenceScore is on the allowlist", () => {
    const offenders: string[] = [];
    let hits = 0;
    for (const root of SCAN_ROOTS) {
      for (const abs of walk(resolve(ROOT, root))) {
        const src = readFileSync(abs, "utf8");
        if (!/\bconfidenceScore\b/.test(src)) continue;
        hits++;
        const rel = relative(ROOT, abs);
        if (!ALLOWLIST.has(rel)) offenders.push(rel);
      }
    }
    // Non-vacuous: the compat emitters are real files this walk actually saw.
    assert.ok(hits >= 10, `guard scan looks broken — only ${hits} files matched`);
    assert.deepEqual(
      offenders,
      [],
      `New confidenceScore reference(s) found outside the frozen allowlist. ` +
        `Use the canonical 'signalStrength' field instead (the deprecated alias ` +
        `may only be emitted by the existing dual-emit builders): ${offenders.join(", ")}`,
    );
  });

  it("the allowlist is honest — no phantom entries for the scanned trees", () => {
    // Every allowlisted file must still exist (entries whose file was deleted
    // should be pruned so the list stays truthful).
    const missing: string[] = [];
    for (const rel of ALLOWLIST) {
      try {
        statSync(resolve(ROOT, rel));
      } catch {
        missing.push(rel);
      }
    }
    assert.deepEqual(missing, [], `allowlist entries no longer exist: ${missing.join(", ")}`);
  });
});

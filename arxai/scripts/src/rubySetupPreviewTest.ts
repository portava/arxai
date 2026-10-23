// Ruby/AI Setup-Preview producer regression suite (Task #374).
//
// Verifies the deterministic, no-LLM setup-preview producer:
//   - draws concrete entry/SL/TP from REAL candles with honest geometry
//     (BUY: SL < entry < TP; SELL: TP < entry < SL) and a price-based R:R
//   - a preview is a DRAWING, never an order: status is always "preview",
//     the module is pure (no DB / broker / order side effects)
//   - honesty gates hold: feed not VERIFIED -> refused (no levels);
//     INSUFFICIENT read -> refused; governance "rejected" -> avoid (no levels);
//     no resolvable edge -> caution (no fabricated levels)
//   - no balance -> no account-currency risk math (riskAmount/potentialReward
//     null) + an honest "set your lot in the ticket" note
//   - composite/synthetic feed -> never broker-native language
//   - NO paper/demo wording anywhere in the explanation
//   - explanation references the EXACT drawn levels so words match the chart
//
// SAFETY: pure function test. No DB, no broker calls, no env mutation.

import {
  buildSetupPreview,
  type BuildSetupPreviewInput,
  type SetupPreviewProviderSource,
} from "../../artifacts/api-server/src/lib/assistant/setupPreview.js";
import { analyzeChartStructure } from "../../artifacts/api-server/src/lib/assistant/chartStructure.js";
import type { Candle } from "../../artifacts/api-server/src/lib/data/types.js";

type CaseResult = { name: string; ok: boolean; detail?: string };
const results: CaseResult[] = [];
function record(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  const label = ok ? "PASS" : "FAIL";
  // eslint-disable-next-line no-console
  console.log(`  ${label}  ${name}${detail ? ` — ${detail}` : ""}`);
}

// Build a smooth uptrend so the structural read is directional + clean.
function uptrend(n = 80, start = 1.1, step = 0.0008, spread = 0.0003): Candle[] {
  let t = Date.parse("2026-01-01T00:00:00Z");
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const close = start + step * i;
    const open = close - step * 0.4;
    const high = Math.max(open, close) + spread;
    const low = Math.min(open, close) - spread;
    t += 5 * 60 * 1000;
    out.push({ time: new Date(t).toISOString(), open, high, low, close });
  }
  return out;
}

// A flat, mid-range chart → no clean directional edge.
function flat(n = 80, level = 1.1, jitter = 0.0001): Candle[] {
  let t = Date.parse("2026-01-01T00:00:00Z");
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const close = level + (i % 2 === 0 ? jitter : -jitter);
    const open = level;
    const high = level + jitter * 2;
    const low = level - jitter * 2;
    t += 5 * 60 * 1000;
    out.push({ time: new Date(t).toISOString(), open, high, low, close });
  }
  return out;
}

const forexSource: SetupPreviewProviderSource = {
  assetClass: "forex",
  composite: false,
  label: "broker-routed quote",
};
const compositeSource: SetupPreviewProviderSource = {
  assetClass: "synthetic_index",
  composite: true,
  label: "composite market",
};

function baseInput(
  candles: Candle[],
  over: Partial<BuildSetupPreviewInput> = {},
): BuildSetupPreviewInput {
  const read = analyzeChartStructure(candles);
  return {
    symbol: "EURUSD",
    displaySymbol: "EUR/USD",
    timeframe: "M5",
    read,
    candles,
    basis: "VERIFIED",
    trustLine: "Chart Truth 88 — fresh feed, mirror clean.",
    providerSource: forexSource,
    availableAllocation: 5000,
    nowMs: Date.parse("2026-01-01T12:00:00Z"),
    ...over,
  };
}

const NO_PAPER = /\b(paper|demo)\b/i;
function explanationHasNoPaperDemo(lines: string[]): boolean {
  return !lines.some((l) => NO_PAPER.test(l));
}

// 1) VERIFIED bullish read, side forced BUY → drawable preview, honest geometry.
{
  const candles = uptrend();
  const p = buildSetupPreview(baseInput(candles, { requestedSide: "BUY" }));
  const lv = p.levels;
  const ok =
    lv != null &&
    (p.verdict === "tradeable" || p.verdict === "caution") &&
    p.side === "BUY" &&
    lv.sl < lv.entry &&
    lv.entry < lv.tp &&
    p.rewardToRisk != null &&
    p.rewardToRisk > 0 &&
    lv.invalidation === lv.sl &&
    p.status === "preview";
  record(
    "BUY preview draws honest entry/SL/TP + R:R",
    ok,
    lv
      ? `entry=${lv.entry} sl=${lv.sl} tp=${lv.tp} rr=${p.rewardToRisk} verdict=${p.verdict}`
      : "no levels",
  );
}

// 2) Forced SELL → mirrored geometry (TP < entry < SL).
{
  const candles = uptrend();
  const p = buildSetupPreview(baseInput(candles, { requestedSide: "SELL" }));
  const lv = p.levels;
  const ok =
    lv != null &&
    p.side === "SELL" &&
    lv.tp < lv.entry &&
    lv.entry < lv.sl &&
    p.rewardToRisk != null &&
    p.rewardToRisk > 0;
  record(
    "SELL preview mirrors geometry",
    ok,
    lv ? `entry=${lv.entry} sl=${lv.sl} tp=${lv.tp}` : "no levels",
  );
}

// 3) A preview is a drawing, NEVER an order: status preview + no riskAmount.
{
  const p = buildSetupPreview(baseInput(uptrend(), { requestedSide: "BUY" }));
  record(
    "preview is not an order (status=preview, no account-currency amounts)",
    p.status === "preview" &&
      p.riskAmount === null &&
      p.potentialReward === null,
    `status=${p.status} riskAmount=${p.riskAmount}`,
  );
}

// 4) Feed not VERIFIED → refused, no fabricated levels.
{
  const p = buildSetupPreview(
    baseInput(uptrend(), { requestedSide: "BUY", basis: "SYNCING" }),
  );
  record(
    "unverified feed → refused, no levels",
    p.verdict === "refused" && p.levels === null && p.side === null,
    `verdict=${p.verdict} levels=${p.levels === null ? "null" : "set"}`,
  );
}

// 5) INSUFFICIENT structural read → refused (no levels) even with VERIFIED basis.
{
  const candles = uptrend(10); // < MIN_BARS_FULL_READ → dataQuality insufficient
  const p = buildSetupPreview(baseInput(candles, { requestedSide: "BUY" }));
  record(
    "insufficient read → refused, no levels",
    p.verdict === "refused" && p.levels === null,
    `verdict=${p.verdict} dataQuality=${analyzeChartStructure(candles).dataQuality}`,
  );
}

// 6) Governance "rejected" → avoid, no levels.
{
  const p = buildSetupPreview(
    baseInput(uptrend(), {
      requestedSide: "BUY",
      governanceOutcome: "rejected",
    }),
  );
  record(
    "governance rejected → avoid, no levels",
    p.verdict === "avoid" && p.levels === null,
    `verdict=${p.verdict}`,
  );
}

// 7) No clean directional edge (flat) and no requested side → caution, no levels.
{
  const candles = flat();
  const p = buildSetupPreview(baseInput(candles)); // no requestedSide
  record(
    "no edge → caution, no fabricated levels",
    p.verdict === "caution" && p.levels === null && p.side === null,
    `verdict=${p.verdict} bias=${analyzeChartStructure(candles).bias}`,
  );
}

// 8) No balance → no account-currency risk math + honest note.
{
  const p = buildSetupPreview(
    baseInput(uptrend(), {
      requestedSide: "BUY",
      availableAllocation: null,
    }),
  );
  const ok =
    p.allocationKnown === false &&
    p.riskAmount === null &&
    p.potentialReward === null &&
    p.explanation.some((l) => /lot in the ticket/i.test(l));
  record(
    "no balance → no risk math + honest note",
    ok,
    `allocationKnown=${p.allocationKnown}`,
  );
}

// 9) Composite feed → indicative language, NEVER broker-native claim.
{
  const p = buildSetupPreview(
    baseInput(uptrend(), {
      requestedSide: "BUY",
      providerSource: compositeSource,
    }),
  );
  const text = p.explanation.join(" ");
  const ok =
    /not a broker-native quote/i.test(text) &&
    /indicative/i.test(text) &&
    !/broker-routed/i.test(text);
  record("composite feed → indicative, never broker-native", ok);
}

// 10) NO paper/demo wording anywhere in the explanation (all branches).
{
  const branches = [
    buildSetupPreview(baseInput(uptrend(), { requestedSide: "BUY" })),
    buildSetupPreview(
      baseInput(uptrend(), { requestedSide: "BUY", basis: "SYNCING" }),
    ),
    buildSetupPreview(
      baseInput(uptrend(), {
        requestedSide: "BUY",
        governanceOutcome: "rejected",
      }),
    ),
    buildSetupPreview(baseInput(flat())),
  ];
  const ok = branches.every((p) => explanationHasNoPaperDemo(p.explanation));
  record("no paper/demo wording in any branch", ok);
}

// 11) Explanation references the EXACT drawn levels (words match the chart).
{
  const p = buildSetupPreview(baseInput(uptrend(), { requestedSide: "BUY" }));
  const lv = p.levels!;
  const head = p.explanation[0] ?? "";
  const ok =
    head.includes(lv.entry.toString()) ||
    // levels are formatted to display decimals; match the formatted forms too
    p.explanation.some(
      (l) =>
        l.includes(lv.sl.toFixed(5)) ||
        l.includes(lv.sl.toFixed(4)) ||
        l.includes(lv.entry.toFixed(5)) ||
        l.includes(lv.entry.toFixed(4)),
    );
  record("explanation references the exact drawn levels", ok, head.slice(0, 80));
}

// 12) A REAL (non-null) governance input flips the verdict (Task #380). The
//     same VERIFIED bullish BUY that is "tradeable" with no governance becomes
//     "caution" when the trading team's outcome is "downgraded" — proving the
//     wired governance signal actually changes the drawn setup's verdict.
{
  const candles = uptrend();
  const baseline = buildSetupPreview(baseInput(candles, { requestedSide: "BUY" }));
  const governed = buildSetupPreview(
    baseInput(candles, {
      requestedSide: "BUY",
      governanceOutcome: "downgraded",
      governanceCautions: ["Risk agent wants this ranked lower."],
    }),
  );
  const ok =
    baseline.verdict === "tradeable" &&
    governed.verdict === "caution" &&
    governed.levels != null && // still a real drawing, just more cautious
    governed.governanceOutcome === "downgraded" &&
    governed.explanation.some((l) => /ranked lower/i.test(l));
  record(
    "real governance 'downgraded' flips tradeable → caution",
    ok,
    `baseline=${baseline.verdict} governed=${governed.verdict} gov=${governed.governanceOutcome}`,
  );
}

// 13) Real (non-null) scanner/flame/run-on/risk inputs are surfaced honestly on
//     the preview output (passthrough — never fabricated, never dropped).
{
  const p = buildSetupPreview(
    baseInput(uptrend(), {
      requestedSide: "BUY",
      scannerScore: 82,
      riskScore: 35,
      flameStage: "RUN_ON",
      runOnQuality: "strong",
    }),
  );
  const ok =
    p.scannerScore === 82 &&
    p.riskScore === 35 &&
    p.flameStage === "RUN_ON" &&
    p.runOnQuality === "strong" &&
    p.setupType === "Momentum scalp"; // flame stage drives momentum setup typing
  record(
    "real scanner/flame/run-on/risk inputs surface honestly",
    ok,
    `scanner=${p.scannerScore} risk=${p.riskScore} flame=${p.flameStage} setupType=${p.setupType}`,
  );
}

// ── summary ───────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
// eslint-disable-next-line no-console
console.log(
  `\nrubySetupPreviewTest: ${results.length - failed.length}/${results.length} passed`,
);
if (failed.length > 0) {
  // eslint-disable-next-line no-console
  console.error(
    `FAILED: ${failed.map((f) => f.name).join("; ")}`,
  );
  process.exit(1);
}

export {};

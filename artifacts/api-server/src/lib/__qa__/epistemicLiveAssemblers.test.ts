// Epistemic-deep live assemblers — consumer wiring + degrade-path proofs.
//
// Review fixes locked here (build/epistemic-deep review):
//   * Conformal flag honesty (HIGH): applyConformalAuthority has NO production
//     call site (runConfidenceGate has no live assembler), so a pressed
//     ARX_CONFORMAL_GATE_ENABLED must surface as a typed, LOUD no-op
//     (NO_OP_NOT_WIRED) — never a silent one, and never a log claiming an
//     armed veto. The boot call is pinned into index.ts and the owner doc is
//     pinned to say NOT WIRED.
//   * calibrationCurveService is genuinely consumed (GET
//     /admin/aaci/calibration-curve) and its failed-read degrade path is
//     PROVEN: an unreachable database yields INSUFFICIENT_HISTORY + typed
//     readError — never a synthesized curve.
//   * distributionOodService is genuinely consumed (GET
//     /admin/market-data/distribution-ood/:symbol); the assembly, the typed
//     insufficiency, and the UNREADABLE degrade path are proven via injected
//     history readers.
//
// OFFLINE: the dummy DATABASE_URL below points at a port nothing listens on —
// the connection failing IS the fixture.
//
// Run: pnpm --filter @workspace/api-server run test:epistemic-live-assemblers

process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(path.resolve(HERE, rel), "utf8");

const {
  conformalGateBootStatus,
  logConformalGateBootStatus,
  isConformalGateEnabled,
  resetConformalGateFlagLogState,
} = await import("../conformal/conformalGateFlag.js");
const { logger } = await import("../logger.js");
const { evaluateLiveDistributionOod, OOD_HISTORY_BARS } = await import(
  "../ood/distributionOodService.js"
);
const { getAaciCalibrationCurve, toConfidence01 } = await import(
  "../aaci/calibrationCurveService.js"
);

// ── Conformal press honesty ─────────────────────────────────────────────────

function withFlag<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env["ARX_CONFORMAL_GATE_ENABLED"];
  try {
    if (value === undefined) delete process.env["ARX_CONFORMAL_GATE_ENABLED"];
    else process.env["ARX_CONFORMAL_GATE_ENABLED"] = value;
    return fn();
  } finally {
    if (prev === undefined) delete process.env["ARX_CONFORMAL_GATE_ENABLED"];
    else process.env["ARX_CONFORMAL_GATE_ENABLED"] = prev;
  }
}

test("conformal boot status: unpressed → NONE; pressed → typed NO_OP_NOT_WIRED", () => {
  const off = withFlag(undefined, () => conformalGateBootStatus());
  assert.equal(off.pressed, false);
  assert.equal(off.effect, "NONE");

  const on = withFlag("true", () => conformalGateBootStatus());
  assert.equal(on.pressed, true);
  assert.equal(on.effect, "NO_OP_NOT_WIRED");
  assert.match(on.reason, /no production call site/i);
});

test("a pressed flag logs the NOT-WIRED truth, never an ARMED claim", () => {
  resetConformalGateFlagLogState();
  const captured: string[] = [];
  const target = logger as unknown as { warn: (...args: unknown[]) => void };
  const realWarn = target.warn.bind(logger);
  target.warn = (...args: unknown[]) => {
    for (const a of args) if (typeof a === "string") captured.push(a);
  };
  try {
    const status = withFlag("true", () => logConformalGateBootStatus());
    assert.equal(status.pressed, true);
    assert.equal(status.effect, "NO_OP_NOT_WIRED");
    const joined = captured.join(" | ");
    assert.match(joined, /conformal_gate_flag_SET_NOT_WIRED/);
    assert.match(joined, /changes NO behavior/i);
    assert.ok(!/conformal_gate_ARMED/.test(joined), "the log must not claim an armed veto");
  } finally {
    target.warn = realWarn;
    resetConformalGateFlagLogState();
  }
});

test("isConformalGateEnabled still reads env truthfully (boot status adds no authority)", () => {
  resetConformalGateFlagLogState();
  assert.equal(withFlag(undefined, () => isConformalGateEnabled()), false);
  assert.equal(withFlag("true", () => isConformalGateEnabled()), true);
  resetConformalGateFlagLogState();
});

test("boot visibility is wired: index.ts calls logConformalGateBootStatus", () => {
  const src = read("../../index.ts");
  assert.ok(
    src.includes("logConformalGateBootStatus()"),
    "index.ts must surface a pressed-but-unwired flag at boot",
  );
});

test("owner doc states the NOT-WIRED truth (no false certainty for the press)", () => {
  const doc = read("../../../../../docs/CONFORMAL_GATE_AUTHORITY.md");
  assert.match(doc, /Integration status: NOT WIRED/);
  assert.match(doc, /no\s+production call site/i);
  assert.match(doc, /conformal_gate_flag_SET_NOT_WIRED/);
});

// ── Calibration-curve service: consumer + proven degrade path ───────────────

test("toConfidence01 normalises 0..1 and 0..100, refuses garbage", () => {
  assert.equal(toConfidence01(0.62), 0.62);
  assert.equal(toConfidence01(62), 0.62);
  assert.equal(toConfidence01(1), 1);
  assert.equal(toConfidence01(0), 0);
  assert.equal(toConfidence01(101), null);
  assert.equal(toConfidence01(-0.1), null);
  assert.equal(toConfidence01(null), null);
  assert.equal(toConfidence01(Number.NaN), null);
});

test("unreadable DB degrades to INSUFFICIENT_HISTORY + typed readError — never a synthesized curve", async () => {
  // DATABASE_URL points at 127.0.0.1:1 — the read MUST fail.
  const report = await getAaciCalibrationCurve();
  assert.equal(report.curve.status, "INSUFFICIENT_HISTORY");
  assert.deepEqual(report.curve.bins, []);
  assert.equal(report.curve.samples, 0);
  assert.equal(report.source, "self_trade_executions_closed");
  assert.ok(report.readError && report.readError.length > 0, "readError must carry the typed reason");
  assert.match(report.curve.reason ?? "", /unreadable/);
});

test("calibration curve has a real consumer: GET /admin/aaci/calibration-curve", () => {
  const src = read("../../routes/aaci.ts");
  assert.ok(src.includes("/admin/aaci/calibration-curve"));
  assert.ok(src.includes("getAaciCalibrationCurve()"));
  // Admin-gated like its sibling admin endpoints.
  const routeIdx = src.indexOf("/admin/aaci/calibration-curve");
  const handler = src.slice(routeIdx, routeIdx + 1200);
  assert.ok(handler.includes("isAdminProductRole"), "route must be ADMIN/OWNER gated");
});

// ── Distribution-OOD service: assembly + typed degrade paths ────────────────

/** Deterministic LCG so the assembled history is real-shaped but repeatable. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function syntheticDeps(bars: number) {
  const rnd = lcg(42);
  const closes: { close: number }[] = [];
  let px = 1.1;
  for (let i = 0; i < bars; i++) {
    px = px * (1 + 0.002 * (rnd() - 0.5));
    closes.push({ close: px });
  }
  const spreads: number[] = [];
  for (let i = 0; i < 240; i++) spreads.push(0.0001 + 0.00005 * rnd());
  return {
    candles: (_s: string, _tf: string, limit: number) => ({ candles: closes.slice(-limit) }),
    spreadRelHistory: (_s: string) => spreads,
  };
}

test("live OOD assembly over full injected history → OK verdict, advisory-only", () => {
  const report = evaluateLiveDistributionOod("EURUSD", "M15", syntheticDeps(OOD_HISTORY_BARS));
  assert.equal(report.status, "OK");
  if (report.status !== "OK") return;
  assert.equal(report.verdict.advisoryOnly, true);
  assert.equal(report.verdict.status, "OK");
  if (report.verdict.status !== "OK") return;
  const features = report.verdict.perFeature.map((f) => f.feature).sort();
  assert.deepEqual(features, ["cost", "volatility"]);
});

test("thin history → the engine's typed INSUFFICIENT_EVIDENCE, never IN_DISTRIBUTION", () => {
  const thin = {
    candles: (_s: string, _tf: string, _l: number) => ({
      candles: [{ close: 1.1 }, { close: 1.1001 }, { close: 1.0999 }],
    }),
    spreadRelHistory: (_s: string) => [] as number[],
  };
  const report = evaluateLiveDistributionOod("EURUSD", "M15", thin);
  assert.equal(report.status, "OK");
  if (report.status !== "OK") return;
  assert.equal(report.verdict.status, "INSUFFICIENT_EVIDENCE");
  assert.equal(report.verdict.advisoryOnly, true);
});

test("a throwing history reader degrades to typed UNREADABLE — never a verdict", () => {
  const broken = {
    candles: (_s: string, _tf: string, _l: number): { candles: { close: number }[] } => {
      throw new Error("candle store exploded");
    },
    spreadRelHistory: (_s: string) => [] as number[],
  };
  const report = evaluateLiveDistributionOod("EURUSD", "M15", broken);
  assert.equal(report.status, "UNREADABLE");
  if (report.status !== "UNREADABLE") return;
  assert.match(report.reason, /candle store exploded/);
});

test("distribution OOD has a real consumer: GET /admin/market-data/distribution-ood/:symbol", () => {
  const src = read("../../routes/adminMarketDataDiagnostics.ts");
  assert.ok(src.includes("/admin/market-data/distribution-ood/:symbol"));
  assert.ok(src.includes("evaluateLiveDistributionOod(symbol, timeframe)"));
  const routeIdx = src.indexOf("/admin/market-data/distribution-ood/:symbol");
  const handler = src.slice(routeIdx, routeIdx + 900);
  assert.ok(handler.includes("requireAdmin(req, res)"), "route must be ADMIN/OWNER gated");
});

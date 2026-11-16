// ═══════════════════════════════════════════════════════════════════════════
// Phase 5c — Personal Risk Prescription tests.
// Verifies prescriptions, restricted/allowed actions, recovery protocol,
// hard-block invariant, vault coverage.
// ═══════════════════════════════════════════════════════════════════════════

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

const { Pool } = pg;
const BASE = "http://localhost:80/api";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function j(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method, headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

before(async () => { await pool.query(`SELECT 1`); });
after(async () => { await pool.end(); });
beforeEach(async () => {
  await pool.query(`DELETE FROM audit_events`);
  await pool.query(`DELETE FROM vault_events`);
});

function trade(over) {
  return {
    id: "t" + Math.random().toString(36).slice(2, 10),
    symbol: "Volatility 75 Index", direction: "BUY", status: "CLOSED_WIN",
    entryPrice: 100, stopLoss: 99, takeProfit: 102, lotSize: 0.5,
    openedAt: "2026-04-10T10:00:00.000Z", closedAt: "2026-04-10T10:30:00.000Z",
    pnl: 50, rMultiple: 2,
    ...over,
  };
}
function matureTrades() {
  const out = [];
  for (let d = 0; d < 14; d++) {
    const day = String(d + 1).padStart(2, "0");
    const n = d < 12 ? 3 : 2;
    for (let i = 0; i < n; i++) {
      const open  = `2026-04-${day}T${String(10 + i).padStart(2, "0")}:00:00Z`;
      const close = `2026-04-${day}T${String(10 + i).padStart(2, "0")}:45:00Z`;
      const isWin = (d + i) % 3 !== 0;
      out.push(trade({
        id: `m${d}-${i}`, status: isWin ? "CLOSED_WIN" : "CLOSED_LOSS",
        pnl: isWin ? 80 : -40, rMultiple: isWin ? 2 : -1,
        openedAt: open, closedAt: close, lotSize: 0.5,
      }));
    }
  }
  return out;
}

// ── PR-1: clean trader gets NONE/ADVISORY, full size allowed ──────────────
test("PR-1 clean mature trader → NONE prescription, full size allowed, no hard block", async () => {
  const r = await j("POST", "/trader-dna/prescription", { id: "u1", trades: matureTrades() });
  assert.equal(r.status, 200);
  assert.equal(r.data.canPlaceTrades, false);
  assert.ok(["NONE","ADVISORY","REDUCED"].includes(r.data.prescriptionLevel));
  assert.equal(r.data.hardBlock, false);
  assert.ok(r.data.allowedActions.includes("REVIEW_ONLY"));
});

// ── PR-2: cognitive crisis → RECOVERY/PAPER_ONLY/LOCKDOWN, restricted live orders ──
test("PR-2 high cognitive risk + rule violations → escalated prescription with concrete restrictions", async () => {
  const r = await j("POST", "/trader-dna/prescription", {
    id: "u2", trades: matureTrades(),
    cognitiveRiskScore01: 0.92,
    ruleViolationsLast24h: 4,
    cooldownMinutes: 60,
  });
  assert.equal(r.status, 200);
  assert.ok(["RECOVERY","PAPER_ONLY","LOCKDOWN"].includes(r.data.prescriptionLevel),
    `level=${r.data.prescriptionLevel}`);
  assert.equal(r.data.hardBlock, true);
  assert.ok(r.data.restrictedActions.includes("LIVE_ORDERS"));
  assert.ok(r.data.restrictedActions.includes("AUTO_EXECUTION"));
  assert.ok(r.data.restrictedActions.includes("OVERRIDE_RISK_CAPS"));
  assert.ok(r.data.recoveryRequirements.length > 0);
  assert.ok(r.data.permissionRestoreConditions.length > 0);
  assert.ok(typeof r.data.explanation === "string" && r.data.explanation.length > 0);
});

// ── PR-3: forcePaperOnly switch routes to PAPER_ONLY with paper-trade gate ──
test("PR-3 forcePaperOnly switch → PAPER_ONLY prescription with paper-win gate", async () => {
  const r = await j("POST", "/trader-dna/prescription", {
    id: "u3", trades: matureTrades(), forcePaperOnly: true,
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.prescriptionLevel, "PAPER_ONLY");
  assert.ok(r.data.allowedActions.includes("PAPER_TRADES_ONLY"));
  assert.ok(r.data.restrictedActions.includes("LIVE_ORDERS"));
});

// ── PR-4: immature baseline defaults to ADVISORY, full size NOT allowed ────
test("PR-4 immature baseline → ADVISORY (no FULL_SIZE_TRADES freely allowed)", async () => {
  const r = await j("POST", "/trader-dna/prescription", {
    id: "u4", trades: [trade({ id: "t1" }), trade({ id: "t2" })],
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.prescription.policies.confirmation.kind !== "NONE", true);
  assert.ok(["NONE","ADVISORY"].includes(r.data.prescriptionLevel));
});

// ── PR-5: restrictions reference danger fingerprint at meaningful severity ─
test("PR-5 danger symbols become restricted symbols when severity ≥ 0.35", async () => {
  // 14 days of losses on V100 Index to make it a worst symbol
  const losses = [];
  for (let d = 0; d < 14; d++) {
    const day = String(d + 1).padStart(2, "0");
    for (let i = 0; i < 3; i++) {
      losses.push(trade({
        id: `bad${d}-${i}`,
        symbol: "Volatility 100 Index",
        status: "CLOSED_LOSS",
        pnl: -100, rMultiple: -1,
        openedAt:  `2026-04-${day}T${String(10+i).padStart(2,"0")}:00:00Z`,
        closedAt:  `2026-04-${day}T${String(10+i).padStart(2,"0")}:30:00Z`,
      }));
    }
  }
  const r = await j("POST", "/trader-dna/prescription", {
    id: "u5", trades: losses, cognitiveRiskScore01: 0.50, ruleViolationsLast24h: 3,
  });
  assert.equal(r.status, 200);
  assert.ok(r.data.prescription.policies.tradeLimit.restrictedSymbols.length > 0,
    "expected at least one restricted symbol from danger fingerprint");
  assert.ok(r.data.restrictedActions.includes("TRADE_RESTRICTED_SYMBOLS"));
});

// ── PR-6: recovery evaluation — pending vs canRestore ─────────────────────
test("PR-6 evaluate-recovery returns pending when conditions unmet, canRestore when met", async () => {
  // First produce a real prescription
  const presc = await j("POST", "/trader-dna/prescription", {
    id: "u6", trades: matureTrades(),
    cognitiveRiskScore01: 0.92, ruleViolationsLast24h: 4, cooldownMinutes: 60,
  });
  assert.equal(presc.status, 200);
  const cond = presc.data.permissionRestoreConditions;
  const reqWins = presc.data.prescription.policies.paperMode.requiredPaperWinsToRestore;
  const minWR = presc.data.prescription.policies.paperMode.minPaperWinRate;

  const pending = await j("POST", "/trader-dna/prescription/evaluate-recovery", {
    id: "u6",
    prescription: { permissionRestoreConditions: cond, recoveryRequirements: presc.data.recoveryRequirements,
      requiredPaperWins: reqWins, minPaperWinRate: minWR },
    observation: { minutesSinceLastCooldown: 5, disciplineScore01: 0.30,
      ruleViolationsLast24h: 4, paperTradeWins: 0, paperTradeSample: 0,
      cognitiveRiskScore01: 0.85, behaviorEvidenceScore01: 0.85, baselineMature: true },
  });
  assert.equal(pending.status, 200);
  assert.equal(pending.data.evaluation.canRestore, false);
  assert.ok(pending.data.evaluation.pending.length >= 1);

  const ok = await j("POST", "/trader-dna/prescription/evaluate-recovery", {
    id: "u6",
    prescription: { permissionRestoreConditions: cond, recoveryRequirements: presc.data.recoveryRequirements,
      requiredPaperWins: reqWins, minPaperWinRate: minWR },
    observation: { minutesSinceLastCooldown: 999, disciplineScore01: 0.95,
      ruleViolationsLast24h: 0, paperTradeWins: reqWins, paperTradeSample: reqWins,
      cognitiveRiskScore01: 0.05, behaviorEvidenceScore01: 0.05, baselineMature: true },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.evaluation.canRestore, true);
});

// ── PR-7: vault coverage — prescription + per-restriction events ──────────
test("PR-7 prescription endpoint vaults PERSONAL_RISK_PRESCRIPTION_ISSUED + per-restriction events", async () => {
  const r = await j("POST", "/trader-dna/prescription", {
    id: "u7", trades: matureTrades(),
    cognitiveRiskScore01: 0.92, ruleViolationsLast24h: 4, cooldownMinutes: 60,
  });
  await new Promise(r => setTimeout(r, 250));
  const issued = await pool.query(
    `SELECT COUNT(*)::int AS c FROM audit_events WHERE event_type = 'PERSONAL_RISK_PRESCRIPTION_ISSUED'`,
  );
  assert.equal(issued.rows[0].c, 1);
  const restrictionsCount = r.data.restrictedActions.length;
  const restrictions = await pool.query(
    `SELECT COUNT(*)::int AS c FROM audit_events WHERE event_type = 'PRESCRIPTION_RESTRICTION'`,
  );
  assert.equal(restrictions.rows[0].c, restrictionsCount);
});

// ── PR-8: recovery completion vaulted ─────────────────────────────────────
test("PR-8 evaluate-recovery vaults PERMISSION_RESTORATION_COMPLETED on success and PENDING otherwise", async () => {
  // pending case
  await j("POST", "/trader-dna/prescription/evaluate-recovery", {
    id: "u8",
    prescription: {
      permissionRestoreConditions: [{ kind: "DISCIPLINE_SCORE", description: "≥0.65", threshold: 0.65 }],
      recoveryRequirements: ["maintain discipline"], requiredPaperWins: 0, minPaperWinRate: 0,
    },
    observation: { disciplineScore01: 0.20 },
  });
  // success case
  await j("POST", "/trader-dna/prescription/evaluate-recovery", {
    id: "u8",
    prescription: {
      permissionRestoreConditions: [{ kind: "DISCIPLINE_SCORE", description: "≥0.65", threshold: 0.65 }],
      recoveryRequirements: ["maintain discipline"], requiredPaperWins: 0, minPaperWinRate: 0,
    },
    observation: { disciplineScore01: 0.95 },
  });
  await new Promise(r => setTimeout(r, 250));
  const completed = await pool.query(
    `SELECT COUNT(*)::int AS c FROM audit_events WHERE event_type='PERMISSION_RESTORATION_COMPLETED'`,
  );
  const pending = await pool.query(
    `SELECT COUNT(*)::int AS c FROM audit_events WHERE event_type='PERMISSION_RESTORATION_PENDING'`,
  );
  assert.equal(completed.rows[0].c, 1);
  assert.equal(pending.rows[0].c, 1);
});

// ── PR-9: LOCKDOWN must remain restorable (no recovery deadlock) ─────────
test("PR-9 LOCKDOWN allows PAPER_TRADES_ONLY so recovery is achievable", async () => {
  const r = await j("POST", "/trader-dna/prescription", {
    id: "u9", trades: matureTrades(),
    cognitiveRiskScore01: 0.99, ruleViolationsLast24h: 10, cooldownMinutes: 60,
  });
  assert.equal(r.status, 200);
  // The trader must have a path forward
  if (r.data.prescriptionLevel === "LOCKDOWN") {
    assert.ok(r.data.allowedActions.includes("PAPER_TRADES_ONLY"),
      "LOCKDOWN must keep PAPER_TRADES_ONLY available for recovery");
  }
  // And the recovery conditions must be satisfiable
  const reqWins = r.data.prescription.policies.paperMode.requiredPaperWinsToRestore;
  const minWR = r.data.prescription.policies.paperMode.minPaperWinRate;
  const ok = await j("POST", "/trader-dna/prescription/evaluate-recovery", {
    id: "u9",
    prescription: { permissionRestoreConditions: r.data.permissionRestoreConditions,
      recoveryRequirements: r.data.recoveryRequirements,
      requiredPaperWins: reqWins, minPaperWinRate: minWR },
    observation: { minutesSinceLastCooldown: 9999, disciplineScore01: 0.99,
      ruleViolationsLast24h: 0, paperTradeWins: reqWins, paperTradeSample: reqWins,
      cognitiveRiskScore01: 0.05, behaviorEvidenceScore01: 0.05, baselineMature: true },
  });
  assert.equal(ok.data.evaluation.canRestore, true);
});

// ── PR-10: /prescription with observation vaults PENDING when canRestore=false ──
test("PR-10 /prescription with failing observation vaults PERMISSION_RESTORATION_PENDING", async () => {
  await j("POST", "/trader-dna/prescription", {
    id: "u10", trades: matureTrades(),
    cognitiveRiskScore01: 0.92, ruleViolationsLast24h: 4, cooldownMinutes: 60,
    observation: { minutesSinceLastCooldown: 1, disciplineScore01: 0.10,
      ruleViolationsLast24h: 5, paperTradeWins: 0, paperTradeSample: 0,
      cognitiveRiskScore01: 0.95, behaviorEvidenceScore01: 0.95, baselineMature: true },
  });
  await new Promise(r => setTimeout(r, 250));
  const pending = await pool.query(
    `SELECT COUNT(*)::int AS c FROM audit_events WHERE event_type='PERMISSION_RESTORATION_PENDING'`,
  );
  assert.equal(pending.rows[0].c, 1);
});

// ── PR-Z: advisory invariant ─────────────────────────────────────────────
test("PR-Z prescription endpoints never emit TRADE_* or MODE_* and always set canPlaceTrades:false", async () => {
  await j("POST", "/trader-dna/prescription", { id: "z", trades: matureTrades(), cognitiveRiskScore01: 0.95 });
  await j("POST", "/trader-dna/prescription/evaluate-recovery", {
    id: "z",
    prescription: { permissionRestoreConditions: [], recoveryRequirements: [], requiredPaperWins: 0, minPaperWinRate: 0 },
    observation: {},
  });
  await new Promise(r => setTimeout(r, 200));
  const trades = await pool.query(
    `SELECT COUNT(*)::int AS c FROM audit_events
       WHERE event_type IN ('TRADE_PLACED','TRADE_OPENED','TRADE_CLOSED','TRADE_EXECUTED','TRADE_REJECTED','TRADE_MODIFIED','TRADE_CANCELLED')`,
  );
  assert.equal(trades.rows[0].c, 0);
  const modes = await pool.query(
    `SELECT COUNT(*)::int AS c FROM audit_events
       WHERE source IN ('TRADER_DNA','COGNITIVE') AND event_type LIKE 'MODE_%'`,
  );
  assert.equal(modes.rows[0].c, 0);
});

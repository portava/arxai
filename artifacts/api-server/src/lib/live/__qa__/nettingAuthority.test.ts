// Capability #49 — netting-effect model + management-authority arbiter.
//
// Pins, offline (pure domain + source wiring pins):
//   NETTING
//   1. Cross-user offset detection: A long / B short the same symbol on one
//      master → offsetting, crossUserOffset, correct gross/net/offset lots.
//   2. Self-hedge is offsetting but NOT cross-user.
//   3. Malformed slices are rejected with typed reasons, never coerced or
//      silently dropped, and flag the symbol incomplete.
//   4. Determinism: identical input → identical output.
//   ARBITER
//   5. Risk-reduction dominance: a CLOSE claim beats a non-reducing claim
//      regardless of source.
//   6. Human dominance: the user's command beats an automated strategy's.
//   7. First-claim priority with total-order tie-break (claimedAt, commandId).
//   8. Default-deny: unknown source refuses; both-invalid → nobody wins.
//   9. Symmetry: swapping A/B never changes the winning commandId.
//   WIRING
//  10. liveCommandPipeline consults the arbiter at dispatch, journals every
//      adjudication (audit), refuses the losing incoming command, and never
//      traps a risk-reducing close (source pins).
//
// Run: node --import tsx --test src/lib/live/__qa__/nettingAuthority.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  detectNettingEffects,
  arbitrateManagementAuthority,
  claimSourceFromActorType,
  type ManagementClaim,
} from "@workspace/domain/live-position";

// ── Netting ────────────────────────────────────────────────────────────────

test("cross-user offset: A long vs B short the same symbol", () => {
  const r = detectNettingEffects([
    { userId: 1, symbol: "EURUSD", side: "BUY", volumeLots: 0.3 },
    { userId: 2, symbol: "EURUSD", side: "SELL", volumeLots: 0.2 },
    { userId: 3, symbol: "XAUUSD", side: "BUY", volumeLots: 0.1 },
  ]);
  assert.equal(r.crossUserOffsetDetected, true);
  const eur = r.perSymbol.find((s) => s.symbol === "EURUSD")!;
  assert.equal(eur.grossBuyLots, 0.3);
  assert.equal(eur.grossSellLots, 0.2);
  assert.equal(eur.netLots, 0.1);
  assert.equal(eur.offsetLots, 0.2);
  assert.equal(eur.offsetting, true);
  assert.equal(eur.crossUserOffset, true);
  const gold = r.perSymbol.find((s) => s.symbol === "XAUUSD")!;
  assert.equal(gold.offsetting, false);
  assert.equal(gold.crossUserOffset, false);
  assert.equal(r.totalGrossLots, 0.6);
  assert.equal(r.totalNetLots, 0.2); // |0.1| + |0.1|
  assert.equal(r.totalOffsetLots, 0.2);
});

test("self-hedge offsets but is not cross-user", () => {
  const r = detectNettingEffects([
    { userId: 7, symbol: "GBPUSD", side: "BUY", volumeLots: 0.5 },
    { userId: 7, symbol: "GBPUSD", side: "SELL", volumeLots: 0.5 },
  ]);
  const s = r.perSymbol[0]!;
  assert.equal(s.offsetting, true);
  assert.equal(s.offsetLots, 0.5);
  assert.equal(s.crossUserOffset, false);
  assert.equal(r.crossUserOffsetDetected, false);
});

test("malformed slices reject with typed reasons and flag the symbol incomplete", () => {
  const r = detectNettingEffects([
    { userId: 1, symbol: "EURUSD", side: "BUY", volumeLots: 0.1 },
    { userId: 1, symbol: "EURUSD", side: "LONG", volumeLots: 0.1 },      // bad side
    { userId: 1, symbol: "EURUSD", side: "SELL", volumeLots: Number.NaN }, // bad volume
    { userId: 0, symbol: "XAUUSD", side: "BUY", volumeLots: 0.1 },       // bad user
    { userId: 1, symbol: "", side: "BUY", volumeLots: 0.1 },             // bad symbol
  ]);
  assert.equal(r.rejectedSlices.length, 4);
  const reasons = r.rejectedSlices.map((x) => x.reason).sort();
  assert.deepEqual(reasons, [
    "SIDE_UNKNOWN", "SYMBOL_EMPTY", "USER_ID_INVALID", "VOLUME_NOT_FINITE",
  ].sort());
  const eur = r.perSymbol.find((s) => s.symbol === "EURUSD")!;
  assert.equal(eur.hasRejectedInput, true, "symbol totals must be flagged incomplete");
  assert.equal(eur.grossBuyLots, 0.1, "the valid slice still counts");
});

test("determinism: identical input → identical output", () => {
  const input = [
    { userId: 2, symbol: "EURUSD", side: "SELL", volumeLots: 0.2 },
    { userId: 1, symbol: "EURUSD", side: "BUY", volumeLots: 0.3 },
  ];
  assert.deepEqual(detectNettingEffects(input), detectNettingEffects(input));
});

// ── Arbiter ────────────────────────────────────────────────────────────────

const OWNER_ID = 42;
function claim(over: Partial<ManagementClaim>): ManagementClaim {
  return {
    commandId: "cmd-a",
    source: "USER_COMMAND",
    actorUserId: OWNER_ID,
    isRiskReducing: false,
    claimedAt: "2026-08-29T10:00:00.000Z",
    ...over,
  };
}

test("risk-reduction dominance: a close beats a non-reducing claim from any source", () => {
  const d = arbitrateManagementAuthority(
    claim({ commandId: "strategy-hold", source: "AUTOMATED_STRATEGY", isRiskReducing: false }),
    claim({ commandId: "user-close", source: "USER_COMMAND", isRiskReducing: true,
            claimedAt: "2026-08-29T11:00:00.000Z" }),
    OWNER_ID,
  );
  assert.equal(d.winner, "B");
  assert.equal(d.rule, "RISK_REDUCTION_DOMINANCE");

  // …and the strategy's close beats the user's non-reducing modify too.
  const d2 = arbitrateManagementAuthority(
    claim({ commandId: "user-modify", source: "USER_COMMAND", isRiskReducing: false }),
    claim({ commandId: "strategy-close", source: "AUTOMATED_STRATEGY", isRiskReducing: true }),
    OWNER_ID,
  );
  assert.equal(d2.winner, "B");
  assert.equal(d2.rule, "RISK_REDUCTION_DOMINANCE");
});

test("human dominance: the user's command beats the automated strategy's", () => {
  const d = arbitrateManagementAuthority(
    claim({ commandId: "strategy", source: "AUTOMATED_STRATEGY",
            claimedAt: "2026-08-29T09:00:00.000Z" }), // earlier!
    claim({ commandId: "user", source: "USER_COMMAND" }),
    OWNER_ID,
  );
  assert.equal(d.winner, "B", "human wins even against the earlier automated claim");
  assert.equal(d.rule, "HUMAN_DOMINANCE");
});

test("first-claim priority + deterministic tie-break", () => {
  const d = arbitrateManagementAuthority(
    claim({ commandId: "early", claimedAt: "2026-08-29T09:00:00.000Z" }),
    claim({ commandId: "late", claimedAt: "2026-08-29T10:00:00.000Z" }),
    OWNER_ID,
  );
  assert.equal(d.winner, "A");
  assert.equal(d.rule, "FIRST_CLAIM_PRIORITY");

  const tie = arbitrateManagementAuthority(
    claim({ commandId: "aaa" }),
    claim({ commandId: "bbb" }),
    OWNER_ID,
  );
  assert.equal(tie.winner, "A", "exact time tie breaks on lexicographic commandId");
});

test("default-deny: unknown source refuses; both invalid → nobody wins", () => {
  const d = arbitrateManagementAuthority(
    claim({ commandId: "stranger", source: "UNKNOWN" }),
    claim({ commandId: "user" }),
    OWNER_ID,
  );
  assert.equal(d.winner, "B");
  assert.equal(d.rule, "SINGLE_VALID_CLAIM");
  assert.ok(d.refusalsA.includes("SOURCE_UNKNOWN"));

  const none = arbitrateManagementAuthority(
    claim({ source: "UNKNOWN" }),
    claim({ commandId: "other-user", actorUserId: OWNER_ID + 1 }),
    OWNER_ID,
  );
  assert.equal(none.winner, null);
  assert.equal(none.rule, "NO_VALID_CLAIM");
  assert.ok(none.refusalsB.includes("ACTOR_NOT_POSITION_OWNER"));
});

test("symmetry: swapping A/B never changes the winning commandId", () => {
  const a = claim({ commandId: "strategy", source: "AUTOMATED_STRATEGY" });
  const b = claim({ commandId: "user", source: "USER_COMMAND" });
  const d1 = arbitrateManagementAuthority(a, b, OWNER_ID);
  const d2 = arbitrateManagementAuthority(b, a, OWNER_ID);
  assert.equal(d1.journal.winnerCommandId, d2.journal.winnerCommandId);
});

test("actor-type mapping is closed: strangers map to UNKNOWN (refused), never permissive", () => {
  assert.equal(claimSourceFromActorType("USER"), "USER_COMMAND");
  assert.equal(claimSourceFromActorType("ADMIN"), "ADMIN_OPERATOR");
  assert.equal(claimSourceFromActorType("OWNER"), "ADMIN_OPERATOR");
  assert.equal(claimSourceFromActorType("SELF_TRADE_AGENT"), "AUTOMATED_STRATEGY");
  assert.equal(claimSourceFromActorType("SYSTEM"), "AUTOMATED_STRATEGY");
  assert.equal(claimSourceFromActorType("EA"), "UNKNOWN");
  assert.equal(claimSourceFromActorType(null), "UNKNOWN");
});

// ── Wiring pins ────────────────────────────────────────────────────────────

test("dispatch pipeline consults the arbiter, journals, refuses the loser, never traps a close", () => {
  const pipeline = readFileSync(
    fileURLToPath(new URL("../liveCommandPipeline.ts", import.meta.url)),
    "utf8",
  );
  assert.ok(pipeline.includes("evaluateManagementAuthority"), "pipeline consults the arbiter");
  assert.ok(pipeline.includes("MANAGEMENT_AUTHORITY_ARBITRATED"),
    "every adjudication is journaled to the audit ledger");
  assert.ok(pipeline.includes("MANAGEMENT_AUTHORITY_CONTENTION"),
    "the losing incoming command is refused with a typed reason");

  const service = readFileSync(
    fileURLToPath(new URL("../managementAuthorityService.ts", import.meta.url)),
    "utf8",
  );
  assert.ok(service.includes('outcome: "PROCEED_ADVISORY"'),
    "a losing risk-reducing close degrades to a journaled advisory (never trapped)");
  assert.ok(service.includes("REFUSE-ONLY"),
    "the service documents (and the shape enforces) refuse-only semantics");
});

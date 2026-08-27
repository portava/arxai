// Phase 6 - DerivExecutionAdapter + execution tier certification.
//
// Covers the owner's adapter checks 17-24 and the tier rules: notSent stays
// distinguishable from timedOutAfterSend, rejection propagates accurately,
// UNKNOWN remains UNKNOWN, Tier 0 proves no frame is sent, and Tier 1 refuses a
// non-demo account.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DerivExecutionAdapter, DERIV_DEMO_VENUE_LITERAL, DERIV_REFUSALS,
  type DerivExecutionDeps,
} from "../../deriv/execution/derivExecutionAdapter.js";
import { isIndeterminateDelivery } from "../../live/executionAdapter.js";
import {
  resolveExecutionTier, tierPermitsVenueSend, tierPermitsRealMoney,
  tierPermitsUnattendedDispatch, EXECUTION_TIERS, DEFAULT_EXECUTION_TIER,
} from "@workspace/domain/safety-contracts/executionTier";

const CMD = { liveRow: { symbol: "R_100" } as never, bridgeUserId: 7, bridgeConnectionId: 1 };

function adapter(over: Partial<DerivExecutionDeps> = {}, calls: string[] = []) {
  const deps: DerivExecutionDeps = {
    tier: "TIER_1_DEMO_GUIDED",
    accountIsProvenDemo: true,
    persistIntent: async () => { calls.push("persistIntent"); return "intent_1"; },
    buyViaCertifiedTransport: async () => {
      calls.push("SEND");
      return { replied: true, wireWritten: true, contractId: "c1", venueRejection: null, detail: "ok" };
    },
    ...over,
  };
  return { a: new DerivExecutionAdapter(deps), calls };
}

// ── execution tier ─────────────────────────────────────────────────────────
test("an unset or unrecognised tier resolves to DRY RUN", () => {
  for (const raw of [
    null, undefined, "", "   ", "TIER_1", "1", "true", "TIER_1_DEMO_GUIDE",
    // A lowercase VALID tier is the value that exposes case-folding. "tier_1"
    // does not: it is invalid in any casing, so it cannot tell a strict matcher
    // from a case-insensitive one.
    "tier_1_demo_guided", "Tier_2_Demo_Supervised",
    // Padding and near-misses that a prefix or fuzzy matcher would accept.
    "TIER_1_DEMO_GUIDED_EXTRA", "XTIER_1_DEMO_GUIDED",
  ]) {
    const r = resolveExecutionTier(raw);
    assert.equal(r.tier, DEFAULT_EXECUTION_TIER, `${JSON.stringify(raw)} escalated to ${r.tier}`);
    assert.equal(r.requestedGranted, false);
    assert.ok(r.denyReason, "a refusal must always carry a reason");
  }
});

test("presence of a value is NEVER enough - only an exact literal grants a tier", () => {
  // The owner's rule: no path may escalate from an env var merely being set.
  // Truthy strings are the classic way that leaks in.
  for (const truthy of ["1", "yes", "on", "enabled", "TRUE"]) {
    assert.equal(resolveExecutionTier(truthy).tier, "TIER_0_DRY_RUN", `${truthy} escalated`);
  }
});

test("TIER_3 (live) and TIER_4 (autonomous) are REFUSED, not merely absent", () => {
  for (const denied of ["TIER_3_LIVE_GUIDED", "TIER_4_AUTONOMOUS"]) {
    const r = resolveExecutionTier(denied);
    assert.equal(r.tier, "TIER_0_DRY_RUN", `${denied} was granted`);
    assert.equal(r.requestedGranted, false);
    assert.match(r.denyReason ?? "", /not authorized/, `${denied} refused without naming a reason`);
    assert.equal(r.requested, denied, "the refused request must still be auditable");
  }
});

test("the demo tiers resolve, and only they permit a venue send", () => {
  assert.equal(resolveExecutionTier("TIER_1_DEMO_GUIDED").tier, "TIER_1_DEMO_GUIDED");
  assert.equal(resolveExecutionTier("TIER_2_DEMO_SUPERVISED").tier, "TIER_2_DEMO_SUPERVISED");
  assert.equal(tierPermitsVenueSend("TIER_0_DRY_RUN"), false);
  assert.equal(tierPermitsVenueSend("TIER_1_DEMO_GUIDED"), true);
  assert.equal(tierPermitsVenueSend("TIER_2_DEMO_SUPERVISED"), true);
  assert.equal(tierPermitsVenueSend("TIER_3_LIVE_GUIDED"), false);
  assert.equal(tierPermitsVenueSend("TIER_4_AUTONOMOUS"), false);
});

test("NO tier permits real money or unattended dispatch", () => {
  for (const t of EXECUTION_TIERS) {
    assert.equal(tierPermitsRealMoney(t), false, `${t} permitted real money`);
    assert.equal(tierPermitsUnattendedDispatch(t), false, `${t} permitted unattended dispatch`);
  }
});

// ── 25. Tier 0 proves NO frame is sent ─────────────────────────────────────
test("TIER 0: the adapter refuses before any frame is written", async () => {
  const { a, calls } = adapter({ tier: "TIER_0_DRY_RUN" });
  await assert.rejects(() => a.deliver(CMD), (e: Error) => {
    assert.ok(e.message.startsWith(DERIV_REFUSALS.TIER_FORBIDS_SEND), e.message);
    // A pre-transmission refusal is a DEFINITE failure, never indeterminate.
    assert.equal(isIndeterminateDelivery(e), false, "a dry run was reported as possibly-sent");
    return true;
  });
  assert.ok(!calls.includes("SEND"), "TIER 0 reached the transport");
  assert.ok(!calls.includes("persistIntent"), "TIER 0 persisted an intent it can never use");
});

// ── 26. Tier 1 refuses a real/live account ─────────────────────────────────
test("TIER 1 refuses an account that is not PROVEN demo", async () => {
  for (const notDemo of [false, undefined, null, "true"] as unknown[]) {
    const { a, calls } = adapter({ accountIsProvenDemo: notDemo as boolean });
    await assert.rejects(() => a.deliver(CMD), (e: Error) => {
      assert.ok(e.message.startsWith(DERIV_REFUSALS.ACCOUNT_NOT_PROVEN_DEMO), e.message);
      return true;
    }, `accountIsProvenDemo=${String(notDemo)} was allowed to send`);
    assert.ok(!calls.includes("SEND"), `a non-demo account reached the transport (${String(notDemo)})`);
  }
});

// ── the intent is durable BEFORE the write ─────────────────────────────────
test("the intent is persisted BEFORE the frame is written", async () => {
  const { a, calls } = adapter();
  await a.deliver(CMD);
  assert.deepEqual(calls, ["persistIntent", "SEND"],
    "the frame was written before a durable intent existed to correlate its reply");
});

test("a failure to persist the intent refuses BEFORE sending", async () => {
  const calls: string[] = [];
  const { a } = adapter({ persistIntent: async () => { throw new Error("db down"); } }, calls);
  await assert.rejects(() => a.deliver(CMD), (e: Error) => {
    assert.ok(e.message.startsWith(DERIV_REFUSALS.INTENT_NOT_PERSISTED), e.message);
    assert.equal(isIndeterminateDelivery(e), false, "a pre-send refusal was reported as possibly-sent");
    return true;
  });
  assert.ok(!calls.includes("SEND"), "sent a frame with no durable intent to correlate it");
});

test("an empty intent id is treated as no intent at all", async () => {
  const calls: string[] = [];
  const { a } = adapter({ persistIntent: async () => "   " }, calls);
  await assert.rejects(() => a.deliver(CMD), /INTENT_NOT_PERSISTED/);
  assert.ok(!calls.includes("SEND"));
});

// ── 17-19. success and rejection propagate accurately ──────────────────────
test("a venue reply with a contract id resolves with that handle", async () => {
  const { a } = adapter();
  const r = await a.deliver(CMD);
  assert.equal(r.contractId, "c1");
  assert.equal(r.transportRef, "c1", "transportRef must carry the venue handle");
  assert.equal(r.intentId, "intent_1", "the result must carry its intent for reconciliation");
  assert.equal(a.venue, DERIV_DEMO_VENUE_LITERAL);
});

test("a venue REJECTION is a definite failure, because a reply proves transmission", async () => {
  // Deriv cannot reject an order it never received, so an adjudicated rejection
  // is one of the few things we can fail closed on with certainty.
  const { a } = adapter({
    buyViaCertifiedTransport: async () => ({
      replied: true, wireWritten: true, contractId: null,
      venueRejection: "InsufficientBalance", detail: "rejected",
    }),
  });
  await assert.rejects(() => a.deliver(CMD), (e: Error) => {
    assert.ok(e.message.includes("InsufficientBalance"), "the venue's reason was lost");
    assert.equal(isIndeterminateDelivery(e), false, "a venue rejection was reported as UNKNOWN");
    return true;
  });
});

// ── 18. notSent stays distinguishable from timedOutAfterSend ───────────────
test("NOT TRANSMITTED is a definite failure; WRITTEN-then-silent is INDETERMINATE", async () => {
  const notSent = adapter({
    buyViaCertifiedTransport: async () => ({
      replied: false, wireWritten: false, contractId: null, venueRejection: null,
      detail: "socket closed before write",
    }),
  }).a;
  await assert.rejects(() => notSent.deliver(CMD), (e: Error) => {
    assert.equal(isIndeterminateDelivery(e), false,
      "a provably-unsent frame was held as UNKNOWN, stranding exposure for no reason");
    return true;
  });

  const sentSilent = adapter({
    buyViaCertifiedTransport: async () => ({
      replied: false, wireWritten: true, contractId: null, venueRejection: null,
      detail: "no reply in 15000ms",
    }),
  }).a;
  await assert.rejects(() => sentSilent.deliver(CMD), (e: unknown) => {
    assert.equal(isIndeterminateDelivery(e), true,
      "a written frame with no reply was reported as a definite failure - the order may exist");
    return true;
  });
});

// ── 21. UNKNOWN remains UNKNOWN ────────────────────────────────────────────
test("a reply with neither a contract id nor a rejection stays INDETERMINATE", async () => {
  // The tempting readings are both wrong: "no contract id means it failed" and
  // "no rejection means it worked". Neither is evidence.
  const { a } = adapter({
    buyViaCertifiedTransport: async () => ({
      replied: true, wireWritten: true, contractId: null, venueRejection: null, detail: "empty reply",
    }),
  });
  await assert.rejects(() => a.deliver(CMD), (e: unknown) => {
    assert.equal(isIndeterminateDelivery(e), true, "an unreadable reply was resolved to a verdict");
    return true;
  });
});

test("a blank contract id is not a contract id", async () => {
  const { a } = adapter({
    buyViaCertifiedTransport: async () => ({
      replied: true, wireWritten: true, contractId: "   ", venueRejection: null, detail: "blank",
    }),
  });
  await assert.rejects(() => a.deliver(CMD), (e: unknown) => isIndeterminateDelivery(e));
});

test("a transport THROW is indeterminate - a throw says nothing about transmission", async () => {
  const { a } = adapter({
    buyViaCertifiedTransport: async () => { throw new Error("ECONNRESET"); },
  });
  await assert.rejects(() => a.deliver(CMD), (e: unknown) => {
    assert.equal(isIndeterminateDelivery(e), true, "a transport throw was read as proof of non-delivery");
    return true;
  });
});

test("every indeterminate outcome carries the intent id reconciliation needs", async () => {
  for (const transport of [
    async () => { throw new Error("boom"); },
    async () => ({ replied: false, wireWritten: true, contractId: null, venueRejection: null, detail: "silent" }),
    async () => ({ replied: true, wireWritten: true, contractId: null, venueRejection: null, detail: "empty" }),
  ]) {
    const { a } = adapter({ buyViaCertifiedTransport: transport as never });
    await assert.rejects(() => a.deliver(CMD), (e: unknown) => {
      assert.equal(isIndeterminateDelivery(e), true);
      assert.equal((e as { intentRef: string | null }).intentRef, "intent_1",
        "an indeterminate delivery lost the intent id, so a late reply can never be correlated");
      return true;
    });
  }
});

test("the adapter never claims the MT5 EA bridge venue", () => {
  assert.notEqual(DERIV_DEMO_VENUE_LITERAL, "mt5_ea_bridge");
  assert.equal(adapter().a.venue, "deriv_demo");
});

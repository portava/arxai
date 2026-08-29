// Economic truth spine (#29/#30) — double-entry posting engine tests.
//
// THE invariant under test: every journal balances to zero, so the sum of
// ALL postings is zero, always — and a per-trade close's net cash effect
// equals the broker-reported net for that trade. Corrections are
// reverse-and-repost, never mutation. Unknown values are FLAGGED zeros,
// never silent ones.
//
// DB-free by design: the engine is pure (@workspace/accounting), and the
// persistence seams are pinned separately in economicReconciliation.test.ts.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Money } from "@workspace/money";
import {
  buildJournal, buildTradeOpenJournals, buildTradeCloseJournals,
  buildCorrectionJournals, checkBalanceInvariant, journalCashNet,
  leg, unknownLeg, JournalImbalanceError,
  type EconomicJournal, type PostingRowLike,
} from "@workspace/accounting";

const T0 = new Date("2026-08-29T10:00:00Z");
const T1 = new Date("2026-08-29T10:00:05Z");

function usd(v: string | number): Money {
  return Money.of(v, "USD");
}

/** Flatten journals into the persisted-row shape the invariant checker folds. */
function toRows(journals: readonly EconomicJournal[]): PostingRowLike[] {
  return journals.flatMap((j) => j.legs.map((l) => ({
    amountMinor: l.amount.minor,
    currency: l.amount.currency,
    scale: l.amount.scale,
    ledger: j.ledger,
  })));
}

describe("balanced postings (#30)", () => {
  it("accepts a balanced journal and freezes it", () => {
    const j = buildJournal({
      journalId: "ej_t1_pnl",
      ledger: "LIVE",
      kind: "TRADE_CLOSE_PNL",
      source: "LOCAL_EXECUTION",
      effectiveAt: T0,
      knownAt: T1,
      userId: 7,
      legs: [leg("BROKER_CASH", usd("123.45")), leg("REALIZED_PNL", usd("-123.45"))],
    });
    assert.equal(j.legs.length, 2);
    assert.ok(Object.isFrozen(j));
  });

  it("REFUSES an imbalanced journal — never plugs the difference", () => {
    assert.throws(() => buildJournal({
      journalId: "ej_bad",
      ledger: "LIVE",
      kind: "TRADE_CLOSE_PNL",
      source: "LOCAL_EXECUTION",
      effectiveAt: T0,
      knownAt: T1,
      userId: 7,
      legs: [leg("BROKER_CASH", usd("100.00")), leg("REALIZED_PNL", usd("-99.99"))],
    }), JournalImbalanceError);
  });

  it("REFUSES mixed currencies rather than coercing", () => {
    assert.throws(() => buildJournal({
      journalId: "ej_fx",
      ledger: "LIVE",
      kind: "TRADE_CLOSE_PNL",
      source: "LOCAL_EXECUTION",
      effectiveAt: T0,
      knownAt: T1,
      userId: 7,
      legs: [leg("BROKER_CASH", usd("10.00")), leg("REALIZED_PNL", Money.of("-10.00", "EUR"))],
    }), JournalImbalanceError);
  });

  it("REFUSES a single-legged journal and an unknown account", () => {
    assert.throws(() => buildJournal({
      journalId: "ej_one",
      ledger: "LIVE", kind: "TRADE_CLOSE_PNL", source: "LOCAL_EXECUTION",
      effectiveAt: T0, knownAt: T1, userId: 7,
      legs: [leg("BROKER_CASH", usd("0"))],
    }), JournalImbalanceError);
    assert.throws(() => buildJournal({
      journalId: "ej_acct",
      ledger: "LIVE", kind: "TRADE_CLOSE_PNL", source: "LOCAL_EXECUTION",
      effectiveAt: T0, knownAt: T1, userId: 7,
      legs: [
        { account: "SLUSH_FUND" as never, amount: usd("1"), valueUnknown: false },
        leg("BROKER_CASH", usd("-1")),
      ],
    }), JournalImbalanceError);
  });

  it("sum(all postings) === 0 across many journals, per ledger partition", () => {
    const journals = [
      ...buildTradeOpenJournals({
        journalIdBase: "ej_a_open", ledger: "LIVE", source: "BROKER_EVENT",
        effectiveAt: T0, knownAt: T1, userId: 1, currency: "USD", fee: null,
      }),
      ...buildTradeCloseJournals({
        journalIdBase: "ej_a_close", ledger: "LIVE", source: "LOCAL_EXECUTION",
        effectiveAt: T0, knownAt: T1, userId: 1, currency: "USD",
        realizedPnl: usd("57.20"), fee: usd("2.50"), funding: usd("-0.10"),
      }),
      ...buildTradeOpenJournals({
        journalIdBase: "ej_demo_open", ledger: "DEMO", source: "BROKER_EVENT",
        effectiveAt: T0, knownAt: T1, userId: 1, currency: "USD", stake: usd("10.00"),
      }),
    ];
    const check = checkBalanceInvariant(toRows(journals));
    assert.equal(check.balanced, true);
    // Live and demo partitions are summed SEPARATELY — demo money never mixes.
    assert.ok(Object.keys(check.totals).some((k) => k.startsWith("LIVE:")));
    assert.ok(Object.keys(check.totals).some((k) => k.startsWith("DEMO:")));
  });

  it("the invariant checker detects an injected imbalance (mutation proof)", () => {
    const rows = toRows(buildTradeCloseJournals({
      journalIdBase: "ej_m", ledger: "LIVE", source: "LOCAL_EXECUTION",
      effectiveAt: T0, knownAt: T1, userId: 1, currency: "USD",
      realizedPnl: usd("10.00"),
    }));
    rows.push({ amountMinor: 1n, currency: "USD", scale: 2, ledger: "LIVE" });
    assert.equal(checkBalanceInvariant(rows).balanced, false);
  });

  it("per-trade net cash equals the broker-reported net", () => {
    // Broker statement fixture: gross P&L 123.45, commission 2.50, swap 0.75,
    // net = 120.20. The ledger's BROKER_CASH movement must equal that net.
    const brokerReportedNet = usd("120.20");
    const journals = buildTradeCloseJournals({
      journalIdBase: "ej_net", ledger: "LIVE", source: "LOCAL_EXECUTION",
      effectiveAt: T0, knownAt: T1, userId: 3, currency: "USD",
      realizedPnl: usd("123.45"), fee: usd("2.50"), funding: usd("0.75"),
      brokerTicket: "555001", commandId: "cmd-net",
    });
    const cashNet = journals
      .map((j) => journalCashNet(j))
      .reduce((a, b) => a.add(b));
    assert.equal(cashNet.equals(brokerReportedNet), true);
  });
});

describe("honest UNKNOWN postings", () => {
  it("an unknown fee posts a FLAGGED zero pair — never a silent zero", () => {
    const [feeJournal] = buildTradeOpenJournals({
      journalIdBase: "ej_u", ledger: "LIVE", source: "BROKER_EVENT",
      effectiveAt: T0, knownAt: T1, userId: 2, currency: "USD", fee: null,
    });
    assert.ok(feeJournal);
    assert.equal(feeJournal!.kind, "TRADE_OPEN_FEE");
    for (const l of feeJournal!.legs) {
      assert.equal(l.valueUnknown, true);
      assert.equal(l.amount.isZero(), true);
    }
    assert.ok(feeJournal!.legs.some((l) => l.account === "UNKNOWN_SUSPENSE"));
  });

  it("an UNREPORTED fee posts NOTHING (absence of an event is not an event)", () => {
    const journals = buildTradeCloseJournals({
      journalIdBase: "ej_nofee", ledger: "LIVE", source: "LOCAL_EXECUTION",
      effectiveAt: T0, knownAt: T1, userId: 2, currency: "USD",
      realizedPnl: usd("5.00"), // fee/funding undefined
    });
    assert.equal(journals.length, 1);
    assert.equal(journals[0]!.kind, "TRADE_CLOSE_PNL");
  });

  it("REFUSES an unknown-flagged leg carrying a claimed value", () => {
    assert.throws(() => buildJournal({
      journalId: "ej_lying_unknown",
      ledger: "LIVE", kind: "TRADE_OPEN_FEE", source: "BROKER_EVENT",
      effectiveAt: T0, knownAt: T1, userId: 2,
      legs: [
        { account: "FEES_EXPENSE", amount: usd("3.00"), valueUnknown: true },
        leg("BROKER_CASH", usd("-3.00")),
      ],
    }), JournalImbalanceError);
  });

  it("unknown realized P&L at close posts flagged, not zero-claimed", () => {
    const [pnl] = buildTradeCloseJournals({
      journalIdBase: "ej_upnl", ledger: "LIVE", source: "LOCAL_EXECUTION",
      effectiveAt: T0, knownAt: T1, userId: 2, currency: "USD",
      realizedPnl: null,
    });
    assert.ok(pnl!.legs.every((l) => l.valueUnknown && l.amount.isZero()));
  });
});

describe("bitemporal corrections (#29) — reverse and repost, never UPDATE", () => {
  const original = buildTradeCloseJournals({
    journalIdBase: "ej_orig", ledger: "LIVE", source: "LOCAL_EXECUTION",
    effectiveAt: T0, knownAt: T1, userId: 4, currency: "USD",
    realizedPnl: usd("50.00"),
  })[0]!;

  const [reversal, repost] = buildCorrectionJournals({
    original,
    correctedLegs: [leg("BROKER_CASH", usd("48.75")), leg("REALIZED_PNL", usd("-48.75"))],
    correctedSource: "BROKER_STATEMENT",
    knownAt: new Date("2026-08-30T02:00:00Z"),
    correctionIdBase: "ej_orig_corr",
  });

  it("the reversal negates every leg and NAMES what it reverses", () => {
    assert.equal(reversal.kind, "CORRECTION_REVERSAL");
    assert.equal(reversal.reversesJournalId, original.journalId);
    const combined = checkBalanceInvariant(toRows([original, reversal]));
    assert.equal(combined.balanced, true);
    // original + reversal individually cancel account by account:
    const cash = original.legs[0]!.amount.add(reversal.legs[0]!.amount);
    assert.equal(cash.isZero(), true);
  });

  it("the repost carries the corrected figures and everything still balances", () => {
    assert.equal(repost.kind, "CORRECTION_REPOST");
    const all = checkBalanceInvariant(toRows([original, reversal, repost]));
    assert.equal(all.balanced, true);
    assert.equal(journalCashNet(repost).equals(usd("48.75")), true);
  });

  it("bitemporal axes: effectiveAt stays the ORIGINAL economic time; knownAt is the correction time", () => {
    assert.equal(reversal.effectiveAt.getTime(), original.effectiveAt.getTime());
    assert.equal(repost.effectiveAt.getTime(), original.effectiveAt.getTime());
    assert.ok(reversal.knownAt.getTime() > original.knownAt.getTime());
  });

  it("correction of an UNKNOWN journal preserves the unknown flags (reversing an unknown is still unknown)", () => {
    const unknownOriginal = buildJournal({
      journalId: "ej_uo", ledger: "LIVE", kind: "TRADE_OPEN_FEE", source: "BROKER_EVENT",
      effectiveAt: T0, knownAt: T1, userId: 4,
      legs: [unknownLeg("FEES_EXPENSE", "USD"), unknownLeg("UNKNOWN_SUSPENSE", "USD")],
    });
    const [rev, rep] = buildCorrectionJournals({
      original: unknownOriginal,
      correctedLegs: [leg("FEES_EXPENSE", usd("1.20")), leg("BROKER_CASH", usd("-1.20"))],
      correctedSource: "BROKER_STATEMENT",
      knownAt: new Date("2026-08-30T02:00:00Z"),
      correctionIdBase: "ej_uo_corr",
    });
    assert.ok(rev.legs.every((l) => l.valueUnknown));
    assert.ok(rep.legs.every((l) => !l.valueUnknown));
  });

  it("a CORRECTION_REVERSAL without reversesJournalId is refused", () => {
    assert.throws(() => buildJournal({
      journalId: "ej_anon_rev", ledger: "LIVE", kind: "CORRECTION_REVERSAL",
      source: "BROKER_STATEMENT", effectiveAt: T0, knownAt: T1, userId: 4,
      legs: [leg("BROKER_CASH", usd("1")), leg("REALIZED_PNL", usd("-1"))],
    }), JournalImbalanceError);
  });
});

describe("demo ledger partition", () => {
  it("a demo stake journal moves cash into OPEN_POSITIONS on the DEMO partition only", () => {
    const [stake] = buildTradeOpenJournals({
      journalIdBase: "ej_demo", ledger: "DEMO", source: "BROKER_EVENT",
      effectiveAt: T0, knownAt: T1, userId: 9, currency: "USD", stake: usd("25.00"),
    });
    assert.equal(stake!.ledger, "DEMO");
    assert.equal(stake!.kind, "TRADE_OPEN_STAKE");
    assert.equal(journalCashNet(stake!).equals(usd("-25.00")), true);
    const open = stake!.legs.find((l) => l.account === "OPEN_POSITIONS");
    assert.ok(open && open.amount.equals(usd("25.00")));
  });
});

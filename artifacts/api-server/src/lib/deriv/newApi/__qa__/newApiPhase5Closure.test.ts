// Phase 5 closure certification.
//
// Certifies the exact crash/recovery lifecycle that exposed the false-absence
// defect, plus the control cases that bound it. Every case here is offline;
// no order is placed and none can be.
//
// The lifecycle under certification:
//
//   issued buy -> venue executes -> ARX crashes -> the contract CLOSES while
//   ARX is down -> it leaves the portfolio -> statement still records the buy
//   -> ARX restarts -> recovery consults the evidence -> ARX MUST NOT report
//   NO_TRADE.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  recoverDerivIntents, type DerivOrderIntent, type DerivVenueEvidence,
} from "../orderIntent.js";
import type { ArxStatementBuy } from "../wire.js";

const NOW = new Date("2026-08-26T12:00:00Z");
const T = (ms: number) => NOW.getTime() + ms;
const SEC = (ms: number) => Math.floor(T(ms) / 1000);

/** An order whose frame the transport CONFIRMED writing, then the process died. */
const crashedIntent = (over: Partial<DerivOrderIntent> = {}): DerivOrderIntent => ({
  intentId: "i-1", accountId: "VRTC9001", symbol: "R_100",
  contractType: "MULTUP", stake: 1, multiplier: 100,
  createdAtMs: T(-11 * 60_000), frameWrittenAtMs: T(-10 * 60_000),
  writeDisposition: "WRITTEN", outcome: null, ...over,
});

const evidence = (over: Partial<DerivVenueEvidence> = {}): DerivVenueEvidence => ({
  openContracts: [], portfolioReadAtMs: T(-1_000), closedInclusive: false,
  statementBuys: [], lateReplies: [], evidenceComplete: true, ...over,
});

const stmt = (over: Partial<ArxStatementBuy> = {}): ArxStatementBuy => ({
  contractId: 777, transactionId: 9001, transactionTimeSec: SEC(-9 * 60_000),
  shortcode: "MULTUP_R_100_1.00_0", amount: -1, ...over,
});

const run = (i: DerivOrderIntent, v: DerivVenueEvidence) =>
  recoverDerivIntents([i], v, { now: NOW })[0]!;

/** Did recovery claim no order was ever placed? */
const claimedNoTrade = (r: ReturnType<typeof run>): boolean =>
  r.action === "NO_ORDER_PLACED"
  || (r.action === "RESOLVED" && r.verdict.action === "RESOLVE_ABSENT");

// ════════════════════════════════════════════════════════════════════════════
// PRIMARY REGRESSION — the exact lifecycle that exposed the defect
// ════════════════════════════════════════════════════════════════════════════

test("LIFECYCLE: executed, closed while ARX was down, gone from portfolio — NOT no-trade", () => {
  // The contract executed and then closed (a multiplier stop-out needs no
  // action from ARX, and ARX is dead by construction here). It is therefore
  // absent from `portfolio`, which returns OUTSTANDING contracts only. The
  // statement still records the buy, and that is the evidence that must win.
  const r = run(crashedIntent(), evidence({
    openContracts: [],                 // closed: no longer outstanding
    portfolioReadAtMs: T(-1_000),
    closedInclusive: true,             // a statement read was performed
    statementBuys: [stmt()],           // ...and it found the executed buy
  }));
  assert.ok(!claimedNoTrade(r),
    `reported no-trade for an executed order: ${JSON.stringify(r)}`);
});

// ════════════════════════════════════════════════════════════════════════════
// CONTROLS
// ════════════════════════════════════════════════════════════════════════════

test("CONTROL 1: portfolio absence WITHOUT a closed-inclusive source stays UNRESOLVED", () => {
  const r = run(crashedIntent(), evidence({ closedInclusive: false, statementBuys: [] }));
  assert.ok(!claimedNoTrade(r));
  assert.equal(r.action, "RESOLVED");
  if (r.action === "RESOLVED") assert.equal(r.verdict.action, "HOLD");
});

test("CONTROL 2: absence WITH a valid closed-inclusive source showing nothing MAY resolve", () => {
  // Only here is a no-execution conclusion legitimate: the venue was asked a
  // question that CAN see a closed contract, and answered with nothing.
  const r = run(crashedIntent(), evidence({ closedInclusive: true, statementBuys: [] }));
  assert.equal(r.action, "RESOLVED");
  if (r.action === "RESOLVED") assert.equal(r.verdict.action, "RESOLVE_ABSENT");
});

test("CONTROL 3: statement evidence WINS over portfolio absence", () => {
  const withStatement = run(crashedIntent(), evidence({
    closedInclusive: true, statementBuys: [stmt()],
  }));
  const withoutStatement = run(crashedIntent(), evidence({
    closedInclusive: true, statementBuys: [],
  }));
  assert.ok(!claimedNoTrade(withStatement), "statement evidence was ignored");
  assert.ok(claimedNoTrade(withoutStatement), "control did not resolve absent");
});

test("CONTROL 4: a statement row missing identity FAILS CLOSED, never attached by guesswork", () => {
  // No shortcode means no symbol — a statement transaction carries no
  // underlying_symbol at all. ARX must not decide it is ours, and must not
  // decide it is not.
  const r = run(crashedIntent(), evidence({
    closedInclusive: true, statementBuys: [stmt({ shortcode: null })],
  }));
  assert.ok(!claimedNoTrade(r), "an unidentifiable row was reasoned past into absence");
});

test("CONTROL 5: a statement row for a DIFFERENT symbol does not reconcile to this order", () => {
  const r = run(crashedIntent(), evidence({
    closedInclusive: true,
    statementBuys: [stmt({ contractId: 999, shortcode: "MULTUP_R_50_1.00_0" })],
  }));
  // A different instrument is a non-match, so absence remains provable.
  assert.ok(claimedNoTrade(r), "attached another instrument's transaction to this order");
});

test("CONTROL 6: identity assertions survive restart — an ALREADY-RESOLVED order is not re-litigated", () => {
  // Correlation after a restart rests on the durable record, not on transport
  // state, which does not survive.
  const filled = run(
    crashedIntent({ outcome: { kind: "CONTRACT", contractId: 777 } }),
    evidence({ closedInclusive: true, statementBuys: [stmt()] }),
  );
  assert.equal(filled.action, "ALREADY_RESOLVED");
  const refused = run(
    crashedIntent({ outcome: { kind: "VENUE_REFUSED", derivCode: "InsufficientBalance" } }),
    evidence({ closedInclusive: true, statementBuys: [stmt()] }),
  );
  assert.equal(refused.action, "ALREADY_RESOLVED");
});

test("CONTROL 7: a contract closed while ARX was down produces NO instruction to sell it", () => {
  // Recovery classifies. It must never emit an action, and least of all a
  // close for a position that is already closed.
  const r = run(crashedIntent(), evidence({
    closedInclusive: true, statementBuys: [stmt()],
  }));
  const blob = JSON.stringify(r).toLowerCase();
  for (const forbidden of ["sell", "close_position", "\"buy\""]) {
    assert.ok(!blob.includes(forbidden), `recovery emitted an instruction: ${forbidden}`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// PURITY, PROVEN BY EXECUTION
// ════════════════════════════════════════════════════════════════════════════
//
// A source grep cannot establish this. The earlier textual assertion passed
// while the module could not load at all without DATABASE_URL, because the
// dependency was transitive. These prove the property by doing it.

test("PURITY: the classifier imports and RUNS with DATABASE_URL unset", async () => {
  const { execFileSync } = await import("node:child_process");
  const pkgRoot = new URL("../../../../../", import.meta.url).pathname;
  const modulePath = new URL("../../../live/unknownClassifier.ts", import.meta.url).pathname;

  // A child process with the variable REMOVED from the environment entirely —
  // not set empty, removed — importing the module and performing a real
  // classification.
  // The child reports through a FILE, not stdout. `no-console-in-server`
  // forbids console.* in this tree and it scans source text, so the call would
  // be flagged inside this script string. Disguising it would be bypassing a
  // guard; a file is simply the right channel here.
  const { writeFileSync: _w, readFileSync: rf, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const outFile = `${tmpdir()}/arx-purity-classifier-${process.pid}.txt`;
  const script = `
    const { writeFileSync } = await import("node:fs");
    const m = await import(${JSON.stringify(modulePath)});
    const v = m.classifyUnknownCommand(
      { commandId: "c", commandType: "PLACE_LIVE_MARKET_ORDER", status: "LIVE_UNKNOWN",
        symbol: "R_100", side: "BUY", requestedVolume: 1, brokerTicket: null,
        sentToMt5At: new Date(0), pickedByEaAt: null, expiresAt: null },
      { positions: [], lateResults: [], lastCompleteSnapshotAt: null, evidenceComplete: true },
      { now: new Date(1000) },
    );
    writeFileSync(${JSON.stringify(outFile)}, "VERDICT:" + v.action + ":" + (v.reason ?? ""));
  `;
  const env = { ...process.env };
  delete env["DATABASE_URL"];
  try {
    execFileSync(process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      { cwd: pkgRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    const out = rf(outFile, "utf8");
    assert.match(out, /VERDICT:HOLD:NO_COMPLETE_SNAPSHOT/,
      `classifier did not run without a database: ${out}`);
  } finally {
    rmSync(outFile, { force: true });
  }
});

test("PURITY: the recovery module imports and RUNS with DATABASE_URL unset", async () => {
  const { execFileSync } = await import("node:child_process");
  const pkgRoot = new URL("../../../../../", import.meta.url).pathname;
  const modulePath = new URL("../orderIntent.ts", import.meta.url).pathname;
  const { readFileSync: rf, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const outFile = `${tmpdir()}/arx-purity-recovery-${process.pid}.txt`;
  const script = `
    const { writeFileSync } = await import("node:fs");
    const m = await import(${JSON.stringify(modulePath)});
    const out = m.recoverDerivIntents(
      [{ intentId: "i", accountId: "a", symbol: "R_100", contractType: "MULTUP",
         stake: 1, multiplier: 100, createdAtMs: 1, frameWrittenAtMs: null,
         writeDisposition: "REFUSED_PRE_TRANSMISSION", outcome: null }],
      { openContracts: [], portfolioReadAtMs: null, closedInclusive: false,
        statementBuys: [], lateReplies: [], evidenceComplete: true },
    );
    writeFileSync(${JSON.stringify(outFile)}, "ACTION:" + out[0].action);
  `;
  const env = { ...process.env };
  delete env["DATABASE_URL"];
  try {
    execFileSync(process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      { cwd: pkgRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    const out = rf(outFile, "utf8");
    assert.match(out, /ACTION:NO_ORDER_PLACED/, `recovery did not run without a database: ${out}`);
  } finally {
    rmSync(outFile, { force: true });
  }
});

// Test: trust REAL close evidence, not just the broker's OK code (task #401).
//
// Two honesty rules are codified here:
//
//   Rule 1 — close resolution requires real evidence:
//     A live close is only "done" when the position's `closedAt` is stamped
//     AND the bridge close command reached a terminal CLOSED/FILLED status
//     carrying an empty/absent error reason — INDEPENDENT of the retcode
//     value. A broker success code (e.g. 10009) alone is never proof, and a
//     terminal-success command that still carries POSITION_NOT_FOUND (or any
//     error reason) is never proof.
//
//   Rule 2 — a missing close fill price keeps realised P/L UNKNOWN:
//     The close-fill validator never fabricates / zero-fills a P/L when the
//     EA omits a valid close fill price.
//
// Pure unit test — no DB, no network — so it is safe to wire into CI via the
// in-process runner.

import {
  resolveLiveCloseConfirmation,
  isLiveCloseConfirmed,
  isPositionClosed,
  isTerminalSuccessStatus,
  hasCloseErrorReason,
} from "../../artifacts/api-server/src/lib/live/closeConfirmation.js";
import {
  computeRealizedPnlUsd,
  isRealizedPnlIngestible,
  PNL_DATA_QUALITY_MISSING_CLOSE_FILL,
} from "../../artifacts/api-server/src/lib/live/realizedPnl.js";
import { FX_STANDARD_LOT_UNITS } from "../../artifacts/api-server/src/lib/mt5/contractSize.js";
import { isEntrypoint, type CiTestResultLike } from "./ci/inProcessAppHarness.js";

export async function run(): Promise<CiTestResultLike> {
  let failures = 0;
  let passes = 0;

  function assert(cond: boolean, label: string) {
    if (cond) { passes++; console.log(`  ✓ ${label}`); }
    else { failures++; console.error(`  ✗ ${label}`); }
  }

  console.log("liveCloseEvidenceTest");
  console.log("=====================\n");

  // ── Helper predicates ────────────────────────────────────────────────────
  console.log("isPositionClosed — only a real closed-at stamp counts");
  assert(isPositionClosed(new Date()) === true, "Date → closed");
  assert(isPositionClosed("2026-06-09T00:00:00Z") === true, "ISO string → closed");
  assert(isPositionClosed(null) === false, "null → not closed");
  assert(isPositionClosed(undefined) === false, "undefined → not closed");
  assert(isPositionClosed("") === false, "empty string → not closed");

  console.log("\nisTerminalSuccessStatus — recognized terminal-success only");
  assert(isTerminalSuccessStatus("LIVE_FILLED") === true, "LIVE_FILLED → success");
  assert(isTerminalSuccessStatus("live_filled") === true, "case-insensitive");
  assert(isTerminalSuccessStatus("CLOSED") === true, "CLOSED → success");
  assert(isTerminalSuccessStatus("SENT_TO_MT5_LIVE") === false, "SENT → not terminal success");
  assert(isTerminalSuccessStatus("LIVE_REJECTED") === false, "LIVE_REJECTED → not success");
  assert(isTerminalSuccessStatus(null) === false, "null → not success");

  console.log("\nhasCloseErrorReason — any error field disqualifies");
  assert(hasCloseErrorReason({ rejectionReason: "POSITION_NOT_FOUND" }) === true, "rejectionReason set");
  assert(hasCloseErrorReason({ errorCode: "10027" }) === true, "errorCode set");
  assert(hasCloseErrorReason({ errorMessage: "boom" }) === true, "errorMessage set");
  assert(hasCloseErrorReason({ rejectionReason: "", errorCode: null, errorMessage: "  " }) === false, "all blank → no error");

  // ── Rule 1: close resolution requires real evidence ──────────────────────
  console.log("\nRule 1 — Fixture A: retcode 10009 + terminal success but closedAt NULL");
  {
    // The bridge said 10009 (success) and the command is LIVE_FILLED, but the
    // position was never stamped closed → POSITION_NOT_FOUND-style phantom.
    const r = resolveLiveCloseConfirmation({
      positionClosedAt: null,
      commandStatus: "LIVE_FILLED",
      mt5Retcode: 10009,
    });
    assert(r.closeConfirmed === false, "NOT confirmed on retcode alone");
    assert(r.reason === "POSITION_NOT_CLOSED", `reason=POSITION_NOT_CLOSED (got ${r.reason})`);
  }

  console.log("\nRule 1 — Fixture B: retcode 10009 + LIVE_FILLED + POSITION_NOT_FOUND reason + closedAt set");
  {
    // closedAt is somehow set, but the command still carries an error reason —
    // we MUST NOT treat this as a clean close.
    const r = resolveLiveCloseConfirmation({
      positionClosedAt: new Date(),
      commandStatus: "LIVE_FILLED",
      rejectionReason: "POSITION_NOT_FOUND",
      mt5Retcode: 10009,
    });
    assert(r.closeConfirmed === false, "NOT confirmed while an error reason is attached");
    assert(r.reason === "COMMAND_HAS_ERROR_REASON", `reason=COMMAND_HAS_ERROR_REASON (got ${r.reason})`);
  }

  console.log("\nRule 1 — Fixture C: closedAt set + LIVE_FILLED + no error reason → CONFIRMED");
  {
    const r = resolveLiveCloseConfirmation({
      positionClosedAt: new Date(),
      commandStatus: "LIVE_FILLED",
      rejectionReason: null,
      errorCode: null,
      errorMessage: null,
      mt5Retcode: 10009,
    });
    assert(r.closeConfirmed === true, "confirmed only with closedAt + terminal success + no error");
    assert(r.reason === "CONFIRMED", `reason=CONFIRMED (got ${r.reason})`);
  }

  console.log("\nRule 1 — Fixture D: retcode value is IRRELEVANT (retcode 0 still confirms on evidence)");
  {
    // retcode 0 normally looks like a local CTrade failure, but the verdict
    // must depend on evidence, not the code. closedAt set + terminal + clean.
    const r = resolveLiveCloseConfirmation({
      positionClosedAt: new Date(),
      commandStatus: "CLOSED",
      mt5Retcode: 0,
    });
    assert(r.closeConfirmed === true, "confirmed independent of retcode value (0)");

    // And the inverse: a "good" retcode 10009 with NO evidence stays unconfirmed.
    const bad = resolveLiveCloseConfirmation({
      positionClosedAt: null,
      commandStatus: "SENT_TO_MT5_LIVE",
      mt5Retcode: 10009,
    });
    assert(bad.closeConfirmed === false, "good retcode + no evidence → still NOT confirmed");
  }

  console.log("\nRule 1 — Fixture E: retcode null + clean evidence → CONFIRMED");
  {
    const r = resolveLiveCloseConfirmation({
      positionClosedAt: "2026-06-09T12:00:00Z",
      commandStatus: "LIVE_CLOSED",
      mt5Retcode: null,
    });
    assert(r.closeConfirmed === true, "null retcode does not block a clean close");
  }

  console.log("\nRule 1 — Fixture F: closedAt set but command not terminal → NOT confirmed");
  {
    const r = resolveLiveCloseConfirmation({
      positionClosedAt: new Date(),
      commandStatus: "SENT_TO_MT5_LIVE",
      mt5Retcode: 10009,
    });
    assert(r.closeConfirmed === false, "NOT confirmed while command still in flight");
    assert(r.reason === "COMMAND_NOT_TERMINAL_SUCCESS", `reason=COMMAND_NOT_TERMINAL_SUCCESS (got ${r.reason})`);
    assert(isLiveCloseConfirmed({ positionClosedAt: new Date(), commandStatus: "SENT_TO_MT5_LIVE" }) === false,
      "isLiveCloseConfirmed convenience wrapper agrees");
  }

  // ── Rule 2: a missing close fill price keeps realised P/L UNKNOWN ─────────
  console.log("\nRule 2 — Fixture G: missing close fill price → P/L UNKNOWN, never fabricated");
  {
    const r = computeRealizedPnlUsd({
      side: "BUY", requestedVolume: 0.01,
      openFillPrice: 1.05000, closeFillPrice: undefined,
      // EURUSD standard lot on a USD account: 100,000 units, quote ccy == account ccy.
      contractSize: FX_STANDARD_LOT_UNITS, quoteToAccountFx: 1,
    });
    assert(r.pnlStatus === "UNKNOWN", `pnlStatus=UNKNOWN (got ${r.pnlStatus})`);
    assert(r.realizedPlUsd === null, "realizedPlUsd is null (never zero-filled)");
    assert(r.dataQualityFlag === PNL_DATA_QUALITY_MISSING_CLOSE_FILL, "flag=MISSING_CLOSE_FILL_PRICE");
    assert(isRealizedPnlIngestible({ pnlStatus: r.pnlStatus, realizedPlUsd: r.realizedPlUsd }) === false,
      "UNKNOWN row is NOT ingestible downstream");
  }

  console.log("\nRule 2 — Fixture H: close fill price = 0 → P/L UNKNOWN (not a real fill)");
  {
    const r = computeRealizedPnlUsd({
      side: "SELL", requestedVolume: 0.01,
      openFillPrice: 1.05000, closeFillPrice: 0,
      // EURUSD standard lot on a USD account: 100,000 units, quote ccy == account ccy.
      contractSize: FX_STANDARD_LOT_UNITS, quoteToAccountFx: 1,
    });
    assert(r.pnlStatus === "UNKNOWN", `pnlStatus=UNKNOWN (got ${r.pnlStatus})`);
    assert(r.realizedPlUsd === null, "realizedPlUsd is null (0 is never a fill)");
    assert(r.dataQualityFlag === PNL_DATA_QUALITY_MISSING_CLOSE_FILL, "flag=MISSING_CLOSE_FILL_PRICE");
  }

  console.log("\nRule 2 — Fixture I: valid close fill price → P/L COMPUTED");
  {
    // 0.01 lot * 100_000 * (1.05100 - 1.05000) = 1.00 USD for a BUY
    const r = computeRealizedPnlUsd({
      side: "BUY", requestedVolume: 0.01,
      openFillPrice: 1.05000, closeFillPrice: 1.05100,
      // EURUSD standard lot on a USD account: 100,000 units, quote ccy == account ccy.
      contractSize: FX_STANDARD_LOT_UNITS, quoteToAccountFx: 1,
    });
    assert(r.pnlStatus === "COMPUTED", `pnlStatus=COMPUTED (got ${r.pnlStatus})`);
    assert(r.realizedPlUsd === 1.00, `realizedPlUsd=1.00 (got ${r.realizedPlUsd})`);
    assert(isRealizedPnlIngestible({ pnlStatus: r.pnlStatus, realizedPlUsd: r.realizedPlUsd }) === true,
      "COMPUTED row IS ingestible downstream");
  }

  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "liveCloseEvidenceTest", passes, failures };
}

if (isEntrypoint(import.meta.url)) {
  run().then(
    (r) => process.exit(r.failures > 0 ? 1 : 0),
    (err) => {
      console.error("[liveCloseEvidenceTest] FAILED:", err);
      process.exit(1);
    },
  );
}

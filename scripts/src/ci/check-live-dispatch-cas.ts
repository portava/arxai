// CI guard — live-dispatch-cas (P0-1: live-dispatch double-send race)
//
// WHY THIS EXISTS
//   `dispatchLiveCommand` reads the command row, evaluates all 18 Phase B
//   gates, and then UPDATEs the row to SENT_TO_MT5_LIVE. That read-then-write
//   is a TOCTOU window: two concurrent dispatches of the same LIVE_APPROVED
//   command both observe status=LIVE_APPROVED, both pass all 23 gates (no gate
//   asks "has this already been sent"), and — if the UPDATE matches on
//   `command_id` ALONE — both succeed and both mirror an order into the
//   `mt5_commands` mailbox the EA polls. The broker then executes the same
//   trade TWICE. Real money.
//
//   The `arx_live_commands_idem_active_uq` idempotency index CANNOT catch
//   this: it constrains INSERTs of distinct rows, and this race UPDATEs one
//   row twice. The compare-and-set predicate on `status` is the only fix.
//
//   The same defect existed on the confirm transition
//   (LIVE_CONFIRMATION_REQUIRED → LIVE_APPROVED).
//
// WHAT THIS ASSERTS (source-scan). The behavioural counterpart is
// `artifacts/api-server/src/lib/live/__qa__/liveDispatchDoubleSendRace.test.ts`,
// run in the `ci` lane by `scripts/src/ci/run-live-dispatch-race-db.ts`. That
// test fires 12 concurrent claims at one command and asserts exactly one wins;
// against the pre-fix predicate all 12 won.
//
//   1. `claimLiveCommandForDispatch` predicates on status = LIVE_APPROVED.
//   2. `claimLiveCommandForConfirm` predicates on status =
//      LIVE_CONFIRMATION_REQUIRED.
//   3. Both carry the commandId predicate too (a status-only match would hit
//      every approved command at once).
//   4. The pipeline routes both transitions through those claims and no
//      longer writes either status with a bare commandId-only `.where`.
//   5. The dispatch race-lost refusal returns BEFORE the EA mailbox mirror,
//      so a loser cannot put a second order in front of the broker.
//   6. Every `dispatchLiveCommand(` call site in `routes/meLive.ts` is wrapped
//      in `withTxAdvisoryLock(ARX_LOCK_NS.USER_SUBMIT, ...)`, and a refused
//      lock surfaces the precise USER_SUBMIT_LOCKED reason.
//
// Weakening any of these re-opens a double-send path to the broker.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { reportResult, ROOT, type CheckResult } from "./_lib.js";

function read(p: string): string { return readFileSync(join(ROOT, p), "utf-8"); }

const CAS = "artifacts/api-server/src/lib/live/liveCommandCas.ts";
const PIPELINE = "artifacts/api-server/src/lib/live/liveCommandPipeline.ts";
const ME_LIVE = "artifacts/api-server/src/routes/meLive.ts";

/** Strip line + block comments so policy prose cannot satisfy a code assertion. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

export function checkLiveDispatchCas(): CheckResult {
  const violations: string[] = [];
  const notes: string[] = [];

  // ── 1-3. The CAS primitives are status-predicated. ────────────────────────
  const cas = stripComments(read(CAS));

  const claims: Array<{ fn: string; status: string }> = [
    { fn: "claimLiveCommandForDispatch", status: "LIVE_APPROVED" },
    { fn: "claimLiveCommandForConfirm", status: "LIVE_CONFIRMATION_REQUIRED" },
  ];
  for (const { fn, status } of claims) {
    const body = new RegExp(
      `export async function ${fn}[\\s\\S]{0,900}?\\.where\\(([\\s\\S]{0,400}?)\\)\\s*\\n?\\s*\\.returning\\(\\)`,
    ).exec(cas);
    if (!body) {
      violations.push(
        `${CAS}: could not locate ${fn}'s .where(...).returning() block — the CAS guard cannot ` +
        `verify itself. Re-point this guard before shipping.`,
      );
      continue;
    }
    const where = body[1] ?? "";
    if (!new RegExp(`eq\\(\\s*arxLiveCommandsTable\\.status\\s*,\\s*"${status}"\\s*\\)`).test(where)) {
      violations.push(
        `${CAS}: ${fn} must compare-and-set on eq(arxLiveCommandsTable.status, "${status}"). ` +
        `Matching on commandId alone lets concurrent callers BOTH claim the command — for ` +
        `dispatch that means two EA orders and a broker double-fill.`,
      );
    }
    if (!/eq\(\s*arxLiveCommandsTable\.commandId\s*,/.test(where)) {
      violations.push(`${CAS}: ${fn} lost its commandId predicate (a status-only match would hit every row in that state).`);
    }
  }
  if (violations.length === 0) notes.push("both CAS claims are (commandId AND status) predicated ✓");

  // ── 4. The pipeline uses the claims, not a bare commandId update. ─────────
  const pipeline = stripComments(read(PIPELINE));
  for (const fn of ["claimLiveCommandForDispatch", "claimLiveCommandForConfirm"]) {
    if (!new RegExp(`\\b${fn}\\s*\\(`).test(pipeline)) {
      violations.push(`${PIPELINE}: must transition through ${fn}() rather than an inline update.`);
    }
  }
  // No unpredicated write of either transition status may reappear inline.
  // Every `status: "<transition>"` update payload in the pipeline must be an
  // argument to a claim helper, never to a raw `db.update(...).set(...)`.
  const WINDOW = 260;
  for (const status of ["SENT_TO_MT5_LIVE", "LIVE_APPROVED"]) {
    const occurrences = [...pipeline.matchAll(new RegExp(`status:\\s*"${status}"`, "g"))];
    if (occurrences.length === 0) {
      violations.push(`${PIPELINE}: no transition into ${status} found at all — re-point this guard.`);
      continue;
    }
    for (const m of occurrences) {
      const before = pipeline.slice(Math.max(0, m.index - WINDOW), m.index);
      const line = pipeline.slice(0, m.index).split("\n").length;
      if (before.includes("db.update(")) {
        violations.push(
          `${PIPELINE}:~${line} — a status:"${status}" payload is being written by a raw ` +
          `db.update(...).set(...). Every transition into ${status} must go through the ` +
          `status-predicated CAS helper, or two concurrent callers can both win it.`,
        );
      } else if (!before.includes("claimLiveCommandFor")) {
        violations.push(
          `${PIPELINE}:~${line} — a status:"${status}" payload is not an argument to a ` +
          `claimLiveCommandFor* CAS helper.`,
        );
      }
    }
    notes.push(`${status}: ${occurrences.length} transition site(s), all routed through the CAS ✓`);
  }

  // ── 5. The race-lost refusal returns before the EA mailbox mirror. ────────
  const casIdx = pipeline.indexOf("claimLiveCommandForDispatch(");
  const raceLostIdx = pipeline.indexOf("reason: LIVE_DISPATCH_RACE_LOST");
  const mirrorIdx = pipeline.indexOf("enqueueBridgedMt5Command({");
  if (casIdx < 0 || raceLostIdx < 0 || mirrorIdx < 0) {
    violations.push(
      `${PIPELINE}: expected the dispatch claim, the LIVE_DISPATCH_RACE_LOST refusal, and the ` +
      `enqueueBridgedMt5Command mirror to all be present in dispatchLiveCommand ` +
      `(claim=${casIdx}, refusal=${raceLostIdx}, mirror=${mirrorIdx}).`,
    );
  } else if (!(casIdx < raceLostIdx && raceLostIdx < mirrorIdx)) {
    violations.push(
      `${PIPELINE}: the LIVE_DISPATCH_RACE_LOST refusal must sit BETWEEN the dispatch claim and ` +
      `the enqueueBridgedMt5Command mirror, so a dispatcher that lost the race returns WITHOUT ` +
      `mirroring an order to the EA mailbox.`,
    );
  } else {
    notes.push("race-lost refusal returns before the EA mailbox mirror ✓");
  }
  if (!/releaseReservation/.test(pipeline.slice(raceLostIdx > 0 ? casIdx : 0, raceLostIdx > 0 ? raceLostIdx : 1))) {
    violations.push(
      `${PIPELINE}: the race-lost path must release the master exposure reservation — otherwise ` +
      `the shared master stays attributed lots for an order this caller never sent.`,
    );
  }

  // ── 6. meLive.ts dispatch sites are serialized per user. ──────────────────
  const meLiveRaw = read(ME_LIVE);
  const meLive = stripComments(meLiveRaw);
  const dispatchCalls = (meLive.match(/\bdispatchLiveCommand\s*\(/g) ?? []).length;
  const lockUses = (meLive.match(/\bwithUserSubmitLock\s*\(/g) ?? []).length;
  if (dispatchCalls === 0) {
    violations.push(`${ME_LIVE}: expected at least one dispatchLiveCommand( call site.`);
  }
  if (!/withTxAdvisoryLock\(\s*ARX_LOCK_NS\.USER_SUBMIT/.test(meLive)) {
    violations.push(
      `${ME_LIVE}: the per-user submit lock must be taken with ` +
      `withTxAdvisoryLock(ARX_LOCK_NS.USER_SUBMIT, ...).`,
    );
  }
  if (lockUses < dispatchCalls) {
    violations.push(
      `${ME_LIVE}: ${dispatchCalls} dispatchLiveCommand( call site(s) but only ${lockUses} ` +
      `withUserSubmitLock( scope(s) — every live dispatch route must serialize a single user's ` +
      `concurrent submissions.`,
    );
  }
  if (!/USER_SUBMIT_LOCKED/.test(meLive)) {
    violations.push(
      `${ME_LIVE}: a route that cannot take the USER_SUBMIT lock must surface the precise ` +
      `USER_SUBMIT_LOCKED reason rather than silently proceeding or hanging.`,
    );
  }
  notes.push(`${ME_LIVE}: ${dispatchCalls} dispatch call site(s), ${lockUses} per-user lock scope(s)`);

  return {
    name: "live-dispatch-cas",
    ok: violations.length === 0,
    violations,
    notes,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkLiveDispatchCas();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}

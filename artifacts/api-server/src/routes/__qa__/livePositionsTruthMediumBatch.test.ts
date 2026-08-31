// Truth-system guards for the LIVE POSITIONS / OPEN TRADES / trade-history
// batch (medium-severity findings, fixed 2026-08-31).
//
// WHAT WAS WRONG (one confident-lie family, four surfaces):
//
//   1. meLiveAccount.ts collapsed a null floatingPl to 0 into the wire's
//      grossProfit/netProfit, so a live position whose P/L never synced
//      rendered as "Current P/L $0.00" instead of "—". The UI's fmtMoney
//      handled null honestly but never received one.
//   2. mePositionsUnified.ts hid live rows on a RELATIVE stale-floor (newest
//      row − 90s) with no snapshot-reliability check and no warning, so a real
//      open broker position could show on OpenLivePositions (flagged
//      "confirming…") yet silently vanish from the chart-side picker —
//      reading as closed/gone. This diverged from the canonical
//      positionFreshness rule the sibling surfaces enforce.
//   3. livePositions.ts (legacy /positions/sync reconciler) marked any
//      mirrored row missing from ONE mt5_state.positions read as
//      MANUALLY_CLOSED + closedAt, with no snapshot-reliability guard — one
//      lagging/partial EA push closed rows still open at the broker, which
//      then displayed "Closed" with confidence.
//   4. trades.ts POST /execute-trade, under LIVE_TRADING mode with an
//      API-supplied confirmationId, inserted a mode='LIVE' OPEN trades row and
//      replied "LIVE trade executed." with NO broker placement anywhere in the
//      route — a phantom live position on the Live Trades surface.
//
// WHY SOURCE SCANS: each invariant is a property of the handlers' SHAPE
// (which literal lands on the wire, which guard precedes which mutation), and
// the handlers do nothing but read/write PostgreSQL — the offline lane cannot
// run them. A scan pins the exact honest shape so a regression fails the build.
//
// Run: node --import tsx --test src/routes/__qa__/livePositionsTruthMediumBatch.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(HERE, rel), "utf8");

/** Source with comment-only lines stripped, so prose about the old defect can
 *  never satisfy (or trip) a code assertion. */
function code(rel: string): string {
  return read(rel)
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

// ── 1. slot-summary: null P/L stays null on the wire ───────────────────────

test("slot-summary never collapses a never-synced floatingPl to 0", () => {
  const src = code("../meLiveAccount.ts");
  assert.match(
    src,
    /p\.floatingPl != null \? Number\(p\.floatingPl\) : null/,
    "floating must degrade to null (unknown), not 0 (a confident flat claim)",
  );
  assert.doesNotMatch(
    src,
    /p\.floatingPl != null \? Number\(p\.floatingPl\) : 0/,
    "the null→0 collapse is back — an unsynced P/L would render as $0.00",
  );
  assert.match(
    src,
    /grossProfit: floating as number \| null/,
    "grossProfit must carry the nullable floating value to the wire",
  );
  assert.match(
    src,
    /netProfit: floating as number \| null/,
    "netProfit must carry the nullable floating value to the wire",
  );
});

test("slot-summary excludes unknown P/L from openPnL and flags the total", () => {
  const src = code("../meLiveAccount.ts");
  assert.match(src, /let openPnLIncomplete = false/, "openPnLIncomplete flag missing");
  assert.match(
    src,
    /if \(floating != null\) openPnL \+= floating;\s*\n\s*else openPnLIncomplete = true;/,
    "a null floating must be EXCLUDED from openPnL and flag the total incomplete — never summed as 0",
  );
  assert.match(src, /openPnLIncomplete,/, "openPnLIncomplete must be emitted in the response");
});

// ── 2. unified feed shares the canonical freshness rule ────────────────────

test("unified positions feed uses positionFreshness, not an ad-hoc relative floor", () => {
  const src = code("../mePositionsUnified.ts");
  assert.match(src, /from "\.\.\/lib\/live\/positionFreshness\.js"/, "canonical module not imported");
  assert.match(src, /isSnapshotReliable\(/, "snapshot reliability check missing");
  assert.match(src, /classifyRow\(/, "canonical per-row classification missing");
  assert.match(
    src,
    /brokerConfirmedAbsent/,
    "rows must be hidden ONLY when broker-confirmed absent by a reliable snapshot",
  );
  for (const adHoc of [/liveFloor/, /newestLiveSync/]) {
    assert.doesNotMatch(
      src,
      adHoc,
      "the ad-hoc relative stale-floor is back — it hid open positions on staleness alone",
    );
  }
  assert.match(
    src,
    /lastPositionsSnapshotAt/,
    "reliability must come from the bridge's complete-sweep marker, same as /api/me/live/positions",
  );
  assert.match(
    src,
    /POSITION_SYNC_INCOMPLETE_WARNING/,
    "the shared snapshotWarning copy must be emitted when the snapshot is unreliable",
  );
  assert.match(src, /snapshotWarning,\s*\n\s*snapshotReliable,/, "warning fields missing from the response");
});

// ── 3. legacy reconciler: vanish→closed needs a reliable snapshot ──────────

test("legacy /positions/sync only closes vanished rows on a RELIABLE feed snapshot", () => {
  const src = code("../livePositions.ts");
  assert.match(src, /import \{ isSnapshotReliable \} from "\.\.\/lib\/live\/positionFreshness\.js"/,
    "canonical reliability helper not imported");
  assert.match(src, /isSnapshotReliable\(lastSyncAtMs,/, "feed reliability must be computed from mt5_state.last_sync_at");

  // The vanished-row loop must branch on reliability BEFORE the terminal stamp.
  const loop = /for \(const row of openish\) \{([\s\S]*?)\n  \}/.exec(src);
  assert.ok(loop, "vanished-row loop not found — did syncFromBroker get restructured?");
  const body = loop![1]!;
  const guardIdx = body.indexOf("!snapshotReliable");
  const closeIdx = body.indexOf('"MANUALLY_CLOSED"');
  assert.ok(guardIdx >= 0, "no snapshot-reliability guard inside the vanish loop");
  assert.ok(closeIdx >= 0, "MANUALLY_CLOSED transition not found in the vanish loop");
  assert.ok(
    guardIdx < closeIdx,
    "the reliability guard must run BEFORE the MANUALLY_CLOSED stamp",
  );

  // The unreliable branch parks the row as SYNC_PENDING and must NOT invent a
  // closedAt the broker never produced.
  const pendingBranch = body.slice(guardIdx, closeIdx);
  assert.match(pendingBranch, /"SYNC_PENDING"/, "unreliable-feed fallback must be SYNC_PENDING, not a close");
  assert.doesNotMatch(
    pendingBranch,
    /closedAt/,
    "the SYNC_PENDING fallback must not stamp closedAt — that fabricates a broker close",
  );
});

// ── 4. /execute-trade can never record a phantom LIVE trade ────────────────

test("execute-trade refuses LIVE outright — no broker placement exists on this route", () => {
  const src = code("../trades.ts");
  const refusal = src.indexOf("if (isEffectivelyLive) {");
  const insert = src.indexOf("db.insert(tradesTable)");
  assert.ok(refusal >= 0, "the LIVE truth-guard refusal is missing");
  assert.ok(insert >= 0, "trades insert not found — did the route get restructured?");
  assert.ok(refusal < insert, "the LIVE refusal must come BEFORE the trades insert");
  assert.match(
    src,
    /res\.status\(501\)\.json\(/,
    "LIVE must answer 501 not-implemented — broker placement does not exist here",
  );
  assert.match(
    src,
    /broker placement not implemented/,
    "the refusal must state plainly that no broker placement exists",
  );
});

test("execute-trade structurally inserts DEMO-only rows and keeps the checklist default-deny", () => {
  const src = code("../trades.ts");
  assert.match(src, /mode: "DEMO",/, "the insert must be structurally DEMO-only");
  assert.doesNotMatch(
    src,
    /mode:\s*gate\.decisionMode === "LIVE" \? "LIVE" : "DEMO"/,
    "the conditional LIVE insert is back — a mode='LIVE' row here is a fabricated live position",
  );
  assert.doesNotMatch(src, /mode:\s*"LIVE"/, "no code path may insert a LIVE-marked trades row on this route");
  // The Pre-Trade-Checklist confirmationId requirement is the documented
  // default-deny (components/execution/index.ts) and must survive the refusal.
  assert.match(
    src,
    /isEffectivelyLive && typeof body\.confirmationId !== "number"/,
    "the LIVE confirmationId requirement (default-deny) must stay",
  );
});

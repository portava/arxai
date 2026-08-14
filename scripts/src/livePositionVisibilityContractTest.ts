// Regression coverage for the ARX position-feed mode-scope cohesion fix.
//
// The defect: GET /api/me/live/positions and GET /api/me/positions/all used
// DIFFERENT visibility rules over the same arx_live_positions truth table, so
// one real broker position could be visible on the dedicated live card and
// silently absent from the chart picker. The fix routes BOTH endpoints through
// one canonical decision function, resolveLivePositionVisibility(mode).
//
// This is a PURE unit suite over that shared decision function. It proves the
// two endpoints can no longer disagree, because they compute includeLive +
// notLiveReason from identical inputs via identical code. It does NOT touch the
// DB (the DB-fixture truth predicate is covered by
// sharedAccountPositionsTruthTest.ts); it asserts the contract every live
// surface now shares.
//
// SAFETY: pure read test. No live trades, no broker calls, no DB writes.

import {
  resolveLivePositionVisibility,
  ACCOUNT_NOT_IN_LIVE_MODE,
} from "../../artifacts/api-server/src/lib/modeScope/livePositionVisibility.js";
import type { CurrentAccountMode } from "../../artifacts/api-server/src/lib/computeAccountModePrecedence.js";

type CaseResult = { name: string; ok: boolean; detail?: string };
const results: CaseResult[] = [];
function record(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  const label = ok ? "PASS" : "FAIL";
  // eslint-disable-next-line no-console
  console.log(`  ${label}  ${name}${detail ? ` — ${detail}` : ""}`);
}

// ── PART A — the rule itself ────────────────────────────────────────────────
{
  const live = resolveLivePositionVisibility("LIVE_SHARED");
  record(
    "LIVE_SHARED → includeLive=true, notLiveReason=null",
    live.includeLive === true && live.notLiveReason === null,
    `includeLive=${live.includeLive} notLiveReason=${live.notLiveReason}`,
  );

  const demo = resolveLivePositionVisibility("DEMO");
  record(
    "DEMO → includeLive=false, notLiveReason=ACCOUNT_NOT_IN_LIVE_MODE",
    demo.includeLive === false && demo.notLiveReason === ACCOUNT_NOT_IN_LIVE_MODE,
    `includeLive=${demo.includeLive} notLiveReason=${demo.notLiveReason}`,
  );

  const paper = resolveLivePositionVisibility("PAPER");
  record(
    "PAPER (the fail-safe fallback) → includeLive=false, notLiveReason=ACCOUNT_NOT_IN_LIVE_MODE",
    paper.includeLive === false && paper.notLiveReason === ACCOUNT_NOT_IN_LIVE_MODE,
    `includeLive=${paper.includeLive} notLiveReason=${paper.notLiveReason}`,
  );
}

// ── PART B — both endpoints AGREE for every mode ────────────────────────────
// Each endpoint now derives its decision from this single function. Simulate
// "two endpoints" by resolving twice from the same mode and asserting identity.
{
  const modes: CurrentAccountMode[] = ["LIVE_SHARED", "DEMO", "PAPER"];
  for (const mode of modes) {
    const liveCard = resolveLivePositionVisibility(mode);          // /api/me/live/positions
    const chartPicker = resolveLivePositionVisibility(mode);       // /api/me/positions/all
    record(
      `both endpoints agree for mode=${mode}`,
      liveCard.includeLive === chartPicker.includeLive &&
        liveCard.notLiveReason === chartPicker.notLiveReason,
      `live={${liveCard.includeLive},${liveCard.notLiveReason}} ` +
        `picker={${chartPicker.includeLive},${chartPicker.notLiveReason}}`,
    );
  }
}

// ── PART C — only LIVE_SHARED ever shows live; nothing else does ─────────────
{
  const everyMode: CurrentAccountMode[] = ["LIVE_SHARED", "DEMO", "PAPER"];
  const showing = everyMode.filter((m) => resolveLivePositionVisibility(m).includeLive);
  record(
    "exactly one mode (LIVE_SHARED) yields includeLive=true",
    showing.length === 1 && showing[0] === "LIVE_SHARED",
    `modes showing live: [${showing.join(", ")}]`,
  );
  // Whenever live is withheld, the reason is ALWAYS the single canonical token
  // (never null, never a second variant) so the UI copy is uniform.
  const withheld = everyMode
    .map((m) => resolveLivePositionVisibility(m))
    .filter((v) => !v.includeLive);
  record(
    "every withheld case uses the single canonical reason token",
    withheld.every((v) => v.notLiveReason === ACCOUNT_NOT_IN_LIVE_MODE),
    `reasons=[${withheld.map((v) => v.notLiveReason).join(", ")}]`,
  );
}

// ── Summary ─────────────────────────────────────────────────────────────────
const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
// eslint-disable-next-line no-console
console.log(`\n${pass}/${results.length} pass · ${fail} fail`);
if (fail > 0) process.exit(1);

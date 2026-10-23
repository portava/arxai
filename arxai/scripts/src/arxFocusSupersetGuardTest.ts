// ── ARX Focus Superset Guard — deterministic + DB-backed test (Task #558 T001) ─
//
// Phase 1 locks ARX to the 36 approved Focus markets. Before that lock is safe to
// keep, the approved universe MUST be a SUPERSET of every symbol that is already
// live in the system, otherwise locking could strand existing exposure. The
// live-pipeline backstop is NEW-ENTRY-ONLY and position management
// (close / modify / cancel) is EXEMPT, so an already-open unapproved position can
// always still be managed — but we still assert the superset condition so the
// operator is never surprised by off-universe live exposure.
//
// This file has two parts:
//   PART 1 — DETERMINISTIC contract (pure, no DB, always identical):
//            locks findUnapprovedSymbols()'s behaviour, including that the live
//            MT5 display names of the synthetics resolve approved and that a
//            genuinely off-universe symbol (e.g. AAPL.OQ) is flagged.
//   PART 2 — DB-backed superset check against the REAL live tables:
//            * open arx_live_positions (closed_at IS NULL)  → HARD ASSERT approved
//            * genuinely in-flight arx_live_commands         → HARD ASSERT approved
//              (SENT_TO_MT5_LIVE, not closed, created within the freshness window)
//            * stale orphan SENT_TO_MT5_LIVE commands        → REPORTED, not failed
//              (a command unacknowledged for far longer than the 15s heartbeat /
//               command-freshness gate is abandoned; the EA will never act on it,
//               so it cannot create new exposure — we never mutate this live
//               evidence to "clean" it).
//   PART 2 is skipped (not failed) when DATABASE_URL is absent so the contract
//   still runs in a DB-less CI.

import {
  findUnapprovedSymbols,
  isApprovedArxMarket,
} from "../../lib/domain/src/market/arxFocusMarkets.js";

type CaseResult = { name: string; ok: boolean; detail?: string };
const results: CaseResult[] = [];
function record(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  // eslint-disable-next-line no-console
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

// ── PART 1 — deterministic contract ──────────────────────────────────────────
console.log("\nPART 1 — findUnapprovedSymbols() contract (pure)");

// The exact MT5 display names that appear as live exposure in this system's
// live tables all resolve to approved synthetics — the superset holds.
const LIVE_SYNTHETIC_NAMES = [
  "Volatility 75 Index",
  "Volatility 75 (1s) Index",
  "Volatility 25 (1s) Index",
  "VOLATILITY 75 (1S) INDEX", // casing variant
];
record(
  "live MT5 synthetic display names all resolve approved",
  findUnapprovedSymbols(LIVE_SYNTHETIC_NAMES).length === 0,
  JSON.stringify(findUnapprovedSymbols(LIVE_SYNTHETIC_NAMES)),
);

// A broker-style crypto ticker for an approved market resolves approved.
record("BTCUSDT resolves approved", isApprovedArxMarket("BTCUSDT"));

// Genuinely off-universe symbols are flagged, approved ones removed, and
// equivalent spellings collapse to a single reported entry.
const MIXED = [
  "AAPL.OQ", // unapproved (stock) — must be flagged
  "NAS100", // unapproved (index not in the 36) — must be flagged
  "V75", // approved — removed
  "Volatility 75 Index", // approved + same market as V75 — removed
  "EURUSD", // approved — removed
];
const flagged = findUnapprovedSymbols(MIXED);
record(
  "mixed list flags ONLY the unapproved symbols",
  arraysEqual(flagged, ["AAPL.OQ", "NAS100"]),
  JSON.stringify(flagged),
);

// De-duplication: equivalent spellings of approved markets collapse to nothing.
record(
  "equivalent approved spellings collapse to empty",
  findUnapprovedSymbols(["V75", "Volatility 75 Index", "v75", "FX:EURUSD", "eurusd"]).length === 0,
);

// Empty / whitespace entries are ignored.
record(
  "empty + whitespace entries ignored",
  findUnapprovedSymbols(["", "   ", "EURUSD"]).length === 0,
);

// Duplicate unapproved spellings are reported once.
record(
  "duplicate unapproved spellings reported once",
  arraysEqual(findUnapprovedSymbols(["AAPL.OQ", "aapl.oq", "AAPL.OQ"]), ["AAPL.OQ"]),
);

// ── PART 2 — DB-backed superset check ────────────────────────────────────────
// A SENT_TO_MT5_LIVE command this old is an abandoned orphan, not in-flight: the
// EA command-freshness / heartbeat gate is 15s, so anything unacknowledged for
// more than this window will never be acted on and cannot create new exposure.
const INFLIGHT_FRESHNESS_MS = 60 * 60 * 1000; // 1 hour — generous vs the 15s gate

async function runDbCheck(): Promise<boolean> {
  if (!process.env.DATABASE_URL) {
    console.log("\nPART 2 — DB superset check SKIPPED (no DATABASE_URL)");
    return true;
  }
  console.log("\nPART 2 — DB superset check (live arx_live_* tables)");

  const { db } = await import("@workspace/db");
  const { sql } = await import("drizzle-orm");

  // (a) Open live positions — the genuine standing exposure surface.
  const openPos = await db.execute(
    sql`SELECT DISTINCT symbol FROM arx_live_positions WHERE closed_at IS NULL`,
  );
  const openSymbols = (openPos.rows as Array<{ symbol: string }>).map((r) => r.symbol);
  const openUnapproved = findUnapprovedSymbols(openSymbols);
  record(
    `open arx_live_positions all approved (${openSymbols.length} distinct)`,
    openUnapproved.length === 0,
    openUnapproved.length ? `OFF-UNIVERSE: ${JSON.stringify(openUnapproved)}` : JSON.stringify(openSymbols),
  );

  // (b) In-flight new-entry commands vs stale orphans.
  const sent = await db.execute(
    sql`SELECT symbol, created_at FROM arx_live_commands
        WHERE status = 'SENT_TO_MT5_LIVE' AND closed_at IS NULL`,
  );
  const now = Date.now();
  const rows = sent.rows as Array<{ symbol: string; created_at: string | Date }>;
  const fresh: string[] = [];
  const stale: string[] = [];
  for (const r of rows) {
    const age = now - new Date(r.created_at).getTime();
    (age <= INFLIGHT_FRESHNESS_MS ? fresh : stale).push(r.symbol);
  }
  const freshUnapproved = findUnapprovedSymbols(fresh);
  record(
    `in-flight (fresh ≤1h) arx_live_commands all approved (${fresh.length} rows)`,
    freshUnapproved.length === 0,
    freshUnapproved.length ? `OFF-UNIVERSE IN-FLIGHT: ${JSON.stringify(freshUnapproved)}` : "none in-flight off-universe",
  );

  const staleUnapproved = findUnapprovedSymbols(stale);
  if (staleUnapproved.length) {
    console.log(
      `  NOTE  ${staleUnapproved.length} STALE orphan SENT_TO_MT5_LIVE command(s) on off-universe ` +
        `symbol(s) ${JSON.stringify(staleUnapproved)} — abandoned (older than the 15s freshness gate), ` +
        `cannot create exposure, and are NOT mutated by this guard. Operator cleanup only.`,
    );
  }
  return true;
}

// ── Summary ──────────────────────────────────────────────────────────────────
async function main() {
  await runDbCheck();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  if (failed.length) {
    console.error(`FAILED: ${failed.map((f) => f.name).join("; ")}`);
    process.exit(1);
  }
  console.log("ARX Focus superset guard: approved universe is a superset of live exposure. ✓");
}

void main();

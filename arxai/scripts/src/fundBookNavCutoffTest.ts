// fundBookNavCutoffTest.ts — Pure unit proof of the NAV cutoff / cycle resolver
// (artifacts/api-server/src/lib/fundbook/navCutoff.ts).
//
// IT PROVES:
//   - Approved BEFORE 5:00 PM America/New_York ⇒ CURRENT_CYCLE (today's cut).
//   - Approved EXACTLY AT 5:00 PM NY ⇒ NEXT_CYCLE (boundary is inclusive of NEXT).
//   - Approved AFTER 5:00 PM NY ⇒ NEXT_CYCLE (tomorrow's cut).
//   - DST date (summer): cut is EDT, UTC-04:00, isDstAtCut = true.
//   - Non-DST date (winter): cut is EST, UTC-05:00, isDstAtCut = false.
//   - Conversion from a UTC instant resolves the correct NY wall-clock side of
//     the cutoff AND the correct NY calendar date (incl. UTC→NY date rollover).
//   - The computed navCutAt instant equals the true 5:00 PM NY instant.
//   - Invalid input fails loudly (no fabricated cycle).
//
// No DB, no IO, no app boot — deterministic.
// Run: pnpm --filter @workspace/scripts run test:fundbook-cutoff

import {
  resolveNavCycle,
  NAV_CUTOFF_TIMEZONE,
} from "../../artifacts/api-server/src/lib/fundbook/navCutoff.js";

let passes = 0;
let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    passes++;
    // eslint-disable-next-line no-console
    console.log(`  \u2713 ${label}`);
  } else {
    failures++;
    // eslint-disable-next-line no-console
    console.error(`  \u2717 ${label}`);
  }
}

// Helper: build a UTC instant from an explicit UTC wall clock.
function utc(y: number, mo: number, d: number, h: number, mi: number, s = 0): Date {
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s));
}

function main(): void {
  // eslint-disable-next-line no-console
  console.log("fundBookNavCutoffTest");
  // eslint-disable-next-line no-console
  console.log("=====================\n");

  // ── 1. Before cutoff (summer, 2:30 PM EDT = 18:30 UTC on 2026-07-15) ───────
  // eslint-disable-next-line no-console
  console.log("1. Before 5:00 PM NY ⇒ CURRENT cycle");
  {
    const r = resolveNavCycle(utc(2026, 7, 15, 18, 30)); // 14:30 EDT
    assert(r.timing === "CURRENT_CYCLE", `timing CURRENT_CYCLE (got ${r.timing})`);
    assert(r.navCutDate === "2026-07-15", `priced at today's cut 2026-07-15 (got ${r.navCutDate})`);
    assert(r.approvalLocalTime === "14:30:00", `approval local time 14:30:00 (got ${r.approvalLocalTime})`);
    assert(r.timeZone === NAV_CUTOFF_TIMEZONE, "uses America/New_York");
    assert(/current NAV cycle/.test(r.explanation), "explanation mentions current NAV cycle");
  }

  // ── 2. Exactly at cutoff (summer, 5:00:00 PM EDT = 21:00 UTC) ──────────────
  // eslint-disable-next-line no-console
  console.log("\n2. Exactly at 5:00 PM NY ⇒ NEXT cycle (inclusive boundary)");
  {
    const r = resolveNavCycle(utc(2026, 7, 15, 21, 0, 0)); // 17:00:00 EDT
    assert(r.timing === "NEXT_CYCLE", `timing NEXT_CYCLE (got ${r.timing})`);
    assert(r.navCutDate === "2026-07-16", `priced at next cut 2026-07-16 (got ${r.navCutDate})`);
    assert(r.approvalLocalTime === "17:00:00", `approval local time 17:00:00 (got ${r.approvalLocalTime})`);
  }

  // One second before the cut stays CURRENT.
  {
    const r = resolveNavCycle(utc(2026, 7, 15, 20, 59, 59)); // 16:59:59 EDT
    assert(r.timing === "CURRENT_CYCLE", `16:59:59 EDT ⇒ CURRENT (got ${r.timing})`);
    assert(r.navCutDate === "2026-07-15", `16:59:59 priced today (got ${r.navCutDate})`);
  }

  // ── 3. After cutoff (summer, 6:15 PM EDT = 22:15 UTC) ──────────────────────
  // eslint-disable-next-line no-console
  console.log("\n3. After 5:00 PM NY ⇒ NEXT cycle (tomorrow's cut)");
  {
    const r = resolveNavCycle(utc(2026, 7, 15, 22, 15)); // 18:15 EDT
    assert(r.timing === "NEXT_CYCLE", `timing NEXT_CYCLE (got ${r.timing})`);
    assert(r.navCutDate === "2026-07-16", `priced at next cut 2026-07-16 (got ${r.navCutDate})`);
  }

  // ── 4. DST date (summer) reports EDT / UTC-04:00 ──────────────────────────
  // eslint-disable-next-line no-console
  console.log("\n4. DST date (summer) ⇒ EDT, UTC-04:00, isDstAtCut=true");
  {
    const r = resolveNavCycle(utc(2026, 7, 15, 18, 30));
    assert(r.isDstAtCut === true, `isDstAtCut true (got ${r.isDstAtCut})`);
    assert(r.zoneAbbrevAtCut === "EDT", `zone abbrev EDT (got ${r.zoneAbbrevAtCut})`);
    assert(r.utcOffsetAtCut === "-04:00", `offset -04:00 (got ${r.utcOffsetAtCut})`);
    // 5:00 PM EDT on 2026-07-15 == 21:00 UTC.
    assert(r.navCutAt.getTime() === utc(2026, 7, 15, 21, 0).getTime(), "navCutAt == 21:00 UTC (5pm EDT)");
  }

  // ── 5. Non-DST date (winter) reports EST / UTC-05:00 ──────────────────────
  // eslint-disable-next-line no-console
  console.log("\n5. Non-DST date (winter) ⇒ EST, UTC-05:00, isDstAtCut=false");
  {
    // 2026-01-15 2:30 PM EST = 19:30 UTC (EST is UTC-5).
    const r = resolveNavCycle(utc(2026, 1, 15, 19, 30));
    assert(r.timing === "CURRENT_CYCLE", `winter 2:30 PM ⇒ CURRENT (got ${r.timing})`);
    assert(r.isDstAtCut === false, `isDstAtCut false (got ${r.isDstAtCut})`);
    assert(r.zoneAbbrevAtCut === "EST", `zone abbrev EST (got ${r.zoneAbbrevAtCut})`);
    assert(r.utcOffsetAtCut === "-05:00", `offset -05:00 (got ${r.utcOffsetAtCut})`);
    // 5:00 PM EST on 2026-01-15 == 22:00 UTC.
    assert(r.navCutAt.getTime() === utc(2026, 1, 15, 22, 0).getTime(), "navCutAt == 22:00 UTC (5pm EST)");
  }

  // ── 6. UTC→NY conversion incl. calendar rollover ──────────────────────────
  // eslint-disable-next-line no-console
  console.log("\n6. Conversion from UTC resolves the correct NY date & side");
  {
    // 2026-07-16T00:30:00Z is 2026-07-15 8:30 PM EDT — after cutoff, NY date
    // is still the 15th, so next cut is the 16th.
    const r = resolveNavCycle(utc(2026, 7, 16, 0, 30));
    assert(r.approvalLocalDate === "2026-07-15", `UTC 00:30 maps to NY 2026-07-15 (got ${r.approvalLocalDate})`);
    assert(r.timing === "NEXT_CYCLE", `8:30 PM EDT ⇒ NEXT (got ${r.timing})`);
    assert(r.navCutDate === "2026-07-16", `next cut 2026-07-16 (got ${r.navCutDate})`);
  }
  {
    // 2026-07-15T21:00:00Z is exactly 5:00 PM EDT — boundary ⇒ NEXT.
    const r = resolveNavCycle(utc(2026, 7, 15, 21, 0));
    assert(r.timing === "NEXT_CYCLE", `21:00 UTC == 5pm EDT ⇒ NEXT (got ${r.timing})`);
  }
  {
    // 2026-07-15T20:59:00Z is 4:59 PM EDT — CURRENT.
    const r = resolveNavCycle(utc(2026, 7, 15, 20, 59));
    assert(r.timing === "CURRENT_CYCLE", `20:59 UTC == 4:59pm EDT ⇒ CURRENT (got ${r.timing})`);
  }

  // ── 7. Month/year rollover after cutoff ───────────────────────────────────
  // eslint-disable-next-line no-console
  console.log("\n7. Calendar rollover (month / year boundary)");
  {
    // 2026-12-31 6:00 PM EST = 2026-12-31T23:00Z — after cut ⇒ next is 2027-01-01.
    const r = resolveNavCycle(utc(2026, 12, 31, 23, 0));
    assert(r.timing === "NEXT_CYCLE", `NYE 6pm ⇒ NEXT (got ${r.timing})`);
    assert(r.navCutDate === "2027-01-01", `rolls to 2027-01-01 (got ${r.navCutDate})`);
    assert(r.zoneAbbrevAtCut === "EST", `Jan 1 cut is EST (got ${r.zoneAbbrevAtCut})`);
  }

  // ── 8. Invalid input fails loudly ─────────────────────────────────────────
  // eslint-disable-next-line no-console
  console.log("\n8. Invalid input throws (no fabricated cycle)");
  {
    let threw = false;
    try {
      resolveNavCycle(new Date("not-a-date"));
    } catch {
      threw = true;
    }
    assert(threw, "invalid Date throws");
  }

  // eslint-disable-next-line no-console
  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main();

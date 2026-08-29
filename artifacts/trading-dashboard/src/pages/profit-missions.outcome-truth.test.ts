// OUTCOME TRUTH (UI) — the realised figure must never be shown bare when the
// set behind it is incomplete.
//
// WHY
//   "Realised profit" / "Peak realised" sum only closed mission trades that
//   carry a broker-confirmed P/L. A trade closed by its own STOP-LOSS at the
//   broker used to produce no record at all, so it silently dropped out of the
//   sum — and because the missing outcomes skewed toward LOSSES, the number on
//   screen read better than the truth. The number itself is still honest; what
//   was dishonest was presenting it as if it were the whole story.
//
// WHAT THIS SUITE PINS
//   The page must, when outcomes are missing or unreconciled, state that plainly
//   NEXT TO the number: a visible completeness note, a badge, and the counts. It
//   must never imply the figure is final while results are outstanding, and it
//   must not promise an estimate of the missing amount.
//
// Source-text assertions (same pattern as profit-missions.honest-labelling):
// claims must live in RENDERED copy, not in a comment.
//
// Run: pnpm --filter @workspace/trading-dashboard run test:mission-outcome-truth

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");

const page = readFileSync(resolve(SRC, "pages/profit-missions.tsx"), "utf8");
/** Page source minus comment lines — a claim in a comment is not a claim. */
const rendered = page
  .split("\n")
  .filter((line) => {
    const t = line.trim();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join("\n");

describe("outcome truth — the realised figure carries its completeness state", () => {
  it("reads the completeness signal the server sends", () => {
    expect(rendered).toMatch(/outcomeCompleteness/);
  });

  it("marks the realised and peak figures when results are missing", () => {
    expect(rendered).toMatch(/note-realised-incomplete/);
    expect(rendered).toMatch(/note-peak-incomplete/);
    expect(rendered).toMatch(/Incomplete —/);
  });

  it("shows a plain 'results incomplete' badge next to the target state", () => {
    expect(rendered).toMatch(/badge-outcomes-incomplete/);
    expect(rendered).toMatch(/Results incomplete/);
  });

  it("never describes the incomplete figure as a floor, a minimum or any other bound", () => {
    // FORWARD-FIX. This suite previously asserted the copy said "floor, not the
    // final result" — pinning a FALSE claim in CI. A floor asserts truth >=
    // shown. The excluded outcomes skew toward stop-loss LOSSES, so the shown
    // figure is if anything upward-biased: the copy was wrong in exactly the
    // case it was written for. An incomplete realised figure bounds the truth in
    // NEITHER direction, and the panel must never imply otherwise.
    // Explicit DENIALS of a bound are the point — strip them first so the scan
    // below only ever sees an affirmative claim.
    const claims = rendered.replace(/\bnot a (floor|minimum|lower bound)\b/gi, "");
    for (const forbidden of [
      /\bfloor\b/i,
      /\bminimum\b/i,
      /\bat least this\b/i,
      /\blower bound\b/i,
      /\bno less than\b/i,
    ]) {
      expect(claims).not.toMatch(forbidden);
    }
  });

  it("says plainly that the true figure may land either side of the number", () => {
    expect(rendered).toMatch(/may be higher or lower/i);
    expect(rendered).toMatch(/it is not a minimum/i);
  });

  it("names the direction of the known skew instead of implying a favourable one", () => {
    expect(rendered).toMatch(/most often stop-losses/i);
    expect(rendered).toMatch(/usually reads better than the result/i);
  });

  it("never shows a success 'target reached' claim while results are outstanding", () => {
    // `stopAndLock` stays TRUE on an incomplete set (removing the stop would
    // resume trading), so the success alert must be suppressed explicitly —
    // the mission is stopped, but the result is not yet a claim ARX can make.
    expect(rendered).toMatch(/m\.stopAndLock && !outcomesIncomplete/);
    expect(rendered).toMatch(/alert-stop-lock-unconfirmed/);
    expect(rendered).toMatch(/completion is held until every closed trade has a broker-confirmed result/i);
  });

  it("names WHY a result can be missing — a close that happened at the broker", () => {
    expect(rendered).toMatch(/stop-loss/i);
    expect(rendered).toMatch(/closed at the broker/i);
  });

  it("states that ARX never estimates the missing figure", () => {
    expect(rendered).toMatch(/never estimate the missing figure/i);
  });

  it("states that the mission still stops but is not marked complete until results are confirmed", () => {
    expect(rendered).toMatch(
      /mission still stops at its target, but it is not marked complete until every closed trade has a confirmed result/i,
    );
  });

  it("breaks the counts out so the user can see the size of the gap", () => {
    expect(rendered).toMatch(/outcome-count-pending/);
    expect(rendered).toMatch(/outcome-count-unreconciled/);
    expect(rendered).toMatch(/outcome-count-reconciled/);
  });

  it("keeps the existing pinned protection copy intact", () => {
    expect(rendered).toMatch(/metric-realised-profit/);
    expect(rendered).toMatch(/metric-peak-realised/);
    expect(rendered).toMatch(/badge-mission-locked/);
    expect(rendered).toMatch(
      /Reinvests realised closed profit only — never floating P\/L, never during/,
    );
  });

  it("never promises a projected or estimated value for a missing result", () => {
    expect(rendered).not.toMatch(/estimated (profit|loss|result) of/i);
    expect(rendered).not.toMatch(/assumed (profit|loss)/i);
  });
});

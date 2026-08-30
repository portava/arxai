// Analysis surfaces refuse visibly instead of rendering a verdict from nothing.
//
// Covers three pages that all had the same failure mode: the backend produced
// an honest refusal or a withheld read, and the page rendered it as a result.
//
//   Brain Analysis   marketBrain returns MarketBrainRefusal { available:false }
//                    below 60 real closed candles — no technicalDetails /
//                    macroDetails / scoring. The page never checked `available`
//                    and rendered <TechnicalPanel data={result.technicalDetails
//                    as any} />, whose body reads d.trendDirection on undefined:
//                    a TypeError that blanked the page mid-render, right after
//                    showing a WAIT decision bar.
//
//   Trade Grader     The page sent `x-security-role: ADMIN` from the browser.
//                    That header is IGNORED in production, so a normal trader
//                    fell to maskSimulatorTradeGrade and got tradeGrade "—",
//                    overallScore 0, shouldHaveTakenTrade false and
//                    `withheld: true`. The page's Grade type had no `withheld`
//                    field and nothing checked it, so a withheld read rendered
//                    as a giant "—" with "Score 0/100 · should NOT take".
//
//   Macro panel      analyzeMacro only ever returns "synthetic" or
//                    "unavailable", so the forex / indices / stocks grids were
//                    unreachable dead code, and the "Macro Score" bar sat at a
//                    permanent 50% — documented in the engine as "NOT a
//                    reading" — colour-coded like a measurement.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");

function code(rel: string): string {
  return readFileSync(resolve(SRC, rel), "utf8")
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

const brain = code("pages/brain-analysis.tsx");
const grader = code("pages/trade-grader.tsx");

describe("Brain Analysis branches on the refusal", () => {
  it("models the union the endpoint actually returns", () => {
    expect(brain).toMatch(/MarketBrainRefusal/);
    expect(brain).toMatch(/r\.available === false/);
  });

  it("renders the refusal instead of the analysis panels", () => {
    expect(brain).toMatch(/\{refusal && <RefusalCard refusal=\{refusal\} \/>\}/);
    // The analysis block is gated on the narrowed result, not the raw outcome.
    expect(brain).toMatch(/const result = outcome && !isRefusal\(outcome\) \? outcome : null/);
  });

  it("no longer claims the analysis is simulated", () => {
    // marketBrain routes REAL candles only and refuses below 60 closed bars.
    expect(brain).not.toMatch(/data is simulated for demo mode/);
    expect(brain).toMatch(/closed bars from/);
  });
});

describe("Brain Analysis macro panel states what is not measured", () => {
  it("the unreachable forex/indices/stocks grids are gone", () => {
    for (const dead of [
      "interestRateBias", "inflationBias", "jobsBias", "GDPBias",
      "baseCurrencyStrength", "quoteCurrencyStrength",
      "dollarBias", "bondYieldBias", "fedBias", "earningsSentiment",
      "sectorBias", "earningsRisk", "relativeStrength",
    ]) {
      expect(brain, `${dead} branch is unreachable dead code`).not.toMatch(new RegExp(dead));
    }
  });

  it("the fixed neutral macro score is no longer drawn as a measured bar", () => {
    expect(brain).not.toMatch(/ConfidenceBar value=\{d\.macroScore\}/);
    expect(brain).toMatch(/Not measured — no macro provider connected/);
  });

  it("the confluence panel shows macro as a fixed neutral, not a scored bar", () => {
    expect(brain).not.toMatch(/label: "Macro Contrib", value: scoring\.breakdown\.macroContrib, max: 20/);
    expect(brain).toMatch(/Fixed neutral \+\{scoring\.breakdown\.macroContrib\}/);
  });
});

describe("Trade Grader stops escalating its own role and reads the refusal", () => {
  it("sends no client-supplied role header", () => {
    expect(grader).not.toMatch(/x-security-role/);
  });

  it("only renders a grade when both reads produced one", () => {
    expect(grader).toMatch(/grade\?\.available === true/);
    expect(grader).toMatch(/sniper\?\.available === true/);
    expect(grader).toMatch(/grade\.tradeGrade != null/);
  });

  it("renders an explicit refusal state", () => {
    expect(grader).toMatch(/Not graded/);
    expect(grader).toMatch(/this is a refusal, not a verdict/);
  });

  it("does not print a should-take verdict when the model has no opinion", () => {
    expect(grader).toMatch(/grade\.shouldHaveTakenTrade != null &&/);
  });

  it("says plainly that the scores come from a simulator, not the live market", () => {
    expect(grader).toMatch(/not the live market/);
  });
});

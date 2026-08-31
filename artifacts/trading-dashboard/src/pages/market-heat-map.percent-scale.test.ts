// Market Heat Map — percentage scores are already 0-100 at the source.
//
// BEFORE
//   Seven render sites did `Math.round(value * 100)` on values that are ALREADY
//   percentages, so the flagship intelligence page rendered:
//     "Trap prob. 6000%"        (trapRoomEngine clamps trapProbability to 0-100)
//     "Primary confidence 7000%" (heatEngine emits confidences of 40-90)
//     "Fakeout risk 4500%"       (sessionKillZoneEngine constants are 40-60)
//   and the danger border was gated on `trapProbability >= 0.5`, true for
//   essentially any non-zero value, so it was permanently on. A trader could
//   not read a single risk number on the page.
//
// AFTER
//   Every site formats through `scorePercent`, which takes an already-0-100
//   value, and the trap warning threshold is TRAP_WARNING_THRESHOLD (50) on the
//   same scale. One helper means the fraction/percent confusion cannot return
//   one render site at a time.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { scorePercent, TRAP_WARNING_THRESHOLD } from "@/lib/score-percent";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");

function read(rel: string): string {
  return readFileSync(resolve(SRC, rel), "utf8");
}

/** Source with comment lines stripped — the header documents the old bug. */
function code(rel: string): string {
  return read(rel)
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

const page = code("pages/market-heat-map.tsx");

describe("scorePercent formats an already-0-100 score", () => {
  it("does not multiply by 100", () => {
    expect(scorePercent(60)).toBe("60%");
    expect(scorePercent(0)).toBe("0%");
    expect(scorePercent(100)).toBe("100%");
  });

  it("rounds rather than inventing precision", () => {
    expect(scorePercent(45.4)).toBe("45%");
    expect(scorePercent(45.6)).toBe("46%");
  });

  it("degrades a missing read to a dash, never a confident 0%", () => {
    expect(scorePercent(null)).toBe("—");
    expect(scorePercent(undefined)).toBe("—");
    expect(scorePercent(Number.NaN)).toBe("—");
  });
});

describe("the heat map no longer scales percentages by 100", () => {
  it("no render site multiplies a score field by 100", () => {
    for (const field of [
      "trapProbability",
      "primaryConfidence",
      "backupConfidence",
      "fakeoutRisk",
      "surpriseScore",
    ]) {
      const bad = new RegExp(`${field}\\s*\\*\\s*100`);
      expect(page, `${field} must not be scaled by 100`).not.toMatch(bad);
    }
  });

  it("renders those fields through scorePercent", () => {
    expect(page).toMatch(/scorePercent\(data\.trapProbability\)/);
    expect(page).toMatch(/scorePercent\(data\.heatSource\.primaryConfidence\)/);
    expect(page).toMatch(/scorePercent\(data\.heatSource\.backupConfidence\)/);
    expect(page).toMatch(/scorePercent\(session\.fakeoutRisk\)/);
    expect(page).toMatch(/scorePercent\(news\.surpriseScore\)/);
  });

  it("gates every trap warning on the 0-100 scale, not 0.5", () => {
    // Two sites: the Danger tab's ScorePill border and the Cross-Symbol Danger
    // Ranking's "Trap" badge. Both fired for essentially any non-zero value.
    expect(page).not.toMatch(/trapProbability\s*>=\s*0\.5/);
    expect(page.match(/trapProbability >= TRAP_WARNING_THRESHOLD/g) ?? []).toHaveLength(2);
    expect(TRAP_WARNING_THRESHOLD).toBe(50);
  });

  it("a typical engine value does not light the warning border", () => {
    // heatEngine/session constants sit in the 40-60 band; the old `>= 0.5`
    // check was true for all of them.
    expect(45 >= TRAP_WARNING_THRESHOLD).toBe(false);
    expect(65 >= TRAP_WARNING_THRESHOLD).toBe(true);
  });
});

describe("no-candle reads are withheld, not rendered as measurements", () => {
  // With < 10 candles the timing brain returns defaults (buy/sell 50/50,
  // room 50) and relabels the session's static fakeoutRisk constant as
  // trapProbability. The Buy/Sell Windows and Danger Windows tabs must never
  // render those defaults as if they were a measured market.

  it("the buy/sell tab gates its meter on candle data and says why it is withheld", () => {
    expect(page).toMatch(/const hasCandles = data\.dataQuality\.hasCandleData/);
    expect(page).toMatch(/Couldn't measure buy\/sell pressure/);
  });

  it("the danger tab's trap pill degrades to a dash without candle data", () => {
    expect(page).toMatch(/hasCandleData \? scorePercent\(data\.trapProbability\) : "—"/);
  });

  it("the cross-symbol Trap badge only fires on candle-backed reads", () => {
    expect(page).toMatch(/!r\.dataQuality\.hasCandleData \?/);
  });

  it("the buy/sell and danger tabs carry the data-quality badge like the other tabs", () => {
    // NowTab, BySymbolTab, BuySellWindowsTab, DangerWindowsTab, AdminDataStatusTab.
    expect((page.match(/<DataQualityBadge label=/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });
});

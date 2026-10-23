// THEME A3 — coaching must never cite a fabricated exit price, and must not
// tag mistakes it has no evidence for.
//
// Two defects, one root cause (inventing facts about how a trade ended):
//
// 1. FABRICATED EXIT PRICE. `aiCoach.coachTrade` computed
//        exit = pnl >= 0 ? trade.takeProfit : trade.stopLoss
//    i.e. it ASSUMED every winner closed exactly at TP and every loser exactly
//    at SL. `rubyQuality/selfReview` — a LIVE path — did the same off
//    `status === "CLOSED_WIN"`. The `trades` table has no close-price column,
//    so there is no real exit to read: the honest fix is to stop claiming one.
//    `TradeOutcomeInput.exit` never influenced a single output field, so it is
//    removed outright — no caller can reintroduce the guess.
//
// 2. INVERTED HOLD-TIME TAGS. The analyzer tagged a <3-min LOSING hold as
//    "late entry" and a <5-min WINNING hold as "early exit". Neither follows:
//    a fast loss is evidence of a bad entry OR a tight stop, not lateness, and
//    a fast win is the normal shape of a trade that reached its target.
//
// aiCoach.ts itself had no live caller and is deleted rather than repaired.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { analyzeTradeOutcome, MISTAKE_TAGS } from "../tradeOutcomeAnalyzer.js";
import type { TradeOutcomeInput } from "../tradeOutcomeAnalyzer.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../../..");

function base(overrides: Partial<TradeOutcomeInput> = {}): TradeOutcomeInput {
  return {
    symbol: "EURUSD",
    strategy: "Break of Structure",
    confidence: 75,
    entry: 1.1,
    stopLoss: 1.0985,
    takeProfit: 1.1045,
    profitLoss: 12.5,
    ...overrides,
  };
}

/** Every .ts file under src, excluding test/QA fixtures. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "__qa__" || name === "dist") continue;
      sourceFiles(full, out);
    } else if (name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("A3 — the dead exit-price fabricator is gone", () => {
  it("aiCoach.ts no longer exists", () => {
    assert.equal(
      existsSync(resolve(SRC, "lib/aiLearning/aiCoach.ts")),
      false,
      "aiCoach.ts had no live caller and fabricated the exit price as TP/SL",
    );
  });

  it("TradeOutcomeInput has no `exit` field to fabricate", () => {
    const src = readFileSync(resolve(SRC, "lib/aiLearning/tradeOutcomeAnalyzer.ts"), "utf8");
    const iface = src.slice(
      src.indexOf("interface TradeOutcomeInput"),
      src.indexOf("interface TradeOutcomeResult"),
    );
    assert.ok(iface.length > 0, "TradeOutcomeInput must still be declared");
    assert.ok(
      !/^\s*exit\s*[?]?\s*:/m.test(iface),
      "the unused `exit` input existed only for callers to guess at — it is removed",
    );
  });

  it("no source file infers an exit price from TP/SL", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const src = readFileSync(file, "utf8");
      // `exit: <cond> ? …takeProfit… : …stopLoss…` in any spacing/line layout.
      if (/\bexit\s*:[^;{}]*takeProfit[^;{}]*stopLoss/s.test(src)) {
        offenders.push(file.slice(SRC.length + 1));
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `these files claim a trade closed exactly at TP or SL: ${offenders.join(", ")}`,
    );
  });
});

describe("A3 — hold-time mistake tags are not inverted", () => {
  it("a fast LOSING hold is not tagged 'late entry'", () => {
    const r = analyzeTradeOutcome(base({ profitLoss: -18, holdTimeMinutes: 2 }));
    assert.equal(r.outcome, "loss");
    assert.ok(
      !r.mistakeTags.includes("late entry"),
      `a 2-minute loss is not evidence of a late entry; got ${JSON.stringify(r.mistakeTags)}`,
    );
  });

  it("a fast WINNING hold is not tagged 'early exit'", () => {
    const r = analyzeTradeOutcome(base({ profitLoss: 22, holdTimeMinutes: 3 }));
    assert.equal(r.outcome, "win");
    assert.ok(
      !r.mistakeTags.includes("early exit"),
      `a 3-minute win is the normal shape of a trade reaching target; got ${JSON.stringify(r.mistakeTags)}`,
    );
  });

  it("the vocabulary no longer advertises tags that are never emitted", () => {
    assert.ok(!(MISTAKE_TAGS as readonly string[]).includes("late entry"));
    assert.ok(!(MISTAKE_TAGS as readonly string[]).includes("early exit"));
  });
});

describe("A3 — evidence-backed analysis still works", () => {
  it("still flags poor risk:reward from real geometry", () => {
    const r = analyzeTradeOutcome(base({ takeProfit: 1.1008, profitLoss: -9 }));
    assert.ok(r.mistakeTags.includes("poor risk reward"));
  });

  it("still flags a low-confidence trade", () => {
    const r = analyzeTradeOutcome(base({ confidence: 40 }));
    assert.ok(r.mistakeTags.includes("low confidence trade"));
  });

  it("still credits a strong risk:reward win", () => {
    const r = analyzeTradeOutcome(base({ takeProfit: 1.1055, profitLoss: 30 }));
    assert.equal(r.outcome, "win");
    assert.ok(r.successTags.includes("strong risk reward"));
    assert.ok(r.successTags.includes("clean break of structure"));
  });

  it("produces a lesson and an adjustment", () => {
    const r = analyzeTradeOutcome(base({ profitLoss: -14 }));
    assert.ok(r.lesson.length > 0);
    assert.ok(r.suggestedAdjustment.length > 0);
  });
});

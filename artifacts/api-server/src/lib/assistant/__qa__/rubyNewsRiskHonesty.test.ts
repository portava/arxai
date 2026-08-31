// Deterministic test for Ruby's news-risk phrasing honesty (Task #611). Run via:
//   pnpm --filter @workspace/api-server run test:ruby-news-risk-honesty
//
// Provider-honesty-FIRST: when news and/or economic-calendar feeds are not
// connected, Ruby MUST report news risk as *unavailable* — it must NEVER imply
// the risk is low, calm, clear, or that there are no upcoming events.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  newsRiskStatement,
  deriveNewsCacheVal,
  composeRubyBriefing,
  type RubyContext,
} from "../rubyContext.js";

const BANNED = ["low risk", "no events", "all clear", "calm", "nothing scheduled"];

function assertNoFalseReassurance(s: string) {
  const lower = s.toLowerCase();
  for (const phrase of BANNED) {
    // The honest copy may say "I can't confirm it's calm" — that negates the
    // word, so only fail when the reassuring phrase appears WITHOUT negation.
    if (lower.includes(phrase)) {
      assert.ok(
        /\b(can't|cannot|won't|not|isn't|aren't|no\b)/.test(lower),
        `phrasing must not falsely reassure with "${phrase}": ${s}`,
      );
    }
  }
}

test("both feeds connected → null (caller surfaces real lines)", () => {
  assert.equal(newsRiskStatement(true, true), null);
});

test("both feeds disconnected → unavailable, no false reassurance", () => {
  const s = newsRiskStatement(false, false);
  assert.ok(s, "must return a statement");
  assert.ok(s!.toLowerCase().includes("unavailable"));
  assertNoFalseReassurance(s!);
});

test("news disconnected only → unavailable, not 'no risk'", () => {
  const s = newsRiskStatement(false, true);
  assert.ok(s, "must return a statement");
  assert.ok(s!.toLowerCase().includes("unavailable"));
  assertNoFalseReassurance(s!);
});

test("calendar disconnected only → events unavailable, not 'none scheduled'", () => {
  const s = newsRiskStatement(true, false);
  assert.ok(s, "must return a statement");
  assert.ok(s!.toLowerCase().includes("unavailable"));
  assertNoFalseReassurance(s!);
});

// ── deriveNewsCacheVal: connected-vs-unavailable mapping honesty ─────────────
// Regression lock (Task #625 review): a CONNECTED provider that returns zero
// headlines is a genuinely quiet feed — it must read connected:true at REAL low
// risk, NOT be collapsed to the "unavailable" disconnected fallback. Only a
// disconnected provider reads "unavailable".
const NOW = Date.UTC(2026, 5, 19, 12, 0, 0);

test("connected provider with ZERO items → connected:true, low (never unavailable)", () => {
  const v = deriveNewsCacheVal({ connected: true, items: [] }, NOW);
  assert.equal(v.connected, true, "a connected feed stays connected even when empty");
  assert.notEqual(v.riskLevel, "unavailable", "an empty connected feed is honest-low, not unavailable");
  assert.equal(v.riskLevel, "low", "empty items ⇒ score 0 ⇒ low");
  assert.deepEqual(v.items, []);
});

test("disconnected provider → connected:false, unavailable", () => {
  const v = deriveNewsCacheVal({ connected: false, items: [] }, NOW);
  assert.equal(v.connected, false);
  assert.equal(v.riskLevel, "unavailable", "only a disconnected feed reads unavailable");
});

test("connected provider with a severe, fresh headline → connected:true, elevated risk", () => {
  const v = deriveNewsCacheVal(
    {
      connected: true,
      items: [
        {
          headline: "Fed announces emergency rate hike amid market crash",
          source: "Reuters",
          summary: "Volatility surges on the surprise decision.",
          publishedAt: new Date(NOW - 5 * 60 * 1000).toISOString(),
        },
      ],
    },
    NOW,
  );
  assert.equal(v.connected, true);
  assert.notEqual(v.riskLevel, "unavailable");
  assert.notEqual(v.riskLevel, "low", "a fresh high-severity headline must read above low");
  assert.equal(v.items.length, 1, "connected feed surfaces its headline(s)");
});

// ── composeRubyBriefing: connected-but-quiet wording lock (Task #630) ────────
// DECISION (locked here): when the news provider is CONNECTED but returns zero
// headlines, the feed is genuinely quiet. Ruby's briefing must read the news
// risk as quiet/low — it must NOT collapse to the disconnected "unavailable"
// fallback. "Unavailable" is reserved for a genuinely disconnected feed; using
// it for a quiet-but-connected feed would understate that we DO have a live
// feed reading low. Mirrors the deriveNewsCacheVal data-layer lock above.

function baseCtx(overrides: Partial<RubyContext> = {}): RubyContext {
  return {
    generatedAt: new Date(NOW).toISOString(),
    page: { key: "/", label: "Cockpit" },
    role: "USER",
    isPrivileged: false,
    timeOfDay: "morning",
    serverUtcHour: 9,
    session: null,
    symbol: null,
    bridge: { availability: "HEALTHY", connected: true, message: "" },
    account: {
      mt5: null,
      allocation: null,
      openPositions: 0,
      openPL: null,
      snapshotFreshness: null,
      live: null,
    },
    performance: { hasTrades: false },
    news: { connected: false, items: [], riskLevel: "unavailable" },
    // Calendar connected so newsRiskStatement returns null and only the
    // news-branch wording is under test.
    calendar: { connected: true, next: null },
    weather: { available: false },
    location: { available: false },
    warnings: [],
    ...overrides,
  };
}

test("briefing: connected provider with ZERO items reads quiet/low, never unavailable", () => {
  const briefing = composeRubyBriefing(
    baseCtx({ news: { connected: true, items: [], riskLevel: "low" } }),
  );
  const joined = briefing.lines.join(" ").toLowerCase();
  assert.ok(
    joined.includes("news risk reads low"),
    `a connected, quiet feed must read low: ${briefing.lines.join(" | ")}`,
  );
  assert.ok(
    !joined.includes("news risk is unavailable"),
    "a connected feed must NEVER report news risk as unavailable",
  );
  assertNoFalseReassurance(briefing.lines.join(" "));
});

// ── composeRubyBriefing: open-positions honesty ──────────────────────────────
// A FAILED open-trades lookup (openPositions: null) must never read as the
// confident "No positions are currently open." — the account may hold live
// broker positions the briefing simply couldn't see.

test("briefing: openPositions null (lookup failed) reads as can't-verify, never 'no positions'", () => {
  const ctx = baseCtx();
  ctx.account.openPositions = null;
  const briefing = composeRubyBriefing(ctx);
  const joined = briefing.lines.join(" ").toLowerCase();
  assert.ok(
    !joined.includes("no positions are currently open"),
    `a failed positions read must NEVER claim flat: ${briefing.lines.join(" | ")}`,
  );
  assert.ok(
    joined.includes("can't verify your open positions"),
    `a failed positions read must say it can't verify: ${briefing.lines.join(" | ")}`,
  );
});

test("briefing: openPositions 0 (successful read) still reads as genuinely flat", () => {
  const ctx = baseCtx();
  ctx.account.openPositions = 0;
  const briefing = composeRubyBriefing(ctx);
  const joined = briefing.lines.join(" ").toLowerCase();
  assert.ok(
    joined.includes("no positions are currently open"),
    `a real zero must still read as flat: ${briefing.lines.join(" | ")}`,
  );
  assert.ok(!joined.includes("can't verify your open positions"));
});

test("briefing: disconnected news feed reads unavailable, never low/quiet", () => {
  const briefing = composeRubyBriefing(
    baseCtx({
      news: { connected: false, items: [], riskLevel: "unavailable" },
      calendar: { connected: false, next: null },
    }),
  );
  const joined = briefing.lines.join(" ").toLowerCase();
  assert.ok(
    joined.includes("unavailable"),
    `a disconnected feed must read unavailable: ${briefing.lines.join(" | ")}`,
  );
  assert.ok(
    !joined.includes("news risk reads low"),
    "a disconnected feed must NEVER read news risk as low",
  );
  assertNoFalseReassurance(briefing.lines.join(" "));
});

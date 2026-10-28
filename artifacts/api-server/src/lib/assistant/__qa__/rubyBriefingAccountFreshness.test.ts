// Truth regression: Ruby's briefing account lines must carry their evidence.
//   - A MISSING master MT5 snapshot is reported by the pool as 0s; the
//     briefing must not show "balance $0.00" as if observed.
//   - A STALE snapshot's numbers are last-known, said on the same line.
//   - Open P/L whose freshness is unavailable/unknown is not shown bare.
import { test } from "node:test";
import assert from "node:assert/strict";
import { composeRubyBriefing, type RubyContext } from "../rubyContext.js";

function ctx(account: Partial<RubyContext["account"]>, privileged = true): RubyContext {
  return {
    generatedAt: "2026-10-28T09:00:00.000Z",
    page: { key: "/", label: "Cockpit" },
    role: privileged ? "OWNER" : "USER",
    isPrivileged: privileged,
    timeOfDay: "morning",
    serverUtcHour: 9,
    session: null,
    symbol: null,
    bridge: { availability: "HEALTHY", connected: true, message: "" },
    account: {
      mt5: null, allocation: null, openPositions: 0, openPositionsChecked: true, openPL: null, snapshotFreshness: null, live: null,
      ...account,
    },
    performance: { hasTrades: false },
    news: { connected: true, items: [], riskLevel: "low" },
    calendar: { connected: true, next: null },
    weather: { available: false },
    location: { available: false },
    warnings: [],
  };
}

const mt5 = (snapshotStatus: string) => ({ balance: 0, equity: 0, openPnl: 0, currency: "USD", snapshotStatus });

test("MISSING master snapshot: no '$0.00 balance' line", () => {
  const lines = composeRubyBriefing(ctx({ mt5: mt5("MISSING") })).lines;
  assert.ok(!lines.some((l) => /balance USD 0\.00/.test(l)), lines.join(" | "));
  assert.ok(lines.some((l) => /no account snapshot has been received/.test(l)), lines.join(" | "));
});

test("STALE master snapshot: numbers are labelled last-known on the same line", () => {
  const lines = composeRubyBriefing(ctx({ mt5: { ...mt5("STALE"), balance: 1000, equity: 990 } })).lines;
  const line = lines.find((l) => l.startsWith("Master MT5"));
  assert.ok(line);
  assert.match(line!, /last-known — the snapshot is stale/);
});

test("FRESH master snapshot reads bare", () => {
  const lines = composeRubyBriefing(ctx({ mt5: { ...mt5("FRESH"), balance: 1000, equity: 990 } })).lines;
  assert.ok(lines.includes("Master MT5: balance USD 1,000.00, equity USD 990.00, open P/L USD 0.00."), lines.join(" | "));
});

test("open P/L with unavailable or unknown freshness is never shown bare", () => {
  for (const f of ["unavailable", null]) {
    const lines = composeRubyBriefing(ctx({ openPositions: 1, openPL: 12.5, snapshotFreshness: f }, false)).lines;
    const line = lines.find((l) => l.startsWith("Open floating P/L"));
    assert.ok(line, lines.join(" | "));
    assert.match(line!, /freshness could not be confirmed/, `freshness=${f}`);
  }
  const live = composeRubyBriefing(ctx({ openPositions: 1, openPL: 12.5, snapshotFreshness: "live" }, false)).lines;
  assert.ok(live.includes("Open floating P/L: $12.50."), live.join(" | "));
});

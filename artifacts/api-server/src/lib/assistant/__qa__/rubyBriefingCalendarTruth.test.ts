// Truth regression: a connected economic calendar that lists no events WAS
// checked. Ruby's context used to report it as connected:false, so the
// briefing told the user "The economic-calendar feed isn't connected" — the
// wrong cause. It must stay connected (next = null) and the briefing must not
// claim the feed is down, nor invent a "no events" all-clear. A calendar that
// is genuinely not configured still reads not connected.
//
// Run with --experimental-test-module-mocks (test:truth-component-evidence).
import { test, mock } from "node:test";
import assert from "node:assert/strict";

let calendar: Record<string, unknown> = { connected: true, provider: "trading_economics", status: "empty", events: [], providerState: "connected" };

const realCal = await import("../../news/economicCalendarProvider.js");
mock.module("../../news/economicCalendarProvider.js", {
  namedExports: { ...realCal, getEconomicCalendar: async () => calendar },
});

const { buildRubyContext, composeRubyBriefing } = await import("../rubyContext.js");

test("connected calendar with no events: stays connected, no 'isn't connected' line, no invented all-clear", async () => {
  const ctx = await buildRubyContext(515151, "USER", "/", null);
  assert.equal(ctx.calendar.connected, true);
  assert.equal(ctx.calendar.next, null);
  const lines = composeRubyBriefing(ctx).lines;
  assert.ok(!lines.some((l) => /economic-calendar feed(s)? (isn't|aren't) connected/i.test(l)), lines.join(" | "));
  assert.ok(!lines.some((l) => /no (scheduled )?events/i.test(l) && !/won't assume|not assuming/i.test(l)), lines.join(" | "));
});

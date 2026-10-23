// Deterministic honesty lock for the Market Impact Radar. Run via:
//   pnpm --filter @workspace/api-server run test:market-heat-radar-honesty
//
// NON-NEGOTIABLE HONESTY: with no live economic-calendar provider connected the
// radar NEVER fabricates a scheduled event and NEVER reads as a confident
// all-clear. The disconnected note must say events are not fabricated, the event
// list must be empty, and the summary must name the missing provider rather than
// implying "no events". Synthetic instruments are never driven by macro events.
// Advisory only — the radar carries no execution field of any kind.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMarketImpactRadar } from "../marketImpactRadar.js";

const NOW = Date.parse("2026-06-19T12:00:00.000Z");

// ── events are real-or-empty, in EITHER environment ──────────────────────────
//
// These two locks used to hardcode "this environment has no live
// economic-calendar provider connected", which only holds on a runner without
// `ECONOMIC_CALENDAR_PROVIDER` / `FRED_API_KEY`. This container HAS those
// secrets, so the provider genuinely connects, the radar legitimately surfaces
// real FRED events, and the tests failed for being wrong about their
// environment — nothing fabricated an event. (Its sibling in
// `heat/__qa__/newsRiskAndEvents.test.ts` was corrected the same way.)
//
// The invariant that actually matters is identical in both environments and is
// asserted as a biconditional: an event may exist ONLY when the provider is
// connected. The disconnected branch keeps every original assertion verbatim,
// so the honesty lock is not weakened — a disconnected radar still cannot
// surface a single event, still must say events are not fabricated, and still
// must never read as a confident all-clear.

test("radar: events are real-or-empty — never fabricated while disconnected", async () => {
  const { radar } = await buildMarketImpactRadar("EURUSD", NOW);

  if (!radar.provider.connected) {
    // The original assertions, unchanged, on the disconnected path.
    assert.deepEqual(radar.events, []);
    // The absence of a warning is NOT an all-clear — the note must say so by
    // explicitly stating events are not fabricated.
    assert.match(radar.provider.note, /none are fabricated/i);
    // The summary must name the missing provider, never imply a confident
    // "no events" all-clear.
    assert.match(radar.summary, /no live economic-calendar provider is connected/i);
    assert.doesNotMatch(radar.summary, /low risk/i);
    return;
  }

  // Connected: the radar may show events, but every one must be a real, fully
  // attributed record — no filler rows, no placeholder titles, no invented
  // timestamps — and the copy must not claim a provider is missing.
  assert.match(radar.provider.note, /live economic-calendar feed connected/i);
  assert.doesNotMatch(radar.summary, /no live economic-calendar provider is connected/i);
  assert.doesNotMatch(radar.summary, /low risk/i);
  for (const e of radar.events) {
    assert.ok(e.id.length > 0, "event carries a real id");
    assert.ok(e.title.length > 0, "event carries a real title");
    assert.ok(
      ["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(e.severity),
      `event severity is a real level: ${e.severity}`,
    );
    assert.ok(
      Number.isFinite(Date.parse(e.eventTimeIso)),
      `event carries a parseable time: ${e.eventTimeIso}`,
    );
    assert.ok(
      Number.isFinite(e.countdownSeconds),
      "countdown is derived from a real timestamp, never a placeholder",
    );
  }
});

test("radar: severity and high-impact window are earned, never asserted", async () => {
  const { radar } = await buildMarketImpactRadar("XAUUSD", NOW);

  if (!radar.provider.connected) {
    // The original assertions, unchanged, on the disconnected path.
    assert.equal(radar.highImpactWindowActive, false);
    assert.equal(radar.topSeverity, null);
    return;
  }

  // Connected: severity must be BACKED by an event that affects this symbol —
  // it can never be conjured from an empty or non-affecting event list.
  const affecting = radar.events.filter((e) => e.affectsSymbol);
  if (affecting.length === 0) {
    assert.equal(radar.topSeverity, null, "no affecting event ⇒ no severity");
    assert.equal(radar.highImpactWindowActive, false, "no affecting event ⇒ no window");
    return;
  }
  assert.ok(
    radar.topSeverity != null && affecting.some((e) => e.severity === radar.topSeverity),
    `topSeverity ${radar.topSeverity} must be carried by an affecting event`,
  );
  if (radar.highImpactWindowActive) {
    // A high-impact window requires a live-or-imminent CRITICAL/HIGH event.
    assert.ok(
      affecting.some(
        (e) =>
          (e.severity === "CRITICAL" || e.severity === "HIGH") &&
          (e.state === "LIVE" || e.state === "IMMINENT"),
      ),
      "high-impact window must be backed by a live/imminent CRITICAL or HIGH event",
    );
  }
});

test("radar: synthetic instrument is never driven by macro events", async () => {
  const { radar } = await buildMarketImpactRadar("Volatility 75 Index", NOW);
  assert.deepEqual(radar.events, []);
  assert.match(radar.summary, /synthetic instrument/i);
  assert.match(radar.summary, /not driven by real-world economic events/i);
});

test("radar: result is advisory-only — carries no execution field", async () => {
  const result = await buildMarketImpactRadar("EURUSD", NOW);
  const blob = JSON.stringify(result).toLowerCase();
  assert.equal(blob.includes("allowexecution"), false);
  assert.equal(blob.includes("alloworderexecution"), false);
  assert.equal(blob.includes("cantrade"), false);
  assert.equal(blob.includes("liveunlock"), false);
});

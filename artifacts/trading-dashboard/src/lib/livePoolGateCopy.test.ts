// Regression test — the shared master-pool pre-gate codes (emitted by
// liveCommandPipeline.ts preflight BEFORE the 16 dispatch gates) must each
// render SPECIFIC user copy, never the generic "server safety check refused"
// fallback. This guards the copy-parity gap behind the real-world
// LIVE_BLOCKED:POOL_OVER_ALLOCATED block (audit ids 587/588).
//
// Behavioural assertions only (we call the real humanize/structure functions
// and inspect their output) — NOT a source-scan, so it can't false-pass off a
// comment or a stale string.

import { describe, it, expect } from "vitest";
import { humanizeReason } from "./humanize.js";
import { structureRejection } from "./structuredRejection.js";

// The exact generic strings these codes used to fall through to.
const GENERIC_DESCRIPTION =
  "A server safety check refused this order. See the technical code below or try again with adjusted settings.";
const GENERIC_TITLES = new Set([
  "Order was blocked by a safety gate",
  "Order refused",
]);

// Source of truth: the master-pool pre-gate reasons in
// artifacts/api-server/src/lib/live/liveCommandPipeline.ts preflight().
const MASTER_POOL_PREGATE_CODES = [
  "MASTER_BRIDGE_NOT_PINNED",
  "MASTER_SNAPSHOT_MISSING",
  "MASTER_SNAPSHOT_STALE",
  "SHARED_LIVE_PAUSED",
  "POOL_OVER_ALLOCATED",
  "USER_ALLOCATION_NOT_ASSIGNED",
  "USER_ALLOCATION_EXHAUSTED",
  "ALLOCATION_EXCEEDS_MASTER_AVAILABLE",
  "ALLOCATION_FROZEN",
] as const;

describe("master-pool pre-gate copy parity", () => {
  for (const code of MASTER_POOL_PREGATE_CODES) {
    const raw = `LIVE_BLOCKED:${code}`;

    it(`${code}: humanizeReason renders specific, non-generic copy`, () => {
      const h = humanizeReason(raw);
      expect(h.description).not.toBe(GENERIC_DESCRIPTION);
      expect(h.description.length).toBeGreaterThan(0);
      expect(GENERIC_TITLES.has(h.title)).toBe(false);
      // raw code preserved for support; never classified UNKNOWN.
      expect(h.technicalCode).toBe(raw);
      expect(h.category).not.toBe("UNKNOWN");
      // copy must never imply the order went through.
      expect(/\b(placed|executed|filled|opened successfully)\b/i.test(h.description)).toBe(false);
    });

    it(`${code}: structureRejection renders specific user copy + layer`, () => {
      const s = structureRejection(raw);
      expect(s.userMessage).not.toBe(GENERIC_DESCRIPTION);
      expect(s.userMessage.length).toBeGreaterThan(0);
      expect(s.suggestedFix.length).toBeGreaterThan(0);
      expect(s.rejectLayer).not.toBe("unknown");
      // never leak internals.
      expect(/ARX_LIVE_BROKER_EXECUTION_ENABLED|Bearer |SESSION_SECRET/i.test(s.userMessage + s.suggestedFix)).toBe(false);
    });
  }
});

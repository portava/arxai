// Task #547 — lock the trader-facing copy for the live-entry reason
// SYNTHETIC_FEED_NOT_LIVE_CONFIRMED (added in Task #542).
//
// The api-server side is already covered by
//   artifacts/api-server/src/lib/data/providers/__qa__/derivSymbolFeedStatus.test.ts
// (which asserts the reason classifies as a TRANSIENT TECHNICAL state, never the
// permanent broker-enforced data-only floor). This test is the FRONTEND mirror:
// the message a trader actually reads must stay honest if anyone edits the copy.
//
// Two presentation surfaces map the reason for users:
//   1. lib/humanize.ts            — humanizeReason() / categorizeReason()
//   2. components/live/liveSharedReasonCopy.ts — mapValidationToUserCopy()
//
// We verify, for BOTH surfaces, that the reason maps to the intended honest
// "isn't live-confirmed yet / feed isn't ticking / transient" copy in all three
// shapes it can arrive in:
//   - bare:            SYNTHETIC_FEED_NOT_LIVE_CONFIRMED
//   - dispatch-suffix: SYNTHETIC_FEED_NOT_LIVE_CONFIRMED:<sym>_no_live_tick
//   - LIVE_BLOCKED:-wrapped envelope
// and is NEVER mislabeled as the permanent data-only block
// (SYMBOL_NOT_LIVE_TRADABLE). Mirroring the source-scan rule, we assert the NEW
// copy is present AND the OLD/forbidden phrasing is absent.

import { describe, it, expect } from "vitest";

import { humanizeReason, categorizeReason } from "./humanize.js";
import {
  mapValidationToUserCopy,
  FORBIDDEN_USER_COPY_TOKENS,
} from "../components/live/liveSharedReasonCopy.js";
import { structureRejection } from "./structuredRejection.js";

const BARE = "SYNTHETIC_FEED_NOT_LIVE_CONFIRMED";
const SUFFIXED = "SYNTHETIC_FEED_NOT_LIVE_CONFIRMED:V75_no_live_tick";
const WRAPPED = "LIVE_BLOCKED:SYNTHETIC_FEED_NOT_LIVE_CONFIRMED";

// The permanent data-only floor this reason must NEVER be confused with. Its
// copy talks about a "data-only market" that "can't be traded live here" / isn't
// "routable to the broker". None of that phrasing may appear for the transient
// synthetic-feed reason.
const DATA_ONLY_PHRASES = [
  "data-only market",
  "can't be traded live here",
  "routable to the broker",
  "Pick a different symbol",
];

// Tokens that signal the intended honest, transient meaning.
const HONEST_PHRASES = ["live-confirmed", "isn't ticking", "No order was sent"];

function assertNoForbiddenTokens(copy: string): void {
  for (const token of FORBIDDEN_USER_COPY_TOKENS) {
    expect(copy.includes(token), `copy must not leak forbidden token "${token}"`).toBe(false);
  }
}

function assertNotDataOnlyCopy(copy: string): void {
  for (const phrase of DATA_ONLY_PHRASES) {
    expect(copy.includes(phrase), `copy must not use data-only phrasing "${phrase}"`).toBe(false);
  }
}

describe("humanize.ts — SYNTHETIC_FEED_NOT_LIVE_CONFIRMED copy", () => {
  it("classifies the bare reason as a transient TECHNICAL state (not BROKER data-only)", () => {
    expect(categorizeReason(BARE)).toBe("TECHNICAL");
    // The permanent data-only floor is BROKER — they must differ.
    expect(categorizeReason("SYMBOL_NOT_LIVE_TRADABLE")).toBe("BROKER");
  });

  it("bare reason maps to honest live-confirmation copy", () => {
    const r = humanizeReason(BARE);
    expect(r.category).toBe("TECHNICAL");
    expect(r.title).toBe("This synthetic isn't live-confirmed yet");
    const full = `${r.title} ${r.description}`;
    for (const phrase of HONEST_PHRASES) {
      expect(full.includes(phrase), `copy should mention "${phrase}"`).toBe(true);
    }
    assertNotDataOnlyCopy(full);
  });

  it("dispatch-suffixed form names the symbol and stays transient/honest", () => {
    const r = humanizeReason(SUFFIXED);
    expect(r.title).toBe("V75 isn't live-confirmed yet");
    expect(r.description).toContain("V75");
    expect(r.description).toContain("isn't ticking right now");
    expect(r.description).toContain("No order was sent");
    // Raw suffix and forbidden tokens must not leak into the prose.
    expect(r.title.includes("_no_live_tick")).toBe(false);
    expect(r.description.includes("_no_live_tick")).toBe(false);
    assertNotDataOnlyCopy(`${r.title} ${r.description}`);
  });

  it("LIVE_BLOCKED:-wrapped envelope maps to the same honest copy + category", () => {
    const r = humanizeReason(WRAPPED);
    expect(r.category).toBe("TECHNICAL");
    expect(r.title).toBe("This synthetic isn't live-confirmed yet");
    const full = `${r.title} ${r.description}`;
    for (const phrase of HONEST_PHRASES) {
      expect(full.includes(phrase)).toBe(true);
    }
    assertNotDataOnlyCopy(full);
  });

  it("is never mislabeled as the permanent data-only block", () => {
    const synthetic = humanizeReason(BARE);
    const dataOnly = humanizeReason("SYMBOL_NOT_LIVE_TRADABLE");
    expect(synthetic.title).not.toBe(dataOnly.title);
    expect(synthetic.description).not.toBe(dataOnly.description);
    expect(synthetic.category).not.toBe(dataOnly.category);
  });
});

describe("liveSharedReasonCopy.ts — SYNTHETIC_FEED_NOT_LIVE_CONFIRMED copy", () => {
  // The data-only (permanent) copy this mapper produces for NOT_LIVE_TRADABLE —
  // used to prove the synthetic reason routes to a DIFFERENT, transient sentence.
  const dataOnlyCopy = mapValidationToUserCopy({ reason: "SYMBOL_NOT_LIVE_TRADABLE" });

  for (const [shape, input] of [
    ["bare (reason)", { reason: BARE }],
    ["dispatch-suffixed (reason)", { reason: SUFFIXED }],
    ["LIVE_BLOCKED-wrapped (primaryReason)", { primaryReason: WRAPPED }],
  ] as const) {
    it(`maps ${shape} to the transient honest sentence`, () => {
      const copy = mapValidationToUserCopy(input);
      expect(copy).not.toBeNull();
      const text = copy!;
      // NEW copy present.
      expect(text).toContain("isn't live-confirmed yet");
      expect(text).toContain("price feed isn't ticking");
      // OLD / forbidden phrasing absent (source-scan parity).
      assertNotDataOnlyCopy(text);
      assertNoForbiddenTokens(text);
      // Must route to a DIFFERENT sentence than the permanent data-only floor.
      expect(text).not.toBe(dataOnlyCopy);
    });
  }

  it("still maps the permanent data-only floor to its own distinct copy", () => {
    // Guards against a future edit collapsing the two branches together.
    expect(dataOnlyCopy).not.toBeNull();
    expect(dataOnlyCopy!).toContain("can't be traded live");
    expect(dataOnlyCopy!).not.toContain("isn't live-confirmed yet");
  });
});

// ── Task #737 follow-up — specific execution-readiness blocker copy ─────────
// The order path threads the resolver's SPECIFIC blockingReasonCode alongside
// the generic canonical reason (LIVE_BLOCKED:LIVE_EXECUTION_ACTIVATION_GATE).
// Each distinct blocker must read DISTINCTLY so "approved but Full Live
// Activation missing" can never be confused with "feed not confirmed" or any
// other cause. Copy stays user-safe (no raw gate tokens leak).
describe("liveSharedReasonCopy.ts — blockingReasonCode distinct copy", () => {
  // The generic activation-gate sentence (when NO specific code is threaded).
  const generic = mapValidationToUserCopy({
    primaryReason: "LIVE_BLOCKED:LIVE_EXECUTION_ACTIVATION_GATE",
  });

  it("approved-but-not-activated reads distinctly from the generic gate", () => {
    const specific = mapValidationToUserCopy({
      primaryReason: "LIVE_BLOCKED:LIVE_EXECUTION_ACTIVATION_GATE",
      blockingReasonCode: "LIVE_CONFIRMATION_REQUIRED",
    });
    expect(specific).not.toBeNull();
    expect(specific).not.toBe(generic);
    expect(specific!).toContain("Full Live Activation isn't complete");
    assertNoForbiddenTokens(specific!);
  });

  it("the substring-colliding code resolves to its OWN sentence", () => {
    // SERVER_LIVE_EXECUTION_OFF contains the substring LIVE_EXECUTION_OFF, which
    // the legacy concatenated chain maps to an EA-input sentence. The exact
    // blockingReasonCode match must win with the maintenance sentence instead.
    const serverOff = mapValidationToUserCopy({
      primaryReason: "LIVE_BLOCKED:LIVE_EXECUTION_ACTIVATION_GATE",
      blockingReasonCode: "SERVER_LIVE_EXECUTION_OFF",
    });
    expect(serverOff).not.toBeNull();
    expect(serverOff!).toContain("paused for maintenance");
    expect(serverOff!).not.toContain("EnableLiveExecution");
    assertNoForbiddenTokens(serverOff!);
  });

  it("every resolver blocker code maps to a unique, clean sentence", () => {
    const codes = [
      "NOT_APPROVED_FOR_LIVE",
      "LIVE_BRIDGE_ASSIGNMENT_PENDING",
      "EMERGENCY_STOP_ACTIVE",
      "LIVE_CONFIRMATION_REQUIRED",
      "LIVE_ARMING_PENDING",
      "SERVER_LIVE_EXECUTION_OFF",
      "RISK_PROFILE_INCOMPLETE",
    ];
    const seen = new Set<string>();
    for (const code of codes) {
      const copy = mapValidationToUserCopy({
        primaryReason: "LIVE_BLOCKED:LIVE_EXECUTION_ACTIVATION_GATE",
        blockingReasonCode: code,
      });
      expect(copy, `copy for ${code}`).not.toBeNull();
      assertNoForbiddenTokens(copy!);
      expect(seen.has(copy!), `copy for ${code} must be unique`).toBe(false);
      seen.add(copy!);
    }
  });
});

describe("structuredRejection.ts — overrideCode drives copy, canonical stays in trail", () => {
  it("overrideCode wins user copy while technicalCode keeps the canonical gate", () => {
    const withOverride = structureRejection(
      { primaryReason: "LIVE_BLOCKED:LIVE_EXECUTION_ACTIVATION_GATE" },
      { overrideCode: "LIVE_CONFIRMATION_REQUIRED" },
    );
    const withoutOverride = structureRejection({
      primaryReason: "LIVE_BLOCKED:LIVE_EXECUTION_ACTIVATION_GATE",
    });
    // User message differs once a specific blocker is threaded.
    expect(withOverride.userMessage).not.toBe(withoutOverride.userMessage);
    expect(withOverride.userMessage).toContain("Full Live Activation isn't complete");
    // Admin trail keeps the canonical gate, never the override code.
    expect(withOverride.technicalCode).toBe("LIVE_BLOCKED:LIVE_EXECUTION_ACTIVATION_GATE");
    expect(withOverride.technicalCode).not.toContain("LIVE_CONFIRMATION_REQUIRED");
  });

  it("an unknown overrideCode falls back to the canonical copy (no crash)", () => {
    const r = structureRejection(
      { primaryReason: "LIVE_BLOCKED:LIVE_EXECUTION_ACTIVATION_GATE" },
      { overrideCode: "TOTALLY_UNKNOWN_CODE" },
    );
    expect(r.userMessage).toContain("Live execution isn't activated");
    expect(r.technicalCode).toBe("LIVE_BLOCKED:LIVE_EXECUTION_ACTIVATION_GATE");
  });
});

import { join } from "node:path";
import { ROOT, read, rel, type CheckResult } from "./_lib.js";

// Task 497 — Ruby's REPORTED safety state must be DERIVED from getEnvelope()
// everywhere (honest both ways), never a hardcoded "paper-only / system-locked"
// stub. This guard asserts the static envelope constants are gone and the
// derived helper is wired into every assistant surface.
//
// Comments are stripped before scanning so doc-comment prose that legitimately
// MENTIONS the old tokens (to explain why they were removed) never trips a
// false positive — we assert against real CODE only. We assert NEW present AND
// OLD absent, per the source-scan-false-pass lesson.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments (incl. JSDoc)
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//")) // line comments
    .join("\n");
}

type Needle = { needle: string | RegExp; why: string };
type FileRule = {
  file: string;
  mustContain?: Needle[];
  mustNotContain?: Needle[];
};

const A = "artifacts/api-server/src";

// NOTE on scope: BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED is asserted ABSENT only
// in derivedEnvelope.ts (the paper-safety derivation). It legitimately remains
// in tools.ts (the getReconciliationStatus `placementLayer` field) and in the
// legacy chokepoint + Phase B blockReasons, so it is NOT asserted globally.
const RULES: FileRule[] = [
  {
    file: `${A}/lib/assistant/derivedEnvelope.ts`,
    mustContain: [
      { needle: "deriveAssistantEnvelope", why: "derived per-user envelope resolver must exist" },
      { needle: "assistantEnvelopeFields", why: "envelope projection helper must exist" },
      { needle: "buildPaperSafetyStatus", why: "pure paper-safety derivation must exist" },
      { needle: "READ_ONLY_PAPER_ENVELOPE", why: "read-only chart surfaces keep the forced paper envelope" },
      { needle: "FAIL_CLOSED_ENVELOPE", why: "fail-closed default must be available to assistant surfaces" },
    ],
    mustNotContain: [
      { needle: /\bSAFETY_ENVELOPE\b/, why: "the deleted static SAFETY_ENVELOPE constant must not return" },
      { needle: /\bASSISTANT_SAFETY_ENVELOPE\b/, why: "the deleted re-export must not return" },
      { needle: "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED", why: "the derived paper-status must not cite the legacy placement literal" },
    ],
  },
  {
    file: `${A}/lib/assistant/tools.ts`,
    mustContain: [
      { needle: "deriveAssistantEnvelope", why: "the dispatch boundary must derive the per-user envelope" },
      { needle: "...assistantEnvelopeFields(env)", why: "the dispatch boundary must merge the derived envelope into every object result" },
      { needle: "liveExecutionAvailabilityNote", why: "tool prose must use the DERIVED live-availability note, not hardcoded account-state copy" },
    ],
    mustNotContain: [
      { needle: /\.\.\.SAFETY_ENVELOPE\b/, why: "tools must not spread the deleted static envelope constant" },
      { needle: /\bASSISTANT_SAFETY_ENVELOPE\b/, why: "the deleted re-export must not return" },
      { needle: /const\s+SAFETY_ENVELOPE\b/, why: "the static envelope constant must not be redeclared" },
      // All code occurrences of the stale "system-locked" account-state claim
      // were removed (only a stripped doc-comment remains). Reporting CODE must
      // never re-hardcode it — the derived note tells the user the real state.
      { needle: /system-locked/i, why: "tool prose must not hardcode a 'system-locked' account-state claim (report the DERIVED state)" },
    ],
  },
  {
    file: `${A}/lib/assistant/systemPrompt.ts`,
    mustContain: [
      // systemPrompt consumes the derived envelope passed in by its callers
      // (it does not resolve it itself) — assert it is threaded into the prompt.
      { needle: "buildSafetyStateBlock", why: "the prompt must render the per-user safety state from the derived envelope" },
      { needle: "marketOrderLiveNote", why: "the market-order prompt line must use the DERIVED live note, not a hardcoded claim" },
      { needle: "liveAvailableForUser", why: "the prompt must branch on the user's real derived live availability" },
    ],
    mustNotContain: [
      { needle: /\bASSISTANT_SAFETY_ENVELOPE\b/, why: "the deleted re-export must not return" },
      // NOTE: the derived AUTHORITATIVE block legitimately uses the word
      // "system-locked" in CODE (to instruct Ruby NOT to make that claim), so a
      // blanket /system-locked/i would false-positive. Guard only the exact
      // stale hardcoded sentence that this task removed.
      { needle: /live remains system-locked/i, why: "the market-order prompt must not re-hardcode 'live remains system-locked' (use marketOrderLiveNote)" },
    ],
  },
  {
    // Confirmation choreography (SAFETY_NOTES §6) — gate #7 was extracted into a
    // pure helper so it could be unit-tested. Lock BOTH the helper literal AND
    // the chain call-site: D5 tests the helper, but if the chain stopped calling
    // it, D5 would still pass. This needle closes that gap.
    file: `${A}/lib/adminTrading/orderGuard.ts`,
    mustContain: [
      { needle: "export function liveConfirmationGate", why: "the pure live-confirmation gate helper must remain exported (unit-testable)" },
      { needle: "liveConfirmationGate(req.mode, req.confirmedByUser)", why: "the order-guard chain must still invoke gate #7 — confirmation choreography call-site" },
      { needle: "LIVE_CONFIRMATION_REQUIRED", why: "the live-confirmation rejection literal must remain" },
    ],
  },
  {
    file: `${A}/lib/assistant/realtimeSession.ts`,
    mustContain: [
      { needle: "deriveAssistantEnvelope", why: "the voice session must derive the per-user envelope" },
      { needle: "assistantEnvelopeFields", why: "the voice session must project the derived envelope" },
    ],
    mustNotContain: [
      { needle: /\bSAFETY_ENVELOPE\b/, why: "the voice session must not use the deleted static constant" },
      { needle: /\bASSISTANT_SAFETY_ENVELOPE\b/, why: "the deleted re-export must not return" },
    ],
  },
  {
    file: `${A}/routes/meAssistant.ts`,
    mustContain: [
      { needle: "deriveAssistantEnvelope", why: "assistant routes must derive the per-user envelope" },
      { needle: "assistantEnvelopeFields", why: "assistant routes must project the derived envelope" },
    ],
    mustNotContain: [
      { needle: /\bASSISTANT_SAFETY_ENVELOPE\b/, why: "the deleted re-export must not return" },
    ],
  },
  {
    file: `${A}/lib/assistant/coachTools.ts`,
    mustNotContain: [
      { needle: /\bSAFETY_ENVELOPE\b/, why: "coach tools must not embed the deleted static constant (the envelope is merged at the dispatch boundary)" },
      { needle: /\bASSISTANT_SAFETY_ENVELOPE\b/, why: "the deleted re-export must not return" },
    ],
  },
];

function present(src: string, needle: string | RegExp): boolean {
  return typeof needle === "string" ? src.includes(needle) : needle.test(src);
}

export function checkRubyDerivedSafetyEnvelope(): CheckResult {
  const violations: string[] = [];
  const notes: string[] = [];
  for (const rule of RULES) {
    const abs = join(ROOT, rule.file);
    let src: string;
    try {
      src = stripComments(read(abs));
    } catch {
      violations.push(`${rule.file}: cannot read (expected assistant surface is missing)`);
      continue;
    }
    for (const m of rule.mustContain ?? []) {
      if (!present(src, m.needle)) {
        violations.push(`${rule.file}: MISSING required '${m.needle}' — ${m.why}`);
      }
    }
    for (const m of rule.mustNotContain ?? []) {
      if (present(src, m.needle)) {
        violations.push(`${rule.file}: FORBIDDEN '${m.needle}' is present — ${m.why}`);
      }
    }
    notes.push(`scanned ${rel(abs)}`);
  }
  return {
    name: "ruby-derived-safety-envelope (assistant reports DERIVED, not hardcoded, safety state)",
    ok: violations.length === 0,
    violations,
    notes,
  };
}

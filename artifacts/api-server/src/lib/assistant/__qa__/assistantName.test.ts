// Task #640 — Per-user AI assistant display name (default "Eleanor").
//
// Personalization/branding ONLY. These are pure, deterministic unit tests — no
// DB, no IO. They lock the rename contract:
//   - the shared default + validation rules (domain helper), and
//   - that user-facing backend copy DERIVES the name (never hardcodes "Ruby").
//
// Coverage map to the task spec's 12 points:
//   (1)  new user / no setting resolves to Eleanor
//   (2)  a valid custom name is accepted + normalized (the persisted value)
//   (3-6) the custom name flows into user-facing copy — exercised here at the
//         backend chart-read derivation (analyzeChartStructure); the chat
//         header, Scanner and Scalp Builder surfaces consume the SAME single
//         source (useAssistantName) on the frontend.
//   (7)  reset (null) restores Eleanor
//   (8)  per-user isolation — the resolver is pure/stateless, so distinct
//         inputs never bleed into one another (the route additionally scopes
//         every read/write by req.authUser.id)
//   (9)  invalid empty/too-short/too-long/invalid-chars/impersonation rejected
//   (10) ARX platform branding is never injected or stripped by name resolution
//   (11) no user-facing "Ruby" copy remains in derived backend text
//   (12) the existing Ruby reasoning/read-layer suites still pass (wired in CI)
//
// Run: pnpm --filter @workspace/api-server run test:assistant-name

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ASSISTANT_NAME,
  resolveAssistantName,
  validateAssistantName,
} from "@workspace/domain/assistant-name";
import { analyzeChartStructure } from "../chartStructure.js";

// (1) new user with no custom setting → Eleanor.
test("resolveAssistantName falls back to Eleanor for null/empty/whitespace", () => {
  assert.equal(DEFAULT_ASSISTANT_NAME, "Eleanor");
  assert.equal(resolveAssistantName(null), "Eleanor");
  assert.equal(resolveAssistantName(undefined), "Eleanor");
  assert.equal(resolveAssistantName(""), "Eleanor");
  assert.equal(resolveAssistantName("   "), "Eleanor");
});

// (7) reset sends null → Eleanor (same path as a brand-new user).
test("resolveAssistantName treats a null reset as the default", () => {
  assert.equal(resolveAssistantName(null), DEFAULT_ASSISTANT_NAME);
});

// (2) a valid custom name is accepted and whitespace-normalized — this is the
// exact value that gets persisted.
test("validateAssistantName accepts and normalizes a valid custom name", () => {
  const ok = validateAssistantName("  Nova   Quant  ");
  assert.equal(ok.ok, true);
  assert.equal(ok.value, "Nova Quant");
  const simple = validateAssistantName("Athena");
  assert.equal(simple.ok, true);
  assert.equal(simple.value, "Athena");
});

// (9) invalid names are rejected with a machine code (server-authoritative).
test("validateAssistantName rejects empty/too-short/too-long/invalid-chars/reserved", () => {
  assert.equal(validateAssistantName("").error, "EMPTY");
  assert.equal(validateAssistantName("   ").error, "EMPTY");
  assert.equal(validateAssistantName("a").error, "TOO_SHORT");
  assert.equal(validateAssistantName("x".repeat(25)).error, "TOO_LONG");
  assert.equal(validateAssistantName("Bad@Name!").error, "INVALID_CHARS");
  // impersonation / reserved (case-insensitive)
  assert.equal(validateAssistantName("admin").error, "RESERVED");
  assert.equal(validateAssistantName("ARX Admin").error, "RESERVED");
  assert.equal(validateAssistantName("SYSTEM").error, "RESERVED");
});

// (10) name resolution is identity-on-nonempty: it never injects, rewrites, or
// strips ARX platform branding, and the default is the assistant name (not ARX).
test("name resolution never alters ARX platform branding", () => {
  assert.notEqual(DEFAULT_ASSISTANT_NAME, "ARX");
  assert.notEqual(DEFAULT_ASSISTANT_NAME, "ARX AI");
  // identity on a non-empty input — cannot rewrite a string into/out of "ARX".
  assert.equal(resolveAssistantName("Nova"), "Nova");
  assert.equal(resolveAssistantName("Eleanor"), "Eleanor");
});

// (8) per-user isolation at the resolver layer: the pure resolver is stateless,
// so one user's name can never leak into another's resolution.
test("resolveAssistantName is stateless — distinct inputs stay distinct", () => {
  const a = resolveAssistantName("UserA-Bot");
  const b = resolveAssistantName("UserB-Bot");
  assert.equal(a, "UserA-Bot");
  assert.equal(b, "UserB-Bot");
  assert.notEqual(a, b);
  // a subsequent null read still falls back to the shared default, unaffected.
  assert.equal(resolveAssistantName(null), "Eleanor");
});

// (3-6) the custom name flows into user-facing backend copy (chart read). The
// insufficient-data path is deterministic and name-bearing.
test("chart-read copy derives the custom assistant name", () => {
  const custom = analyzeChartStructure([], { assistantName: "Nova" });
  assert.equal(custom.dataQuality, "insufficient");
  assert.match(custom.why, /Nova/);
  assert.doesNotMatch(custom.why, /Ruby/);
});

// (11) with the default name, derived backend copy says "Eleanor" and contains
// no user-facing "Ruby".
test("default chart-read copy says Eleanor, never Ruby", () => {
  const def = analyzeChartStructure([]);
  assert.match(def.why, /Eleanor/);
  assert.doesNotMatch(def.why, /Ruby/);
});

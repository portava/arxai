// The override token comparison must be constant-time.
//
// `a !== b` on strings short-circuits at the first differing byte, so how long
// a rejection takes leaks how much of the prefix was correct. This endpoint
// writes to the behaviour log the AI later reasons from, which is exactly what
// the token protects.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { secretsMatch } from "../../lib/secretsMatch.js";

const SRC = readFileSync(new URL("../../lib/secretsMatch.ts", import.meta.url), "utf8")
  // Comments discuss the naive comparison they forbid; matching prose would be
  // a false failure, the mirror of the comment-trap seen across this codebase.
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the override token is NOT compared with a short-circuiting operator", () => {
  assert.ok(!/provided\s*!==\s*expected/.test(SRC),
    "the token is compared with !==, which leaks a prefix through timing");
  assert.match(SRC, /timingSafeEqual/, "no constant-time comparison present");
});

test("both sides are DIGESTED before comparison, so length is not a channel", () => {
  // timingSafeEqual throws on a length mismatch. Comparing raw values would
  // either crash on a wrong-length token or force a length check that leaks
  // the length by another route. A digest makes every comparison identical.
  assert.match(SRC, /createHash\("sha256"\)[\s\S]{0,120}?digest\(\)/,
    "values are not hashed to a fixed width before comparison");
});

test("the comparison semantics are unchanged — right accepts, wrong rejects", () => {
  // Exercises the SHIPPED function, not a reimplementation. An earlier version
  // of this test re-declared the predicate locally, so an always-true mutation
  // in the real one passed clean.
  const token = "correct-horse-battery-staple-0123456789";
  assert.equal(secretsMatch(token, token), true, "the correct token was rejected");
  assert.equal(secretsMatch(`${token}x`, token), false, "a longer token was accepted");
  assert.equal(secretsMatch(token.slice(0, -1), token), false, "a truncated token was accepted");
  assert.equal(secretsMatch("", token), false, "an empty token was accepted");
  assert.equal(secretsMatch(undefined, token), false, "a missing token was accepted");
  // A wrong token of the SAME length must still be rejected — the case a
  // length-only guard would wave through.
  assert.equal(secretsMatch("x".repeat(token.length), token), false);
  // Single-byte difference at the END: the case a prefix-only check misses.
  assert.equal(secretsMatch(`${token.slice(0, -1)}Z`, token), false);
});

test("a wrong-LENGTH token does not throw — it returns false", () => {
  // The failure mode of comparing raw buffers: timingSafeEqual throws on a
  // length mismatch, which would turn a bad token into a 500 instead of a 401.
  // Raw-buffer comparison throws on a length mismatch, which would turn a bad
  // token into a 500 instead of a 401. assert.doesNotThrow pins that.
  assert.doesNotThrow(() => secretsMatch("short", "a-much-longer-expected-token-value"));
  assert.equal(secretsMatch("short", "a-much-longer-expected-token-value"), false);
});

test("an EMPTY configured token authenticates nobody", () => {
  // If VAULT_OVERRIDE_TOKEN is unset and defaults to "", a digest comparison
  // alone returns true for an empty submission: hash("") === hash(""). The
  // explicit length guard is what closes that, so it is load-bearing.
  assert.equal(secretsMatch("", ""), false, "empty token matched an empty secret");
  assert.equal(secretsMatch(undefined, ""), false);
});

test("the FULL digest is compared, not a prefix of it", () => {
  // Comparing a slice of the digest still passes every behavioural test —
  // an 8-byte sha256 prefix collision is infeasible to construct — so this
  // weakening is only reachable by reading the source.
  const call = SRC.match(/timingSafeEqual\([\s\S]*?\)/);
  assert.ok(call, "no timingSafeEqual call found");
  assert.ok(!/subarray|slice|\.length\s*-|0\s*,\s*\d/.test(call[0]),
    `the comparison is truncated rather than full-width: ${call[0]}`);
});

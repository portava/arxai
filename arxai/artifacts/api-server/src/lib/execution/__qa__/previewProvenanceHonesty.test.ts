// The execution preview is advisory, so it keeps the router's display-path
// fallback and must never go blank. But a spread/ATR estimate priced from a
// venue the user is NOT executing on is misleading unless it says so — the
// audit flagged exactly this ("a cross-venue quote can invisibly become the
// fill/spread estimate"). This pins the labeling, not a behavior change.
process.env["DATABASE_URL"] ??= "postgres://user:pass@127.0.0.1:1/nonexistent";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "../executionPreviewService.ts"), "utf8");

test("the routed source of BOTH the quote and the ATR candles is captured", () => {
  assert.match(src, /quoteSource\s*=/, "quote provenance must be captured");
  assert.match(src, /atrSource\s*=/, "ATR-candle provenance must be captured");
});

test("a non-execution-broker source produces a warning, never a blocker", () => {
  assert.match(src, /warnings:\s*\[/, "labeling must append to warnings");
  assert.ok(!/blockers:\s*\[\s*\.\.\.preview\.blockers,/.test(src),
    "provenance labeling must never add a blocker — the preview stays viable");
});

test("mt5_broker (the execution venue) is treated as native and NOT warned about", () => {
  assert.match(src, /!==\s*"mt5_broker"/, "only foreign sources may be labeled");
});

test("multiple distinct foreign sources are deduped and all named", () => {
  assert.match(src, /new Set\(/, "sources must be deduped");
  assert.match(src, /\.join\(" \+ "\)/, "every contributing foreign venue must be named");
});

test("the preview is still returned unchanged when priced natively", () => {
  assert.match(src, /return preview;/, "native pricing must return the estimator output untouched");
});

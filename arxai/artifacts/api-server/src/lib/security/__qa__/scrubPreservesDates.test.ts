// scrub() walked every object with Object.entries, so a Date (no own keys)
// came out as {} and every scrubbed timestamp reached the client as an empty
// object. /live-trading-control then crashed on new Date({}).toISOString().
import { test } from "node:test";
import assert from "node:assert/strict";
import { scrub } from "../redact.js";

test("scrub keeps Date values so they serialize as ISO strings", () => {
  const createdAt = new Date("2026-11-04T12:00:00.000Z");
  const out = scrub({ id: 1, createdAt, nested: { at: createdAt }, list: [createdAt] });
  assert.ok(out.createdAt instanceof Date);
  assert.equal(JSON.parse(JSON.stringify(out)).createdAt, "2026-11-04T12:00:00.000Z");
  assert.equal(JSON.parse(JSON.stringify(out)).nested.at, "2026-11-04T12:00:00.000Z");
  assert.equal(JSON.parse(JSON.stringify(out)).list[0], "2026-11-04T12:00:00.000Z");
});

test("scrub still redacts secrets next to dates", () => {
  const out = scrub({ apiKey: "sk-live-abc", createdAt: new Date(0) }) as Record<string, unknown>;
  assert.equal(out.apiKey, "[REDACTED]");
  assert.ok(out.createdAt instanceof Date);
});

// Close-only mode: spec §3.1 lists it as a global control and §20 requires
// close-only controls be PROVEN. user_slot_allocation.close_only_mode was
// persisted and shown in admin UI but read by no dispatch path — the schema
// said so outright ("future hook ... Not enforced yet").
//
// The load-bearing property is the entry-vs-ops split: a close-only control
// that also blocked closes would TRAP the exposure it exists to wind down,
// making it strictly more dangerous than the risk it was set against.
process.env["DATABASE_URL"] ??= "postgres://user:pass@127.0.0.1:1/nonexistent";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const pipelineSrc = readFileSync(path.join(here, "../liveCommandPipeline.ts"), "utf8");
const schemaSrc = readFileSync(
  path.join(here, "../../../../../../lib/db/src/schema/userSlotAllocation.ts"),
  "utf8",
);

const { closeOnlyBlocksDispatch, CLOSE_ONLY_BLOCK_REASON } =
  await import("../liveCommandPipeline.js");

test("the reason literal is CI-pinned", () => {
  assert.equal(CLOSE_ONLY_BLOCK_REASON, "LIVE_BLOCKED:CLOSE_ONLY_MODE");
});

test("close-only refuses ENTRY commands", () => {
  assert.equal(closeOnlyBlocksDispatch({ closeOnlyMode: true, isEntryCommand: true }), true);
});

test("close-only NEVER blocks closes or SL/TP edits — it must not trap exposure", () => {
  assert.equal(
    closeOnlyBlocksDispatch({ closeOnlyMode: true, isEntryCommand: false }), false,
    "blocking a close would trap the very exposure close-only exists to wind down",
  );
});

test("an unset or absent flag refuses nothing", () => {
  for (const v of [false, null, undefined]) {
    assert.equal(
      closeOnlyBlocksDispatch({ closeOnlyMode: v, isEntryCommand: true }), false,
      `closeOnlyMode=${String(v)} must not refuse`,
    );
  }
});

test("only strict true engages it — truthy garbage does not", () => {
  for (const junk of ["true", 1, {}, [] as unknown]) {
    assert.equal(
      closeOnlyBlocksDispatch({
        closeOnlyMode: junk as unknown as boolean, isEntryCommand: true,
      }),
      false,
      `${JSON.stringify(junk)} must not engage close-only`,
    );
  }
});

test("the gate is wired entry-only at the dispatch call site", () => {
  const start = pipelineSrc.indexOf("// ── CLOSE-ONLY PRE-GATE");
  assert.ok(start > -1, "the pre-gate block must exist");
  const block = pipelineSrc.slice(start, start + 2600);
  assert.match(block, /PLACE_LIVE_MARKET_ORDER/);
  assert.match(block, /PLACE_LIVE_PENDING_ORDER/);
  assert.ok(
    !/CLOSE_LIVE_POSITION|MODIFY_LIVE_SLTP/.test(block),
    "ops commands must not appear in the close-only guard condition",
  );
});

test("it runs BEFORE the 23-gate evaluator and never replaces it", () => {
  const gateIdx = pipelineSrc.indexOf("// ── CLOSE-ONLY PRE-GATE");
  const evalIdx = pipelineSrc.indexOf("evaluateLivePhaseBDispatchGate(");
  assert.ok(gateIdx > -1 && evalIdx > -1);
  assert.ok(gateIdx < evalIdx, "the pre-gate must precede the 23-gate evaluator");
});

test("a refusal is audited and snapshot-tagged, not silent", () => {
  const start = pipelineSrc.indexOf("// ── CLOSE-ONLY PRE-GATE");
  const block = pipelineSrc.slice(start, start + 2600);
  assert.match(block, /CLOSE_ONLY_MODE_BLOCKED/);
  assert.match(block, /closeOnlyGate: true/);
  assert.match(block, /status: "LIVE_BLOCKED"/);
});

test("the schema no longer claims the flag is unenforced", () => {
  assert.ok(
    !/Not enforced yet/.test(schemaSrc),
    "the schema comment must not contradict the code that now enforces it",
  );
  assert.match(schemaSrc, /ENFORCED at live dispatch/);
});

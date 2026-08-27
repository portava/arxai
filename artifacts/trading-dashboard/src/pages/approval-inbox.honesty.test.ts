// @vitest-environment node
// Phase 6 — Approval Inbox UI honesty.
//
// Runs in the NODE environment, not jsdom: this is a source-text scan of the
// page's copy and control flow, so a DOM would be dead weight and an extra
// dependency for a test that never renders anything.
//
// The copy on this page IS a safety surface. A trader who reads "no trade" about
// an order that may exist will place another one, and that is how one approval
// becomes two positions. These assertions treat wording as behaviour.
//
// Source-scanned on STRIPPED source: the page's own comments describe the
// forbidden patterns, so a raw match would pass on the prose that forbids them.

import { test, expect } from "vitest";
import { readFileSync } from "node:fs";

const assert = {
  ok(v: unknown, msg?: string) { expect(v, msg).toBeTruthy(); },
  match(v: string, re: RegExp, msg?: string) { expect(v, msg).toMatch(re); },
  equal(a: unknown, b: unknown, msg?: string) { expect(a, msg).toBe(b); },
};

const RAW = readFileSync(new URL("./approval-inbox.tsx", import.meta.url), "utf8");
const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const APP = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");

test("the page is registered as a route — an unreachable page helps nobody", () => {
  assert.match(APP, /ApprovalInboxPage/);
  assert.match(APP, /path="\/approval-inbox"/);
});

// ── 1. no auto-approve, and approve is not send ───────────────────────────
test("there is NO auto-approve and no approve-and-send convenience", () => {
  assert.ok(!/autoApprove|approveAll|approveAndDispatch|bulkApprove/i.test(SRC),
    "the inbox offers a bulk or fused approval");
  // Approve and dispatch must be separate calls to separate endpoints.
  assert.match(SRC, /act\(t\.ticketId, "approve"\)/);
  assert.match(SRC, /act\(t\.ticketId, "dispatch"\)/);
  // No handler may fire both.
  assert.ok(!/act\([^)]*"approve"[^)]*\)[\s;]*(await\s*)?act\([^)]*"dispatch"/.test(SRC),
    "one click both approves and dispatches");
});

test("dispatch is only offered on an APPROVED ticket, never a PENDING one", () => {
  const pending = SRC.slice(SRC.indexOf('t.state === "PENDING"'), SRC.indexOf('t.state === "APPROVED"'));
  assert.ok(!/"dispatch"/.test(pending), "a PENDING ticket can be sent without being approved first");
});

// ── 2. an operator waiver is not the user's consent ───────────────────────
test("an operator disclosure waiver is shown as ITS OWN warning", () => {
  assert.match(SRC, /disclosureWaivedByOperator/,
    "the operator waiver is not surfaced at all, so it reads as the user's own consent");
  // Target the RENDER site, not the type declaration — indexOf finds the
  // interface field first, and asserting against that would pass while the
  // warning was never rendered at all.
  const at = SRC.indexOf("t.disclosureWaivedByOperator &&");
  assert.ok(at > 0, "the waiver is declared but never rendered");
  const block = SRC.slice(at, at + 500);
  assert.match(block, /waived by an operator/i, "the waiver is not named as an operator's act");
  assert.match(block, /not accepted it yourself|have not accepted/i,
    "the waiver does not state that the user has NOT accepted");
});

// ── 3. UNKNOWN never reads as no-trade or failed ──────────────────────────
test("an INDETERMINATE outcome says an order MAY EXIST, never no-trade", () => {
  assert.match(SRC, /result\.indeterminate/, "the indeterminate flag is ignored by the UI");
  const at = SRC.indexOf("result.indeterminate");
  const block = SRC.slice(at, at + 700);
  assert.match(block, /Outcome unknown/i, "an unknown outcome is not labelled unknown");
  assert.match(block, /may exist/i, "the copy does not say an order may exist");
  assert.match(block, /not retry|Do not retry/i, "the copy does not warn against retrying");
});

test("the words 'no trade' and 'failed' never appear near the unknown branch", () => {
  const at = SRC.indexOf("result.indeterminate");
  const block = SRC.slice(at, at + 700);
  assert.ok(!/no trade|failed|did not go through/i.test(block),
    `the unknown branch claims absence: ${block.slice(0, 200)}`);
});

test("an UNRESOLVED ticket carries the same warning in the list itself", () => {
  const at = SRC.indexOf('t.state === "UNRESOLVED"');
  assert.ok(at > 0, "an UNRESOLVED ticket is rendered with no special treatment");
  const block = SRC.slice(at, at + 500);
  assert.match(block, /may exist/i);
  assert.match(block, /not a failed trade|must not be retried/i);
});

// ── 4. a dry run is never shown as a trade ────────────────────────────────
test("a dry run is labelled a dry run, and says nothing was sent", () => {
  assert.match(SRC, /result\.dryRun/, "the dry-run flag is ignored");
  const at = SRC.indexOf("result.dryRun");
  const block = SRC.slice(at, at + 400);
  assert.match(block, /Dry run/i);
  assert.match(block, /nothing was sent/i, "a dry run does not state that nothing was sent");
});

test("a placed order shows the venue's OWN reference, never a fabricated one", () => {
  assert.match(SRC, /result\.venueContractRef/,
    "the success branch does not show the broker's reference");
  assert.ok(!/venueContractRef\s*\|\|\s*["'`]/.test(SRC),
    "a missing broker reference is defaulted to a placeholder, fabricating evidence");
});

// ── expiry cannot look actionable ─────────────────────────────────────────
test("expired tickets disable their action buttons", () => {
  assert.match(SRC, /const expired = left <= 0/, "expiry is not computed");
  // COUNT, do not merely match. Two buttons must be expiry-guarded (Approve and
  // Send to broker); a single `match` stays green when the guard is removed
  // from one of them, because the other still satisfies it.
  const guarded = SRC.match(/disabled=\{expired\s*\|\|/g) ?? [];
  assert.equal(guarded.length, 2,
    `expected BOTH the approve and dispatch buttons to be expiry-guarded, found ${guarded.length}`);
  assert.match(SRC, /setInterval\(\(\) => setNow\(Date\.now\(\)\), 1000\)/,
    "the countdown does not tick, so a dead button can look live");
  assert.match(SRC, /clearInterval/, "the countdown timer leaks");
});

test("an absent stop or take-profit is STATED, not left blank", () => {
  // Blank reads as "fine". "none" reads as "there is no stop".
  assert.match(SRC, /stopLossUsd === null \? "none"/, "an absent stop renders blank");
  assert.match(SRC, /takeProfitUsd === null \? "none"/, "an absent take-profit renders blank");
});

// ── the page cannot leak a credential ─────────────────────────────────────
test("the UI never references a credential field", () => {
  for (const forbidden of ["credentialHandle", "token", "authorization", "secret", "pepper"]) {
    assert.ok(!new RegExp(`\\b${forbidden}\\b`, "i").test(SRC),
      `the approval inbox references ${forbidden}`);
  }
});

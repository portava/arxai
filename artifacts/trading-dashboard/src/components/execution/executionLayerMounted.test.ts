// Build F — "Live Execution Safety Layer" mount status, pinned both ways.
//
// The barrel exports PreTradeChecklistModal, ConfirmExecutionButton,
// CancelTradeButton, ExecutionWarningPanel and LiveExecutionHistory, and NOT
// ONE of them is imported anywhere. The advertised pre-trade checklist (verdict
// + blockers + warnings, Confirm hard-disabled while BLOCKED) therefore never
// runs for any user, and the LIVE branch of POST /api/execute-trade that it is
// the only client for is unreachable from the UI.
//
// That gap could not be closed by mounting the modal into the live ticket: the
// reachable live path (LiveTradeTicket / LiveSharedTradeTicket → the Phase B
// command pipeline) is single-confirm by owner decision, pinned by
// scripts/src/liveSingleConfirmTest.ts, which fails the build if a validate
// pre-step or ack checkbox is added there. And it must not be closed by
// deleting the server's confirmationId requirement — that requirement is what
// keeps live /execute-trade default-denied.
//
// So the honest move was to state the status in the barrel. This test keeps
// that statement true in BOTH directions:
//   • if an importer appears, the "NOT MOUNTED" note is now a lie → RED;
//   • if the note is removed while the components are still orphaned, the
//     surface goes back to looking delivered → RED.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../..");
const BARREL_DIR = resolve(SRC, "components/execution");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules") continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const ALL = walk(SRC);
const OUTSIDE = ALL.filter((f) => !f.startsWith(BARREL_DIR + "/"));

// Any import that resolves into components/execution from outside the folder.
const IMPORT_RE = /from\s+["'](?:@\/components\/execution|[./]+\/components\/execution)(?:\/[^"']*)?["']/;

function importers(): string[] {
  return OUTSIDE.filter((f) => IMPORT_RE.test(readFileSync(f, "utf8")));
}

const barrel = readFileSync(join(BARREL_DIR, "index.ts"), "utf8");
const DECLARES_UNMOUNTED = /STATUS: NOT MOUNTED/.test(barrel);

describe("Build F execution safety layer — mount status is stated truthfully", () => {
  it("the walker found real files (an empty scan must not read as a pass)", () => {
    expect(ALL.length).toBeGreaterThan(200);
    expect(OUTSIDE.length).toBeGreaterThan(200);
  });

  it("the barrel's status note matches whether anything imports it", () => {
    const found = importers().map((f) => f.slice(SRC.length + 1));
    if (found.length === 0) {
      expect(
        DECLARES_UNMOUNTED,
        "components/execution has no importers, so index.ts must keep its 'STATUS: NOT MOUNTED' note",
      ).toBe(true);
    } else {
      expect(
        DECLARES_UNMOUNTED,
        `components/execution is now imported by ${found.join(", ")} — remove the 'STATUS: NOT MOUNTED' note and describe where it is mounted`,
      ).toBe(false);
    }
  });

  it("the note names the server requirement it must not be 'cleaned up' against", () => {
    if (!DECLARES_UNMOUNTED) return;
    expect(barrel).toMatch(/confirmationId/);
    expect(barrel).toMatch(/execute-trade/);
    expect(barrel).toMatch(/liveSingleConfirmTest/);
  });

  it("the exported components still exist (the note must not outlive them)", () => {
    for (const f of [
      "PreTradeChecklistModal.tsx",
      "ConfirmExecutionButton.tsx",
      "CancelTradeButton.tsx",
      "ExecutionWarningPanel.tsx",
      "LiveExecutionHistory.tsx",
    ]) {
      expect(() => statSync(join(BARREL_DIR, f))).not.toThrow();
    }
  });
});

describe("the trade-plan surface no longer points at the unmounted flow", () => {
  const convert = readFileSync(resolve(SRC, "components/tradePlan/ConvertToLiveExecutionButton.tsx"), "utf8");
  const panel = readFileSync(resolve(SRC, "components/tradePlan/TradePlanBuilderPanel.tsx"), "utf8");
  const page = readFileSync(resolve(SRC, "pages/trade-plan-builder.tsx"), "utf8");

  it("does not send the user to a Pre-Trade Confirmation flow that has no screen", () => {
    for (const [name, src] of [["ConvertToLiveExecutionButton", convert], ["TradePlanBuilderPanel", panel]] as const) {
      expect(src, `${name} still points at the unmounted flow`).not.toMatch(
        /Open the Pre-Trade Confirmation flow/,
      );
    }
  });

  it("says plainly that nothing was placed", () => {
    expect(convert).toMatch(/no order has been placed/);
    expect(panel).toMatch(/no order has been placed/);
    expect(page).toMatch(/never places an order/);
  });
});

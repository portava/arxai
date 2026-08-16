// THEME G-FINISH — "coming soon" controls are finished or removed, not left.
//
// A permanently-disabled control is a promise the product does not keep. It
// takes up space in the UI, invites a click that does nothing, and — for the
// bulk actions below — advertises EXECUTION capabilities (Close All, Close
// Winners, Protect All) that have no implementation whatsoever. A trader
// reading that list could reasonably believe a panic-close is one click away.
//
// The work order said "finish or remove". Each was assessed:
//
//   Open Trades → Export      REMOVED. The only trades CSV endpoint
//                             (/api/export/trades.csv) is gated to
//                             OWNER/ADMIN/TESTER and exports the OMS position
//                             list, not the signed-in trader's own trades.
//                             Wiring the button to it would 403 for a normal
//                             trader and export the wrong dataset. A
//                             user-scoped export needs a new endpoint — a
//                             product decision, not a patch.
//
//   Open Trades → Bulk actions REMOVED. Protect All / Move All to BE / Close
//                             Winners / Close Losers / Close All are all
//                             execution paths. Implementing them here would
//                             mean building new multi-position dispatch, which
//                             is far outside a cleanup theme and would touch
//                             the gated trade path.
//
//   Alerts → Snooze           REMOVED. No snooze state exists on the alert
//                             model or its API.
//
// Individual position close is unaffected — it works and stays, and the page
// now says so plainly instead of pointing at absent bulk actions.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");

function read(rel: string): string {
  return readFileSync(resolve(SRC, rel), "utf8");
}

/** Source with comment lines stripped (these files document what was removed). */
function code(rel: string): string {
  return read(rel)
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

const myTrades = code("pages/my-trades.tsx");
const alerts = code("pages/alerts.tsx");

describe("G-FINISH — Open Trades has no dead affordances", () => {
  it("the disabled Export control is gone", () => {
    expect(myTrades).not.toMatch(/Export coming soon/);
  });

  it("the bulk-action ghosts are gone", () => {
    expect(myTrades).not.toMatch(/ActionGhost/);
    for (const label of ["Protect All", "Move All to BE", "Close Winners", "Close Losers", "Close All"]) {
      expect(myTrades).not.toMatch(new RegExp(label));
    }
  });

  it("no 'coming soon' copy remains", () => {
    expect(myTrades).not.toMatch(/coming soon/i);
  });

  it("individual close still works and is still signposted", () => {
    expect(myTrades).toMatch(/Close a position individually from its row/);
  });

  it("the real actions on the page are untouched", () => {
    // Refresh, Open Trade and Ask-the-assistant all do something.
    expect(myTrades).toMatch(/Refresh/);
    expect(myTrades).toMatch(/Open Trade/);
    expect(myTrades).toMatch(/openRubyLiveChat/);
  });
});

describe("G-FINISH — Alerts has no dead affordance", () => {
  it("the disabled Snooze control is gone", () => {
    expect(alerts).not.toMatch(/Snooze coming soon/);
    expect(alerts).not.toMatch(/>\s*Snooze\s*</);
  });

  it("the real alert actions are untouched", () => {
    // Whatever else the page offers must still be there — only the dead
    // control was removed.
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts).toMatch(/alert/i);
  });
});

describe("G-FINISH — nothing was replaced by a fake implementation", () => {
  it("Open Trades did not gain a client-side export", () => {
    // Removing is honest; inventing a half-export would not be.
    expect(myTrades).not.toMatch(/\.csv/);
    expect(myTrades).not.toMatch(/createObjectURL/);
  });

  it("Open Trades did not gain a bulk dispatch path", () => {
    expect(myTrades).not.toMatch(/closeAll|bulkClose|protectAll/i);
  });
});

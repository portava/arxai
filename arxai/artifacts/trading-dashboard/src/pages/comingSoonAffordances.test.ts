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
//   Open Trades → Export      FINISHED (prodready/20260819). Implemented as a
//                             real client-side CSV of the currently filtered
//                             rows — columns mirror the visible table and no
//                             backend is involved, because the only trades CSV
//                             endpoint (/api/export/trades.csv) is gated to
//                             OWNER/ADMIN/TESTER and exports the OMS position
//                             list, not the signed-in trader's own trades.
//
//   Open Trades → Bulk actions REMOVED. Protect All / Move All to BE / Close
//                             Winners / Close Losers / Close All are all
//                             execution paths. Implementing them here would
//                             mean building new multi-position dispatch, which
//                             is far outside a cleanup theme and would touch
//                             the gated trade path.
//
//   Alerts → Snooze           REMOVED. The only snooze endpoint
//                             (POST /api/notifications/:id/snooze) targets the
//                             legacy Notification Center `notifications` table
//                             (string notificationId), not the
//                             `user_notifications` rows (numeric id) the
//                             Alerts page lists — wiring it would 404 on
//                             every row.
//
//   Economic Calendar →       REMOVED (prodready/20260819). The reminder
//   Event reminders           offset/channel chips were permanent placebos; no
//                             server endpoint creates or schedules per-user
//                             calendar reminders. The card now states that
//                             plainly and links to the real alerts inbox.
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
const econCalendar = code("pages/economic-calendar.tsx");

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

describe("G-FINISH — Open Trades export is real, not a placebo", () => {
  it("exports a client-side CSV of the filtered rows", () => {
    // The export must be a genuine download built from the rows on screen —
    // a Blob object URL fed by the `visible` (filtered) list.
    expect(myTrades).toMatch(/\.csv/);
    expect(myTrades).toMatch(/createObjectURL/);
    expect(myTrades).toMatch(/visible\.map/);
  });

  it("export never fetches from the admin-gated OMS export endpoint", () => {
    // /api/export/trades.csv is OWNER/ADMIN/TESTER-gated and is the wrong
    // dataset for a signed-in trader; the client export must not call it.
    expect(myTrades).not.toMatch(/api\/export\/trades/);
  });

  it("Open Trades did not gain a bulk dispatch path", () => {
    expect(myTrades).not.toMatch(/closeAll|bulkClose|protectAll/i);
  });
});

describe("G-FINISH — Economic Calendar has no fake reminder toggles", () => {
  it("the placebo offset chips are gone", () => {
    for (const chip of ["60m Before", "30m Before", "15m Before", "At Release", "15m After"]) {
      expect(econCalendar).not.toMatch(new RegExp(chip));
    }
  });

  it("no 'coming soon' copy remains", () => {
    expect(econCalendar).not.toMatch(/coming soon/i);
  });

  it("the real Manage Alerts link stays", () => {
    expect(econCalendar).toMatch(/Manage Alerts/);
  });
});

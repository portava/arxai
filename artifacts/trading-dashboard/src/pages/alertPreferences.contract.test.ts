// RANK 14 — the alert-preferences page was wired to a route that had been
// 410 Gone for a whole phase.
//
// THE DEFECT
//   Every hook on the page pinned GET/PATCH `/api/alert-preferences`.
//   routes/alerts.ts registers that exact path as `deprecatedGet` — a fixed
//   envelope carrying NO preference fields — and `deprecatedMutation` → 410
//   Gone. No other router handles it. So:
//     * all eight category switches rendered OFF regardless of the user's real
//       setting, because `Boolean(prefs[key])` on an absent key is false; and
//     * flipping any switch, the severity select, or a quiet-hours field threw
//       410 with NO error UI — the control snapped back and nothing saved.
//   A user who silenced a category believed they had, and had not.
//
//   routes/alerts.ts line 11 justified the deprecation with "Frontend audit
//   (rg) confirmed zero consumers of … /api/alert-preferences". That audit was
//   wrong: this page was the consumer, and still is.
//
// THE GUARD
//   Pins the page to the canonical per-user store and pins that store's
//   contract, both ways — so re-deprecating the endpoint without moving the
//   page, or moving the page back, fails the build instead of silently
//   blanking every switch again.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { isNormalUserAllowedPath, isPendingTraderAllowedPath } from "@/lib/routeAccess";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

/**
 * Source with comments stripped. The fix documents the exact endpoint it moved
 * off (that is how the next reader learns what was wrong), so "this must no
 * longer appear" assertions have to look at CODE, not at the comment quoting
 * the old code.
 */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const page = read("artifacts/trading-dashboard/src/pages/alert-preferences.tsx");
const legacy = read("artifacts/api-server/src/routes/alerts.ts");
const canonical = read("artifacts/api-server/src/routes/meNotifications.ts");
const drawer = read("artifacts/trading-dashboard/src/components/alerts/AlertsDrawer.tsx");

describe("the legacy endpoint really is dead (non-vacuous)", () => {
  it("GET /alert-preferences is a deprecated empty envelope", () => {
    expect(legacy).toMatch(/router\.get\("\/alert-preferences", requireUser, deprecatedGet/);
  });

  it("PATCH /alert-preferences is 410 Gone", () => {
    expect(legacy).toMatch(/router\.patch\("\/alert-preferences", requireUser, deprecatedMutation/);
    expect(legacy).toMatch(/res\.status\(410\)/);
  });
});

describe("the page reads and writes the canonical per-user store", () => {
  it("no longer touches /api/alert-preferences", () => {
    expect(code(page)).not.toMatch(/["'`]\/api\/alert-preferences/);
    expect(code(page)).not.toMatch(/useGetAlertPreferences|useUpdateAlertPreferences/);
  });

  it("uses /api/me/notification-preferences for both read and write", () => {
    expect(page).toMatch(/fetch\("\/api\/me\/notification-preferences", \{ credentials: "include" \}\)/);
    expect(page).toMatch(/method: "PATCH"/);
  });

  it("the canonical routes are requireUser and per-user scoped", () => {
    expect(canonical).toMatch(/router\.get\("\/me\/notification-preferences", requireUser/);
    expect(canonical).toMatch(/router\.patch\("\/me\/notification-preferences", requireUser/);
    expect(canonical).toMatch(/const userId = req\.authUser!\.id;/);
    expect(canonical).toMatch(/eq\(userNotificationPreferencesTable\.userId, userId\)/);
  });

  it("every switch key the page renders is a column the server accepts", () => {
    const boolKeys = new Set(
      (/const PREF_BOOL_KEYS = \[([\s\S]*?)\] as const;/.exec(canonical)?.[1] ?? "")
        .match(/"([a-zA-Z]+)"/g)?.map((s) => s.replaceAll('"', "")) ?? [],
    );
    expect(boolKeys.size).toBeGreaterThan(5);
    const rendered = [...page.matchAll(/^\s*\["[^"]+", "([a-zA-Z]+)",/gm)].map((m) => m[1]);
    expect(rendered.length).toBeGreaterThan(5);
    const unknown = rendered.filter((k) => !boolKeys.has(k));
    expect(
      unknown,
      `the page renders switches the PATCH would silently drop: ${unknown.join(", ")}`,
    ).toEqual([]);
  });

  it("minimumPushSeverity is accepted by the server, so the select is not inert", () => {
    expect(page).toMatch(/minimumPushSeverity: e\.target\.value/);
    expect(canonical).toMatch(/patch\["minimumPushSeverity"\]/);
  });
});

describe("a failed save is never silent", () => {
  it("the mutation reports an error to the user", () => {
    expect(page).toMatch(/onError:/);
    expect(page).toMatch(/Preference not saved/);
    expect(page).toMatch(/variant: "destructive"/);
  });

  it("a field the server dropped is treated as a failure, not a save", () => {
    expect(page).toMatch(/updatedFields/);
    expect(page).toMatch(/The server did not store/);
  });

  it("an unreadable preference set is UNKNOWN, not 'everything is off'", () => {
    // The original defect rendered every switch OFF over an empty envelope.
    expect(page).toMatch(/alert-preferences-unavailable/);
    expect(page.replace(/\s+/g, " ")).toMatch(/not claiming your alerts are off/i);
    expect(page).toMatch(/typeof json\.inAppEnabled !== "boolean"\) return null/);
  });
});

describe("the page is reachable by everyone who is offered a link to it", () => {
  it("the alerts drawer links here", () => {
    expect(drawer).toMatch(/href="\/alert-preferences"/);
  });

  it("/alert-preferences is on BOTH trader allowlists", () => {
    // The drawer opens for every human trader, so a pending trader must not be
    // redirected home by RouteAccessGuard when they press "Preferences".
    expect(isPendingTraderAllowedPath("/alert-preferences")).toBe(true);
    expect(isNormalUserAllowedPath("/alert-preferences")).toBe(true);
  });
});

// RANKS 33 + 53 — every alert surface a user can see was reading a dead route.
//
// THE DEFECT
//   1. The global bell (NotificationBell, rendered in the Topbar on every page)
//      polled GET /api/alerts/unread-count. routes/alerts.ts has served that as
//      a deprecated FIXED-EMPTY envelope since Phase 22C — `unreadCount: 0,
//      criticalCount: 0`, always. The badge was structurally incapable of
//      appearing, for every user, forever.
//   2. AlertsDrawer read GET /api/alerts and rendered "No alerts. You're all
//      caught up." over the same permanently-empty envelope, and its "Run scan"
//      / "Mark all read" buttons POSTed into a 410 Gone with no error UI.
//   3. CriticalAlertBanner read GET /api/alerts/critical — same empty envelope
//      — so the dashboard's loudest safety affordance could never fire.
//   4. The retired components/AlertBell.tsx (zero importers) additionally read a
//      `count` key that the per-user endpoint has never emitted; it is deleted
//      rather than left as a fixed-but-dead second bell.
//   Meanwhile alert content WAS being written the whole time, via
//   upsertAlertOnce() into user_alerts (liveCommandPipeline, chart AI alerts,
//   poolViewAnomalyDetector, dailyReportScheduler).
//
// WHY THESE ASSERTIONS
//   A pure unit test could not have caught this: each component was internally
//   consistent, and it was the CONTRACT with the server that was wrong. So this
//   suite pins both halves —
//     * behaviour of the client helpers over stubbed responses, including the
//       exact legacy payload shapes that used to be trusted, and
//     * the server source, so renaming a response key or re-pointing a
//       component at the deprecated router fails this build instead of silently
//       blanking the badge again.
//
// HONESTY
//   A failed read is null, never 0 and never []. The whole defect class here is
//   a UI that reported "you have nothing" when the truth was "I could not look".

import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { fetchUnreadCounts, fetchAlerts } from "./meAlerts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../../..");

const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

const meAlertsRoute = read("artifacts/api-server/src/routes/meAlerts.ts");
const legacyAlertsRoute = read("artifacts/api-server/src/routes/alerts.ts");
const bellSrc = read("artifacts/trading-dashboard/src/components/alerts/NotificationBell.tsx");
const drawerSrc = read("artifacts/trading-dashboard/src/components/alerts/AlertsDrawer.tsx");
const bannerSrc = read("artifacts/trading-dashboard/src/components/alerts/CriticalAlertBanner.tsx");

function stubFetch(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    })) as unknown as typeof fetch,
  );
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("fetchUnreadCounts reads the keys the server actually sends", () => {
  it("returns the real unread and critical counts", async () => {
    stubFetch(200, { unreadCount: 4, criticalCount: 2 });
    await expect(fetchUnreadCounts()).resolves.toEqual({ unreadCount: 4, criticalCount: 2 });
  });

  it("a genuine zero stays zero (not confused with unavailable)", async () => {
    stubFetch(200, { unreadCount: 0, criticalCount: 0 });
    await expect(fetchUnreadCounts()).resolves.toEqual({ unreadCount: 0, criticalCount: 0 });
  });

  it("the retired bell's `count` shape yields null, not a false zero", async () => {
    stubFetch(200, { count: 7 });
    await expect(fetchUnreadCounts()).resolves.toBeNull();
  });

  it("a failed read is null (UNKNOWN), never 0", async () => {
    stubFetch(500, {});
    await expect(fetchUnreadCounts()).resolves.toBeNull();
  });

  it("a malformed body is null, never 0", async () => {
    stubFetch(200, { unreadCount: "4" });
    await expect(fetchUnreadCounts()).resolves.toBeNull();
  });
});

describe("fetchAlerts never reports an empty inbox it did not verify", () => {
  it("returns the list and unread count", async () => {
    stubFetch(200, { alerts: [{ id: 1, title: "t", severity: "critical" }], unread: 1 });
    const out = await fetchAlerts();
    expect(out?.alerts).toHaveLength(1);
    expect(out?.unread).toBe(1);
  });

  it("a real empty inbox is an empty array, not null", async () => {
    stubFetch(200, { alerts: [], unread: 0, isEmpty: true });
    await expect(fetchAlerts()).resolves.toEqual({ alerts: [], unread: 0 });
  });

  it("a failed read is null so the drawer can say 'could not load'", async () => {
    stubFetch(503, {});
    await expect(fetchAlerts()).resolves.toBeNull();
  });
});

describe("contract: the per-user endpoints exist, are user-scoped, and keep their keys", () => {
  it("GET /me/alerts/unread-count is requireUser and emits unreadCount + criticalCount", () => {
    expect(meAlertsRoute).toMatch(/router\.get\("\/me\/alerts\/unread-count",\s*requireUser/);
    expect(meAlertsRoute).toMatch(/res\.json\(\{\s*unreadCount:[^}]*criticalCount:/);
  });

  it("GET /me/alerts is requireUser and scoped to req.authUser.id", () => {
    expect(meAlertsRoute).toMatch(/router\.get\("\/me\/alerts",\s*requireUser/);
    expect(meAlertsRoute).toMatch(/const userId = req\.authUser!\.id;/);
    expect(meAlertsRoute).toMatch(/eq\(userAlertsTable\.userId, userId\)/);
  });

  it("the read/read-all mutations the drawer calls are requireUser", () => {
    expect(meAlertsRoute).toMatch(/router\.post\("\/me\/alerts\/:id\/read",\s*requireUser/);
    expect(meAlertsRoute).toMatch(/router\.post\("\/me\/alerts\/read-all",\s*requireUser/);
  });
});

describe("contract: the legacy router is still dead, and nothing reads it", () => {
  it("every legacy alerts GET is the deprecated fixed-empty envelope", () => {
    // Non-vacuous: prove the deprecation is real before asserting nobody uses it.
    const gets = legacyAlertsRoute.match(/router\.get\("[^"]+",\s*requireUser,\s*\w+/g) ?? [];
    expect(gets.length).toBeGreaterThan(2);
    for (const g of gets) expect(g).toMatch(/deprecatedGet$/);
  });

  it("every legacy alerts mutation is 410 Gone", () => {
    const muts = legacyAlertsRoute.match(/router\.(post|patch|delete)\("[^"]+",\s*requireUser,\s*\w+/g) ?? [];
    expect(muts.length).toBeGreaterThan(2);
    for (const m of muts) expect(m).toMatch(/deprecatedMutation$/);
    expect(legacyAlertsRoute).toMatch(/res\.status\(410\)/);
  });

  it("no alert surface imports the generated legacy-alerts hooks any more", () => {
    // Only the IMPORT block matters — the components' comments deliberately
    // name the old hooks to record what was wrong.
    for (const [name, src] of [["NotificationBell", bellSrc], ["AlertsDrawer", drawerSrc], ["CriticalAlertBanner", bannerSrc]] as const) {
      const imports = (src.match(/^import[\s\S]*?;$/gm) ?? []).join("\n");
      expect(imports, `${name} must not read the deprecated /api/alerts router`).not.toMatch(
        /useGetAlerts|useGetAlertUnreadCount|useGetCriticalAlerts|useGenerateSystemAlerts|useMarkAllAlertsRead|useMarkAlertRead/,
      );
      expect(imports, `${name} must read the per-user store`).toMatch(/from "\.\/meAlerts"/);
    }
  });

  it("the retired components/AlertBell.tsx is gone rather than left dead", () => {
    let existed = true;
    try { read("artifacts/trading-dashboard/src/components/AlertBell.tsx"); } catch { existed = false; }
    expect(existed, "AlertBell.tsx had zero importers and read a key the server never sent").toBe(false);
  });
});

describe("the drawer cannot say 'all caught up' over a failed read", () => {
  it("an unreadable inbox renders its own distinct state", () => {
    expect(drawerSrc).toMatch(/alerts-drawer-unreadable/);
    expect(drawerSrc).toMatch(/not a confirmation that your inbox is empty/i);
  });

  it("a failed mutation surfaces an error instead of being swallowed", () => {
    expect(drawerSrc).toMatch(/alerts-drawer-error/);
    expect(drawerSrc).toMatch(/Nothing was changed\./);
  });
});

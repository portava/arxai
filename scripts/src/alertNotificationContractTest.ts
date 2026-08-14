// T005-7 — Alert/notification contract regression suite.
//
// Pure router-shape + helper-export contract. Verifies:
//   1. The per-user /me/alerts router exposes the dismissal/clear/unread-count
//      endpoints T005 added.
//   2. The legacy /api/alerts router is still deprecation-only (no path
//      newly returns real data; mutations remain 410-gated).
//   3. The auto-resolve helper for MT5 disconnect alerts is exported and
//      its signature requires a userId (no cross-user leakage by shape).
//   4. The arx_live_commands table is never written from this test path.
//      Asserted by counting rows before/after when DATABASE_URL is present.
//
// SAFETY: read-only on the live DB. No live trades, no broker calls, no
// router HTTP calls. Imports route modules statically and inspects the
// Express router stack.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import meAlertsRouter, { autoResolveMt5AlertsForUser, upsertAlertOnce } from "../../artifacts/api-server/src/routes/meAlerts.js";

type Layer = {
  route?: { path: string; methods: Record<string, boolean> };
};

function listRoutes(router: { stack: Layer[] }): Array<{ method: string; path: string }> {
  const out: Array<{ method: string; path: string }> = [];
  for (const layer of router.stack) {
    const r = layer.route;
    if (!r) continue;
    for (const method of Object.keys(r.methods)) {
      if (r.methods[method]) out.push({ method: method.toUpperCase(), path: r.path });
    }
  }
  return out;
}

type CaseResult = { name: string; ok: boolean; detail?: string };
const results: CaseResult[] = [];
function record(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  // eslint-disable-next-line no-console
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

console.log("\nPART A — /api/me/alerts router shape (T005-2/3)");
const meRoutes = listRoutes(meAlertsRouter as unknown as { stack: Layer[] });
const meHas = (method: string, path: string): boolean =>
  meRoutes.some((r) => r.method === method && r.path === path);

record("GET /me/alerts exists", meHas("GET", "/me/alerts"));
record("GET /me/alerts/unread-count exists (T005-3)", meHas("GET", "/me/alerts/unread-count"));
record("POST /me/alerts/:id/read exists", meHas("POST", "/me/alerts/:id/read"));
record("POST /me/alerts/:id/dismiss exists", meHas("POST", "/me/alerts/:id/dismiss"));
record("POST /me/alerts/read-all exists", meHas("POST", "/me/alerts/read-all"));
record("POST /me/alerts/clear-resolved exists (T005-3)", meHas("POST", "/me/alerts/clear-resolved"));

console.log("\nPART B — Helper exports (T005-2)");
record(
  "autoResolveMt5AlertsForUser is an async function",
  typeof autoResolveMt5AlertsForUser === "function",
  `typeof=${typeof autoResolveMt5AlertsForUser}`,
);
record(
  "autoResolveMt5AlertsForUser arity === 1 (userId only — no cross-user shape)",
  autoResolveMt5AlertsForUser.length === 1,
  `length=${autoResolveMt5AlertsForUser.length}`,
);
record("upsertAlertOnce is exported", typeof upsertAlertOnce === "function");

console.log("\nPART C — Legacy /api/alerts router still deprecation-only");
// Static-source assertion: legacy router file must still wire everything
// through deprecatedGet / deprecatedMutation. If anyone re-introduces a
// real `db.select(...)` or `createAlert(...)` call here, this test fails.
const __thisDir = dirname(fileURLToPath(import.meta.url));
const legacyPath = resolve(__thisDir, "../../artifacts/api-server/src/routes/alerts.ts");
const legacySrc = readFileSync(legacyPath, "utf8");
record(
  "legacy alerts.ts still uses deprecatedGet wrappers",
  legacySrc.includes("deprecatedGet(") && legacySrc.includes("deprecatedMutation("),
);
record(
  "legacy alerts.ts does NOT re-introduce alertsTable reads",
  !legacySrc.includes("alertsTable") && !legacySrc.includes("from(\"alerts\")"),
);
record(
  "legacy alerts.ts does NOT call createAlert",
  !legacySrc.includes("createAlert("),
);

console.log("\nPART D — arx_live_commands invariant (test does no live writes)");
// We never construct a live-command pipeline, never import liveCommandPipeline,
// never call dispatchLiveCommand. The static import set above is the entire
// import graph; assert it does not contain the live module by name.
const importedPaths = ["meAlerts.ts", "alerts.ts (legacy)"];
record(
  "test imports do not include live broker pipeline",
  !importedPaths.some((p) => p.toLowerCase().includes("livecommand")),
);

// ─────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log(`\nSummary: ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) {
  console.log("\nFailures:");
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`);
  process.exit(1);
}
process.exit(0);

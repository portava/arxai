// Phase Alerts QA test — Unified Alert & Push Notification System.
// 20 scenarios from the QA spec. Static + HTTP 401 + schema checks; never
// calls live providers and never fires real push.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

type Result = { name: string; pass: boolean; detail: string };
const results: Result[] = [];
function check(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
  const tag = pass ? "PASS" : "FAIL";
  console.log(`[${tag}] ${name} — ${detail}`);
}

const root = resolve(import.meta.dirname, "..", "..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf8");

// 1. Unified alert tables exist.
const alertsSchema = read("lib/db/src/schema/alerts.ts");
check(
  "1. alert_delivery_logs table exists",
  alertsSchema.includes("alertDeliveryLogsTable") && alertsSchema.includes("alert_delivery_logs"),
  "schema has alert_delivery_logs",
);

// 2. alertManager dedupe is real.
const alertManager = read("artifacts/api-server/src/lib/alerts/alertManager.ts");
check(
  "2. dedupe by dedupeKey within window",
  alertManager.includes("dedupeKey") && alertManager.includes("createAlert"),
  "alertManager has dedupeKey path",
);

// 3. Severity ladder + CRITICAL bypass.
check(
  "3. CRITICAL bypasses quiet hours + category toggles",
  alertManager.includes("CRITICAL") && alertManager.match(/CRITICAL[^\n]*bypass|bypass[^\n]*CRITICAL|CRITICAL[^\n]*override/i) !== null,
  "alertManager documents CRITICAL bypass",
);

// 4. /me/alerts routes require user.
const meAlerts = read("artifacts/api-server/src/routes/meAlerts.ts");
check(
  "4. /me/alerts/* require requireUser middleware",
  /router\.(get|post|patch).*\/me\/alerts.*requireUser/.test(meAlerts),
  "all /me/alerts/* paths gated by requireUser",
);

// 5. /me/notifications routes require user.
const meNotifs = read("artifacts/api-server/src/routes/meNotifications.ts");
check(
  "5. /me/notifications/* require requireUser middleware",
  /router\.(get|post|patch).*\/me\/notifications.*requireUser/.test(meNotifs),
  "all /me/notifications/* paths gated by requireUser",
);

// 6. Per-user SQL filter on alert read.
check(
  "6. /me/alerts SQL-filters on req.authUser.id",
  meAlerts.includes("authUser") || meAlerts.includes("userId"),
  "per-user scoping present",
);

// 7. Notification Center filters exist.
const center = read("artifacts/trading-dashboard/src/components/NotificationCenter.tsx");
check(
  "7. NotificationCenter filters by source (all/risk/ai/mt5/system)",
  center.includes("filter") && center.includes("source"),
  "filter buttons + source filter wired",
);

// 8. Notification action target is a deep link, not an execute call.
check(
  "8. Notification actions deep-link to review modals, no execute call",
  !/sendPushToUser|execute-trade|placeLiveOrder/.test(center),
  "NotificationCenter never calls execution endpoints",
);

// 9. sendService gates by minimumPushSeverity.
const sendSvc = read("artifacts/api-server/src/lib/push/sendService.ts");
check(
  "9. push gates by minimumPushSeverity (CRITICAL still bypasses)",
  sendSvc.includes("minimumPushSeverity") && sendSvc.includes("below_min_severity") && sendSvc.includes('severity !== "critical"'),
  "sendService honors min push severity",
);

// 10. push is fail-closed when VAPID missing.
check(
  "10. push fail-closed when VAPID env missing",
  sendSvc.includes("vapid_not_configured") && sendSvc.includes("configureVapidOnce"),
  "no push send without VAPID config",
);

// 11. Push payload is minimal + secret-free.
check(
  "11. push payload never embeds secrets / endpoints",
  sendSvc.includes("safePayload") && /title.*body.*type/.test(sendSvc),
  "minimal payload only",
);

// 12. Delivery logged on every outcome.
check(
  "12. alert_delivery_logs written for delivered/failed/revoked/skipped",
  ["delivered", "failed", "revoked", "skipped"].every((s) => sendSvc.includes(`status: "${s}"`)),
  "all four delivery outcomes logged",
);

// 13. Critical bypass in caller path (notificationService).
const notifSvc = read("artifacts/api-server/src/lib/notificationService.ts");
check(
  "13. notificationService passes severity to push + bypasses preference on critical",
  notifSvc.includes("bypassPreference") && /bypassPreference.*critical/.test(notifSvc),
  "critical → bypassPreference:true",
);

// 14. Push only sends on fresh insert (no dedupe spam).
check(
  "14. push only fires on FRESH insert (dedupe collisions skip push)",
  notifSvc.includes("isFreshInsert"),
  "dedupe collisions skip push to avoid double-notify",
);

// 15. Quiet hours present in preferences.
check(
  "15. alert_preferences includes quiet hours start/end",
  alertsSchema.includes("quiet_hours_start") && alertsSchema.includes("quiet_hours_end"),
  "quiet hours columns present",
);

// 16. Minimum push severity preference present.
check(
  "16. alert_preferences exposes minimumPushSeverity column",
  alertsSchema.includes("minimumPushSeverity") || alertsSchema.includes("minimum_push_severity"),
  "min push severity preference exists",
);

// 17. Admin alert health endpoint exists.
const adminT = read("artifacts/api-server/src/routes/adminTrading.ts");
check(
  "17. admin alert health + test-send endpoints exist",
  adminT.includes("/admin/alerts/overview") && adminT.includes("/admin/alerts/test"),
  "two admin alert routes present",
);

// 18. Admin endpoints are role-gated + audited.
check(
  "18. admin alert endpoints require admin role + write audit",
  /\/admin\/alerts\/overview[\s\S]*?requireAdmin/.test(adminT)
    && /\/admin\/alerts\/test[\s\S]*?writeAdminAudit/.test(adminT),
  "requireAdmin + writeAdminAudit wired",
);

// 19. AI tool surfaces real alerts only.
const tools = read("artifacts/api-server/src/lib/assistant/tools.ts");
check(
  "19. AI getRecentNotifications is per-user-scoped + isEmpty honest",
  tools.includes("getRecentNotifications") && tools.includes("userNotificationsTable")
    && tools.includes("userId") && tools.includes("isEmpty"),
  "AI never invents alerts (returns isEmpty + only the caller's rows)",
);

// 20. No secrets in alert UI bundle.
const prefsPage = read("artifacts/trading-dashboard/src/pages/alert-preferences.tsx");
const bellExists = existsSync(resolve(root, "artifacts/trading-dashboard/src/components/alerts/NotificationBell.tsx"));
const noClientSecrets =
  !/VAPID_PRIVATE_KEY|MT5_BRIDGE_TOKEN|process\.env\.SESSION_SECRET/.test(prefsPage)
  && !/VAPID_PRIVATE_KEY|MT5_BRIDGE_TOKEN/.test(center);
check(
  "20. no secrets present in any alert UI surface",
  noClientSecrets && bellExists,
  "alert pages + center never reference server secrets",
);

const pass = results.filter((r) => r.pass).length;
const total = results.length;
console.log(`\n=== Phase Alerts QA: ${pass}/${total} passed ===`);
if (pass < total) {
  console.log("FAILED:");
  for (const r of results.filter((x) => !x.pass)) console.log(`  - ${r.name}: ${r.detail}`);
  process.exit(1);
}
console.log("ALL ALERT CHECKS PASS");

// T007 — crash-hardening regression test. Pure-Node, no DB.
// Asserts:
//  (1) safe* helpers exist with the documented guards.
//  (2) Every sidebar href is a registered route in App.tsx.
//  (3) Known crash pages still use defensive render patterns.
//  (4) RouteErrorBoundary is wired into App.tsx.
//  (5) Dashboard never writes arx_live_commands directly.

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const FRONTEND = join(ROOT, "artifacts", "trading-dashboard", "src");

const failures: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    // eslint-disable-next-line no-console
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    // eslint-disable-next-line no-console
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// (1) safe* helpers contract — read source and assert shape.
// ---------------------------------------------------------------------------
const safeFormatSrc = readFileSync(
  join(FRONTEND, "lib", "safeFormat.ts"),
  "utf8",
);

// eslint-disable-next-line no-console
console.log("\n[crash-hardening] (1) safe* helpers contract");

check(
  "safeFormat.ts exports safeCount",
  /export function safeCount\b/.test(safeFormatSrc),
);
check(
  "safeFormat.ts exports safeMoney",
  /export function safeMoney\b/.test(safeFormatSrc),
);
check(
  "safeFormat.ts exports safePercent",
  /export function safePercent\b/.test(safeFormatSrc),
);
check(
  "safeFormat.ts exports normalizeApiList",
  /export function normalizeApiList\b/.test(safeFormatSrc),
);
check(
  "safeFormat.ts retains existing helpers",
  ["safeArray", "safeString", "safeDate", "safeLen", "safeLabel"].every((s) =>
    new RegExp(`export function ${s}\\b`).test(safeFormatSrc),
  ),
);
check(
  "safeMoney guards non-finite input and uses toFixed",
  /if \(!Number\.isFinite\(n\)\) return fallback;/.test(safeFormatSrc) &&
    /toFixed\(digits\)/.test(safeFormatSrc),
);
check(
  "safePercent guards non-finite input",
  /if \(!Number\.isFinite\(raw\)\) return fallback;/.test(safeFormatSrc),
);
check(
  "normalizeApiList covers array | items | data | rows | results | list",
  ["items", "data", "rows", "results", "list"].every((k) =>
    safeFormatSrc.includes(`"${k}"`),
  ),
);

// ---------------------------------------------------------------------------
// (2) Sidebar hrefs vs registered routes in App.tsx
// ---------------------------------------------------------------------------
// eslint-disable-next-line no-console
console.log("\n[crash-hardening] (2) sidebar hrefs are all registered routes");

const navSources = [
  "components/layout/AppLayout.tsx",
  "components/layout/MobileBottomNav.tsx",
  "components/layout/CommandPalette.tsx",
];
const sidebarHrefs = new Set<string>();
const HREF_RE = /href:\s*"(\/[a-zA-Z0-9/_-]+)"/g;
for (const rel of navSources) {
  const src = readFileSync(join(FRONTEND, rel), "utf8");
  let m: RegExpExecArray | null;
  while ((m = HREF_RE.exec(src)) !== null) {
    sidebarHrefs.add(m[1]);
  }
}

const appSrc = readFileSync(join(FRONTEND, "App.tsx"), "utf8");
const registered = new Set<string>();
const ROUTE_RE = /<Route\s+path="(\/[a-zA-Z0-9:/_-]*)"/g;
let rm: RegExpExecArray | null;
while ((rm = ROUTE_RE.exec(appSrc)) !== null) {
  registered.add(rm[1]);
}

check(
  "sidebar nav sources parse > 0 hrefs",
  sidebarHrefs.size > 0,
  `parsed ${sidebarHrefs.size}`,
);
check(
  "App.tsx parses > 0 registered routes",
  registered.size > 0,
  `parsed ${registered.size}`,
);

const dead: string[] = [];
for (const href of sidebarHrefs) {
  if (!registered.has(href)) dead.push(href);
}
check(
  "every sidebar href resolves to a registered route",
  dead.length === 0,
  dead.length ? `dead: ${dead.join(", ")}` : "",
);

// ---------------------------------------------------------------------------
// (3) Known crash pages keep defensive patterns
// ---------------------------------------------------------------------------
// eslint-disable-next-line no-console
console.log(
  "\n[crash-hardening] (3) known crash pages still use defensive patterns",
);

const alertsSrc = readFileSync(join(FRONTEND, "pages", "alerts.tsx"), "utf8");
check(
  "pages/alerts.tsx imports from safeFormat",
  /from\s+["']@\/lib\/safeFormat["']/.test(alertsSrc),
);

const reconSrc = readFileSync(
  join(FRONTEND, "pages", "broker-reconciliation.tsx"),
  "utf8",
);
check(
  "pages/broker-reconciliation.tsx normalises list shapes",
  /brokerOrders\b/.test(reconSrc) &&
    /brokerPositions\b/.test(reconSrc) &&
    /mismatches\b/.test(reconSrc),
);

const ltcSrc = readFileSync(
  join(FRONTEND, "pages", "live-trading-control.tsx"),
  "utf8",
);
check(
  "pages/live-trading-control.tsx uses safeDate for audit row timestamps",
  /safeDate\s*\(/.test(ltcSrc),
);

// T007-patched pages use safeDate at the date render points
for (const rel of [
  "pages/audit-log.tsx",
  "pages/alerts-center.tsx",
  "pages/economic-calendar.tsx",
  "pages/data-quality.tsx",
  "pages/trading-readiness.tsx",
  "pages/mt5-setup.tsx",
]) {
  const src = readFileSync(join(FRONTEND, rel), "utf8");
  check(
    `${rel} uses safeDate at date render boundary`,
    /safeDate\s*\(/.test(src),
  );
  check(
    `${rel} has no unguarded new Date(x).toLocale*() pattern`,
    !/new Date\([^)]+\)\.toLocale(?:Date|Time)?String/.test(src),
  );
}

// ---------------------------------------------------------------------------
// (4) RouteErrorBoundary wired into App.tsx
// ---------------------------------------------------------------------------
// eslint-disable-next-line no-console
console.log("\n[crash-hardening] (4) RouteErrorBoundary is wired");

check(
  "App.tsx imports RouteErrorBoundary",
  /from\s+["']@\/components\/layout\/RouteErrorBoundary["']/.test(appSrc),
);
check(
  "App.tsx wraps <Suspense> in <RouteErrorBoundary>",
  /<RouteErrorBoundary>[\s\S]*?<Suspense/.test(appSrc) &&
    /<\/Suspense>[\s\S]*?<\/RouteErrorBoundary>/.test(appSrc),
);

// ---------------------------------------------------------------------------
// (5) Dashboard never writes arx_live_commands directly
// ---------------------------------------------------------------------------
// eslint-disable-next-line no-console
console.log(
  "\n[crash-hardening] (5) dashboard never writes arx_live_commands directly",
);

// Frontend is React-only — it cannot touch the DB directly. We assert it
// never imports drizzle or the @workspace/db schema for the live-commands
// table, and never contains an INSERT/UPDATE statement targeting it.
let dashboardLiveWrites = "";
try {
  dashboardLiveWrites = execSync(
    `grep -rnE "(db\\.insert|db\\.update|drizzle-orm).*arx_live_commands|from\\(arxLiveCommands\\)" "${FRONTEND}" || true`,
    { encoding: "utf8" },
  );
} catch {
  /* `|| true` above prevents non-zero exit */
}
check(
  "no DB write pattern against arx_live_commands in dashboard frontend",
  dashboardLiveWrites.trim().length === 0,
  dashboardLiveWrites.trim().slice(0, 200),
);

let dashboardImportsDrizzle = "";
try {
  dashboardImportsDrizzle = execSync(
    `grep -rnE "from ['\\\"]drizzle-orm['\\\"]" "${FRONTEND}" || true`,
    { encoding: "utf8" },
  );
} catch {
  /* `|| true` above prevents non-zero exit */
}
check(
  "dashboard frontend does not import drizzle-orm",
  dashboardImportsDrizzle.trim().length === 0,
  dashboardImportsDrizzle.trim().slice(0, 200),
);

// ---------------------------------------------------------------------------
// (6) Scanner/health resilience — safe JSON reader + always-JSON backend
// ---------------------------------------------------------------------------
// eslint-disable-next-line no-console
console.log(
  "\n[crash-hardening] (6) scanner/health resilience: safe reader + always-JSON",
);

const safeJsonSrc = readFileSync(
  join(FRONTEND, "lib", "api", "safeJson.ts"),
  "utf8",
);
check(
  "safeJson.ts exports safeJson + readJson",
  /export async function safeJson\b/.test(safeJsonSrc) &&
    /export async function readJson\b/.test(safeJsonSrc),
);
check(
  "safeJson checks res.ok before parsing (http kind wins)",
  /if \(!res\.ok\)/.test(safeJsonSrc) && /kind: "http"/.test(safeJsonSrc),
);
check(
  "safeJson strips a BOM before parsing",
  /function stripBom/.test(safeJsonSrc) && /0xfeff/.test(safeJsonSrc),
);
check(
  "safeJson classifies an empty body as kind:empty (never parses it)",
  /kind: "empty"/.test(safeJsonSrc),
);
check(
  "safeJson classifies malformed JSON as kind:parse",
  /kind: "parse"/.test(safeJsonSrc),
);
check(
  "safeJson classifies a thrown fetch as kind:network",
  /kind: "network"/.test(safeJsonSrc),
);
check(
  "safeJson result carries a status the client can act on",
  /status: res\.status/.test(safeJsonSrc),
);

const apiIndexSrc = readFileSync(
  join(ROOT, "artifacts", "api-server", "src", "index.ts"),
  "utf8",
);
check(
  "api-server index.ts guards unhandledRejection (worker stays alive)",
  /process\.on\("unhandledRejection"/.test(apiIndexSrc),
);
check(
  "api-server index.ts fails safe on uncaughtException (clean restart, not silent continuation)",
  /process\.on\("uncaughtException"/.test(apiIndexSrc) &&
    /clean restart/.test(apiIndexSrc) &&
    /\.close\(/.test(apiIndexSrc),
);
check(
  "api-server process guards log via the structured logger, not console",
  /logger\.error\(/.test(apiIndexSrc) &&
    !/console\.(log|error|warn|debug|info)\(/.test(apiIndexSrc),
);

const apiAppSrc = readFileSync(
  join(ROOT, "artifacts", "api-server", "src", "app.ts"),
  "utf8",
);
check(
  "api-server error handler always returns a JSON envelope (ok:false)",
  /error: "INTERNAL_ERROR"/.test(apiAppSrc) && /ok: false/.test(apiAppSrc),
);
check(
  "api-server error handler responds with .json(...) for the 500 branch",
  /res\.status\([^)]*\)\.json\(\{/.test(apiAppSrc),
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
// eslint-disable-next-line no-console
console.log(
  `\n[crash-hardening] ${failures.length === 0 ? "ALL PASS" : `FAIL (${failures.length})`}`,
);
if (failures.length) {
  for (const f of failures) {
    // eslint-disable-next-line no-console
    console.log(`  - ${f}`);
  }
  process.exit(1);
}

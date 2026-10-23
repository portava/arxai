// healthWorkflows.ts — ARX runtime/workflow health check.
//
//   pnpm run health:workflows
//
// Lightweight, run-ONCE watchdog. Confirms the expected ARX services are
// actually listening and serving — not merely that a workflow *claims* to be
// "running". This is the guard against the failure mode where dead/orphaned
// api-server + frontend workflows silently served a broken/frozen app (every
// page hung ~7s on the first blocking /api call).
//
// SAFETY:
//   - Read-only. GET-only probes through the shared proxy (localhost:80), the
//     same path real users take. No auth, no secrets, no mutations.
//   - The Scanner candles probe is intentionally UNAUTHENTICATED: it asserts
//     the deny-by-default auth gate is intact (expects HTTP 401). It never
//     places or reads a trade and never touches the live MT5 path.
//   - No loop, no auto-restart. Exits non-zero if a required service is down
//     so it can be wired into CI / a manual preflight without hiding failures.
//
// Process-level orphan/duplicate detection (ss/lsof) is best-effort: in some
// sandboxes socket introspection is restricted. When unavailable we say so and
// fall back to the authoritative proxy probe (a dead workflow cannot answer
// 200 through the proxy).

import { performance } from "node:perf_hooks";
import net from "node:net";
import { execSync } from "node:child_process";

const PROXY = process.env.ARX_HEALTH_BASE_URL ?? "http://localhost:80";
const HTTP_TIMEOUT_MS = Number(process.env.ARX_HEALTH_TIMEOUT_MS ?? 6000);

interface ServiceSpec {
  name: string;
  /** localPort from the artifact's .replit-artifact/artifact.toml. */
  port: number;
  /** Path on the shared proxy that proves the service serves. */
  proxyPath: string;
  /** Acceptable HTTP statuses that prove "healthy & serving". */
  expect: number[];
  required: boolean;
  note?: string;
}

// Ports mirror each artifact's .replit-artifact/artifact.toml `localPort`.
const SERVICES: ServiceSpec[] = [
  { name: "api-server", port: 8080, proxyPath: "/api/healthz", expect: [200], required: true },
  { name: "frontend (app preview)", port: 24210, proxyPath: "/", expect: [200], required: true },
  { name: "mockup-sandbox", port: 8081, proxyPath: "/__mockup", expect: [200, 301, 302, 304, 404], required: false, note: "design-only; not required for the trading app" },
];

interface HttpResult {
  status: number;
  ms: number;
  bodyHead: string;
  contentType: string | null;
  error: string | null;
}

async function httpGet(path: string): Promise<HttpResult> {
  const t0 = performance.now();
  try {
    const r = await fetch(`${PROXY}${path}`, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const text = await r.text().catch(() => "");
    return {
      status: r.status,
      ms: performance.now() - t0,
      bodyHead: text.slice(0, 2000),
      contentType: r.headers.get("content-type"),
      error: null,
    };
  } catch (e) {
    return {
      status: 0,
      ms: performance.now() - t0,
      bodyHead: "",
      contentType: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function tcpListening(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, "127.0.0.1");
  });
}

interface ListenerInfo {
  pids: number[];
  method: "ss" | "lsof" | "unavailable";
}

/** Best-effort: count processes listening on a port. Never throws. */
function listenersOnPort(port: number): ListenerInfo {
  try {
    const out = execSync(`ss -ltnp 2>/dev/null || true`, { encoding: "utf8" });
    if (out.trim()) {
      const pids = new Set<number>();
      for (const line of out.split("\n")) {
        if (!new RegExp(`[:.]${port}\\b`).test(line)) continue;
        for (const m of line.matchAll(/pid=(\d+)/g)) pids.add(Number(m[1]));
      }
      // Even without pid= detail, presence of a matching LISTEN line is signal.
      if (pids.size > 0) return { pids: [...pids], method: "ss" };
    }
  } catch { /* fall through */ }
  try {
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN 2>/dev/null || true`, { encoding: "utf8" });
    if (out.trim()) {
      const pids = new Set<number>();
      for (const line of out.split("\n").slice(1)) {
        const cols = line.trim().split(/\s+/);
        if (cols.length > 1 && /^\d+$/.test(cols[1]!)) pids.add(Number(cols[1]));
      }
      if (pids.size > 0) return { pids: [...pids], method: "lsof" };
    }
  } catch { /* fall through */ }
  return { pids: [], method: "unavailable" };
}

function extractBuildHash(html: string): string {
  const asset = html.match(/\/assets\/[A-Za-z0-9_.\-]+\.js/);
  if (asset) return asset[0];
  if (html.includes("/@vite/client") || html.includes("/@react-refresh")) {
    return "dev (vite — unhashed module graph)";
  }
  return "unknown";
}

type Status = "PASS" | "WARN" | "FAIL";

interface Finding {
  service: string;
  status: Status;
  detail: string;
}

async function main(): Promise<void> {
  console.log(`ARX workflow health — probing via ${PROXY}`);
  console.log(`(read-only; GET-only; no auth; no trade path touched)\n`);

  const findings: Finding[] = [];
  let hardFail = false;

  // ── Per-service liveness through the shared proxy (authoritative) ──────────
  for (const svc of SERVICES) {
    const http = await httpGet(svc.proxyPath);
    const listening = await tcpListening(svc.port);
    const listeners = listenersOnPort(svc.port);

    const served = http.error == null && svc.expect.includes(http.status);
    let status: Status = served ? "PASS" : svc.required ? "FAIL" : "WARN";

    // Orphan / duplicate process detection (best-effort enrichment).
    let procNote = "";
    if (listeners.method === "unavailable") {
      procNote = "  procs: introspection unavailable in this sandbox";
    } else {
      procNote = `  procs: ${listeners.pids.length} pid(s) on :${svc.port} [${listeners.pids.join(",")}] via ${listeners.method}`;
      if (listeners.pids.length > 1) {
        status = status === "FAIL" ? "FAIL" : "WARN";
        procNote += "  ⚠ DUPLICATE/ORPHAN listeners on the same port";
      }
    }

    if (status === "FAIL") hardFail = true;

    const reason = http.error
      ? `proxy probe error: ${http.error} (workflow likely dead / not listening)`
      : `HTTP ${http.status} in ${http.ms.toFixed(0)}ms (expected ${svc.expect.join("/")})`;
    const tcpNote = listening ? "tcp:open" : "tcp:closed/blocked";

    findings.push({
      service: svc.name,
      status,
      detail: `${reason}  ${tcpNote}${procNote}${svc.note ? `  — ${svc.note}` : ""}`,
    });
  }

  // ── api-server health payload sanity ──────────────────────────────────────
  {
    const h = await httpGet("/api/healthz");
    let detail: string;
    let status: Status = "PASS";
    try {
      const body = JSON.parse(h.bodyHead) as { ok?: boolean; version?: string; uptimeSeconds?: number; app?: string };
      if (h.status === 200 && body.ok === true) {
        detail = `app="${body.app ?? "?"}" version=${body.version ?? "?"} uptime=${body.uptimeSeconds ?? "?"}s`;
      } else {
        status = "FAIL"; hardFail = true;
        detail = `unexpected healthz payload (status ${h.status})`;
      }
    } catch {
      status = "FAIL"; hardFail = true;
      detail = `healthz did not return JSON (status ${h.status})`;
    }
    findings.push({ service: "api-server /healthz payload", status, detail });
  }

  // ── frontend serves real HTML + build hash ────────────────────────────────
  {
    const f = await httpGet("/");
    const isHtml = (f.contentType?.includes("text/html") ?? false) || /<!doctype html|<html/i.test(f.bodyHead);
    const status: Status = f.status === 200 && isHtml ? "PASS" : "FAIL";
    if (status === "FAIL") hardFail = true;
    findings.push({
      service: "frontend served asset/build hash",
      status,
      detail: status === "PASS"
        ? `served build: ${extractBuildHash(f.bodyHead)}`
        : `frontend did not serve HTML (status ${f.status}${f.error ? `, ${f.error}` : ""})`,
    });
  }

  // ── Scanner candles auth behavior (deny-by-default gate intact) ───────────
  {
    const c = await httpGet("/api/data/candles?symbol=EURUSD&timeframe=H1&limit=5");
    let status: Status;
    let detail: string;
    if (c.error) {
      status = "FAIL"; hardFail = true;
      detail = `candles endpoint unreachable: ${c.error}`;
    } else if (c.status === 401) {
      status = "PASS";
      detail = `unauth → 401 (deny-by-default auth gate intact; ${c.ms.toFixed(0)}ms)`;
    } else if (c.status === 200) {
      status = "FAIL"; hardFail = true;
      detail = `unauth → 200 — AUTH REGRESSION: candles answered WITHOUT auth (expected 401)`;
    } else {
      status = "FAIL"; hardFail = true;
      detail = `unauth → ${c.status} (expected 401)`;
    }
    findings.push({ service: "scanner candles auth behavior", status, detail });
  }

  // ── Render ────────────────────────────────────────────────────────────────
  const icon = (s: Status) => (s === "PASS" ? "✓" : s === "WARN" ? "•" : "✗");
  for (const f of findings) {
    console.log(`  [${icon(f.status)} ${f.status.padEnd(4)}] ${f.service.padEnd(38)} ${f.detail}`);
  }
  const passes = findings.filter((f) => f.status === "PASS").length;
  const warns = findings.filter((f) => f.status === "WARN").length;
  const fails = findings.filter((f) => f.status === "FAIL").length;
  console.log(`\nSUMMARY: ${passes} pass, ${warns} warn, ${fails} fail`);
  if (hardFail) {
    console.log("\nA REQUIRED service is unhealthy. Likely a dead/orphaned workflow.");
    console.log("Restart the affected workflow(s), then re-run `pnpm run health:workflows`.");
    console.log("Do NOT casually restart the live MT5 path during frontend/api repair, and");
    console.log("never place a live trade as part of a health check. See docs/WORKFLOW_HEALTH.md.");
  }
  process.exit(hardFail ? 1 : 0);
}

void main().catch((e) => {
  console.error("health:workflows crashed:", e);
  process.exit(2);
});

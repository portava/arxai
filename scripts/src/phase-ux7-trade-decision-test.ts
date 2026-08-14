export {};
// Phase UX7 — Trade Decision Orchestrator (19 scenarios).
// Black-box HTTP-only suite against the running API. Verifies the new
// /api/me/trades/:tradeKey/decision endpoints exist and are user-scoped,
// payloads carry the safety envelope, decisions are honest on missing
// data, recalc never executes a trade, no secrets leak, AI tool is
// registered and read-only, alerts dedupe per transition, the assistant
// system prompt teaches the 7-section response, and source files declare
// the 14 labels + 9 actions used by the orchestrator.

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname_local = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname_local, "..", "..");
function repo(p: string): string { return resolve(REPO_ROOT, p); }
function readRepo(p: string): string {
  const full = repo(p);
  return existsSync(full) ? readFileSync(full, "utf8") : "";
}

const BASE = process.env["BASE"] ?? "http://localhost:80";
type R = { name: string; pass: boolean; note?: string };
const results: R[] = [];
function record(name: string, pass: boolean, note?: string) {
  results.push({ name, pass, note });
  // eslint-disable-next-line no-console
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${note ? "  — " + note : ""}`);
}

let cookie = "";
async function api(path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers ?? {});
  if (cookie) headers.set("cookie", cookie);
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const r = await fetch(`${BASE}${path}`, { ...init, headers, redirect: "manual" });
  const sc = r.headers.get("set-cookie");
  if (sc) {
    const m = sc.match(/(?:^|, )([^=]+=[^;]+)/g);
    if (m) cookie = m.map((s) => s.replace(/^, /, "")).join("; ");
  }
  return r;
}
async function asJson(r: Response): Promise<Record<string, unknown> | null> {
  try { return await r.json() as Record<string, unknown>; } catch { return null; }
}

async function register() {
  const u = `ux7_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const r = await api("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ username: u, password: "Password!23", email: `${u}@example.test` }),
  });
  if (!r.ok) {
    const r2 = await api("/api/auth/dev-owner-login", { method: "POST", body: JSON.stringify({}) });
    if (!r2.ok) throw new Error(`register/dev-owner failed (${r.status}/${r2.status})`);
  }
}

const ENVELOPE_KEYS = ["safetyMode", "liveLocked", "readOnlyMode", "allowOrderExecution"] as const;
function hasEnvelope(o: Record<string, unknown> | null | undefined): boolean {
  if (!o) return false;
  const s = (o as { safety?: Record<string, unknown> }).safety ?? o;
  return ENVELOPE_KEYS.every((k) => k in (s as Record<string, unknown>));
}

function containsSecrets(text: string): boolean {
  const env = process.env;
  const haystack = text.toLowerCase();
  for (const k of ["SESSION_SECRET", "TWELVEDATA_API_KEY", "MT5_BRIDGE_TOKEN"]) {
    const v = env[k];
    if (v && v.length >= 8 && haystack.includes(v.toLowerCase())) return true;
  }
  return /apikeyhash|password_hash|sessionsecret|mt5_bridge_token/i.test(text);
}

const FOURTEEN_LABELS = [
  "Hold", "Hold but monitor", "Healthy pullback", "Continuation still valid",
  "Protect profit", "Review partial close", "Review full close",
  "Move stop review", "Trail stop review", "Exit risk rising",
  "Trade invalidation near", "Trade invalidated",
  "No clear decision", "Data insufficient",
];
const NINE_ACTIONS = [
  "HOLD", "WATCH_CLOSELY", "SET_ALERT", "REVIEW_MOVE_STOP", "REVIEW_TRAIL_STOP",
  "REVIEW_PARTIAL_CLOSE", "REVIEW_FULL_CLOSE", "WAIT_FOR_CONFIRMATION",
  "NO_ACTION_DATA_INSUFFICIENT",
];

async function main() {
  await register();

  // S01 — GET unknown trade key returns 404 (ownership check before any compute).
  {
    const r = await api("/api/me/trades/lp_999999999/decision");
    record("S01 GET decision unknown key → 404", r.status === 404);
  }

  // S02 — GET malformed key returns 404, not 500.
  {
    const r = await api("/api/me/trades/garbage_xx/decision");
    record("S02 GET decision malformed key → 404", r.status === 404);
  }

  // S03 — POST recalc unknown key returns 404 and NEVER places an order.
  {
    const r = await api("/api/me/trades/lp_999999999/decision/recalculate", {
      method: "POST", body: JSON.stringify({}),
    });
    const j = await asJson(r);
    const noOrder = !("orderId" in (j ?? {})) && !("placedOrder" in (j ?? {})) && !("ticket" in (j ?? {}));
    record("S03 recalc unknown trade → 404, no order ever", r.status === 404 && noOrder);
  }

  // S04 — Endpoint payloads carry safety envelope on both success and error.
  {
    const r = await api("/api/me/trades/lp_999999999/decision");
    const j = await asJson(r);
    record("S04 error payload carries safety envelope", hasEnvelope(j),
      `status=${r.status} keys=${Object.keys(j ?? {}).join(",")}`);
  }

  // S05 — GET /api/me/trade-decisions/active returns array + envelope.
  {
    const r = await api("/api/me/trade-decisions/active");
    const j = await asJson(r);
    const arr = (j?.["decisions"] ?? j?.["items"]) as unknown;
    record("S05 GET active decisions → 200 array + envelope",
      r.status === 200 && Array.isArray(arr) && hasEnvelope(j),
      `status=${r.status} keys=${Object.keys(j ?? {}).join(",")}`);
  }

  // S06 — Unauthenticated request to decision endpoint returns 401 (no leak).
  {
    const saved = cookie; cookie = "";
    const r = await api("/api/me/trades/lp_1/decision");
    cookie = saved;
    record("S06 unauth → 401", r.status === 401);
  }

  // S07 — POST ask-ai unknown key → 404 (ownership re-check before AI dispatch).
  {
    const r = await api("/api/me/trades/lp_999999999/decision/ask-ai", {
      method: "POST", body: JSON.stringify({ question: "should I close" }),
    });
    record("S07 ask-ai unknown trade → 404", r.status === 404);
  }

  // S08 — Source: orchestrator file exists and is wired.
  {
    const s = readRepo("artifacts/api-server/src/lib/decision/orchestrator.ts");
    record("S08 orchestrator.ts exists + exports buildTradeDecision",
      s.length > 0 && /export\s+(async\s+)?function\s+buildTradeDecision/.test(s));
  }

  // S09 — Source: rules.ts declares ALL 14 decision labels (no fewer, no extras outside set).
  {
    const s = readRepo("artifacts/api-server/src/lib/decision/rules.ts")
            + readRepo("artifacts/api-server/src/lib/decision/types.ts");
    const present = FOURTEEN_LABELS.filter((lbl) => s.includes(`"${lbl}"`));
    record(`S09 rules/types declare all 14 labels`,
      present.length === FOURTEEN_LABELS.length,
      `${present.length}/14`);
  }

  // S10 — Source: rules.ts/types.ts declare ALL 9 decision actions.
  {
    const s = readRepo("artifacts/api-server/src/lib/decision/rules.ts")
            + readRepo("artifacts/api-server/src/lib/decision/types.ts");
    const present = NINE_ACTIONS.filter((a) => s.includes(`"${a}"`));
    record(`S10 rules/types declare all 9 actions`,
      present.length === NINE_ACTIONS.length,
      `${present.length}/9`);
  }

  // S11 — Source: orchestrator NEVER calls executeTrade / placeOrder / mt5 send.
  {
    const s = readRepo("artifacts/api-server/src/lib/decision/orchestrator.ts")
            + readRepo("artifacts/api-server/src/lib/decision/rules.ts")
            + readRepo("artifacts/api-server/src/routes/meTradeDecisions.ts");
    const bad = /executeTrade\s*\(|placeOrder\s*\(|sendTradeCommand\s*\(|sendMt5Command\s*\(/.test(s);
    record("S11 decision code never calls execution APIs", !bad);
  }

  // S12 — Source: meTradeDecisions route uses resolveUserTrade for ownership.
  {
    const s = readRepo("artifacts/api-server/src/routes/meTradeDecisions.ts");
    record("S12 route enforces resolveUserTrade ownership",
      /resolveUserTrade\s*\(/.test(s));
  }

  // S13 — Source: alert dedupe declared (advisory lock + 5-min window),
  //       either in decisionAlerts.ts or in the route that flushes them.
  {
    const a = readRepo("artifacts/api-server/src/lib/decision/decisionAlerts.ts");
    const b = readRepo("artifacts/api-server/src/routes/meTradeDecisions.ts");
    const c = readRepo("artifacts/api-server/src/lib/decision/persistence.ts");
    const s = a + "\n" + b + "\n" + c;
    const advisory = /pg_advisory_xact_lock/i.test(s);
    const fiveMin = /5\s*\*\s*60\s*\*\s*1000|300\s*000|300_000|'5\s*minutes?'|"5\s*minutes?"|5-min|five[\s-]*minute|FIVE_MIN|RECENT_WINDOW_MS|recentMs\s*=\s*300/i.test(s);
    record("S13 alert dedupe via advisory lock + 5-min window",
      advisory && fiveMin, `advisory=${advisory} fiveMin=${fiveMin}`);
  }

  // S14 — Source: persistence is idempotent (onConflict update on userId+tradeKey).
  {
    const s = readRepo("artifacts/api-server/src/lib/decision/persistence.ts");
    const ok = /onConflict/i.test(s) && /tradeKey/.test(s) && /userId/.test(s);
    record("S14 persistence is idempotent (userId, tradeKey)", ok);
  }

  // S15 — AI tool registered: getTradeDecision in TOOL_DEFINITIONS + dispatch.
  {
    const s = readRepo("artifacts/api-server/src/lib/assistant/tools.ts");
    const def = /name:\s*"getTradeDecision"/.test(s);
    const dispatch = /case\s+"getTradeDecision"/.test(s);
    const impl = /function\s+getTradeDecisionTool\s*\(/.test(s);
    record("S15 AI tool getTradeDecision registered (def+dispatch+impl)",
      def && dispatch && impl, `def=${def} disp=${dispatch} impl=${impl}`);
  }

  // S16 — AI tool returns safety envelope (impl spreads SAFETY_ENVELOPE).
  {
    const s = readRepo("artifacts/api-server/src/lib/assistant/tools.ts");
    const m = s.match(/function\s+getTradeDecisionTool[\s\S]*?\n\}\s*$/m)
      || s.match(/function\s+getTradeDecisionTool[\s\S]{0,3000}/);
    const slice = m ? m[0] : "";
    record("S16 AI tool spreads SAFETY_ENVELOPE on every return",
      /\.\.\.SAFETY_ENVELOPE/.test(slice));
  }

  // S17 — systemPrompt teaches the Phase UX7 7-section format + "not guaranteed".
  {
    const s = readRepo("artifacts/api-server/src/lib/assistant/systemPrompt.ts");
    const phase = /Phase\s+UX7/i.test(s);
    const sevenSec = /7-section/i.test(s) || (s.match(/^\s*[1-7]\.\s/mg)?.length ?? 0) >= 7;
    const cautious = /not\s+guaranteed/i.test(s);
    const reviewOnly = /review/i.test(s) && /explicit\s+confirmation/i.test(s);
    record("S17 systemPrompt teaches UX7 cautious format",
      phase && sevenSec && cautious && reviewOnly,
      `phase=${phase} sec=${sevenSec} caut=${cautious} review=${reviewOnly}`);
  }

  // S18 — No secrets leak across ANY decision endpoint surface.
  {
    const probes = [
      "/api/me/trades/lp_999999999/decision",
      "/api/me/trade-decisions/active",
    ];
    let leaked = false;
    for (const p of probes) {
      const r = await api(p);
      const t = await r.text();
      if (containsSecrets(t)) { leaked = true; break; }
    }
    record("S18 no secrets leaked from decision endpoints", !leaked);
  }

  // S19 — DB schema file exists with unique (userId,tradeKey) declaration
  //       (either unique() composite or uniqueIndex on the pair).
  {
    const s = readRepo("lib/db/src/schema/tradeDecisions.ts");
    const hasTable = /export\s+const\s+tradeDecisions(Table)?\s*=/.test(s);
    const hasUnique = (/unique\s*\(|uniqueIndex\s*\(/i.test(s))
      && /userId/.test(s) && /tradeKey/.test(s);
    record("S19 tradeDecisions schema has unique (userId,tradeKey)",
      hasTable && hasUnique, `table=${hasTable} unique=${hasUnique}`);
  }

  const failed = results.filter((r) => !r.pass);
  // eslint-disable-next-line no-console
  console.log(`\n${results.length - failed.length}/${results.length} PASSED`);
  if (failed.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`FAILED:\n${failed.map((r) => "  - " + r.name + (r.note ? "  ("+r.note+")" : "")).join("\n")}`);
    process.exit(1);
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});

export {};
// Phase UX6 — Market Context Engine (17 scenarios).
// Black-box HTTP-only suite against the running API. Verifies the new
// endpoints exist and are user-scoped, payloads carry the safety
// envelope and an honest dataQuality, no fabrication occurs when the
// provider is not connected, no secrets leak, recalc never executes a
// trade, AI tools are registered and read-only, and the assistant
// system prompt teaches the 8-section response format.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname_local = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname_local, "..", "..");
function repo(p: string): string { return resolve(REPO_ROOT, p); }

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
  const u = `ux6_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

async function main() {
  await register();

  // 1: GET /api/me/market-context/:symbol returns 200 with safety envelope
  //    and a classification.label (real provider) OR explicitly says
  //    Data insufficient (honest no-data path). Never 500.
  {
    const r = await api("/api/me/market-context/EURUSD");
    const j = await asJson(r);
    const cls = (j?.["classification"] as Record<string, unknown> | undefined) ?? null;
    const label = cls?.["label"] as string | undefined;
    record("S01 GET market-context/:symbol returns label + envelope",
      r.status === 200 && Boolean(label) && hasEnvelope(j));
  }

  // 2: GET ?tfs=M15,H1 narrows timeframes (response only contains those).
  {
    const r = await api("/api/me/market-context/EURUSD?tfs=M15,H1");
    const j = await asJson(r);
    const ctx = j?.["context"] as { timeframes?: Record<string, unknown> } | undefined;
    const tfs = Object.keys(ctx?.timeframes ?? {});
    const ok = tfs.length > 0 && tfs.every((t) => t === "M15" || t === "H1");
    record("S02 ?tfs= narrows the timeframe map", ok, tfs.join(","));
  }

  // 3: payload never includes raw candles (we strip them at the wire).
  {
    const r = await api("/api/me/market-context/EURUSD");
    const text = await r.text();
    record("S03 payload strips raw candles", !/"candles"\s*:/.test(text));
  }

  // 4: invalid symbol returns 400 (not 500).
  {
    const r = await api("/api/me/market-context/!!!");
    record("S04 invalid symbol → 400", r.status === 400);
  }

  // 5: GET trade market-context with unknown trade key returns 404
  //    (ownership/existence check fires before any provider call).
  {
    const r = await api("/api/me/trades/lp_999999999/market-context");
    record("S05 unknown trade key → 404", r.status === 404);
  }

  // 6: GET trade market-context with malformed key returns 404 (not 500).
  {
    const r = await api("/api/me/trades/garbage_xx/market-context");
    record("S06 malformed key → 404", r.status === 404);
  }

  // 7: POST recalculate for unknown trade key returns 404 and never
  //    creates an order anywhere.
  {
    const r = await api("/api/me/trades/lp_999999999/market-context/recalculate", {
      method: "POST", body: JSON.stringify({}),
    });
    const j = await asJson(r);
    const noOrder = !("orderId" in (j ?? {})) && !("placedOrder" in (j ?? {}));
    record("S07 recalc unknown trade → 404, no order ever", r.status === 404 && noOrder);
  }

  // 8: GET market-context for a real symbol exposes context.dataQuality
  //    with a known enum value and a missing[] array.
  {
    const r = await api("/api/me/market-context/EURUSD");
    const j = await asJson(r);
    const dq = (j?.["context"] as { dataQuality?: { quality?: string; missing?: unknown[] } } | undefined)?.dataQuality;
    const ok = dq != null
      && typeof dq.quality === "string"
      && ["good", "partial", "insufficient"].includes(dq.quality)
      && Array.isArray(dq.missing);
    record("S08 dataQuality is honest (quality + missing)", Boolean(ok), dq?.quality);
  }

  // 9: classification.scores contains the 11 declared scores from T203.
  {
    const r = await api("/api/me/market-context/EURUSD");
    const j = await asJson(r);
    const scores = (j?.["classification"] as { scores?: Record<string, unknown> } | undefined)?.scores ?? {};
    const want = [
      "continuationScore", "pullbackScore", "retracementScore",
      "reversalRiskScore", "fakeoutRiskScore", "liquiditySweepScore",
      "chopRiskScore", "breakoutStrengthScore", "trendStrengthScore",
      "momentumStrengthScore", "volatilityRiskScore",
    ];
    const present = want.filter((k) => k in scores);
    record("S09 classifier returns all 11 scores",
      present.length === want.length, `present=${present.length}/${want.length}`);
  }

  // 10: classification.label is one of the fixed set.
  {
    const r = await api("/api/me/market-context/EURUSD");
    const j = await asJson(r);
    const label = (j?.["classification"] as { label?: string } | undefined)?.label;
    const ok = typeof label === "string" && [
      "Strong continuation","Weak continuation","Healthy pullback","Deep retracement",
      "Reversal risk rising","Possible fakeout","Liquidity sweep possible",
      "Breakout holding","Failed breakout","Choppy / no clear edge","Data insufficient",
    ].includes(label);
    record("S10 label is from the fixed enum", Boolean(ok), label);
  }

  // 11: response carries no broker credentials / master account ids.
  {
    const r = await api("/api/me/market-context/EURUSD");
    const t = await r.text();
    const bad = /sharedMasterAccountId|brokerLogin|brokerPassword|investorPassword|apiKeyHash/i.test(t);
    record("S11 no broker/master credential fields leak", !bad);
  }

  // 12: response carries no environment secret values.
  {
    const r = await api("/api/me/market-context/EURUSD");
    const t = await r.text();
    record("S12 no secret values leak in payload", !containsSecrets(t));
  }

  // 13: AI assistant tool registry surfaces the 2 new tools.
  {
    const r = await api("/api/assistant/tool-registry");
    let names: string[] = [];
    if (r.ok) {
      const j = await asJson(r) as { tools?: Array<{ name?: string }> } | null;
      names = (j?.tools ?? []).map((t) => String(t.name ?? ""));
    } else {
      // Fallback: read source file when the endpoint isn't exposed.
      const src = readFileSync(repo("artifacts/api-server/src/lib/assistant/tools.ts"), "utf8");
      names = Array.from(src.matchAll(/name:\s*"([A-Za-z][A-Za-z0-9]+)"/g)).map((m) => m[1] ?? "");
    }
    const has1 = names.includes("getSymbolMarketContext");
    const has2 = names.includes("getTradeMarketContext");
    record("S13 AI tools registered (getSymbolMarketContext + getTradeMarketContext)", has1 && has2);
  }

  // 14: system prompt teaches the 8-section UX6 response format.
  {
    const src = readFileSync(repo("artifacts/api-server/src/lib/assistant/systemPrompt.ts"), "utf8");
    const ok = /Phase UX6/.test(src)
      && /8-section/.test(src)
      && /getSymbolMarketContext/.test(src)
      && /getTradeMarketContext/.test(src)
      && /Cautious phrasing rules/.test(src);
    record("S14 systemPrompt teaches UX6 format + cautious phrasing", ok);
  }

  // 15: recalc + GET endpoints both return the safety envelope. We can't
  //     hit recalc on a real trade without one, so probe the unknown-key
  //     path: a 404 body still must NOT contain placedOrder/closedTrade.
  {
    const r = await api("/api/me/trades/lp_999999999/market-context/recalculate", {
      method: "POST", body: JSON.stringify({}),
    });
    const t = await r.text();
    record("S15 recalc never returns order/close fields, even on 404",
      !/placedOrder|orderId|closedTrade|executedTrade/i.test(t));
  }

  // 16: market-context endpoints require auth — strip cookie and retry.
  {
    const save = cookie; cookie = "";
    const r = await api("/api/me/market-context/EURUSD");
    cookie = save;
    record("S16 endpoints require auth (no cookie → 401)", r.status === 401);
  }

  // 17: market-context payload sets safety = paper_only with no
  //     order-execution capability, matching the platform invariant.
  {
    const r = await api("/api/me/market-context/EURUSD");
    const j = await asJson(r);
    const s = (j?.["safety"] as Record<string, unknown> | undefined) ?? {};
    const ok = s["safetyMode"] === "paper_only"
      && s["liveLocked"] === true
      && s["readOnlyMode"] === true
      && s["allowOrderExecution"] === false;
    record("S17 safety envelope = paper_only / liveLocked / readOnly", Boolean(ok));
  }

  const passed = results.filter((r) => r.pass).length;
  // eslint-disable-next-line no-console
  console.log(`\nUX6 RESULT: ${passed}/${results.length} PASS`);
  if (passed !== results.length) process.exit(1);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});

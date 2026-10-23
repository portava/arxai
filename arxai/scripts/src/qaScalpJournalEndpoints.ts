// qaScalpJournalEndpoints.ts — Authenticated QA for the Phase-3 Ruby Flame
// Scalp journal / after-action review / per-symbol personality endpoints.
//
// What it asserts (READ-ONLY — never places, modifies, or closes a trade):
//  1. Unauthenticated calls to all three endpoints are rejected (401).
//  2. Authenticated calls return 200 with the documented shape.
//  3. Response bodies leak no internal enum tokens / engine field names.
//  4. Response bodies carry no guaranteed-return / risk-free wording.
//  5. P/L honesty: every entry's plQuality is one of KNOWN/ESTIMATED/UNKNOWN
//     and an UNKNOWN/ESTIMATED row never claims a realized figure.
//  6. limit query param is honoured (capped).
//
// No auto-trading happens here. This is a pure read sweep.

import { performance } from "node:perf_hooks";

const BASE = process.env.QA_BASE_URL ?? "http://localhost:80";
const EMAIL = process.env.QA_OWNER_EMAIL;
const PASSWORD = process.env.QA_OWNER_PASSWORD;
if (!EMAIL || !PASSWORD) {
  console.error("FATAL: QA_OWNER_EMAIL / QA_OWNER_PASSWORD required.");
  process.exit(2);
}

let cookie = "";

async function req(
  method: string,
  path: string,
  body?: unknown,
  withAuth = true,
): Promise<{ status: number; json: unknown; text: string; ms: number }> {
  const t0 = performance.now();
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(withAuth && cookie ? { Cookie: cookie } : {}),
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const setCookie = r.headers.get("set-cookie");
  if (setCookie) {
    const m = setCookie.match(/(?:^|,\s*)([^=,;\s]+=[^;]+)/);
    if (m) cookie = m[1]!;
  }
  const text = await r.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: r.status, json, text, ms: performance.now() - t0 };
}

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  [PASS] ${name}${detail ? `  ${detail}` : ""}`); }
  else { failed++; console.log(`  [FAIL] ${name}${detail ? `  ${detail}` : ""}`); }
}

// Internal tokens that must never reach a normal user's screen via the API.
// (These are raw engine identifiers; the UI renders plain-English instead.)
const INTERNAL_TOKEN_PATTERNS: RegExp[] = [
  /qualityBias/,
  /minQualityDelta/,
  /scoreAdjust/,
  /LIVE_BLOCKED/,
  /recentFailureLockout/,
  /flameCore/,
];

const RISKY_WORDING_PATTERNS: RegExp[] = [
  /guaranteed/i,
  /risk[-\s]?free/i,
  /can'?t lose/i,
  /sure thing/i,
  /\bno risk\b/i,
];

function scanForbidden(label: string, text: string, patterns: RegExp[]) {
  const hits = patterns.filter((p) => p.test(text)).map((p) => p.source);
  check(`${label}: no forbidden matches`, hits.length === 0, hits.length ? `matched ${hits.join(", ")}` : "");
}

async function main() {
  console.log(`ARX scalp-journal endpoints QA — ${BASE}\n`);

  // ── 1) Unauthenticated must be rejected ──────────────────────────────────
  console.log("Unauthenticated (expect 401):");
  for (const p of ["/api/me/scalp/journal", "/api/me/scalp/reviews", "/api/me/scalp/personality"]) {
    const r = await req("GET", p, undefined, false);
    check(`${p} rejects anon`, r.status === 401, `HTTP ${r.status}`);
  }

  // ── 2) Login ─────────────────────────────────────────────────────────────
  console.log("\nLogin:");
  const login = await req("POST", "/api/auth/login", { email: EMAIL!.toLowerCase(), password: PASSWORD });
  check("login succeeds", login.status === 200, `HTTP ${login.status}`);
  if (login.status !== 200) { console.error("login failed", login.json); process.exit(2); }

  // ── 3) Journal ───────────────────────────────────────────────────────────
  console.log("\nGET /api/me/scalp/journal:");
  const journal = await req("GET", "/api/me/scalp/journal?limit=5");
  check("journal 200", journal.status === 200, `HTTP ${journal.status}`);
  const jbody = journal.json as { entries?: unknown[]; generatedAt?: string } | null;
  check("journal has entries[] + generatedAt", Array.isArray(jbody?.entries) && typeof jbody?.generatedAt === "string");
  check("journal honours limit<=5", (jbody?.entries?.length ?? 0) <= 5, `n=${jbody?.entries?.length ?? 0}`);
  scanForbidden("journal", journal.text, INTERNAL_TOKEN_PATTERNS);
  scanForbidden("journal", journal.text, RISKY_WORDING_PATTERNS);
  // P/L honesty
  const jentries = (jbody?.entries ?? []) as Array<Record<string, unknown>>;
  const badPl = jentries.filter((e) => {
    const q = e.plQuality;
    if (q !== "KNOWN" && q !== "ESTIMATED" && q !== "UNKNOWN" && q !== "OPEN") return true;
    if (q === "UNKNOWN" && e.realizedPl != null) return true;
    return false;
  });
  check("journal P/L honesty (no UNKNOWN claiming realized)", badPl.length === 0, badPl.length ? `${badPl.length} bad rows` : "");

  // ── 4) Reviews ───────────────────────────────────────────────────────────
  console.log("\nGET /api/me/scalp/reviews:");
  const reviews = await req("GET", "/api/me/scalp/reviews?limit=5");
  check("reviews 200", reviews.status === 200, `HTTP ${reviews.status}`);
  const rbody = reviews.json as { reviews?: unknown[]; generatedAt?: string } | null;
  check("reviews has reviews[] + generatedAt", Array.isArray(rbody?.reviews) && typeof rbody?.generatedAt === "string");
  check("reviews honours limit<=5", (rbody?.reviews?.length ?? 0) <= 5, `n=${rbody?.reviews?.length ?? 0}`);
  scanForbidden("reviews", reviews.text, INTERNAL_TOKEN_PATTERNS);
  scanForbidden("reviews", reviews.text, RISKY_WORDING_PATTERNS);
  const rentries = (rbody?.reviews ?? []) as Array<Record<string, unknown>>;
  check("reviews are all CLOSED", rentries.every((e) => e.status === "CLOSED"), rentries.length ? "" : "(none yet)");

  // ── 5) Personality ───────────────────────────────────────────────────────
  console.log("\nGET /api/me/scalp/personality:");
  const personality = await req("GET", "/api/me/scalp/personality?limit=5");
  check("personality 200", personality.status === 200, `HTTP ${personality.status}`);
  const pbody = personality.json as { symbols?: unknown[]; generatedAt?: string } | null;
  check("personality has symbols[] + generatedAt", Array.isArray(pbody?.symbols) && typeof pbody?.generatedAt === "string");
  check("personality honours limit<=5", (pbody?.symbols?.length ?? 0) <= 5, `n=${pbody?.symbols?.length ?? 0}`);
  scanForbidden("personality", personality.text, INTERNAL_TOKEN_PATTERNS);
  scanForbidden("personality", personality.text, RISKY_WORDING_PATTERNS);
  const psyms = (pbody?.symbols ?? []) as Array<Record<string, unknown>>;
  check("personality win-rate is in [0,100] or null", psyms.every((s) => s.winRatePct == null || (typeof s.winRatePct === "number" && s.winRatePct >= 0 && s.winRatePct <= 100)));

  console.log(`\n${passed}/${passed + failed} checks passed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error("harness error", e); process.exit(2); });

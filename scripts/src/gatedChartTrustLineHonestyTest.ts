// Gated chart-read trust-line honesty test.
//
// Proves the fix for the gated-branch trust-line leak in
// `POST /api/me/assistant/read-chart` (meAssistant.ts). The gated branch used
// to reuse `rubyCtx.trustLine`, which is composed from the raw Phase-3 gate
// flags by `buildTrustLine`. Those flags can ALL be true (so the line reads
// "Verified W1 candles · Live feed · Mirror synced · AACI verified") even when
// the read is gated because the feed is delayed (`state.aiUsable === false`),
// which makes `toBasis` return INSUFFICIENT. The fix derives a separate,
// feed-state-driven `buildGatedTrustLine` so a gated read can NEVER claim
// verification or a live feed.
//
// The SAME leak exists in `POST /api/me/assistant/draft-read`, whose trust line
// comes from `buildRubyDraftRead` (also composed from the raw Phase-3 gate flags
// via `buildTrustLine`). It is fixed the same way — gating on
// `basis !== "VERIFIED"` and overriding the line with `buildGatedTrustLine`.
// Check #10 below is the static wiring guard for that endpoint.
//
// This test is deterministic (pure function + static source scan) — no DB,
// network, or app harness required.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  buildGatedTrustLine,
  buildStructuralReadTrustLine,
  type RubyChartReadBasis,
} from "../../artifacts/api-server/src/lib/data/chart/rubyChartContext.js";

type CheckResult = { id: number; name: string; ok: boolean; detail: string };
const results: CheckResult[] = [];
const rec = (id: number, name: string, ok: boolean, detail = "") =>
  results.push({ id, name, ok, detail });

// Confidence tokens that must NEVER appear on a gated OR structural-only read —
// the SAME limitation the Scanner header badge enforces. Only the verified FULL
// success-path line (buildTrustLine) may use these.
const FORBIDDEN = ["Verified", "Live feed", "AACI verified", "Live-confirmed", "Execution-ready"];
const hasForbidden = (s: string) => FORBIDDEN.filter((t) => s.includes(t));

// 1. THE BUG CASE: W1 read whose gate flags all pass but whose feed is delayed
//    (available, not stale, NOT aiUsable → basis INSUFFICIENT). The old code
//    could surface "Verified W1 candles · Live feed · …" here.
const w1 = buildGatedTrustLine("W1", {
  available: true,
  stale: false,
  aiUsable: false,
  basis: "INSUFFICIENT",
});
rec(
  1,
  "W1 delayed-feed gated line is exact + honest",
  w1 === "W1 candles syncing · feed delayed · read gated",
  `got "${w1}"`,
);
rec(
  2,
  "W1 delayed-feed gated line never claims Verified/Live feed",
  hasForbidden(w1).length === 0,
  `forbidden: ${hasForbidden(w1).join(", ")}`,
);
rec(
  3,
  "W1 gated line is NOT the leaky success-path string",
  w1 !== "Verified W1 candles · Live feed · Mirror synced · AACI verified",
  w1,
);

// 4. Feed unavailable (rubyCtx null) → honest "feed unavailable".
const unavail = buildGatedTrustLine("M5", {
  available: false,
  stale: false,
  aiUsable: false,
  basis: "INSUFFICIENT",
});
rec(
  4,
  "unavailable feed → 'feed unavailable', honest",
  unavail === "M5 candles syncing · feed unavailable · read gated" &&
    hasForbidden(unavail).length === 0,
  unavail,
);

// 5. Stale feed → honest "feed stale".
const stale = buildGatedTrustLine("M15", {
  available: true,
  stale: true,
  aiUsable: false,
  basis: "INSUFFICIENT",
});
rec(
  5,
  "stale feed → 'feed stale', honest",
  stale === "M15 candles syncing · feed stale · read gated" &&
    hasForbidden(stale).length === 0,
  stale,
);

// 6. Fresh feed but PARTIAL basis (mirror/AACI degraded) → "mirror syncing".
const partial = buildGatedTrustLine("H1", {
  available: true,
  stale: false,
  aiUsable: true,
  basis: "PARTIAL",
});
rec(
  6,
  "fresh+PARTIAL → 'mirror syncing', honest",
  partial === "H1 candles syncing · mirror syncing · read gated" &&
    hasForbidden(partial).length === 0,
  partial,
);

// 7. Fresh feed but SYNCING basis (truth < threshold) → "awaiting sync".
const syncing = buildGatedTrustLine("H4", {
  available: true,
  stale: false,
  aiUsable: true,
  basis: "SYNCING",
});
rec(
  7,
  "fresh+SYNCING → 'awaiting sync', honest",
  syncing === "H4 candles syncing · awaiting sync · read gated" &&
    hasForbidden(syncing).length === 0,
  syncing,
);

// 8. EXHAUSTIVE INVARIANT: across every feed-state combination, a gated trust
//    line must never contain "Verified" or "Live feed", and must echo the
//    timeframe + the "read gated" suffix.
const bases: RubyChartReadBasis[] = ["INSUFFICIENT", "PARTIAL", "SYNCING", "VERIFIED"];
const tfs = ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN1"];
const leaks: string[] = [];
for (const tf of tfs) {
  for (const available of [true, false]) {
    for (const sstale of [true, false]) {
      for (const aiUsable of [true, false]) {
        for (const basis of bases) {
          const line = buildGatedTrustLine(tf, { available, stale: sstale, aiUsable, basis });
          const bad = hasForbidden(line);
          const wellFormed =
            line.startsWith(`${tf} candles syncing · `) && line.endsWith(" · read gated");
          if (bad.length > 0 || !wellFormed) {
            leaks.push(`${tf}/${available}/${sstale}/${aiUsable}/${basis} → "${line}"`);
          }
        }
      }
    }
  }
}
rec(
  8,
  "exhaustive: gated line never claims Verified/Live feed and is well-formed",
  leaks.length === 0,
  leaks.slice(0, 4).join(" | "),
);

// 9. STATIC WIRING GUARD (read-chart): the read-chart gated/structural pipeline
//    was EXTRACTED into rubyStructuralReadService.ts (buildRubyStructuralRead).
//    So the guard now spans two facts: (9a) the read-chart ROUTE delegates to the
//    service and keeps NO inline gated branch that could re-leak, and (9b) the
//    service's WITHHELD branches derive their trust line from the dedicated
//    builders — buildGatedTrustLine (INSUFFICIENT) / buildStructuralReadTrustLine
//    (STRUCTURAL_ONLY) — and reuse the verified success-path `rubyCtx.trustLine`
//    EXACTLY ONCE, only in the VERIFIED/FULL branch. Comments are stripped so the
//    explanatory text (which legitimately names rubyCtx.trustLine) can't cause a
//    false pass/fail.
const here = dirname(fileURLToPath(import.meta.url));
const meAssistantPath = resolve(here, "../../artifacts/api-server/src/routes/meAssistant.ts");
const src = readFileSync(meAssistantPath, "utf8");
const stripComments = (s: string) =>
  s
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");

// 9a. read-chart route delegates to buildRubyStructuralRead and keeps NO inline
//     gated branch (no `gated: true`, no buildGatedTrustLine, no trust line).
const readChartAnchor = src.indexOf('router.post("/me/assistant/read-chart"');
const readChartEnd =
  readChartAnchor === -1 ? -1 : src.indexOf("\nrouter.", readChartAnchor + 1);
let routeOk = false;
let routeDetail = "read-chart route not found";
if (readChartAnchor !== -1 && readChartEnd !== -1 && readChartEnd > readChartAnchor) {
  const routeCode = stripComments(src.slice(readChartAnchor, readChartEnd));
  const delegates = routeCode.includes("buildRubyStructuralRead(");
  const noInlineGated =
    !routeCode.includes("gated: true") &&
    !routeCode.includes("buildGatedTrustLine(") &&
    !routeCode.includes("trustLine");
  routeOk = delegates && noInlineGated;
  routeDetail = `delegates=${delegates} noInlineGated=${noInlineGated}`;
}

// 9b. the extracted service wires both withheld builders and reuses the
//     success-path rubyCtx.trustLine exactly once, only in the VERIFIED branch.
const servicePath = resolve(
  here,
  "../../artifacts/api-server/src/lib/assistant/rubyStructuralReadService.ts",
);
const svc = stripComments(readFileSync(servicePath, "utf8"));
const usesGated = svc.includes("buildGatedTrustLine(");
const usesStructural = svc.includes("buildStructuralReadTrustLine(");
const successReuses = (svc.match(/rubyCtx\.trustLine/g) ?? []).length;
const optionalReuse = svc.includes("rubyCtx?.trustLine");
const verifiedIdx = svc.indexOf('rubyCtx.basis === "VERIFIED"');
const reuseIdx = svc.indexOf("rubyCtx.trustLine");
const reuseInVerifiedBranch = verifiedIdx !== -1 && reuseIdx !== -1 && reuseIdx > verifiedIdx;
const serviceOk =
  usesGated && usesStructural && successReuses === 1 && !optionalReuse && reuseInVerifiedBranch;
const serviceDetail = `usesGated=${usesGated} usesStructural=${usesStructural} successReuses=${successReuses} optionalReuse=${optionalReuse} reuseInVerified=${reuseInVerifiedBranch}`;
rec(
  9,
  "read-chart delegates to the service; withheld branches use the dedicated trust-line builders, not rubyCtx.trustLine",
  routeOk && serviceOk,
  `route(${routeDetail}) service(${serviceDetail})`,
);

// 10. STATIC WIRING GUARD (draft-read): the POST /me/assistant/draft-read
//     handler must override its trust line with buildGatedTrustLine, gated on
//     `basis !== "VERIFIED"` — exactly like the read-chart gated branch — so a
//     gated draft read can never keep buildRubyDraftRead's success-path
//     "Verified … · Live feed …" line. Scope to the handler block (anchor → the
//     next route registration) and strip line comments so the explanatory
//     comment can't cause a false pass.
const draftAnchor = src.indexOf('router.post("/me/assistant/draft-read"');
const draftEnd = draftAnchor === -1 ? -1 : src.indexOf("\nrouter.", draftAnchor + 1);
let draftWiringOk = false;
let draftWiringDetail = "draft-read handler not found";
if (draftAnchor !== -1 && draftEnd !== -1 && draftEnd > draftAnchor) {
  const block = src.slice(draftAnchor, draftEnd);
  const codeOnly = block
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  const usesBuilder = codeOnly.includes("buildGatedTrustLine(");
  const gatesOnBasis = codeOnly.includes('!== "VERIFIED"');
  const overridesTrustLine = codeOnly.includes("draftRead.trustLine =");
  draftWiringOk = usesBuilder && gatesOnBasis && overridesTrustLine;
  draftWiringDetail = `usesBuilder=${usesBuilder} gatesOnBasis=${gatesOnBasis} overridesTrustLine=${overridesTrustLine}`;
}
rec(
  10,
  "draft-read gated trust line wired to buildGatedTrustLine on basis !== VERIFIED",
  draftWiringOk,
  draftWiringDetail,
);

// 11. buildStructuralReadTrustLine — closed-only (feed unconfirmed) variant is
//     exact, names the limitation, and claims no verified/live-confirmed feed.
const sClosed = buildStructuralReadTrustLine("H1", { canUseCurrentCandleForEntry: false });
rec(
  11,
  "structural closed-only line names the feed-not-confirmed limitation, no forbidden tokens",
  sClosed ===
    "Historical/closed-candle H1 structural read · Feed not confirmed for live entry · Entry confirmation pending" &&
    hasForbidden(sClosed).length === 0,
  sClosed,
);

// 12. buildStructuralReadTrustLine — live-but-withheld variant (feed confirmed,
//     exact setup withheld by the shared sufficiency verdict) still claims no
//     execution-readiness and never an exact entry.
const sLive = buildStructuralReadTrustLine("M5", { canUseCurrentCandleForEntry: true });
rec(
  12,
  "structural live-but-withheld line withholds the exact setup, no forbidden tokens",
  sLive === "M5 closed-candle structural read · Exact setup withheld · Entry confirmation pending" &&
    hasForbidden(sLive).length === 0,
  sLive,
);

// 13. EXHAUSTIVE INVARIANT: across every timeframe and both entry-confirmation
//     states, a structural-only trust line never contains a confidence token the
//     Scanner header would withhold (Verified / Live feed / AACI verified /
//     Live-confirmed / Execution-ready) and is always well-formed (echoes the
//     timeframe, ends on the entry-confirmation caveat).
const sLeaks: string[] = [];
for (const tf of tfs) {
  for (const canUseCurrentCandleForEntry of [true, false]) {
    const line = buildStructuralReadTrustLine(tf, { canUseCurrentCandleForEntry });
    const bad = hasForbidden(line);
    const wellFormed = line.includes(tf) && line.endsWith("Entry confirmation pending");
    if (bad.length > 0 || !wellFormed) {
      sLeaks.push(`${tf}/${canUseCurrentCandleForEntry} → "${line}" [${bad.join(",")}]`);
    }
  }
}
rec(
  13,
  "exhaustive: structural-only line never claims verified/live-confirmed and is well-formed",
  sLeaks.length === 0,
  sLeaks.slice(0, 4).join(" | "),
);

// ── tally ──
const passed = results.filter((r) => r.ok).length;
for (const r of results)
  console.log(
    `${r.ok ? "PASS" : "FAIL"}  #${String(r.id).padStart(2, "0")}  ${r.name}${r.ok ? "" : "  → " + r.detail}`,
  );
console.log(`\n${passed}/${results.length} gated chart-read trust-line honesty checks passed`);
if (passed !== results.length) process.exit(1);

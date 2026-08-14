// check-mock-provider-live-feed.ts
//
// Static-analysis CI guard: proves that the keyless mock provider (and the
// legacy mock shims that re-serve its synthetic candles) can never be wired
// into a code path that labels data `LIVE_FEED`.
//
// Why this matters:
//   `mockProvider` (artifacts/api-server/src/lib/data/providers/mockProvider.ts)
//   has `name = "mock"` and `isConnected()` ALWAYS returns true — it needs no
//   API key and self-reports connected. That is exactly the surface that, if
//   accidentally wired into the scanner/router, would let synthetic candles be
//   tagged as a real `LIVE_FEED`. The legacy `twelveDataProvider`
//   (`twelveData_mock_shim`) and `alphaVantageProvider` both re-serve
//   `mockProvider` output (and alphaVantage can even report `isConnected:true`
//   when a key is present while STILL returning mock data) — so they belong to
//   the same "mock surface" that must stay out of every live-feed path.
//
// The single LIVE_FEED-tagging path is `analyzeViaRouter()` in
// `marketScanner.ts`, fed exclusively by `marketDataRouter.ts`
// (mt5_broker → deriv → assistant_real). None of those is the mock surface.
//
// What it checks (source-scan, no network/DB required):
//
//   1. MOCK_CONTRACT — mockProvider.ts still declares `name = "mock"` so the
//      downstream source-mode classifier (guarded separately by
//      check-chart-truth-mock-leak) keeps treating it as mock.
//
//   2. NO_LIVE_FEED_WITH_MOCK — no file under the api-server tree may both
//      import the mock surface AND contain the `LIVE_FEED` token. This is the
//      core invariant: emitter and mock can never coexist in one file.
//
//   3. ROUTER_NO_MOCK_SURFACE — marketDataRouter.ts (the sole feed for the
//      LIVE_FEED tag) must not import the mock surface. Comments are allowed;
//      a real import / instantiation is a violation.
//
//   4. SCANNER_LIVE_FEED_FROM_ROUTER_ONLY — marketScanner.ts must not import
//      the mock surface and must keep the honest `"SIMULATOR"` default for any
//      non-router analysis, so the simulator fallback is never tagged live.
//
// All checks are fast static scans — no runtime, no DB, no network.

import { join } from "node:path";
import type { CheckResult } from "./_lib.js";
import { ROOT, walk, read, rel } from "./_lib.js";

const API_SRC = join(ROOT, "artifacts/api-server/src");
const PROVIDERS_DIR = join(API_SRC, "lib/data/providers");
const ROUTER_PATH = join(API_SRC, "lib/data/marketDataRouter.ts");
const SCANNER_PATH = join(API_SRC, "lib/marketScanner.ts");
const LIVE_FEED_TOKEN = "LIVE_FEED";

// An import line that pulls in the mock provider, the MockProvider class, or
// either legacy mock shim (both of which re-serve mockProvider output). Import
// statements (not bare-word mentions) keep this free of comment false-positives.
const MOCK_SURFACE_IMPORT =
  /\b(?:import|from)\b[^\n;]*['"][^'"]*\/(?:mockProvider|twelveDataProvider|alphaVantageProvider)(?:\.js)?['"]/;
const MOCK_SURFACE_NEW = /\bnew\s+MockProvider\s*\(/;

function usesMockSurface(src: string): boolean {
  return MOCK_SURFACE_IMPORT.test(src) || MOCK_SURFACE_NEW.test(src);
}

export function checkMockProviderLiveFeed(): CheckResult {
  const violations: string[] = [];
  const notes: string[] = [];

  // ── Check 1: MOCK_CONTRACT ────────────────────────────────────────────────
  const mockPath = join(PROVIDERS_DIR, "mockProvider.ts");
  let mockSrc: string;
  try {
    mockSrc = read(mockPath);
  } catch {
    violations.push(`mockProvider.ts not found at expected path (${rel(mockPath)})`);
    return { name: "mock-provider-live-feed", ok: false, violations };
  }
  if (!/name\s*=\s*["']mock["']/.test(mockSrc)) {
    violations.push(
      'mockProvider.ts: must declare `name = "mock"` so the source-mode classifier keeps treating it as mock',
    );
  }

  // ── Check 2: NO_LIVE_FEED_WITH_MOCK ──────────────────────────────────────
  // Walk the whole api-server tree. The provider DEFINITION files legitimately
  // contain the mock surface (they ARE the shims); they carry no LIVE_FEED
  // token, so the intersection rule still passes for them.
  const files = walk(API_SRC, {
    exts: [".ts", ".tsx"],
    skip: (p) => p.includes("node_modules") || p.includes("dist") || p.endsWith(".d.ts"),
  });
  let scanned = 0;
  for (const f of files) {
    let src: string;
    try {
      src = read(f);
    } catch {
      continue;
    }
    scanned++;
    if (usesMockSurface(src) && src.includes(LIVE_FEED_TOKEN)) {
      violations.push(
        `${rel(f)} imports the mock provider surface AND references ${LIVE_FEED_TOKEN} — ` +
          "mock/synthetic data must never be reachable from a live-feed label",
      );
    }
  }

  // ── Check 3: ROUTER_NO_MOCK_SURFACE ──────────────────────────────────────
  let routerSrc: string;
  try {
    routerSrc = read(ROUTER_PATH);
  } catch {
    violations.push(`marketDataRouter.ts not found (${rel(ROUTER_PATH)})`);
    return { name: "mock-provider-live-feed", ok: false, violations };
  }
  if (usesMockSurface(routerSrc)) {
    violations.push(
      "marketDataRouter.ts imports the mock provider surface — the router is the sole feed for the " +
        "LIVE_FEED tag and must use only real providers (mt5_broker / deriv / assistant_real)",
    );
  }

  // ── Check 4: SCANNER_LIVE_FEED_FROM_ROUTER_ONLY ──────────────────────────
  let scannerSrc: string;
  try {
    scannerSrc = read(SCANNER_PATH);
  } catch {
    violations.push(`marketScanner.ts not found (${rel(SCANNER_PATH)})`);
    return { name: "mock-provider-live-feed", ok: false, violations };
  }
  if (usesMockSurface(scannerSrc)) {
    violations.push(
      "marketScanner.ts imports the mock provider surface — its LIVE_FEED tag must come only from the router",
    );
  }
  if (!scannerSrc.includes('"SIMULATOR"') && !scannerSrc.includes("'SIMULATOR'")) {
    violations.push(
      'marketScanner.ts: missing the honest `"SIMULATOR"` dataSource default — a non-router analysis must ' +
        "never silently retain a LIVE_FEED label",
    );
  }

  notes.push('Mock contract: mockProvider declares name = "mock" ✓');
  notes.push(`No-live-feed-with-mock: scanned ${scanned} api-server file(s), zero mock⨯LIVE_FEED overlaps ✓`);
  notes.push("Router: marketDataRouter.ts free of the mock surface ✓");
  notes.push('Scanner: marketScanner.ts free of the mock surface, keeps "SIMULATOR" default ✓');

  return {
    name: "mock-provider-live-feed",
    ok: violations.length === 0,
    violations,
    notes,
  };
}

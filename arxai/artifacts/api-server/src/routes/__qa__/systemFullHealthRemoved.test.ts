// THEME G-CUT / H2 — System Full-Health is retired; the REAL health console stays.
//
// GET /api/system/full-health reported the SIMULATOR world to admins:
// hardcoded "Provider: SIMULATOR" market data, simulator-derived safety flags,
// and a finalState block describing a deferred-MT5 test posture. Admin
// Diagnostics plus runHealthCheck (/api/system-health/check) already cover real
// health from real sources, so this was a second, less truthful answer to the
// same question — exactly the duplication Theme H2 consolidates away.
//
// The sweep listed two UI consumers. There were in fact SIX call sites, all
// handled here rather than left to 404:
//   pages/system-health.tsx          — the StabilizationBlock (removed; the
//                                      real runHealthCheck report on the same
//                                      page is KEPT)
//   pages/admin-security-status.tsx  — "Hardening" card
//   components/dashboard/AdminTesterCards.tsx — Audit Log + Security cells
//   pages/admin-data-management.tsx  — "Storage status" card
//   scripts/src/test-system.ts       — checks 01, 27, 28
//   lib/dailyTesting.ts              — a checklist expectation string
//
// Cards fed exclusively by the deleted report are REMOVED rather than left
// rendering permanent em-dashes or a "REVIEW"/"NO" pill, which would read as a
// live problem instead of an absent data source.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../../..");

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

describe("G-CUT — the route is gone", () => {
  it("routes/systemFullHealth.ts no longer exists", () => {
    assert.equal(existsSync(resolve(ROOT, "artifacts/api-server/src/routes/systemFullHealth.ts")), false);
  });

  it("it is no longer imported or mounted", () => {
    const index = read("artifacts/api-server/src/routes/index.ts");
    assert.ok(!/systemFullHealth/.test(index));
  });
});

describe("G-CUT — no caller is left pointing at a deleted endpoint", () => {
  const callers = [
    "artifacts/trading-dashboard/src/pages/system-health.tsx",
    "artifacts/trading-dashboard/src/pages/admin-security-status.tsx",
    "artifacts/trading-dashboard/src/components/dashboard/AdminTesterCards.tsx",
    "artifacts/trading-dashboard/src/pages/admin-data-management.tsx",
    "scripts/src/test-system.ts",
  ];
  for (const rel of callers) {
    it(`${rel.split("/").pop()} no longer fetches it`, () => {
      const src = read(rel);
      assert.ok(
        !/fetch\([^)]*\/api\/system\/full-health/.test(src) && !/get\("\/api\/system\/full-health"\)/.test(src),
        `${rel} still calls the deleted endpoint`,
      );
    });
  }

  it("the daily-testing checklist no longer cites it", () => {
    assert.ok(!/system\/full-health/.test(read("artifacts/api-server/src/lib/dailyTesting.ts")));
  });

  it("no spoofable x-security-role header is sent to it anywhere", () => {
    for (const rel of callers) {
      const src = read(rel);
      assert.ok(
        !/x-security-role[^\n]*full-health/.test(src),
        `${rel} still sends the header to the deleted route`,
      );
    }
  });
});

describe("H2 — the REAL health console survives", () => {
  it("the System Health page keeps its runHealthCheck report", () => {
    const page = read("artifacts/trading-dashboard/src/pages/system-health.tsx");
    assert.ok(
      /\/api\/system-health\/check/.test(page),
      "the real health check is the surface being kept",
    );
    assert.ok(/subsystemStatus/.test(page), "the real subsystem report still renders");
    assert.ok(!/StabilizationBlock/.test(page), "the SIMULATOR block is gone");
  });

  it("the systemHealth route module is untouched", () => {
    assert.ok(existsSync(resolve(ROOT, "artifacts/api-server/src/routes/systemHealth.ts")));
    assert.ok(/systemHealthRouter/.test(read("artifacts/api-server/src/routes/index.ts")));
  });

  it("runHealthCheck itself still exists", () => {
    assert.ok(/runHealthCheck/.test(read("artifacts/api-server/src/lib/systemHealth/health.ts")));
  });

  it("Admin Market Data Diagnostics is untouched", () => {
    const admin = read("artifacts/api-server/src/routes/adminMarketDataDiagnostics.ts");
    assert.ok(/\/admin\/market-data\/diagnostics/.test(admin));
  });

  it("the security-status page keeps its real auth/permission surfaces", () => {
    const page = read("artifacts/trading-dashboard/src/pages/admin-security-status.tsx");
    assert.ok(/\/api\/auth\/session/.test(page));
    assert.ok(/\/api\/auth\/permissions/.test(page));
  });

  it("the data-management page keeps its exports", () => {
    const page = read("artifacts/trading-dashboard/src/pages/admin-data-management.tsx");
    assert.ok(/\/api\/export\/trades\.csv/.test(page));
    assert.ok(/btn-export-/.test(page));
  });
});

// Pending-order drafts are not broker orders (truth upgrade, 2026-10-28).
//
// /api/me/pending-order-drafts lists drafts whose pendingStatus is
// EA_UPGRADE_REQUIRED: "saved as a validated draft, awaiting EA upgrade" — the
// bridge only executes market orders, so they are never queued to MT5. The
// Scanner chart labelled each one "PENDING", counted them as "N pending" and
// drew "Pending BUY BUY_LIMIT" lines, which reads as a working order at the
// broker that will fill at that price. Expired drafts were shown the same way.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pendingDraftLabel } from "./ScannerChartPanel";

const NOW = Date.UTC(2026, 9, 28, 12, 0);

describe("pendingDraftLabel", () => {
  it("an EA_UPGRADE_REQUIRED draft says it was not sent to the broker", () => {
    const l = pendingDraftLabel({ pendingStatus: "EA_UPGRADE_REQUIRED", expiration: null }, NOW);
    expect(l.chip).toBe("Draft · not sent");
    expect(l.chip).not.toMatch(/^pending$/i);
    expect(l.title).toMatch(/not at the broker/i);
    expect(l.line).toBe("Draft (not sent)");
  });

  it("a READY_TO_EXECUTE draft is still not called a working order", () => {
    const l = pendingDraftLabel({ pendingStatus: "READY_TO_EXECUTE", expiration: null }, NOW);
    expect(l.chip).toBe("Draft · not confirmed");
    expect(l.title).toMatch(/no broker confirmation/i);
  });

  it("an expired draft says it expired", () => {
    const l = pendingDraftLabel({ pendingStatus: "EA_UPGRADE_REQUIRED", expiration: new Date(NOW - 60_000).toISOString() }, NOW);
    expect(l.chip).toBe("Expired draft");
    expect(l.title).toMatch(/expired 2026-10-28 11:59 UTC/);
  });

  it("an unrecognised status never leaks the token and is not confirmed", () => {
    const l = pendingDraftLabel({ pendingStatus: "SOMETHING_NEW", expiration: null }, NOW);
    expect(l.chip).toBe("Draft");
    expect(l.chip + l.title).not.toContain("SOMETHING_NEW");
    expect(l.title).toMatch(/not confirmed at the broker/i);
  });
});

describe("ScannerChartPanel renders drafts with that label", () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const code = readFileSync(join(HERE, "ScannerChartPanel.tsx"), "utf8");
  it("no bare 'PENDING' badge or 'N pending' count", () => {
    expect(code).not.toMatch(/>PENDING</);
    expect(code).not.toMatch(/\{symbolPending\.length\} pending\s*\n/);
    expect(code).toMatch(/pending draft\{symbolPending\.length > 1 \? "s" : ""\}/);
  });
  it("draft lines on the chart are named drafts, not pending orders", () => {
    expect(code).not.toMatch(/`Pending \$\{o\.side\}/);
    expect(code).not.toContain('"Pending SL"');
    expect(code).not.toContain('"Pending TP"');
  });
});

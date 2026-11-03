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

describe("pendingDraftLabel — the statuses draft save and submit store today", () => {
  // Since the draft-status vocabulary change, save/submit store the submit
  // gate's answer (BRIDGE_DISCONNECTED, BRIDGE_UNSUPPORTED, READ_ONLY, …), not
  // EA_UPGRADE_REQUIRED. Each is a known reason, not "an unrecognised state".
  const STORED = ["BRIDGE_DISCONNECTED", "BRIDGE_UNSUPPORTED", "READ_ONLY", "LIVE_LOCKED", "BLOCKED_BY_PAPER_LOCK", "TRADING_DISABLED", "BLOCKED_BY_RISK"];
  for (const status of STORED) {
    it(`${status} is a draft that was not sent, with its reason`, () => {
      const l = pendingDraftLabel({ pendingStatus: status, expiration: null }, NOW);
      expect(l.chip).toBe("Draft · not sent");
      expect(l.line).toBe("Draft (not sent)");
      expect(l.title).not.toMatch(/unrecognised/i);
      expect(l.title).toMatch(/not at the broker/i);
      expect(l.title).toMatch(/When it was saved or last submitted, /);
      expect(l.chip + l.title).not.toContain(status);
      expect(l.title).toMatch(/What a submit would answer now was not checked\./);
    });
  }

  it("names the specific recorded reason", () => {
    expect(pendingDraftLabel({ pendingStatus: "BRIDGE_DISCONNECTED" }, NOW).title).toMatch(/had not sent a recent heartbeat/);
    expect(pendingDraftLabel({ pendingStatus: "BRIDGE_UNSUPPORTED" }, NOW).title).toMatch(/did not report support/);
    expect(pendingDraftLabel({ pendingStatus: "READ_ONLY" }, NOW).title).toMatch(/read-only/);
  });

  it("shows the server's current bridge answer with the time it was read", () => {
    const l = pendingDraftLabel({
      pendingStatus: "BRIDGE_DISCONNECTED",
      currentPendingStatus: "READ_ONLY",
      currentPendingReason: "Your connected EA (EA v1.50) reports pending-order support, but ARX is paper-only: its pending-order path is read-only and does not deliver pending orders to the broker.",
      bridgeCheckedAt: new Date(NOW - 120_000).toISOString(),
    }, NOW);
    expect(l.chip).toBe("Draft · not sent · pending-order path is read-only");
    expect(l.title).toMatch(/When it was saved or last submitted, your MT5 bridge had not sent a recent heartbeat/);
    expect(l.title).toMatch(/Bridge checked 2026-10-28 11:58 UTC: Your connected EA \(EA v1\.50\) reports pending-order support/);
    expect(l.title).not.toMatch(/was not checked/);
  });

  it("a current answer without the time it was read is not shown as current", () => {
    const l = pendingDraftLabel({ pendingStatus: "READ_ONLY", currentPendingStatus: "READ_ONLY", bridgeCheckedAt: null }, NOW);
    expect(l.chip).toBe("Draft · not sent");
    expect(l.title).toMatch(/was not checked/);
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
  it("the chart copies the list's bridgeCheckedAt onto each draft", () => {
    expect(code).toMatch(/penRes\?\.bridgeCheckedAt/);
    expect(code).toMatch(/\.map\(\(d\) => \(\{ \.\.\.d, bridgeCheckedAt \}\)\)/);
  });
});

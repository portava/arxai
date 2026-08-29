// Source-level honesty guard for the surfaces where a click is supposed to
// move real money. Two rules, enforced here for the files that broke them:
//
//   R1. Never swallow a non-ok response.
//   R2. Never render an action as succeeded when the server said mock/403/404.
//
// Each block below names the defect it pins. These are shape/copy invariants —
// a render test on one page cannot prove the other five did not regress, and
// the /orders and /positions mutations are all admin-gated server-side so a
// behavioural test would only ever exercise the refusal branch.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");

function read(rel: string): string {
  return readFileSync(resolve(SRC, rel), "utf8");
}
/** Source with comment lines stripped — these files document what was removed. */
function code(rel: string): string {
  return read(rel)
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("{/*");
    })
    .join("\n");
}

const orders = code("pages/orders.tsx");
const positions = code("pages/positions.tsx");
const liveShared = code("pages/live-shared.tsx");
const tradeDetail = code("pages/trade-detail.tsx");
const liveTradeCard = code("components/LiveTradeCard.tsx");
const liveTradeTicket = code("components/live/LiveTradeTicket.tsx");
const recentScannerTrades = code("components/scanner/RecentScannerTrades.tsx");
const marketScanner = code("pages/market-scanner.tsx");

// ── /orders + /positions — the spoofed ADMIN header and the swallowed 403 ──
describe("/orders and /positions no longer fake a role or swallow a refusal", () => {
  for (const [name, src] of [["orders", orders], ["positions", positions]] as const) {
    it(`${name}: the spoofed x-security-role header is gone`, () => {
      // Production ignores this header (lib/security/middleware.ts): a normal
      // user resolved to VIEWER and every mutating call took a 403.
      expect(src).not.toMatch(/x-security-role/);
    });

    it(`${name}: the shared api() helper checks r.ok and throws the server's text`, () => {
      expect(src).toMatch(/if\s*\(!r\.ok\)/);
      expect(src).toMatch(/throw new Error\(/);
      // The old shape — return r.json() with no status check — must not return.
      expect(src).not.toMatch(/\}\);\s*\n\s*return r\.json\(\);/);
    });

    it(`${name}: a refusal is put on screen, not dropped`, () => {
      expect(src).toMatch(/setErr\(/);
      expect(src).toMatch(new RegExp(`data-testid="${name}-error"`));
    });

    it(`${name}: mutating controls are gated on the real product role`, () => {
      expect(src).toMatch(/useProductRole\(\)/);
      expect(src).toMatch(/isAdmin/);
      expect(src).toMatch(new RegExp(`data-testid="${name}-readonly-note"`));
    });
  }

  it("positions: every mutating press goes through a confirmation first", () => {
    // Close / ½ close / Break-even / Trail used to fire straight off onClick —
    // a misclick closed a position with no confirm and no undo.
    expect(positions).toMatch(/data-testid="positions-confirm"/);
    expect(positions).toMatch(/data-testid="positions-confirm-yes"/);
    for (const kind of ["close", "partial", "breakeven", "trail"]) {
      expect(positions).toMatch(new RegExp(`setPending\\(\\{ kind: "${kind}"`));
    }
    // No handler may call the mutating endpoints directly from an onClick.
    expect(positions).not.toMatch(/onClick=\{\(\) => closeP\(/);
    expect(positions).not.toMatch(/onClick=\{\(\) => trail\(/);
  });

  it("positions: the trail distance is shown and editable, not invented", () => {
    expect(positions).toMatch(/data-testid="positions-trail-distance"/);
    // The undisclosed hard-coded fallback is gone.
    expect(positions).not.toMatch(/XAUUSD" \? 1 : 0\.001/);
  });
});

// ── /live-trades card — the (mock) close and the unhandled rejection ──────
describe("LiveTradeCard reports what the server actually said", () => {
  it("renders the server's message instead of discarding it", () => {
    expect(liveTradeCard).toMatch(/data-testid=\{`action-result-\$\{trade\.id\}`\}/);
    expect(liveTradeCard).toMatch(/setActionResult\(/);
  });

  it("no action button can produce an unhandled rejection", () => {
    // The old shape was `onClick={async () => { await x.mutateAsync(...); }}`
    // with no catch: a 409/404/401 became an unhandled promise and the user
    // saw nothing at all.
    expect(liveTradeCard).not.toMatch(/onClick=\{async \(\) => \{ await/);
    expect(liveTradeCard).toMatch(/runAction\(/);
    expect(liveTradeCard).toMatch(/catch \(e\) \{\s*\n\s*setActionResult\(\{ tone: "error"/);
  });

  it("a LIVE row hides the four actions and says why", () => {
    expect(liveTradeCard).toMatch(/isLiveRow/);
    expect(liveTradeCard).toMatch(/data-testid=\{`live-actions-unavailable-\$\{trade\.id\}`\}/);
  });

  it("a failed status read shows UNKNOWN, never a confident 'OFF'", () => {
    // The three status queries used to fall back to `{}` on a non-ok response,
    // so a 500 on /me/protective-auto-close/settings rendered "Auto-Close OFF"
    // — a safety claim manufactured from a read that never happened.
    expect(liveTradeCard).not.toMatch(/r\.ok \? r\.json\(\) : \(\{\}/);
    expect(liveTradeCard).toMatch(/if \(!r\.ok\) throw new Error/);
    expect(liveTradeCard).toMatch(/badge-auto-close-unknown/);
    expect(liveTradeCard).toMatch(/badge-news-unknown/);
  });

  it("the capability badges do not claim close/SL-TP on a LIVE row", () => {
    expect(liveTradeCard).not.toMatch(/label: "Manual Close Available"/);
    expect(liveTradeCard).not.toMatch(/label: "SL\/TP Editable"/);
    expect(liveTradeCard).toMatch(/Managed in Live Shared/);
  });
});

// ── /live-shared — the promised dry-run step and the phantom positions ────
describe("/live-shared describes the flow it actually runs", () => {
  it("does not promise a two-step Review → Confirm flow", () => {
    // LiveSharedTradeTicket calls /execute on the first press; the single-
    // confirm design is pinned by scripts/src/liveSingleConfirmTest.ts, so a
    // "Review trade" pre-step cannot be added — the copy had to be corrected.
    expect(liveShared).not.toMatch(/Two-step gated flow/);
    expect(liveShared).not.toMatch(/dry-runs every server safety check/);
    expect(liveShared).toMatch(/One confirmation, no dry-run step/);
  });

  it("Open Positions and SL/TP read positions, not the command log", () => {
    // `commands.filter(c => c.status === 'SENT_TO_MT5_LIVE' || c.brokerTicket != null)`
    // listed CLOSE and MODIFY commands as extra open positions and never
    // retired a closed one — it overstated live exposure.
    expect(liveShared).not.toMatch(/status === "SENT_TO_MT5_LIVE" \|\| c\.brokerTicket != null/);
    expect(liveShared).toMatch(/getMyLiveSharedPositions/);
    expect(liveShared).toMatch(/POSITION_TABS/);
  });

  it("a failed position read renders as a failure, never as an empty list", () => {
    expect(liveShared).toMatch(/positionsError/);
    expect(liveShared).toMatch(/data-testid="ls-positions-error"/);
  });

  it("no refusal renders as 'unknown'", () => {
    expect(liveShared).not.toMatch(/\?\? "unknown"/);
    expect(liveShared).toMatch(/without a reason/);
  });
});

// ── /my-trades/:tradeKey — "ARX cannot place orders" next to a Close button ─
describe("trade detail no longer contradicts its own Close control", () => {
  it("drops the false 'ARX cannot place orders' claim", () => {
    expect(tradeDetail).not.toMatch(/ARX cannot place orders/);
    expect(tradeDetail).not.toMatch(/Stop-loss adjustments must be done in MT5/);
  });

  it("says what the buttons do (timeline notes) and links to what acts", () => {
    expect(tradeDetail).toMatch(/records a note on this trade's timeline/i);
    expect(tradeDetail).toMatch(/Live Shared → SL\/TP Manager/);
    // The page still has the real close control it was denying.
    expect(tradeDetail).toMatch(/data-testid="review-close-button"/);
  });
});

// ── Live ticket — the stale header and the invented gate count ────────────
describe("LiveTradeTicket describes itself accurately", () => {
  it("no longer claims an ack checkbox that does not exist", () => {
    const raw = read("components/live/LiveTradeTicket.tsx");
    expect(raw).not.toMatch(/"I confirm this live order" checkbox,\s*\n\/\/\s*the required/);
    expect(raw).toMatch(/There is NO separate/);
    expect(raw).toMatch(/liveSingleConfirmTest/);
  });

  // CORRECTED ASSERTION (review). This block previously pinned the OPPOSITE:
  //   expect(liveTradeTicket).not.toMatch(/15-check gate/)
  // on the premise that no 15-check gate existed in the product. It does, and
  // it is precisely the gate this alert is about: `armed` is read from
  // GET /api/me/live/arming → lib/live/liveArming.ts, whose
  // evaluateLiveArmingGate pushes checks 1..15 and whose ARM_SUCCESS audit line
  // says "passed all 15 checks". The earlier assertion would have blocked
  // anyone restoring the accurate number, so it is replaced — not deleted —
  // with one that derives the count from the evaluator itself.
  it("names the arming gate with the count liveArming.ts actually implements", () => {
    const arming = readFileSync(
      resolve(SRC, "../../api-server/src/lib/live/liveArming.ts"),
      "utf8",
    );
    // Count the `push(<n>, "KEY", …)` calls inside evaluateLiveArmingGate.
    const ids = [...arming.matchAll(/^\s*push\((\d+),\s*"/gm)].map((m) => Number(m[1]));
    expect(ids.length, "no arming checks found — the scan, not the gate, is broken").toBeGreaterThan(5);
    // Ids must be a dense 1..N so N is a count the user can verify on screen.
    expect(ids).toEqual(Array.from({ length: ids.length }, (_, i) => i + 1));
    const n = ids.length;

    // The ticket must name that number, and nothing else.
    expect(
      liveTradeTicket,
      `LiveTradeTicket must send the user to the ${n}-check arming gate`,
    ).toMatch(new RegExp(`${n}-check arming gate`));
    for (const wrong of [n - 1, n + 1]) {
      expect(liveTradeTicket).not.toMatch(new RegExp(`${wrong}-check arming gate`));
    }

    // …and must not conflate it with the separate dispatch evaluator, which is
    // a different gate with a different count (GovernancePanel /
    // LiveSharedTradeTicket). This alert fires on `!armed`, i.e. arming only.
    expect(liveTradeTicket).toMatch(/Live Trading Setup/);
  });

  it("the pre-arm split it quotes matches the evaluator's preArm flags", () => {
    const arming = readFileSync(
      resolve(SRC, "../../api-server/src/lib/live/liveArming.ts"),
      "utf8",
    );
    // preArm defaults true; a check excluded from the on-screen "Pre-arm
    // checklist" passes an explicit `false` in the 7th push() slot, annotated
    // inline as `/* preArm … */` (today only SERVER_LIVE_FLAG, the runtime
    // dispatch flag, which LiveTradingUnlockCard renders as its own row).
    const total = [...arming.matchAll(/^\s*push\((\d+),\s*"/gm)].length;
    const nonPreArm = (arming.match(/\/\*\s*preArm\b/g) ?? []).length;
    expect(nonPreArm, "expected exactly one runtime (non-pre-arm) check").toBe(1);
    expect(liveTradeTicket).toMatch(new RegExp(`${total - nonPreArm} pre-arm checks`));
  });
});

// ── Market Scanner — the empty live feed and the raw-enum alert ───────────
describe("Market Scanner surfaces", () => {
  it("does not promise live scanner history the panel cannot show", () => {
    expect(recentScannerTrades).not.toMatch(/Live Shared scanner trade history will appear here/);
    expect(recentScannerTrades).toMatch(/not available in Live Shared mode/);
    expect(recentScannerTrades).toMatch(/data-testid="recent-scanner-trades-live-link"/);
  });

  // WIDENED (review). The assertion above reads only the component. The page
  // that WRAPS it kept the original promise — market-scanner.tsx passed
  // description="Scanner-generated trades will appear here once orders are
  // placed." to CollapsibleSection, which renders `description`
  // unconditionally, directly above the corrected panel. A live-armed
  // non-admin therefore read the false promise and its correction back to
  // back. The wrapper is now forbidden its own sentence: it must import the
  // constant the panel exports.
  it("the section wrapping the panel cannot carry its own contradicting copy", () => {
    expect(marketScanner).not.toMatch(/trades will appear here once orders are placed/);
    expect(marketScanner).not.toMatch(/Scanner-generated trades/);
    expect(marketScanner).toMatch(/RECENT_SCANNER_TRADES_SECTION_DESCRIPTION/);
    expect(marketScanner).toMatch(
      /description=\{RECENT_SCANNER_TRADES_SECTION_DESCRIPTION\}/,
    );
    // The exported sentence must itself be true in every mode — this panel's
    // only source is the DEMO queue, so it may not promise live rows.
    const raw = read("components/scanner/RecentScannerTrades.tsx");
    const decl = /RECENT_SCANNER_TRADES_SECTION_DESCRIPTION\s*=\s*\n?\s*"([^"]+)"/.exec(raw);
    expect(decl, "the shared description constant must be a plain string literal").not.toBeNull();
    expect(decl![1]).toMatch(/demo command queue/);
    expect(decl![1]).not.toMatch(/will appear/);
  });

  it("the tester capture is admin-only, labelled honestly, and error-handled", () => {
    expect(marketScanner).not.toMatch(/Live Intent</);
    expect(marketScanner).not.toMatch(/alert\(`Live intent captured/);
    expect(marketScanner).not.toMatch(/PENDING_MT5_CONNECTION\.\)`/);
    expect(marketScanner).toMatch(/Capture for operator review/);
    expect(marketScanner).toMatch(/captureForOperatorReview/);
    expect(marketScanner).toMatch(/catch \(e\) \{\s*\n\s*reportErr\(e\);/);
    expect(marketScanner).toMatch(/testId="scanner-capture-notice"/);
  });

  it("no raw alert() reaches the user from this page", () => {
    expect(marketScanner).not.toMatch(/(^|[^.\w])alert\(/m);
  });
});

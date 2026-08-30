// The basis strip is the only place a person learns that ARX's money figures
// disagree with their broker. Its failure modes are the whole point:
//
//   * a failed read must NOT look like agreement, and must not be silent;
//   * "no reconciliation has ever run" must NOT look like agreement;
//   * a DISCREPANCY must say the figures elsewhere are not broker-reconciled.
//
// Render proof only — fetch is stubbed, no network.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { LedgerBasisStrip, formatMinor } from "./LedgerBasisStrip";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetch(impl: () => Promise<Response> | Response) {
  vi.stubGlobal("fetch", vi.fn(async () => impl()));
}

function ok(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

describe("LedgerBasisStrip", () => {
  it("a failed read says the basis is unknown, and explicitly not agreement", async () => {
    stubFetch(() => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response);
    render(<LedgerBasisStrip />);
    const el = await screen.findByTestId("ledger-basis-unreadable");
    expect(el.textContent).toContain("Basis unknown");
    expect(el.textContent).toMatch(/not.{0,3}\s*a statement that/i);
    // The failure must never be reported as a match.
    expect(screen.queryByTestId("ledger-basis-RECONCILED")).toBeNull();
  });

  it("NEVER_RUN renders the server's honest headline, never a clean bill of health", async () => {
    stubFetch(() => ok({
      state: "NEVER_RUN",
      headline: "No ledger-vs-broker reconciliation has run for your account yet. Money figures shown elsewhere in ARX have not been checked against the broker.",
      latest: null,
    }));
    render(<LedgerBasisStrip />);
    await screen.findByTestId("ledger-basis-NEVER_RUN");
    const headline = screen.getByTestId("ledger-basis-headline");
    expect(headline.textContent).toContain("have not been checked against the broker");
    expect(headline.textContent).not.toMatch(/matched/i);
  });

  it("DISPUTED surfaces the disagreement and the difference", async () => {
    stubFetch(() => ok({
      state: "DISPUTED",
      headline: "Your posting ledger DISAGREES with the broker's reported balance. Money figures shown elsewhere in ARX are not broker-reconciled until this is resolved.",
      latest: {
        verdict: "DISCREPANCY",
        reason: "broker balance disagrees with the posting ledger",
        differenceMinor: "-12345",
        currency: "USD",
        scale: 2,
        trigger: "DAILY",
        observedAt: "2026-08-28T10:00:00.000Z",
      },
    }));
    render(<LedgerBasisStrip />);
    const el = await screen.findByTestId("ledger-basis-DISPUTED");
    expect(el.textContent).toContain("DISAGREES");
    expect(el.textContent).toContain("-123.45 USD");
  });

  it("RECONCILED is reachable only from a MATCHED-derived state", async () => {
    stubFetch(() => ok({
      state: "RECONCILED",
      headline: "Your posting ledger matched the broker's reported balance at the last check.",
      latest: {
        verdict: "MATCHED", reason: "balances agree", differenceMinor: "0",
        currency: "USD", scale: 2, trigger: "DAILY", observedAt: "2026-08-28T10:00:00.000Z",
      },
    }));
    render(<LedgerBasisStrip />);
    await waitFor(() => expect(screen.getByTestId("ledger-basis-RECONCILED")).toBeTruthy());
  });
});

describe("formatMinor", () => {
  it("renders minor units exactly and keeps the sign", () => {
    expect(formatMinor("-12345", "USD", 2)).toBe("-123.45 USD");
    expect(formatMinor("5", "USD", 2)).toBe("0.05 USD");
    expect(formatMinor("700", "JPY", 0)).toBe("700 JPY");
  });

  it("returns null rather than inventing a figure it cannot format", () => {
    expect(formatMinor(null, "USD", 2)).toBeNull();
    expect(formatMinor("not-a-number", "USD", 2)).toBeNull();
    expect(formatMinor("100", "MIXED", -1)).toBeNull();
  });
});

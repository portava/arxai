import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { NativeAccountReport, nativeAccountMoney } from "./NativeAccountReport";

const NOW = Date.parse("2026-11-01T18:00:00Z");
const report = (extra: Record<string, unknown> = {}) => ({
  status: "reported" as const, reason: "CLOCK_AND_CONTINUITY_UNVERIFIED", currentVerified: false as const,
  observedAt: new Date(NOW - 2000).toISOString(), receivedAt: new Date(NOW - 1000).toISOString(),
  currency: "KWD", currencyDigits: 3,
  amounts: { balance: "9007199254740993.123", equity: "1025.000", profit: "-5.125", credit: "30.000", margin: "0.000", freeMargin: "1025.000" },
  ...extra,
});
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("preserves decimal text beyond safe-number precision and direct profit distinct from equity minus balance", () => {
  render(<NativeAccountReport report={report()} />);
  expect(screen.getByTestId("native-money-balance").textContent).toBe("KWD 9,007,199,254,740,993.123");
  expect(screen.getByTestId("native-money-profit").textContent).toBe("KWD -5.125");
  expect(screen.getByTestId("native-money-credit").textContent).toBe("KWD 30.000");
  expect(screen.getByTestId("native-money-margin").textContent).toBe("KWD 0.000");
  expect(screen.getByText(/current state unverified/)).toBeTruthy();
  expect(screen.getByText(/whole broker account/)).toBeTruthy();
});
it.each([["0", "JPY", 0, "JPY 0"], ["-0.01", "USD", 2, "USD -0.01"], ["12.345", "KWD", 3, "KWD 12.345"], ["0.0000000000000001", "X", 16, "X 0.0000000000000001"]])("formats exact reported %s", (v, c, d, expected) => {
  expect(nativeAccountMoney(v, c, d)).toBe(expected);
});
it.each([0, null, "NaN", "Infinity", "1e5", "1.00", "-0.000", "+1.000", "01.000", "0.0000"])("rejects malformed or wrong-precision %s", value => {
  expect(nativeAccountMoney(value, "KWD", 3)).toBeNull();
});
it.each([{ status: "unavailable" }, { currentVerified: true }, { observedAt: new Date(NOW + 1).toISOString() }, { receivedAt: new Date(NOW - 3000).toISOString() }, { currency: "" }, { currencyDigits: 17 }, { amounts: null }])("withholds all numbers on inconsistent report %j", extra => {
  render(<NativeAccountReport report={report(extra)} />);
  expect(screen.getByText(/Complete MT5 account report unavailable/)).toBeTruthy();
  expect(screen.getByTestId("native-money-profit").textContent).toBe("—");
});
it("a failed refresh with cached data cannot leave reported amounts visible", () => {
  render(<NativeAccountReport report={report()} failed />);
  expect(screen.getByTestId("native-money-balance").textContent).toBe("—");
});
it("repeat fetches do not rejuvenate the same observation and clock rollback cannot revive it", () => {
  const { rerender } = render(<NativeAccountReport report={report()} />);
  act(() => { vi.advanceTimersByTime(125000); });
  rerender(<NativeAccountReport report={report()} />);
  expect(screen.getByText(/Stale report/)).toBeTruthy();
  vi.setSystemTime(NOW);
  rerender(<NativeAccountReport report={report()} />);
  expect(screen.getByText(/Stale report/)).toBeTruthy();
});

it.each(['2026-11-01','2026-11-01T17:59:59','2026-02-30T17:59:59.000Z'])('receipt without valid canonical UTC %s is withheld',receivedAt=>{
 render(<NativeAccountReport report={report({receivedAt})}/>);expect(screen.getByTestId('native-money-balance').textContent).toBe('—');
});
it('one malformed monetary field withholds the whole report',()=>{
 const value=report();value.amounts.credit='NaN';render(<NativeAccountReport report={value}/>);expect(screen.getByTestId('native-money-balance').textContent).toBe('—');
});

it('server age cannot be replaced by a smaller local age',()=>{
 render(<NativeAccountReport report={report({observationAgeMs:180000})}/>);expect(screen.getByText(/Stale report/)).toBeTruthy();
});
it('broker currency text is retained rather than replaced with USD',()=>{expect(nativeAccountMoney('1.000','US Cent',3)).toBe('US Cent 1.000');expect(nativeAccountMoney('1.000','A\nB',3)).toBeNull();});

it('negative used margin invalidates the complete report',()=>{const value=report();value.amounts.margin='-1.000';render(<NativeAccountReport report={value}/>);expect(screen.getByTestId('native-money-equity').textContent).toBe('—');});

it('account mismatch explains the hold without leaking internal identifiers',()=>{render(<NativeAccountReport report={report({status:'unavailable',reason:'ACCOUNT_BINDING_MISMATCH',amounts:null})}/>);expect(screen.getByText(/does not match the selected broker account/)).toBeTruthy();expect(screen.queryByText(/ACCOUNT_BINDING_MISMATCH/)).toBeNull();});

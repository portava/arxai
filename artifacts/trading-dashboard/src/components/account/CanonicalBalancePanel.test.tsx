import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CanonicalBalancePanel } from "./CanonicalBalancePanel";
import type { InvestorLiveBalance } from "@/hooks/useLiveAccountSnapshot";
afterEach(cleanup);
// Hypothetical qualified scope isolates each UI gate; production composer is separately proven to emit false.
const live: InvestorLiveBalance = { source: "live_shared", positionPnlComplete: true, monetaryScopeVerified: true, realizedPnLPendingCount: 0, allocatedBalance: 1000, realizedPnL: 0,
  floatingPnL: 100, liveEquity: 1100, marginUsed: 0, freeMargin: 1100, availableBalance: 1000,
  openTradeCount: 0, freshness: { status: "fresh", ageMs: 0, lastUpdatedAt: new Date().toISOString() } };
describe("canonical balance presentation", () => {
  it("unknown counts stay unknown instead of reporting no trades", () => {
    render(<CanonicalBalancePanel live={null} />);
    expect(screen.getByText("Open trades").parentElement?.textContent).toBe("Open trades—");
  });
  it("a confirmed zero count is still shown as zero", () => {
    render(<CanonicalBalancePanel live={live} />);
    expect(screen.getByText("Open trades").parentElement?.textContent).toBe("Open trades0");
  });
  it("paused updates label the retained amount last-known", () => {
    render(<CanonicalBalancePanel live={live} updatesPaused />);
    expect(screen.getByText("Last-known allocation equity").parentElement?.textContent).toContain("$1,100.00");
    expect(screen.queryByText("Live equity")).toBeNull();
    expect(screen.getByTestId("canonical-balance-paused-note").textContent).toContain("Refresh checks them once");
  });
  it("expired funds stay visible with their stale warning", () => {
    render(<CanonicalBalancePanel live={{...live, freshness: {...live.freshness, status:"stale"}}} />);
    expect(screen.queryByText("Live equity")).toBeNull();
    expect(screen.getByTestId("canonical-balance-stale-note").textContent).toContain("last known");
  });
});
it('incomplete position evidence cannot present zero-filled derived account money',()=>{
 render(<CanonicalBalancePanel live={{...live,floatingPnL:null,positionPnlComplete:false} as InvestorLiveBalance}/>);
 expect(screen.queryByText('$1,100.00')).toBeNull();
 expect(screen.getByText(/position.*incomplete/i)).toBeTruthy();
 expect(screen.queryByText('Live equity')).toBeNull();
});
it('allocation arithmetic is labeled separately from broker account balances and margins',()=>{
 render(<CanonicalBalancePanel live={live}/>);
 expect(screen.getByText('ARX allocation')).toBeTruthy();
 expect(screen.queryByText('Account balance')).toBeNull();
 expect(screen.queryByText('Margin used')).toBeNull();
 expect(screen.queryByText('Free margin')).toBeNull();
});

it('legacy Live balance title cannot override allocation scope',()=>{
 render(<CanonicalBalancePanel live={live} title="Live balance"/>);
 expect(screen.queryByText('Live balance')).toBeNull();expect(screen.getByText('ARX allocation')).toBeTruthy();
});
it('quote estimates cannot turn derived allocation money into fresh broker currency',()=>{
 render(<CanonicalBalancePanel live={{...live,positionPnlEstimated:true}}/>);
 expect(screen.queryByText('$1,100.00')).toBeNull();expect(screen.getByText('~100 (currency unverified)')).toBeTruthy();
 expect(screen.queryByLabelText('Data freshness: Fresh')).toBeNull();
 expect(screen.getByText(/Quote-derived.*conversion is unverified/)).toBeTruthy();
});
it('pending realized evidence withholds derived equity even with complete position rows',()=>{
 render(<CanonicalBalancePanel live={{...live,realizedPnLPendingCount:1}}/>);
 expect(screen.queryByText('$1,100.00')).toBeNull();expect(screen.queryByLabelText('Data freshness: Fresh')).toBeNull();
});

it.each([undefined,false])('complete broker rows without monetary scope proof %s cannot establish dollar equity',scope=>{
 render(<CanonicalBalancePanel live={{...live,monetaryScopeVerified:scope}}/>);
 expect(screen.queryByText('$1,100.00')).toBeNull();expect(screen.queryByLabelText('Data freshness: Fresh')).toBeNull();
 expect(screen.getByText('100 (currency unverified)')).toBeTruthy();expect(screen.getByText(/verified shared account and currency scope/)).toBeTruthy();
});

it.each([1,undefined])('pending or absent realized evidence %s cannot display a complete realized total',pending=>{
 render(<CanonicalBalancePanel live={{...live,realizedPnL:321,realizedPnLPendingCount:pending}}/>);
 expect(screen.getByText('Realized P/L').parentElement?.textContent).toBe('Realized P/L—');
 expect(screen.queryByText('$1,100.00')).toBeNull();
});
it('hypothetical affirmative scope and complete evidence isolate the other display gates',()=>{
 render(<CanonicalBalancePanel live={live}/>);expect(screen.getAllByText('$1,100.00').length).toBeGreaterThan(0);
});

it('a broker-valued subtotal with unverified units remains neutral, not green account profit',()=>{
 render(<CanonicalBalancePanel live={{...live,monetaryScopeVerified:false}}/>);
 expect(screen.getByText('100 (currency unverified)').className).toContain('text-txt-muted');
});
it.each([NaN,Infinity,-Infinity])('malformed floating P/L %s never bypasses finite display validation',value=>{
 render(<CanonicalBalancePanel live={{...live,floatingPnL:value}}/>);
 expect(screen.queryByText(/NaN|Infinity/)).toBeNull();expect(screen.queryByText('$1,100.00')).toBeNull();
});

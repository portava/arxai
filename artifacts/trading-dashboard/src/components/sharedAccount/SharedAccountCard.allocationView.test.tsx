import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, within, fireEvent, waitFor } from "@testing-library/react";
import { SharedAccountCard } from "./SharedAccountCard";

// Render-proof for the live-allocation source-of-truth fix. A normal (non
// owner/admin) shared user's ARX Allocation section must read the canonical
// allocationView (the SAME figures the live gate enforces), NOT the static
// per-account virtual_balance. This is what made the Cockpit say "$181.58
// available / all clear" while a live submit blocked USER_ALLOCATION_EXHAUSTED.

type SummaryShape = {
  ok: boolean;
  userId: number;
  accounts: Array<Record<string, unknown>>;
  masterAccess?: boolean;
  masterMt5?: unknown;
  allocationView?: {
    assignedAllocation: number;
    availableAllocation: number;
    reservedRisk: number;
    openFloatingLoss: number;
    bridgeAvailability: string;
    bridgeMessage: string;
    hasAllocation: boolean;
    isOverAllocated: boolean;
  } | null;
};

const h = vi.hoisted(() => ({
  summary: null as SummaryShape | null,
  refresh: vi.fn<() => Promise<{ok:boolean;error?:string}>>(async()=>({ok:true})),
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetMeSharedAccountSummary: () => ({
    data: h.summary,
    isLoading: false,
    isFetching: false,
    error: null,
    refetch: () => {},
  }),
  getGetMeSharedAccountSummaryQueryKey: () => ["summary"],
  useGetMeSharedAccountPositions: () => ({
    data: { rows: [], count: 0 },
    isLoading: false,
    refetch: () => {},
  }),
  getGetMeSharedAccountPositionsQueryKey: () => ["positions"],
  useGetMeSharedAccountAttributions: () => ({ data: { rows: [] }, refetch: () => {} }),
  useRefreshMeSharedAccountSnapshot: () => ({ isPending: false, mutateAsync: h.refresh }),
}));

function normalUser(over: Partial<SummaryShape["allocationView"]> = {}) {
  h.summary = {
    ok: true,
    userId: 4,
    masterAccess: false,
    masterMt5: null,
    // Static virtual_balance is intentionally the OLD, drifted figure ($181.58)
    // so the test fails if the card ever reads it for the Available stat.
    accounts: [
      { id: 1, virtualBalance: 181.58, virtualEquity: 94.85, virtualPnl: -86.73,
        realizedPnl7d: 0, openAttributions: 2, status: "active",
        masterBrokerName: "ARX", masterAccountNumberMasked: "***", accountType: "live" },
    ],
    allocationView: {
      assignedAllocation: 181.58,
      availableAllocation: 0,
      reservedRisk: 0,
      openFloatingLoss: -86.73,
      bridgeAvailability: "HEALTHY",
      bridgeMessage: "",
      hasAllocation: true,
      isOverAllocated: true,
      ...over,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.refresh.mockReset().mockResolvedValue({ok:true});
  normalUser();
});
afterEach(() => cleanup());

describe("SharedAccountCard — canonical allocationView", () => {
  it("renders Available from allocationView (0), not the static virtual_balance (181.58)", () => {
    render(<SharedAccountCard />);
    const section = screen.getByTestId("arx-allocation-section");
    const text = section.textContent ?? "";
    // Allocated reads assignedAllocation; Available reads availableAllocation.
    expect(text).toContain("Allocated");
    expect(text).toContain("Available");
    expect(text).toContain("$0.00");
    // The exhausted note explains WHY available is 0 (matches the gate copy).
    expect(screen.getByTestId("arx-allocation-exhausted-note")).toBeTruthy();
  });

  it("shows the 'no allocation assigned' note when hasAllocation is false", () => {
    normalUser({ hasAllocation: false, assignedAllocation: 0, availableAllocation: 0, isOverAllocated: false });
    render(<SharedAccountCard />);
    expect(screen.getByTestId("arx-no-allocation-note")).toBeTruthy();
    // and must NOT claim it is "exhausted" — it was never assigned
    expect(screen.queryByTestId("arx-allocation-exhausted-note")).toBeNull();
  });

  it("shows a positive Available with no warning note when headroom exists", () => {
    normalUser({ assignedAllocation: 200, availableAllocation: 190, reservedRisk: 10, openFloatingLoss: 0, isOverAllocated: false });
    render(<SharedAccountCard />);
    const text = screen.getByTestId("arx-allocation-section").textContent ?? "";
    expect(text).toContain("$190.00");
    expect(screen.queryByTestId("arx-no-allocation-note")).toBeNull();
    expect(screen.queryByTestId("arx-allocation-exhausted-note")).toBeNull();
  });
});

const masterFixture=(extra:Record<string,unknown>={})=>({mt5Balance:null,mt5Equity:null,mt5UsedMargin:null,mt5FreeMargin:null,mt5OpenPnl:null,openPositions:null,arxAllocated:200,arxAvailable:190,arxReserved:10,realizedPnl7d:0,unattributedCount:0,isOverAllocated:false,snapshotStatus:'MISSING',syncStatus:'UNAVAILABLE',accountObservationScope:'LATEST_ACCOUNT_UPDATE',amountsCoherent:false,lastMt5SnapshotAt:null,snapshotAgeMs:null,...extra});
it('unknown master monetary fields render safely without fabricated zero or null text',()=>{
 h.summary={ok:true,userId:4,masterAccess:true,accounts:[],masterMt5:masterFixture()};render(<SharedAccountCard/>);
 const section=screen.getByTestId('master-mt5-section');expect(section.textContent).not.toContain('$0.00');expect(section.textContent).not.toContain('null');expect(section.textContent).toContain('—');
});
it('recent account update is not a live coherent-funds claim',()=>{
 h.summary={ok:true,userId:4,masterAccess:true,accounts:[],masterMt5:masterFixture({mt5Balance:1000,mt5Equity:900,mt5OpenPnl:0,snapshotStatus:'FRESH',syncStatus:'LIVE',accountCurrency:'EUR',lastMt5SnapshotAt:new Date().toISOString(),snapshotAgeMs:0})};render(<SharedAccountCard/>);
 expect(screen.getByTestId('shared-account-sync-badge').textContent).toBe('Current state unverified');expect(screen.getByText(/Complete MT5 account report unavailable/)).toBeTruthy();expect(screen.queryByText('€900.00')).toBeNull();expect(screen.queryByText(/Last account update:/)).toBeNull();
});

it.each([false,true])('owner missing master does not substitute user allocation or zero (empty rows=%s)',empty=>{
 h.summary={...h.summary!,masterAccess:true,masterMt5:null,...(empty?{accounts:[],allocationView:null}:{})};
 render(<SharedAccountCard/>);
 expect(screen.getByTestId('arx-master-allocation-unavailable').textContent).toContain('Master allocation figures unavailable');
 expect(screen.queryByTestId('arx-allocation-section')).toBeNull();
 expect(screen.queryByText('$181.58')).toBeNull();expect(screen.queryByText('$0.00')).toBeNull();
 expect(screen.queryByTestId('shared-account-row-1')).toBeNull();
});
it.each([null,undefined])('missing canonical allocation %s leaves all three headroom fields unknown',allocationView=>{
 h.summary={...h.summary!,allocationView};render(<SharedAccountCard/>);
 const section=screen.getByTestId('arx-allocation-section');
 for(const label of ['Allocated','Available','Reserved']){
  const tile=within(section).getByText(label).parentElement!;
  expect(within(tile).getByText('—')).toBeTruthy();expect(tile.textContent).not.toContain('$');
 }
 expect(screen.getByTestId('shared-account-row-1').textContent).toContain('$181.58');
 expect(screen.queryByTestId('arx-allocation-exhausted-note')).toBeNull();
});
it('canonical zero is retained for allocated, available and reserved funds',()=>{
 normalUser({assignedAllocation:0,availableAllocation:0,reservedRisk:0});render(<SharedAccountCard/>);
 const section=screen.getByTestId('arx-allocation-section');
 for(const label of ['Allocated','Available','Reserved'])expect(within(within(section).getByText(label).parentElement!).getByText('$0.00')).toBeTruthy();
});
it.each(['missing','failed','exception'])('stored refresh %s never diagnoses broker connectivity',async kind=>{
 h.summary={...h.summary!,masterAccess:true,masterMt5:null};
 if(kind==='exception')h.refresh.mockRejectedValueOnce(new Error('local refresh failure'));
 else h.refresh.mockResolvedValueOnce({ok:false,error:kind==='missing'?'MASTER_BRIDGE_NOT_AVAILABLE':'REFRESH_FAILED'});
 render(<SharedAccountCard/>);fireEvent.click(screen.getByRole('button',{name:'Refresh'}));
 await waitFor(()=>expect(screen.getByTestId('shared-account-refresh-error').textContent).toMatch(/stored/i));
 expect(screen.getByTestId('shared-account-refresh-error').textContent).not.toMatch(/offline|connected|sync/i);
});

it.each([undefined,null,{status:"unavailable",amounts:null}])("native report %j cannot fall back to stored money",value=>{h.summary={ok:true,userId:4,masterAccess:true,accounts:[],masterMt5:masterFixture({mt5Balance:1000,mt5Equity:900,nativeAccountReport:value})};render(<SharedAccountCard/>);expect(screen.getByTestId("native-money-equity").textContent).toBe("—");expect(screen.queryByText("$900.00")).toBeNull();});

it('shared account native report preserves direct profit and reported precision',()=>{
 h.summary={ok:true,userId:4,masterAccess:true,accounts:[],masterMt5:masterFixture({nativeAccountReport:{status:'reported',reason:'CLOCK_AND_CONTINUITY_UNVERIFIED',currentVerified:false,observedAt:new Date(Date.now()-2000).toISOString(),receivedAt:new Date(Date.now()-1000).toISOString(),currency:'KWD',currencyDigits:3,amounts:{balance:'12.345',equity:'15.000',profit:'-0.123',credit:'3.000',margin:'0.000',freeMargin:'15.000'}}})};
 render(<SharedAccountCard/>);expect(screen.getByTestId('native-money-balance').textContent).toBe('KWD 12.345');expect(screen.getByTestId('native-money-profit').textContent).toBe('KWD -0.123');
});
it('ordinary user does not see accidentally supplied native master money',()=>{
 h.summary={...h.summary!,masterAccess:false,masterMt5:masterFixture({nativeAccountReport:{status:'reported',amounts:{balance:'999999.00'}}})};render(<SharedAccountCard/>);expect(screen.queryByTestId('native-account-report')).toBeNull();expect(screen.queryByText(/999999/)).toBeNull();
});

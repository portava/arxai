import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RubyReadStoreProvider, useRubyReadStore } from "./rubyReadStore";
import { RubyChartRead } from "./RubyChartRead";
import { resolveCappedRubyReadStatus } from "@/lib/rubyReadPanelState";
import { StrictMode } from "react";

const observed = vi.hoisted(() => ({ evidence: { symbol: "EURUSD", timeframe: "M5", source: "deriv_public", sourceIdentity: "a".repeat(64), closedWindowIdentity: "c".repeat(64), lastClosedCandleAt: "2026-01-01T00:00:00.000Z", userId: 7 } }));
vi.mock("@/hooks/useScannerTruth", () => ({ useScannerTruth: () => ({ truth: { analysis: { level: "full" } }, feedStatus: null, assessmentEvidence: observed.evidence }) }));
vi.mock("@/components/charts/FeedConfidenceBadge", () => ({ FeedConfidenceBadge: () => null }));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Eleanor" }) }));

type Draft = {side:"BUY"|"SELL";entry:number;sl:number;tp:number}|null;
const plan: Exclude<Draft,null> = {side:"BUY",entry:100,sl:99,tp:102};
const changes: [string,Draft][] = [
  ["side",{...plan,side:"SELL"}], ["entry",{...plan,entry:100.00000001}],
  ["stop",{...plan,sl:98}], ["target",{...plan,tp:104}], ["cleared",null],
];
const reply=(name:string)=>new Response(JSON.stringify({chartRead:{symbol:"EURUSD",timeframe:"M5",assessmentEvidence:{...observed.evidence},gated:false,bias:"Bullish",why:name,readLayer:"FULL",liveSetupWithheld:false,canShowLiveTradeSetup:true}}));
function deferred(){let resolve!:(r:Response)=>void;let reject!:(e:Error)=>void;const promise=new Promise<Response>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
function Summary(){const read=useRubyReadStore().get("EURUSD","M5");return <output data-testid="summary">{resolveCappedRubyReadStatus("FULL_READ",read,undefined).status}</output>;}
function panel(draft:Draft,id="primary",timeframe="M5"){return <section data-testid={id}><RubyChartRead symbol="EURUSD" timeframe={timeframe} draft={draft}/></section>;}
function tree(draft:Draft,second?:Draft){return <RubyReadStoreProvider><Summary/>{panel(draft)}{second!==undefined&&panel(second,"secondary","5m")}</RubyReadStoreProvider>;}
const ask=(id="primary")=>within(screen.getByTestId(id)).getByTestId("ruby-chart-read-ask") as HTMLButtonElement;
const bias=(id="primary")=>within(screen.getByTestId(id)).queryByTestId("ruby-chart-read-bias");
afterEach(()=>{cleanup();vi.restoreAllMocks(); observed.evidence = {symbol:"EURUSD",timeframe:"M5",source:"deriv_public",sourceIdentity:"a".repeat(64),closedWindowIdentity:"c".repeat(64),lastClosedCandleAt:"2026-01-01T00:00:00.000Z",userId:7};});

describe("assessment binding to the current trading plan",()=>{
  it("an unassessed nonnull plan cannot inherit a full shared summary",()=>{
    render(tree(plan));expect(screen.getByTestId("summary").textContent).not.toBe("FULL_READ");
  });

  it.each(["unmount","market switch"])("orphaned pending plans cannot reappear after %s",async change=>{
    const pending=deferred();let signal!:AbortSignal;
    vi.spyOn(globalThis,"fetch").mockImplementation((_url,init)=>{signal=init!.signal!;return pending.promise;});
    const content=(phase:string)=><RubyReadStoreProvider><Summary/>{phase!=="unmount"&&<RubyChartRead symbol={phase==="market switch"?"GBPUSD":"EURUSD"} timeframe="M5" draft={plan}/>}</RubyReadStoreProvider>;
    const view=render(content("initial"));fireEvent.click(screen.getByTestId("ruby-chart-read-ask"));
    view.rerender(content(change));expect(signal.aborted).toBe(true);
    await act(async()=>pending.resolve(reply("ORPHANED PLAN")));
    view.rerender(content("returned"));
    expect(screen.queryByText("ORPHANED PLAN")).toBeNull();
    expect(screen.getByTestId("summary").textContent).not.toBe("FULL_READ");
    expect((screen.getByTestId("ruby-chart-read-ask") as HTMLButtonElement).disabled).toBe(false);
  });

  it.each(["unmount","market switch"])("completed plans must be reread after %s",async change=>{
    vi.spyOn(globalThis,"fetch").mockResolvedValue(reply("FORMER PLAN"));
    const content=(phase:string)=><RubyReadStoreProvider><Summary/>{phase!=="unmount"&&<RubyChartRead symbol={phase==="market switch"?"GBPUSD":"EURUSD"} timeframe="M5" draft={plan}/>}</RubyReadStoreProvider>;
    const view=render(content("initial"));fireEvent.click(screen.getByTestId("ruby-chart-read-ask"));await screen.findByText("FORMER PLAN");
    view.rerender(content(change));view.rerender(content("returned"));
    expect(screen.queryByText("FORMER PLAN")).toBeNull();expect(screen.getByTestId("summary").textContent).not.toBe("FULL_READ");
  });

  it("unmounting one matching consumer preserves the other's pending plan",async()=>{
    const pending=deferred();let signal!:AbortSignal;
    vi.spyOn(globalThis,"fetch").mockImplementation((_url,init)=>{signal=init!.signal!;return pending.promise;});
    const content=(both:boolean)=><RubyReadStoreProvider><Summary/>{both&&<RubyChartRead key="removed" symbol="EURUSD" timeframe="M5" draft={plan}/>}<section key="kept" data-testid="kept"><RubyChartRead symbol="EURUSD" timeframe="5m" draft={{...plan}}/></section></RubyReadStoreProvider>;
    const view=render(content(true));fireEvent.click(within(screen.getByTestId("kept")).getByTestId("ruby-chart-read-ask"));
    view.rerender(content(false));expect(signal.aborted).toBe(false);
    await act(async()=>pending.resolve(reply("KEPT PLAN")));expect(screen.getByText("KEPT PLAN")).toBeTruthy();
    expect(screen.getByTestId("summary").textContent).toBe("FULL_READ");
  });

  it("StrictMode registration allows one request and clears an edited plan",async()=>{
    const fetch=vi.spyOn(globalThis,"fetch").mockResolvedValue(reply("STRICT PLAN"));
    const view=render(<StrictMode>{tree(plan)}</StrictMode>);fireEvent.click(ask());await screen.findByText("STRICT PLAN");
    expect(fetch).toHaveBeenCalledTimes(1);view.rerender(<StrictMode>{tree(changes[2][1])}</StrictMode>);
    expect(screen.queryByText("STRICT PLAN")).toBeNull();expect(screen.getByTestId("summary").textContent).not.toBe("FULL_READ");
  });
  it.each(changes)("withdraws completed plan commentary when %s changes",async(_name,next)=>{
    vi.spyOn(globalThis,"fetch").mockResolvedValue(reply("OLD PLAN ASSESSMENT"));
    const view=render(tree(plan));fireEvent.click(ask());
    await screen.findByText("OLD PLAN ASSESSMENT");
    view.rerender(tree(next));
    expect(screen.queryByText("OLD PLAN ASSESSMENT")).toBeNull();expect(bias()).toBeNull();
    expect(screen.getByTestId("summary").textContent).not.toBe("FULL_READ");
    expect(ask().disabled).toBe(false);
  });

  it.each(changes)("ignores a late old-plan response after %s changes",async(_name,next)=>{
    const old=deferred();let signal!:AbortSignal;
    const fetch=vi.spyOn(globalThis,"fetch").mockImplementation((_url,init)=>{signal=init!.signal!;return old.promise;});
    const view=render(tree(plan));fireEvent.click(ask());
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string).draft).toEqual(plan);
    view.rerender(tree(next));
    expect(signal.aborted).toBe(true);expect(ask().disabled).toBe(false);
    await act(async()=>old.resolve(reply("LATE OLD PLAN")));
    expect(screen.queryByText("LATE OLD PLAN")).toBeNull();expect(bias()).toBeNull();
    expect(screen.getByTestId("summary").textContent).not.toBe("FULL_READ");
  });

  it.each(["success","failure"])("an obsolete %s cannot replace a completed reread",async outcome=>{
    const old=deferred(); const fetch=vi.spyOn(globalThis,"fetch").mockReturnValueOnce(old.promise).mockResolvedValueOnce(reply("NEW PLAN ASSESSMENT"));
    const view=render(tree(plan));fireEvent.click(ask());view.rerender(tree(changes[2][1]));
    fireEvent.click(ask());await screen.findByText("NEW PLAN ASSESSMENT");
    expect(JSON.parse(fetch.mock.calls[1][1]!.body as string).draft).toEqual(changes[2][1]);
    await act(async()=>outcome==="success"?old.resolve(reply("OLD PLAN")):old.reject(Error("old failure")));
    expect(screen.getByText("NEW PLAN ASSESSMENT")).toBeTruthy();expect(screen.queryByTestId("ruby-chart-read-err")).toBeNull();
  });

  it("different simultaneous chart and scalp plans never share plan commentary",async()=>{
    const first=deferred(),second=deferred();vi.spyOn(globalThis,"fetch").mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(tree(plan,changes[2][1]));fireEvent.click(ask());
    expect(ask("secondary").disabled).toBe(false);
    await act(async()=>first.resolve(reply("PRIMARY PLAN")));
    expect(within(screen.getByTestId("primary")).getByText("PRIMARY PLAN")).toBeTruthy();
    expect(within(screen.getByTestId("secondary")).queryByText("PRIMARY PLAN")).toBeNull();
    expect(screen.getByTestId("summary").textContent).not.toBe("FULL_READ");
    fireEvent.click(ask("secondary"));await act(async()=>second.resolve(reply("SECONDARY PLAN")));
    expect(within(screen.getByTestId("primary")).queryByText("SECONDARY PLAN")).toBeNull();
    expect(within(screen.getByTestId("secondary")).getByText("SECONDARY PLAN")).toBeTruthy();
    expect(screen.getByTestId("summary").textContent).not.toBe("FULL_READ");
  });

  it("identical plan values and interval aliases share one pending request",async()=>{
    const pending=deferred();const fetch=vi.spyOn(globalThis,"fetch").mockReturnValue(pending.promise);
    render(tree(plan,{...plan}));fireEvent.click(ask());
    expect(ask("secondary").disabled).toBe(true);fireEvent.click(ask("secondary"));expect(fetch).toHaveBeenCalledTimes(1);
    await act(async()=>pending.resolve(reply("SHARED PLAN")));
    expect(screen.getAllByText("SHARED PLAN")).toHaveLength(2);
    expect(screen.getByTestId("summary").textContent).toBe("FULL_READ");
  });

  it("keeps a shared request for the unchanged consumer when the other changes plan",async()=>{
    const pending=deferred();let signal!:AbortSignal;vi.spyOn(globalThis,"fetch").mockImplementation((_u,init)=>{signal=init!.signal!;return pending.promise;});
    const view=render(tree(plan,{...plan}));fireEvent.click(ask());view.rerender(tree(changes[2][1],{...plan}));
    expect(signal.aborted).toBe(false);expect(ask().disabled).toBe(false);expect(ask("secondary").disabled).toBe(true);
    await act(async()=>pending.resolve(reply("UNCHANGED PLAN")));
    expect(within(screen.getByTestId("primary")).queryByText("UNCHANGED PLAN")).toBeNull();
    expect(within(screen.getByTestId("secondary")).getByText("UNCHANGED PLAN")).toBeTruthy();
  });

  it("returning to a discarded draft does not resurrect its prior assessment",async()=>{
    vi.spyOn(globalThis,"fetch").mockResolvedValue(reply("DISCARDED PLAN"));const view=render(tree(plan));
    fireEvent.click(ask());await screen.findByText("DISCARDED PLAN");view.rerender(tree(changes[2][1]));view.rerender(tree({...plan}));
    expect(screen.queryByText("DISCARDED PLAN")).toBeNull();expect(screen.getByTestId("summary").textContent).not.toBe("FULL_READ");
  });

  it.each([NaN,Infinity,-Infinity])("never serializes invalid draft geometry %s as null",async value=>{
    const fetch=vi.spyOn(globalThis,"fetch").mockResolvedValue(reply("INVALID PLAN"));render(tree({...plan,entry:value}));
    fireEvent.click(ask());await act(async()=>{});expect(fetch).not.toHaveBeenCalled();expect(bias()).toBeNull();
  });
});

for (const [field, value] of [["closedWindowIdentity", "d".repeat(64)], ["sourceIdentity", "b".repeat(64)], ["source", "mt5_broker"], ["lastClosedCandleAt", "2026-01-01T00:05:00.000Z"], ["userId", 8]] as const) {
  it(`withdraws completed assessment when observed ${field} changes`, async () => {
    vi.spyOn(globalThis,"fetch").mockResolvedValue(reply("OLD EVIDENCE"));
    const view=render(tree(plan)); fireEvent.click(ask()); await screen.findByText("OLD EVIDENCE");
    observed.evidence={...observed.evidence,[field]:value}; view.rerender(tree({...plan}));
    expect(screen.queryByText("OLD EVIDENCE")).toBeNull();
    expect(screen.getByTestId("summary").textContent).not.toBe("FULL_READ");
  });
  it(`cancels pending assessment when observed ${field} changes`, async () => {
    const old=deferred(); const oldResponse=reply("LATE EVIDENCE"); let signal!:AbortSignal;
    vi.spyOn(globalThis,"fetch").mockImplementation((_u,init)=>{signal=init!.signal!;return old.promise;});
    const view=render(tree(plan)); fireEvent.click(ask());
    observed.evidence={...observed.evidence,[field]:value}; view.rerender(tree({...plan}));
    expect(signal.aborted).toBe(true); await act(async()=>old.resolve(oldResponse));
    expect(screen.queryByText("LATE EVIDENCE")).toBeNull();
    expect(screen.getByTestId("summary").textContent).not.toBe("FULL_READ");
  });
}
it("equivalent evidence objects retain the completed assessment", async()=>{
  vi.spyOn(globalThis,"fetch").mockResolvedValue(reply("SAME EVIDENCE"));
  const view=render(tree(plan)); fireEvent.click(ask()); await screen.findByText("SAME EVIDENCE");
  observed.evidence={...observed.evidence}; view.rerender(tree({...plan}));
  expect(screen.getByText("SAME EVIDENCE")).toBeTruthy();
});

it("rejects a different server capture without pretending the read succeeded",async()=>{
  const response=JSON.parse(await reply("WRONG CAPTURE").text());
  response.chartRead.assessmentEvidence.sourceIdentity="b".repeat(64);
  vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response(JSON.stringify(response)));
  render(tree(plan)); fireEvent.click(ask()); await screen.findByTestId("ruby-chart-read-err");
  expect(screen.queryByText("WRONG CAPTURE")).toBeNull();
  expect(screen.getByTestId("summary").textContent).not.toBe("FULL_READ");
});
it("withdraws a completed assessment when observation disappears",async()=>{
  vi.spyOn(globalThis,"fetch").mockResolvedValue(reply("OBSERVED READ"));
  const view=render(tree(plan)); fireEvent.click(ask()); await screen.findByText("OBSERVED READ");
  observed.evidence=null as unknown as typeof observed.evidence; view.rerender(tree(plan));
  expect(screen.queryByText("OBSERVED READ")).toBeNull();
  expect(screen.getByTestId("summary").textContent).not.toBe("FULL_READ");
});

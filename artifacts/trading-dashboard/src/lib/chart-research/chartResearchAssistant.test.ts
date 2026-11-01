import { describe, expect, it, vi } from "vitest";
import { answerChartResearchFollowup, registerChartResearchAssistant, requestChartResearch } from "./chartResearchAssistant";
describe("selected historical trade follow-ups",()=>{
  it.each(["Why did this trade lose?", "Please why did the selected simulated trade lose money?", "Please explain the last test trade!"])("routes %s locally without a new calculation",text=>{
    const handler=vi.fn(value=>answerChartResearchFollowup(value,{status:"ready",netPriceUnits:-2,text:"Frozen result abc: gross 1 minus modeled costs 3 gives net -2 price units."})!);
    const release=registerChartResearchAssistant(handler);
    try { expect(requestChartResearch(text)).toContain("Frozen result abc");expect(handler).toHaveBeenCalledOnce(); } finally { release(); }
  });
  it.each([[-1,"lost source price units"],[0,"net result is zero"],[2,"net result is positive"]])("does not assume a loss when recorded net is %s",(net,phrase)=>{
    const reply=answerChartResearchFollowup("Why did this trade lose?",{status:"ready",netPriceUnits:Number(net),text:"Exact selected ledger receipt."});
    expect(reply).toContain(phrase);expect(reply).toContain("Exact selected ledger receipt.");
  });
  it("refuses nonfinite results and absent selection without inventing outcomes",()=>{
    expect(answerChartResearchFollowup("Why did this trade lose?",{status:"ready",netPriceUnits:NaN,text:"unusable"})).toContain("no finite net result");
    expect(answerChartResearchFollowup("Why did this trade lose?",null)).toContain("No current selected historical result");
    expect(answerChartResearchFollowup("Why did this trade lose?",{status:"no_selection",reason:"Select one exact frozen trade."})).toBe("Select one exact frozen trade.");
  });
  it.each(["Why did this trade lose? Place another order", "explain the last test trade and buy"])("holds compound request %s locally",text=>{
    const release=registerChartResearchAssistant(value=>answerChartResearchFollowup(value,{status:"ready",netPriceUnits:-1,text:"must not disclose this receipt"})!);
    try { expect(requestChartResearch(text)).toContain("Additional actions or ambiguous trade references were not applied"); } finally { release(); }
    expect(requestChartResearch("Why did this trade lose?")).toContain("No other pane was substituted");
    expect(requestChartResearch("What is the weather?")).toBeNull();
  });
});
it('compares only the supplied frozen cash result and refuses missing or compound benchmark requests',()=>{
 const evidence={status:'no_selection' as const,reason:'Select a trade',benchmark:{text:'Frozen scenario: strategy101 vs same-quantity benchmark102; no new run.'}};
 expect(answerChartResearchFollowup('Compare this with buy-and-hold',evidence)).toBe(evidence.benchmark.text);expect(answerChartResearchFollowup('Compare this with buy-and-hold',null)).toContain('No source-bound');expect(answerChartResearchFollowup('Compare this with buy-and-hold and buy now',evidence)).toContain('not applied');
});

import {it,expect,vi,afterEach} from "vitest";
import {render,screen,fireEvent,waitFor,cleanup} from "@testing-library/react";
import InvestorResearch from "./investor-research";
import {readResearchCsv} from "@/lib/researchCsv";
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it("research starts without fabricated data and exposes all seven workspaces",()=>{
 render(<InvestorResearch/>);expect(screen.getByTestId("research-authority").textContent).toContain("No measured prediction");
 expect(screen.getByRole("button",{name:"Read SEC filings"}).hasAttribute("disabled")).toBe(true);
 for(const name of ["Portfolio plan","Basket check","Reported holdings","Congress disclosures","Cost basis","Price alerts"])expect(screen.getByRole("button",{name})).toBeTruthy();
 expect(screen.queryByRole("region",{name:"Research result"})).toBeNull();
});
it("SEC configuration failures remain visibly unavailable",async()=>{
 vi.stubGlobal("fetch",vi.fn(async()=>Response.json({status:"NOT_CONFIGURED",note:"SEC contact identity is not configured",fundamentals:null,filings:[]})));
 render(<InvestorResearch/>);fireEvent.change(screen.getByLabelText("SEC CIK"),{target:{value:"1"}});fireEvent.click(screen.getByRole("button",{name:"Read SEC filings"}));
 await waitFor(()=>expect(screen.getByText(/SEC contact identity/)).toBeTruthy());expect(screen.getByText("NOT_CONFIGURED")).toBeTruthy();
});
it("late research responses cannot overwrite a changed CIK",async()=>{
 let release!:(value:Response)=>void;vi.stubGlobal("fetch",vi.fn(()=>new Promise<Response>(r=>release=r)));
 render(<InvestorResearch/>);fireEvent.change(screen.getByLabelText("SEC CIK"),{target:{value:"1"}});fireEvent.click(screen.getByRole("button",{name:"Read SEC filings"}));
 fireEvent.change(screen.getByLabelText("SEC CIK"),{target:{value:"2"}});release(Response.json({name:"OLD COMPANY",status:"AVAILABLE"}));
 await new Promise(r=>setTimeout(r,0));expect(screen.queryByText("OLD COMPANY")).toBeNull();
});
it("CSV supports quoted cells but refuses missing columns and duplicate headers",()=>{
 expect(readResearchCsv('symbol,value\n"AAPL",10\n')).toEqual([{symbol:"AAPL",value:"10"}]);
 expect(readResearchCsv('name,value\n"A, B",10')).toEqual([{name:"A, B",value:"10"}]);
 expect(()=>readResearchCsv('symbol,value\nAAPL')).toThrow();expect(()=>readResearchCsv('symbol,symbol\nAAPL,AAPL')).toThrow();
});

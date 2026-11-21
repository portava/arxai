import { Router } from "express";
import { requireUser } from "../lib/auth/middleware.js";
import { z } from "zod";
import { previewPortfolio, checkResearchBasket, screenCompanies, previewLots, analyzeDisclosures, analyzeHoldingsDisclosure, previewPriceAlerts } from "@workspace/domain/investor-research";
import { stockStyleSymbol } from "../lib/assistant/providerSymbolMapping.js";
import { getSecResearch } from "../lib/research/secResearch.js";

const router=Router();
// Stateless research: no order routes, account mutation, shared private state or DB writes.
router.get("/research/sec/:cik",requireUser,async(req,res)=>{
  const cik=z.string().regex(/^\d{1,10}$/).safeParse(req.params.cik);
  if(!cik.success){res.status(400).json({error:"INVALID_CIK"});return;}
  res.json(await getSecResearch(cik.data));
});
const actions={portfolio:previewPortfolio,basket:checkResearchBasket,screen:screenCompanies,lots:previewLots,disclosures:analyzeDisclosures,holdings:analyzeHoldingsDisclosure,alerts:previewPriceAlerts};
for(const [name,calculate] of Object.entries(actions))router.post(`/research/${name}`,requireUser,(req,res)=>{
  try{
    const symbols: string[] = [];
    for (const key of ["holdings", "targets", "orders", "companies", "lots", "rows", "observations", "rules"]) {
      if (Array.isArray(req.body?.[key])) for (const row of req.body[key]) if (typeof row?.symbol === "string") symbols.push(row.symbol);
    }
    if (typeof req.body?.symbol === "string") symbols.push(req.body.symbol);
    if (symbols.some(symbol => !stockStyleSymbol(symbol))) throw new Error("Stock research does not support this FX, synthetic or non-stock symbol");
    res.json(calculate(req.body));
  }
  catch(error){res.status(400).json({error:"INVALID_RESEARCH_INPUT",message:error instanceof z.ZodError?error.issues.map(i=>i.message).join("; "):error instanceof Error?error.message:"Invalid research input"});}
});
export default router;

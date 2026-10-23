// FX / Indices / Synthetic intelligence endpoints.
//
// FEATURE TRUTH AUDIT (P0-4) — these three routes previously served fabricated
// market data, UNLABELED, to auto-refreshing pages. `getForexIntelligence`,
// `getIndicesIntelligence` and `getSyntheticAnalysis` invented VIX, bond
// yields, index levels, currency strengths, a coin-flip risk regime, per-index
// confidence and synthetic ATR readings, and this router passed them straight
// through with no honesty marker of any kind.
//
// They now return an honest not-connected payload (`providerConnected: false`
// + `safetyNote` + empty arrays). The handlers stay thin on purpose: the
// honesty contract lives in the modules, is covered by
// `scripts/src/intelligenceHonestyTest.ts`, and there is nothing here to
// re-decorate.
//
// If a real provider is ever wired, it must set `providerConnected: true` and
// populate the arrays with measured values — never estimates.

import { Router } from "express";
import { getForexIntelligence } from "../lib/forexIntelligence.js";
import { getIndicesIntelligence, getSyntheticAnalysis } from "../lib/indicesIntelligence.js";

const router = Router();

router.get("/forex/intelligence", (_req, res) => {
  res.json(getForexIntelligence());
});

router.get("/indices/intelligence", (_req, res) => {
  res.json(getIndicesIntelligence());
});

router.get("/synthetic/analysis", (_req, res) => {
  res.json(getSyntheticAnalysis());
});

export default router;

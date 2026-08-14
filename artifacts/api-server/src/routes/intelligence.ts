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

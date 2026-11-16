// GET /api/me/broker-clock — the signed-in trader's own bridge broker clock
// offset (see lib/brokerHub/brokerClockView.ts). Read-only, no gate.
import { Router } from "express";
import { requireUser } from "../lib/auth/middleware.js";
import { createBrokerClockHandler } from "../lib/brokerHub/brokerClockView.js";

const router = Router();
router.get("/me/broker-clock", requireUser, createBrokerClockHandler());
export default router;

import { Router, type Request } from "express";
import { bridgeAuthPerUserOnly } from "./mt5.js";
import { ingestMt5Calendar, getMt5CalendarClockEvidence } from "../lib/news/calendar/mt5CalendarProvider.js";
import { parseMt5CalendarSnapshot } from "../lib/news/calendar/mt5CalendarWire.js";
const router = Router();
// Existing auth resolves the immutable registered connection, never payload identity.
router.post("/mt5/calendar/ingest", bridgeAuthPerUserOnly, (req, res) => {
  const connection = (req as Request & { mt5Connection?: { id: string | number; accountNumber?: string | null; serverName?: string | null } }).mt5Connection;
  if (!connection) { res.status(401).json({error:"Authenticated MT5 connection required"}); return; }
  try {
    const payload = parseMt5CalendarSnapshot(req.body);
    if ((connection.accountNumber && connection.accountNumber !== payload.account)
      || (connection.serverName && connection.serverName !== payload.server)) {
      res.status(400).json({error:"Calendar identity differs from authenticated MT5 connection"}); return;
    }
    const result = ingestMt5Calendar(String(connection.id),payload);
    res.status(200).json({...result, clockEvidence:getMt5CalendarClockEvidence()}); // accepted=false records a genuine provider failure
  } catch (err) {
    // Contract errors are bounded strings; payload/headers/tokens never logged.
    res.status(400).json({error:err instanceof Error ? err.message : "Invalid MT5 calendar snapshot"});
  }
});
export default router;

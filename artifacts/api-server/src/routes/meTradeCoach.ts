// Phase 25 — Per-trade AI Q&A endpoint.
//
// SAFETY:
//   * requireUser; per-user scoped (trade fetched WHERE userId = req.authUser.id).
//   * Read-only. Never opens, modifies, or closes trades.
//   * Strict honesty prompt: AI must say what is missing rather than fabricate.
//   * No order-execution tools attached. Pure text generation grounded in the
//     user's own trade row + snapshot. Same paper_only / liveLocked envelope.
//   * No raw secrets, no other users' data, no bridge state spoofing.

import { Router, type IRouter, type Request } from "express";
import { z } from "zod/v4";
import { db, tradesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { openai } from "@workspace/integrations-openai-ai-server";

const router: IRouter = Router();

const SAFETY = {
  safetyMode: "paper_only" as const,
  liveLocked: true as const,
  readOnlyMode: true as const,
  allowOrderExecution: false as const,
};

const AskSchema = z.object({
  tradeId: z.number().int().positive(),
  question: z.string().min(1).max(500),
});

const SYSTEM_PROMPT = `You are ARX AI's per-trade coach. Rules:
- ANSWER ONLY about the single trade you are given context for.
- READ-ONLY. You cannot open, close, modify, or queue any order. If asked to do so, refuse and say the user must use the trade card buttons.
- HONESTY: If candles, news, scanner data, or live price is missing from the context, SAY SO explicitly. Never fabricate a price, level, news headline, or confidence number.
- Do not claim certainty about future direction. Use language like "may", "could", "tends to" — never "will".
- If asked "should I close?" / "where should TP go?" / "should I move SL?", give a reasoned suggestion grounded in the provided trade fields (entry, current price, SL, TP, R-multiple, floating P&L) and clearly mark it as a SUGGESTION not an instruction.
- Keep replies under 180 words. No emojis. No markdown headers.
- End with one short "Safety:" sentence reminding the user that execution remains paper-only and any change must be confirmed by them.`;

router.post("/me/trade-coach/ask", async (req, res): Promise<void> => {
  const userId = (req as Request & { authUser?: { id?: number } }).authUser?.id ?? 0;
  if (!userId) {
    res.status(401).json({ ok: false, error: "unauthorized", ...SAFETY });
    return;
  }
  const parsed = AskSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "invalid_body", details: parsed.error.issues, ...SAFETY });
    return;
  }
  const { tradeId, question } = parsed.data;

  // Per-user scoped fetch. Cannot read another user's trade.
  const rows = await db.select().from(tradesTable)
    .where(and(eq(tradesTable.id, tradeId), eq(tradesTable.userId, userId)))
    .limit(1);
  const trade = rows[0];
  if (!trade) {
    res.status(404).json({ ok: false, error: "trade_not_found", ...SAFETY });
    return;
  }

  const tradeContext = [
    `tradeId=${trade.id}`,
    `symbol=${trade.symbol}`,
    `direction=${trade.direction}`,
    `mode=${trade.mode}`,
    `strategy=${trade.strategy ?? "n/a"}`,
    `confidence=${trade.confidence ?? "n/a"}`,
    `entry=${trade.entryPrice}`,
    `stopLoss=${trade.stopLoss}`,
    `takeProfit=${trade.takeProfit}`,
    `lot=${trade.lot}`,
    `status=${trade.status}`,
    `floatingPnl=${trade.pnl ?? "n/a"}`,
  ].join(" ");

  let answer = "Sorry, the trade coach could not generate an answer right now.";
  let aiOk = false;
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
      max_tokens: 350,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "system", content: `Trade context: ${tradeContext}\nNote: live candles / news may be unavailable; if so, say so honestly.` },
        { role: "user", content: question },
      ],
    });
    const text = completion.choices?.[0]?.message?.content?.trim();
    if (text && text.length > 0) {
      answer = text;
      aiOk = true;
    }
  } catch (e) {
    req.log?.error?.({ err: (e as Error).message, userId, tradeId }, "trade-coach AI call failed");
  }

  // Lightweight audit log — full assistant tool-call audit lives in
  // arx_assistant_tool_calls; here we just emit a structured server log
  // entry tagged with userId+tradeId for traceability.
  req.log?.info?.(
    { userId, tradeId, action: "trade_coach_ask", aiOk, qLen: question.length },
    "trade-coach question answered",
  );

  res.status(200).json({
    ok: true,
    tradeId,
    question,
    answer,
    aiOk,
    ...SAFETY,
  });
});

export default router;

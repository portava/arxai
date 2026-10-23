// Chart Brain v2 — Task 6: per-user chart annotations (SLOW BRAIN, read-only wrt
// trading). Marked support/resistance levels, watch zones, and user-defined
// price alerts created from the chart command menu.
//
// Strictly per-user: every read/write is scoped by userId. Nothing here places,
// modifies, or closes a trade. Annotations are SOFT-deleted (status="dismissed")
// — there is no hard-delete path from the API. Price alerts are evaluated
// (read-only) by the AI-alert scan and fire through the notification system; they
// NEVER execute a trade.

import { db, chartAnnotationsTable } from "@workspace/db";
import type { ChartAnnotation } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { logger } from "../logger.js";

export type AnnotationKind = "SUPPORT" | "RESISTANCE" | "WATCH_ZONE" | "PRICE_ALERT";
export type AnnotationDirection = "above" | "below";
export type AnnotationStatus = "active" | "triggered" | "dismissed";

export interface CreateAnnotationInput {
  userId: number;
  symbol: string;
  displaySymbol?: string | null;
  timeframe?: string;
  kind: AnnotationKind;
  direction?: AnnotationDirection | null;
  price: number;
  priceTo?: number | null;
  note?: string | null;
  expiresAt?: Date | null;
}

/** Public-safe DTO — never leaks another user's identity beyond the owner. */
export interface AnnotationDTO {
  id: number;
  symbol: string;
  displaySymbol: string | null;
  timeframe: string;
  kind: AnnotationKind;
  direction: AnnotationDirection | null;
  price: number;
  priceTo: number | null;
  note: string | null;
  status: AnnotationStatus;
  lastTriggeredAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export function toAnnotationDTO(row: ChartAnnotation): AnnotationDTO {
  return {
    id: row.id,
    symbol: row.symbol,
    displaySymbol: row.displaySymbol,
    timeframe: row.timeframe,
    kind: row.kind as AnnotationKind,
    direction: (row.direction as AnnotationDirection | null) ?? null,
    price: row.price,
    priceTo: row.priceTo,
    note: row.note,
    status: row.status as AnnotationStatus,
    lastTriggeredAt: row.lastTriggeredAt ? row.lastTriggeredAt.toISOString() : null,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Create one annotation. Fails open (returns null) on a storage error. */
export async function createAnnotation(
  input: CreateAnnotationInput,
): Promise<ChartAnnotation | null> {
  try {
    const rows = await db
      .insert(chartAnnotationsTable)
      .values({
        userId: input.userId,
        symbol: input.symbol,
        displaySymbol: input.displaySymbol ?? null,
        timeframe: input.timeframe ?? "M5",
        kind: input.kind,
        direction: input.direction ?? null,
        price: input.price,
        priceTo: input.priceTo ?? null,
        note: input.note ?? null,
        status: "active",
        expiresAt: input.expiresAt ?? null,
      })
      .returning();
    return rows[0] ?? null;
  } catch (err) {
    logger.warn({ err, userId: input.userId }, "createAnnotation failed");
    return null;
  }
}

/** List a user's annotations. Per-user scoped; excludes dismissed by default. */
export async function listAnnotations(
  userId: number,
  opts?: { symbol?: string; includeDismissed?: boolean },
): Promise<ChartAnnotation[]> {
  try {
    const where = [eq(chartAnnotationsTable.userId, userId)];
    if (opts?.symbol) where.push(eq(chartAnnotationsTable.symbol, opts.symbol));
    const rows = await db
      .select()
      .from(chartAnnotationsTable)
      .where(and(...where))
      .orderBy(desc(chartAnnotationsTable.createdAt))
      .limit(500);
    return opts?.includeDismissed
      ? rows
      : rows.filter((r) => r.status !== "dismissed");
  } catch (err) {
    logger.warn({ err, userId }, "listAnnotations failed");
    return [];
  }
}

/**
 * Soft-delete (dismiss) one annotation. Per-user scoped — only the owner can
 * dismiss their own row. Returns true when a row was dismissed.
 */
export async function dismissAnnotation(userId: number, id: number): Promise<boolean> {
  try {
    const u = await db
      .update(chartAnnotationsTable)
      .set({ status: "dismissed", updatedAt: new Date() })
      .where(
        and(
          eq(chartAnnotationsTable.userId, userId),
          eq(chartAnnotationsTable.id, id),
        ),
      )
      .returning();
    return u.length > 0;
  } catch (err) {
    logger.warn({ err, userId, id }, "dismissAnnotation failed");
    return false;
  }
}

/** Active price-alert annotations for a user+symbol (used by the AI-alert scan). */
export async function listActivePriceAlerts(
  userId: number,
  symbol: string,
): Promise<ChartAnnotation[]> {
  try {
    const rows = await db
      .select()
      .from(chartAnnotationsTable)
      .where(
        and(
          eq(chartAnnotationsTable.userId, userId),
          eq(chartAnnotationsTable.symbol, symbol),
          eq(chartAnnotationsTable.kind, "PRICE_ALERT"),
          eq(chartAnnotationsTable.status, "active"),
        ),
      )
      .limit(100);
    return rows;
  } catch (err) {
    logger.warn({ err, userId, symbol }, "listActivePriceAlerts failed");
    return [];
  }
}

/** Mark a price alert as triggered (per-user scoped). */
export async function markAnnotationTriggered(
  userId: number,
  id: number,
): Promise<void> {
  try {
    await db
      .update(chartAnnotationsTable)
      .set({ status: "triggered", lastTriggeredAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(chartAnnotationsTable.userId, userId),
          eq(chartAnnotationsTable.id, id),
        ),
      );
  } catch (err) {
    logger.warn({ err, userId, id }, "markAnnotationTriggered failed");
  }
}

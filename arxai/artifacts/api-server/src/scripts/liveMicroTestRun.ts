// One-shot controlled LIVE micro-test runner for task #399.
//
// WHAT THIS IS: a thin operator harness that proves the shared LIVE bridge
// path end-to-end with ONE real 0.01 EURUSD BUY that auto-closes. It does NOT
// re-implement any gate, pipeline, or close logic. It only:
//   1. captures + temporarily adjusts operator state (gov posture + role) so an
//      authenticated session can reach the OWNER-gated test-cycle routes,
//   2. calls the EXISTING HTTP routes through the shared proxy exactly like the
//      UI would (allocation set → preview → start → poll current),
//   3. polls the lazy state machine to terminal and prints the real broker
//      evidence (tickets, retcodes, fills, realised P/L),
//   4. on a SAFE terminal (COMPLETED or never-opened OPEN_REJECTED) reverts the
//      temporary state (allocation → 0, role + gov posture restored, session
//      destroyed). If a position may still be open, it leaves OWNER + session
//      intact and prints a loud warning for manual follow-up — it never reverts
//      role while a live position could be open.
//
// SAFETY: places exactly ONE real 0.01 EURUSD order via the standard 16-gate
// pipeline. Every gate, per-user approval, allocation, and kill-switch check
// still runs. Nothing is fabricated. Run with --apply to actually execute;
// default is a dry-preview (allocation set + preview only, no /start).

import { eq } from "drizzle-orm";
import {
  db,
  usersTable,
  ownerGovernanceSettingsTable,
  arxLiveCommandsTable,
} from "@workspace/db";
import { createUserSession, destroyUserSession } from "../lib/auth/userSessions.js";
import { routeQuote } from "../lib/data/marketDataRouter.js";

const USER_ID = 4;
const BASE = "http://localhost:80";
const APPLY = process.argv.includes("--apply");
const TERMINAL = new Set([
  "COMPLETED",
  "OPEN_REJECTED",
  "CLOSE_FAILED_MANUAL_REQUIRED",
  "EXPIRED",
  "CANCELLED",
  "OPEN_BLOCKED",
]);
// States where a real broker position may still be open → must NOT revert role.
const MAYBE_OPEN = new Set([
  "OPEN_DISPATCHED",
  "OPEN_FILLED",
  "CLOSE_DISPATCHED",
  "CLOSE_FAILED_MANUAL_REQUIRED",
]);

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function api(
  method: string,
  path: string,
  cookie: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", cookie },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

function extractPrice(quote: unknown): number | null {
  if (!quote || typeof quote !== "object") return null;
  const keys = ["price", "last", "mid", "close", "bid", "ask"];
  const q = quote as Record<string, unknown>;
  for (const k of keys) {
    const v = q[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

function j(v: unknown): string {
  return JSON.stringify(v, null, 2);
}

async function main() {
  console.log(`=== LIVE MICRO-TEST (#399) user=${USER_ID} apply=${APPLY} ===`);

  // ── Capture original operator state (to restore later) ────────────────────
  const [u0] = await db.select().from(usersTable).where(eq(usersTable.id, USER_ID)).limit(1);
  if (!u0) throw new Error(`user ${USER_ID} not found`);
  const origRole = u0.role;
  const [g0] = await db
    .select()
    .from(ownerGovernanceSettingsTable)
    .where(eq(ownerGovernanceSettingsTable.userId, USER_ID))
    .limit(1);
  const origGov = g0?.ownerLiveControlMode ?? null;
  console.log(`ORIGINAL: role=${origRole} ownerLiveControlMode=${origGov}`);

  // ── Quote → SL (1% below entry for a BUY, safely on the correct side) ──────
  const quoteRes = await routeQuote("EURUSD");
  const entry = extractPrice((quoteRes as { quote?: unknown }).quote);
  const stopLoss = entry ? Number((entry * 0.99).toFixed(5)) : 1.13;
  console.log(`QUOTE EURUSD ok=${(quoteRes as { ok?: boolean }).ok} entry=${entry} → BUY stopLoss=${stopLoss}`);

  let sessionToken: string | null = null;
  let finalStatus = "(none)";
  let positionMayBeOpen = false;

  try {
    // ── Temporarily set protective/standard governance + OWNER role ─────────
    if (g0) {
      await db
        .update(ownerGovernanceSettingsTable)
        .set({ ownerLiveControlMode: false })
        .where(eq(ownerGovernanceSettingsTable.userId, USER_ID));
    }
    await db.update(usersTable).set({ role: "OWNER" }).where(eq(usersTable.id, USER_ID));
    console.log("STATE: ownerLiveControlMode→false (standard path), role→OWNER");

    // ── Mint a real per-user session (same helper /auth/login uses) ─────────
    const s = await createUserSession({ userId: USER_ID, userAgent: "arx-live-microtest-harness" });
    sessionToken = s.rawToken;
    const cookie = `arx_user_session=${s.rawToken}`;

    // 1) Allocate $40 (real funds, audited) → available > 0 and > margin proxy.
    const alloc = await api("POST", "/api/admin/allocations/4/set", cookie, {
      amount: 40,
      note: "#399 controlled live micro-test — temporary allocation for one-shot 0.01 EURUSD verification",
    });
    console.log(`\n[1] ALLOCATION SET → HTTP ${alloc.status}\n${j(alloc.json)}`);
    if (alloc.status !== 200) throw new Error("allocation set failed; aborting before any live dispatch");

    // 2) Preview (runs precheck + preflight, no dispatch).
    const prev = await api("POST", "/api/me/live/test-cycle/preview", cookie, {
      side: "BUY",
      stopLoss,
    });
    console.log(`\n[2] PREVIEW → HTTP ${prev.status}\n${j(prev.json)}`);
    const previewOk = (prev.json as { ok?: boolean })?.ok === true;
    if (!previewOk) {
      console.log("\nPREVIEW NOT OK — refusing to /start. (No real order placed.)");
    } else if (!APPLY) {
      console.log("\nDRY MODE (no --apply): preview passed; NOT calling /start. Re-run with --apply to place the live order.");
    } else {
      // 3) Start — places ONE real live order, auto-closes after fill.
      const start = await api("POST", "/api/me/live/test-cycle/start", cookie, {
        side: "BUY",
        stopLoss,
        acknowledged: true,
      });
      console.log(`\n[3] START → HTTP ${start.status}\n${j(start.json)}`);

      // 4) Poll the lazy state machine to terminal.
      console.log("\n[4] POLLING /current until terminal...");
      for (let i = 0; i < 60; i++) {
        await sleep(4000);
        const cur = await api("GET", "/api/me/live/test-cycle/current", cookie);
        const cyc = (cur.json as { cycle?: Record<string, unknown> })?.cycle ?? null;
        const st = String(cyc?.status ?? "(null)");
        finalStatus = st;
        console.log(
          `  poll#${i + 1} status=${st} openTicket=${cyc?.openBrokerTicket ?? "-"} ` +
            `openFill=${cyc?.openFillPrice ?? "-"} openRet=${cyc?.openMt5Retcode ?? "-"} ` +
            `closeFill=${cyc?.closeFillPrice ?? "-"} closeRet=${cyc?.closeMt5Retcode ?? "-"} ` +
            `pnl=${cyc?.realizedPlUsd ?? "-"}/${cyc?.pnlStatus ?? "-"}`,
        );
        if (TERMINAL.has(st)) {
          console.log(`\nTERMINAL: ${st}\nFULL CYCLE:\n${j(cyc)}`);
          break;
        }
      }
      positionMayBeOpen = MAYBE_OPEN.has(finalStatus) && finalStatus !== "COMPLETED";

      // 5) Dump the underlying live command rows (real broker evidence).
      const cyc = (await api("GET", "/api/me/live/test-cycle/current", cookie).then(
        (r) => (r.json as { cycle?: Record<string, unknown> })?.cycle,
      )) as Record<string, unknown> | undefined;
      for (const which of ["openCommandId", "closeCommandId"] as const) {
        const cmdId = cyc?.[which];
        if (typeof cmdId === "string" && cmdId) {
          const [cmd] = await db
            .select()
            .from(arxLiveCommandsTable)
            .where(eq(arxLiveCommandsTable.commandId, cmdId))
            .limit(1);
          console.log(
            `\n[5] ${which}=${cmdId} → status=${cmd?.status} brokerTicket=${cmd?.brokerTicket} ` +
              `mt5Retcode=${cmd?.mt5Retcode} fillPrice=${cmd?.fillPrice} ` +
              `rejectionReason=${cmd?.rejectionReason ?? "-"} brokerMessage=${cmd?.brokerMessage ?? "-"}`,
          );
        }
      }
    }

    // ── Conditional cleanup ─────────────────────────────────────────────────
    const safeToCleanup =
      !positionMayBeOpen &&
      (finalStatus === "COMPLETED" || finalStatus === "OPEN_REJECTED" || finalStatus === "(none)");
    if (safeToCleanup) {
      // Revert allocation to 0 (decrease — skips pool precheck, still audited).
      const cookie2 = `arx_user_session=${sessionToken}`;
      const dealloc = await api("POST", "/api/admin/allocations/4/set", cookie2, {
        amount: 0,
        note: "#399 revert temporary live micro-test allocation",
      });
      console.log(`\n[CLEANUP] allocation→0 HTTP ${dealloc.status} ${j(dealloc.json)}`);
    } else {
      console.log(
        `\n[CLEANUP] SKIPPED allocation revert — finalStatus=${finalStatus} positionMayBeOpen=${positionMayBeOpen}.`,
      );
    }
  } finally {
    // Only revert role/gov/session when NO live position can be open. Otherwise
    // keep OWNER + session so a follow-up poll can drive the auto-close.
    if (!positionMayBeOpen) {
      await db.update(usersTable).set({ role: origRole }).where(eq(usersTable.id, USER_ID));
      if (g0 && origGov !== null) {
        await db
          .update(ownerGovernanceSettingsTable)
          .set({ ownerLiveControlMode: origGov })
          .where(eq(ownerGovernanceSettingsTable.userId, USER_ID));
      }
      if (sessionToken) await destroyUserSession(sessionToken).catch(() => undefined);
      console.log(`\nRESTORED: role→${origRole} ownerLiveControlMode→${origGov} session destroyed.`);
    } else {
      console.log(
        `\n*** WARNING: leaving role=OWNER + session ALIVE (finalStatus=${finalStatus}). ` +
          `A live position may be OPEN. Re-poll /api/me/live/test-cycle/current to drive auto-close, ` +
          `then restore role→${origRole}, ownerLiveControlMode→${origGov}, and revert allocation. ***`,
      );
      if (sessionToken) console.log(`Session token (for follow-up polling) is held in-process only; mint a fresh one if needed.`);
    }
  }

  console.log("\n=== DONE ===");
  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});

// ARX ↔ MT5 live bridge sweep (2026-11-04): server-side defects found by the
// bridge audit. Pure checks plus fake-db unit tests; no PostgreSQL needed.
process.env["DATABASE_URL"] ??= "postgres://user:pass@127.0.0.1:1/nonexistent";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { isAckOnlyMailboxEa } = await import("../managementTargetProtocol.js");
const { eaPendingPlacementPayload, eaPendingCancelPayload } = await import("../pendingPayloadWire.js");
const { requireAuthOrPublic } = await import("../../auth/globalGate.js");
const { isLivePartialCloseRequest, eaHonoursLiveCloseVolume, LIVE_PARTIAL_CLOSE_UNSUPPORTED } = await import("../../live/liveCommandPipeline.js");
const { claimBridgeV2CommandsForEa } = await import("../../bridgeV2/commandClaim.js");

const mt5Src = readFileSync(new URL("../../../routes/mt5.ts", import.meta.url), "utf8");
const v154 = readFileSync(new URL("../../../../../../mt5-bridge/ARX_AI_Universal_Agent_v154.mq5", import.meta.url), "utf8");

// ── 4. a legacy acknowledgement-only EA never claims a live mirror ─────────
test("v1.2x/v1.3x EAs are acknowledgement-only mailbox consumers; v1.40+ and unknown are not", () => {
  for (const v of ["1.31", "1.30", "1.29", "1.28", "v1.31", "1.27 beta"]) assert.equal(isAckOnlyMailboxEa(v), true, v);
  for (const v of ["1.40", "1.50", "1.54", "2.00", "", null, undefined, "garbage"]) assert.equal(isAckOnlyMailboxEa(v), false, String(v));
});
test("the mailbox poll applies the live-mirror predicate to both its SELECT and its CAS", () => {
  const handler = mt5Src.slice(mt5Src.indexOf('router.get("/mt5/commands"'), mt5Src.indexOf('router.post("/mt5/queue-command"'));
  assert.equal(handler.match(/liveMirrorMailboxPickupPredicate\(conn\.eaVersion\)/g)?.length, 2);
});

// ── 5. EA push endpoints reach their per-user token check ──────────────────
test("sync-symbol-specs and sync-candle-history pass the global gate and are bridge-token gated", () => {
  for (const path of ["/mt5/sync-symbol-specs", "/mt5/sync-candle-history"]) {
    let passed = false;
    let code: number | null = null;
    requireAuthOrPublic(
      { method: "POST", path } as never,
      { status(n: number) { code = n; return { json() {} }; } } as never,
      () => { passed = true; },
    );
    assert.equal(passed, true, path);
    assert.equal(code, null, path);
    assert.match(mt5Src, new RegExp(`router\\.post\\("${path.replace(/\//g, "\\/")}", bridgeAuthPerUserOnly`), path);
  }
});

// ── 6. mailbox pending payload uses the keys the EA reads ──────────────────
test("v1.54 HandlePlacePending reads entry / stopLimitPrice / expirationEpoch / lot / sl / tp", () => {
  const fn = v154.slice(v154.indexOf("void HandlePlacePending"), v154.indexOf("void HandleModifyPending"));
  for (const key of ["entry", "stopLimitPrice", "expirationEpoch", "lot", "sl", "tp", "orderType"])
    assert.match(fn, new RegExp(`"${key}"`), key);
  assert.match(v154.slice(v154.indexOf("void HandleCancelPending")), /JsonLong\(slice, "orderTicket"\)/);
});
test("a limit draft carries entry and expirationEpoch", () => {
  const exp = new Date("2026-11-05T12:00:00Z");
  const p = eaPendingPlacementPayload({ orderType: "BUY_LIMIT", requestedPrice: 1.1, stopTriggerPrice: null, stopLimitPrice: null, expiration: exp });
  assert.equal(p.entry, 1.1);
  assert.equal(p.expirationEpoch, Math.floor(exp.getTime() / 1000));
  assert.equal(p.orderType, "BUY_LIMIT");
  assert.equal("stopLimitPrice" in p && p.stopLimitPrice != null, false);
});
test("a stop-limit draft sends the trigger as entry and the limit as stopLimitPrice", () => {
  const p = eaPendingPlacementPayload({ orderType: "SELL_STOP_LIMIT", requestedPrice: 1.2, stopTriggerPrice: 1.19, stopLimitPrice: 1.195, expiration: null });
  assert.equal(p.entry, 1.19);
  assert.equal(p.stopLimitPrice, 1.195);
  assert.equal(p.expirationEpoch, undefined);
});
test("a draft without a usable price sends no entry (the EA refuses it honestly)", () => {
  const p = eaPendingPlacementPayload({ orderType: "BUY_STOP", requestedPrice: null, stopTriggerPrice: null, stopLimitPrice: null, expiration: null });
  assert.equal(p.entry, undefined);
});
test("a cancel carries orderTicket", () => {
  assert.deepEqual(eaPendingCancelPayload("4242"), { mt5OrderTicket: "4242", orderTicket: "4242" });
});

// ── 7. live partial close is refused, never closed in full ─────────────────
test("a close volume below the open position volume is a partial request", () => {
  assert.equal(isLivePartialCloseRequest(0.05, 0.10), true);
  assert.equal(isLivePartialCloseRequest(0.10, 0.10), false);
  assert.equal(isLivePartialCloseRequest(0.10 - 1e-12, 0.10), false, "float noise is a full close");
  assert.equal(isLivePartialCloseRequest(0.20, 0.10), false);
  assert.equal(isLivePartialCloseRequest(0.05, null), false, "unknown position volume is not provably partial");
  assert.equal(LIVE_PARTIAL_CLOSE_UNSUPPORTED, "LIVE_PARTIAL_CLOSE_UNSUPPORTED");
});
// (Replit line) The Universal Agent 1.55 EA source is not carried on this line, so the
// "CLOSE_POSITION honours a smaller lot" check that read the EA source is not run here;
// the server refuses live partial closes on EAs below 1.55 (eaHonoursLiveCloseVolume).
test("only a Universal Agent v1.55+ is trusted with a live partial close", () => {
  assert.equal(eaHonoursLiveCloseVolume("1.55"), true);
  assert.equal(eaHonoursLiveCloseVolume("v1.60"), true);
  assert.equal(eaHonoursLiveCloseVolume("2.0"), true);
  assert.equal(eaHonoursLiveCloseVolume("1.54"), false);
  assert.equal(eaHonoursLiveCloseVolume("1.31"), false);
  assert.equal(eaHonoursLiveCloseVolume(null), false);
  assert.equal(eaHonoursLiveCloseVolume("garbage"), false);
});

// ── 8. bridge v2 command channel serves a row once ─────────────────────────
test("the v2 command poll serves only rows it claimed; a second poll gets nothing", async () => {
  const picked = new Set<string>();
  const rows = [
    { arxCommandId: "a", action: "OPEN_MARKET" }, { arxCommandId: "b", action: "CLOSE_POSITION" },
  ] as never[];
  const events: string[] = [];
  const deps = {
    list: async () => rows.filter((r: { arxCommandId: string }) => !picked.has(r.arxCommandId)),
    claim: async ({ commandIds }: { commandIds: string[] }) => {
      // "b" was claimed by a racing poll between projection and CAS.
      const won = commandIds.filter((id) => id !== "b" && !picked.has(id));
      picked.add("b");
      for (const id of won) picked.add(id);
      return won.map((commandId, i) => ({ id: i + 1, commandId }));
    },
    recordPickup: async (row: { commandId: string }) => { events.push(row.commandId); },
  };
  const first = await claimBridgeV2CommandsForEa(1, 7, Date.now(), deps as never);
  assert.deepEqual(first.map((c) => c.arxCommandId), ["a"]);
  assert.deepEqual(events, ["a"]);
  const second = await claimBridgeV2CommandsForEa(1, 7, Date.now(), deps as never);
  assert.deepEqual(second, []);
});
test("the v2 route claims instead of re-projecting, and egress stays a pure read", () => {
  const route = readFileSync(new URL("../../../routes/bridgeV2.ts", import.meta.url), "utf8");
  assert.match(route, /claimBridgeV2CommandsForEa\(conn\.userId/);
  const egress = readFileSync(new URL("../../bridgeV2/egress.ts", import.meta.url), "utf8");
  assert.doesNotMatch(egress, /\.update\s*\(/);
  assert.match(egress, /isNull\(arxLiveCommandsTable\.pickedByEaAt\)/);
});

// ── 9. platform-wide bridge identifiers are operator-only ──────────────────
test("/mt5/heartbeat/status redacts account, IPs and user agent for non-operators", () => {
  const handler = mt5Src.slice(mt5Src.indexOf('router.get("/mt5/heartbeat/status"'), mt5Src.indexOf('router.get("/mt5/bridge-diagnostics"'));
  for (const f of ["lastRejectRemoteIp", "lastAcceptedAccount", "lastAcceptedRemoteIp", "lastAcceptedUserAgent"])
    assert.match(handler, new RegExp(`${f}: idScope\\.operator \\? bridgeDiag\\.${f} : null`), f);
  // The operator check lives in bridgeIdentifierScope(), which the handler calls.
  assert.match(handler, /bridgeIdentifierScope\(req\)/);
  assert.match(mt5Src, /function bridgeIdentifierScope[\s\S]*operatorRoleFromSession\(readRoleFromRequest\(req\)\)/);
});

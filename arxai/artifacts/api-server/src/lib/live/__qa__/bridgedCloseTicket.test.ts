// Regression test for the silent-close-failure guard on the live bridge. Run via:
//   node --import tsx --test src/lib/live/__qa__/bridgedCloseTicket.test.ts
// (wired as `pnpm --filter @workspace/api-server run test:bridged-close-ticket`)
//
// A real bug let a CLOSE command be mirrored into mt5_commands with position
// ticket 0, which the broker reported as "executed" (retcode 10009) even though
// it closed NOTHING — leaving a position the user believed closed still open and
// exposed. It was fixed by reading the position ticket from the command payload
// (`payload.brokerTicket`) when the `arx_live_commands.brokerTicket` column is
// null. These assertions exercise the SAME pure helpers the mirror path
// (`enqueueBridgedMt5Command`) uses to build the mt5_commands payload, so the
// behavior can never silently break — no DB required.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildBridgedMt5CommandPayload,
  resolveBridgedPositionTicket,
} from "../liveCommandPipeline.js";

const POSITION_TARGETED = ["CLOSE_LIVE_POSITION", "MODIFY_LIVE_SLTP"] as const;
const ENTRY_ORDERS = ["PLACE_LIVE_MARKET_ORDER", "PLACE_LIVE_PENDING_ORDER"] as const;

test("CLOSE/MODIFY: positionTicket comes from payload.brokerTicket when the column is null", () => {
  for (const commandType of POSITION_TARGETED) {
    const payload = buildBridgedMt5CommandPayload({
      commandId: "cmd-1",
      userId: 42,
      commandType,
      brokerTicket: null, // column empty — the original bug condition
      payload: { brokerTicket: "987654321" },
    });
    assert.equal(
      payload.positionTicket,
      "987654321",
      `${commandType} must mirror the real open ticket from payload.brokerTicket`,
    );
  }
});

test("CLOSE/MODIFY: brokerTicket column takes precedence over payload when present", () => {
  const ticket = resolveBridgedPositionTicket({
    commandType: "CLOSE_LIVE_POSITION",
    brokerTicketColumn: "111222333",
    payload: { brokerTicket: "987654321" },
  });
  assert.equal(ticket, "111222333");
});

test("CLOSE/MODIFY: a missing ticket throws rather than mirroring a no-op close", () => {
  for (const commandType of POSITION_TARGETED) {
    assert.throws(
      () =>
        buildBridgedMt5CommandPayload({
          commandId: "cmd-x",
          userId: 42,
          commandType,
          brokerTicket: null,
          payload: null,
        }),
      /LIVE_BRIDGE_CLOSE_TICKET_MISSING/,
      `${commandType} with no ticket anywhere must throw`,
    );
  }
});

test("CLOSE/MODIFY: a zero / empty / whitespace ticket throws (never mirrored)", () => {
  const badTickets: Array<string | null> = ["0", "", "   ", null];
  for (const commandType of POSITION_TARGETED) {
    for (const bad of badTickets) {
      // From the column.
      assert.throws(
        () =>
          buildBridgedMt5CommandPayload({
            commandId: "cmd-col",
            userId: 1,
            commandType,
            brokerTicket: bad,
            payload: null,
          }),
        /LIVE_BRIDGE_CLOSE_TICKET_MISSING/,
        `${commandType} column=${JSON.stringify(bad)} must throw`,
      );
      // From the payload (column null).
      assert.throws(
        () =>
          buildBridgedMt5CommandPayload({
            commandId: "cmd-pl",
            userId: 1,
            commandType,
            brokerTicket: null,
            payload: bad == null ? null : { brokerTicket: bad },
          }),
        /LIVE_BRIDGE_CLOSE_TICKET_MISSING/,
        `${commandType} payload=${JSON.stringify(bad)} must throw`,
      );
    }
  }
});

test("CLOSE/MODIFY: no degenerate input ever yields a mirrored positionTicket of 0", () => {
  const badTickets: Array<string | null> = ["0", "", "   ", null];
  for (const commandType of POSITION_TARGETED) {
    for (const bad of badTickets) {
      let leaked = false;
      try {
        const payload = buildBridgedMt5CommandPayload({
          commandId: "cmd-z",
          userId: 1,
          commandType,
          brokerTicket: bad,
          payload: null,
        });
        const pt = payload.positionTicket;
        leaked = pt == null || String(pt).trim() === "" || Number(pt) === 0;
      } catch {
        // Throwing is the correct, safe outcome.
        leaked = false;
      }
      assert.equal(
        leaked,
        false,
        `${commandType} must never mirror positionTicket=0 (input ${JSON.stringify(bad)})`,
      );
    }
  }
});

test("entry orders carry no position ticket and never throw", () => {
  for (const commandType of ENTRY_ORDERS) {
    const payload = buildBridgedMt5CommandPayload({
      commandId: "cmd-open",
      userId: 7,
      commandType,
      brokerTicket: null,
      payload: null,
    });
    assert.ok(
      !("positionTicket" in payload),
      `${commandType} must not inject a positionTicket`,
    );
  }
});

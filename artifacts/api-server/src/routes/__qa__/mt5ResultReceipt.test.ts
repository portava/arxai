// Execute the actual route handler extracted from its AST; middleware/network and
// DB/forwarding are controlled. This tests acknowledgement flow, not HTTP delivery.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
// The real classifier: unversioned EA bodies take the legacy mapping path.
import { normalizeTerminalResultEvidence } from "../../lib/mt5/terminalResultEvidence.js";
const source = readFileSync(new URL("../mt5.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile(
  "mt5.ts",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
let handler: ts.Expression | undefined;
function visit(node: ts.Node) {
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.expression.getText(tree) === "router" &&
    node.expression.name.text === "post" &&
    node.arguments[0] &&
    ts.isStringLiteral(node.arguments[0]) &&
    node.arguments[0].text === "/mt5/command-result"
  )
    handler = node.arguments[node.arguments.length - 1];
  ts.forEachChild(node, visit);
}
visit(tree);
assert.ok(handler);
const compiled = ts.transpileModule(`const handler=${handler.getText(tree)};`, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  },
  transformers: {
    before: [
      (context) => (root) => {
        const replace = (node: ts.Node): ts.VisitResult<ts.Node> =>
          ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword
            ? ts.factory.updateCallExpression(
                node,
                ts.factory.createIdentifier("loadModule"),
                undefined,
                node.arguments,
              )
            : ts.visitEachChild(node, replace, context);
        return ts.visitNode(root, replace) as ts.SourceFile;
      },
    ],
  },
}).outputText;
async function run(
  forward: () => Promise<unknown>,
  { bridged = true, owned = true, awaiting = true, status = "FILLED", action = "PLACE_MARKET", mt5Ticket = "123" as string | undefined } = {},
) {
  const cmd = {
    id: 1,
    action,
    status: awaiting ? "DELIVERED" : "FILLED",
    requestedByUserId: 9,
    payload: bridged
      ? {
          bridged: "LIVE_PHASE_B",
          liveCommandId: "cmd",
          liveCommandOwnerUserId: 9,
        }
      : {},
  };
  // Table sentinels let the ownership lookup and the linked-command lookup
  // answer differently; a row is only visible to the connection that owns it.
  const mt5CommandsTable = { table: "mt5_commands" };
  const arxLiveCommandsTable = { table: "arx_live_commands" };
  const linked = { commandId: "cmd", commandType: "PLACE_LIVE_MARKET_ORDER", requestedVolume: 0.1, brokerTicket: null, payload: {} };
  const updates: Record<string, unknown>[] = [];
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => (table === mt5CommandsTable ? (owned ? [cmd] : []) : table === arxLiveCommandsTable ? [linked] : []),
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => (updates.push(values), {
        where: () => ({ returning: async () => {
          // The status precondition is part of the WHERE: a row not awaiting a
          // result (terminal or never delivered) matches nothing.
          return owned && awaiting ? [{ ...cmd, ...values }] : [];
        } }),
      }),
    }),
  };
  const loadModule = async (path: string) => {
    if (path.endsWith("liveCommandPipeline.js"))
      return {
        recordLiveCommandResult: forward,
        mapBridgedLiveOutcome: () => "LIVE_FILLED",
      };
    if (path === "@workspace/db/schema") return { tradeActionRequestsTable: { table: "trade_action_requests" } };
    if (path.endsWith("managementConsumers.js"))
      return { reportedManagementIdentity: () => [] };
    throw new Error(`Unexpected module ${path}`);
  };
  const fn = new Function(
    "db",
    "PostMt5CommandResultBody",
    "mt5CommandsTable",
    "arxLiveCommandsTable",
    "normalizeTerminalResultEvidence",
    "and",
    "eq",
    "inArray",
    "loadModule",
    `${compiled};return handler;`,
  )(
    db,
    { parse: (x: unknown) => x },
    mt5CommandsTable,
    arxLiveCommandsTable,
    normalizeTerminalResultEvidence,
    () => true,
    () => true,
    () => true,
    loadModule,
  );
  const reply = {
    code: 200,
    body: null as unknown,
    status(n: number) {
      this.code = n;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  await fn(
    {
      mt5Connection: { id: 1, userId: 9 },
      body: {
        commandId: 1,
        status,
        ...(mt5Ticket !== undefined ? { mt5Ticket } : {}),
        filledLotSize: 0.1,
        fillPrice: 1.1,
      },
      log: { info() {}, warn() {}, error() {} },
    },
    reply,
  );
  return Object.assign(reply, { updates });
}
test("bridge persistence failure returns retryable503 and never acknowledges received", async () => {
  const reply = await run(async () => {
    throw new Error("storage down");
  });
  assert.equal(reply.code, 503);
  assert.deepEqual(reply.body, {
    received: false,
    error: "LIVE_RESULT_PERSISTENCE_FAILED",
  });
});
test("bridge ownership/state refusal cannot become a successful acknowledgement", async () => {
  const reply = await run(async () => ({
    ok: false,
    reason: "BRIDGE_BINDING_MISMATCH",
  }));
  assert.equal(reply.code, 409);
  assert.deepEqual(reply.body, {
    received: false,
    error: "BRIDGE_BINDING_MISMATCH",
  });
});
test("durably accepted or deduplicated report keeps normal acknowledgement", async () => {
  for (const reason of [undefined, "DUPLICATE_IGNORED"]) {
    const reply = await run(async () => ({
      ok: true,
      reason,
      receiptPersisted: true,
      positionSettlement: "APPLIED",
    }));
    assert.equal(reply.code, 200);
    assert.deepEqual(reply.body, {
      received: true,
      receiptPersisted: true,
      positionSettlement: "APPLIED",
    });
  }
});
test("unbridged/manual result keeps prior acknowledgement and does not invoke live forwarding", async () => {
  const reply = await run(
    async () => {
      throw new Error("must not forward");
    },
    { bridged: false },
  );
  assert.equal(reply.code, 200);
  assert.deepEqual(reply.body, { received: true });
});
test("connection ownership still rejects before forwarding", async () => {
  const reply = await run(
    async () => {
      throw new Error("must not forward");
    },
    { owned: false },
  );
  assert.equal(reply.code, 404);
});

test("durable receipt explicitly distinguishes held position settlement", async () => {
  const reply = await run(async () => ({
    ok: true,
    receiptPersisted: true,
    positionSettlement: "HELD",
    positionSettlementReason: "LEGACY_PARTIAL_APPLICATION_UNKNOWN",
  }));
  assert.equal(reply.code, 200);
  assert.deepEqual(reply.body, {
    received: true,
    receiptPersisted: true,
    positionSettlement: "HELD",
    positionSettlementReason: "LEGACY_PARTIAL_APPLICATION_UNKNOWN",
  });
});

test("capacity refusal is retryable503 and never acknowledged as a durable receipt", async () => {
  const reply = await run(async () => ({
    ok: false,
    receiptPersisted: false,
    reason: "LIVE_RESULT_RECEIPT_CAPACITY",
  }));
  assert.equal(reply.code, 503);
  assert.deepEqual(reply.body, {
    received: false,
    error: "LIVE_RESULT_RECEIPT_CAPACITY",
  });
});
test("durable receipt with pending recovery explicitly reports default-off worker",async()=>{
  const recovery={workerEnabled:false,pending:true,held:false,scope:"LATEST_ACCEPTED_COMMAND_STATE",jobs:[{consumer:"MANUAL_CLOSE_POSITION",status:"RETRY",generation:1,completedGeneration:null,reason:"SETTLEMENT_PROCESSING_FAILED"}]};
  const reply=await run(async()=>({ok:true,receiptPersisted:true,positionSettlement:"PENDING",settlementRecovery:recovery}));
  assert.equal(reply.code,200);
  assert.deepEqual(reply.body,{received:true,receiptPersisted:true,positionSettlement:"PENDING",settlementRecovery:recovery});
});

test("a result for a terminal unlinked row is refused 409 and never rewrites it", async () => {
  const reply = await run(async () => { throw new Error("must not forward"); }, { awaiting: false, bridged: false });
  assert.equal(reply.code, 409);
  assert.deepEqual(reply.body, { received: false, error: "COMMAND_NOT_AWAITING_RESULT", status: "FILLED" });
  assert.equal(reply.updates.length, 1, "the guarded update matched nothing; no draft write-back");
});

test("a late report for a final linked mirror is still forwarded for exactly-once adjudication", async () => {
  let forwarded = 0;
  const reply = await run(async () => { forwarded++; return { ok: true, reason: "DUPLICATE_IGNORED", receiptPersisted: true, positionSettlement: "APPLIED" }; }, { awaiting: false });
  assert.equal(reply.code, 200);
  assert.equal(forwarded, 1);
});

test("EA refusals and expiries are failures, never completions", async () => {
  for (const status of ["EA_EXECUTION_NOT_IMPLEMENTED", "EA_READ_ONLY_MODE_ACTIVE", "EXPIRED", "COMMAND_EXPIRED", "UNSUPPORTED_COMMAND"]) {
    const reply = await run(async () => { throw new Error("must not forward"); }, { bridged: false, status, mt5Ticket: undefined });
    assert.equal(reply.code, 200, status);
    const set = reply.updates[0]!;
    assert.equal(set.completedAt, null, status);
    assert.ok(set.failedAt instanceof Date, status);
  }
});

test("a pending placement without an order ticket is unresolved and never marks the draft PLACED", async () => {
  const reply = await run(async () => { throw new Error("must not forward"); },
    { bridged: false, status: "PLACED", action: "PLACE_PENDING_ORDER", mt5Ticket: "0" });
  assert.equal(reply.code, 200);
  assert.equal(reply.updates.length, 1, "only the mailbox row; no draft write-back");
  assert.equal(reply.updates[0]!.completedAt, null);
  assert.equal(reply.updates[0]!.failedAt, null);
});

test("a pending placement with an order ticket marks the draft PLACED with that ticket", async () => {
  const reply = await run(async () => { throw new Error("must not forward"); },
    { bridged: false, status: "PLACED", action: "PLACE_PENDING_ORDER", mt5Ticket: "777" });
  assert.equal(reply.code, 200);
  assert.equal(reply.updates.length, 2);
  assert.equal(reply.updates[1]!.pendingStatus, "PLACED");
  assert.equal(reply.updates[1]!.mt5OrderTicket, "777");
});

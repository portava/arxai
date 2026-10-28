// Actual direct live-result route, AST-extracted with controlled auth/DB seams.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
// The real classifier: an unversioned body takes the legacy mapping path.
import { normalizeTerminalResultEvidence } from "../../lib/mt5/terminalResultEvidence.js";
const source = readFileSync(new URL("../mt5Live.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile(
  "mt5Live.ts",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
let handler: ts.Expression | undefined;
function visit(n: ts.Node) {
  if (
    ts.isCallExpression(n) &&
    ts.isPropertyAccessExpression(n.expression) &&
    n.expression.expression.getText(tree) === "router" &&
    n.expression.name.text === "post" &&
    ts.isStringLiteral(n.arguments[0]) &&
    n.arguments[0].text === "/mt5/live-command-result"
  )
    handler = n.arguments[n.arguments.length - 1];
  ts.forEachChild(n, visit);
}
visit(tree);
assert.ok(handler);
const code = ts.transpileModule(`const handler=${handler.getText(tree)};`, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  },
  transformers: {
    before: [
      (context) => (root) => {
        const replace = (n: ts.Node): ts.VisitResult<ts.Node> =>
          ts.isCallExpression(n) &&
          n.expression.kind === ts.SyntaxKind.ImportKeyword
            ? ts.factory.updateCallExpression(
                n,
                ts.factory.createIdentifier("loadModule"),
                undefined,
                n.arguments,
              )
            : ts.visitEachChild(n, replace, context);
        return ts.visitNode(root, replace) as ts.SourceFile;
      },
    ],
  },
}).outputText;
test("direct result route returns retryable503 with receiptPersisted false on capacity refusal", async () => {
  const response = {
    statusCode: 200,
    body: null as any,
    status(n: number) {
      this.statusCode = n;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  let guardian = 0,
    recomputes = 0;
  const fn = new Function(
    "requireLiveBridge",
    "db",
    "arxLiveCommandsTable",
    "and",
    "eq",
    "recordLiveCommandResult",
    "reportedManagementIdentity",
    "normalizeTerminalResultEvidence",
    "scheduleGuardian",
    "loadModule",
    "LIVE_SAFETY_ENVELOPE",
    `${code};return handler;`,
  )(
    () => ({ id: 1, userId: 9 }),
    {
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => [{ id: 1 }] }) }),
      }),
    },
    {},
    () => true,
    () => true,
    async () => ({
      ok: false,
      command: null,
      reason: "LIVE_RESULT_RECEIPT_CAPACITY",
      receiptPersisted: false,
    }),
    () => [],
    normalizeTerminalResultEvidence,
    () => {
      guardian++;
    },
    async () => ({
      recomputeMasterPool: async () => {
        recomputes++;
      },
    }),
    {},
  );
  await fn(
    { body: { commandId: "qa", status: "LIVE_FILLED" }, log: { warn() {} } },
    response,
  );
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.receiptPersisted, false);
  assert.equal(response.body.ok, false);
  assert.equal(guardian, 0);
  assert.equal(recomputes, 0);
});

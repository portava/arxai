import ts from "typescript";
/** Check executable calls, not comments or a fixed character window. */
export function masterGatePrecedesPhaseB(source: string): boolean {
  const file = ts.createSourceFile("pipeline.ts", source, ts.ScriptTarget.Latest, true);
  const dispatch = file.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "dispatchLiveCommand");
  if (!dispatch?.body) return false;
  const master: number[] = [], phaseB: number[] = [];
  const sharedCondition = (node: ts.Expression) => ts.isBinaryExpression(node)
    && node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
    && ts.isIdentifier(node.left) && node.left.text === "routingMode"
    && ts.isStringLiteral(node.right) && node.right.text === "SHARED_MASTER_MT5";
  const visit = (node: ts.Node, shared: boolean): void => {
    if (ts.isFunctionLike(node)) return; // uncalled helpers cannot satisfy a dispatch gate
    if (ts.isIfStatement(node)) {
      visit(node.thenStatement, shared || sharedCondition(node.expression));
      if (node.elseStatement) visit(node.elseStatement, shared);
      return;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === "loadAndEvaluateMasterLiveBridgeGate" && shared && ts.isAwaitExpression(node.parent)) master.push(node.getStart(file));
      if (node.expression.text === "evaluateLivePhaseBDispatchGate") phaseB.push(node.getStart(file));
    }
    ts.forEachChild(node, child => visit(child, shared));
  };
  visit(dispatch.body, false);
  return master.length === 1 && phaseB.length === 1 && master[0]! < phaseB[0]!;
}

export function insertedTables(source: string): Set<string> {
  const file = ts.createSourceFile("writer.ts", source, ts.ScriptTarget.Latest, true);
  const tables = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "insert" && node.arguments[0] && ts.isIdentifier(node.arguments[0])) tables.add(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return tables;
}

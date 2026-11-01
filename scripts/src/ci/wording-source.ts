// Shared read-only wording coverage. Missing paths/tools/read/parse failures are
// errors, never evidence of a clean product. Paths never depend on process.cwd().
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";
import { ROOT } from "./_lib.js";

export interface WordingScanOptions { root?: string; rgBinary?: string }
export interface WordingSource { path: string; source: string; file: ts.SourceFile }
export interface CopyFragment { text: string; start: number }
export function isWordingTestFile(path: string): boolean {
  return /\.(test|spec)\.[cm]?tsx?$/.test(path) || /\/(?:__tests__|__qa__)\//.test(path) || path.includes(".stories.");
}
export function parseWordingSource(path: string, source: string): WordingSource {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const errors = (file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (errors.length) throw new Error(`Cannot parse ${path}: ${ts.flattenDiagnosticMessageText(errors[0]!.messageText, " ")}`);
  return { path, source, file };
}
export function readWordingSources(paths: readonly string[], options: WordingScanOptions = {}): WordingSource[] {
  const root = resolve(options.root ?? ROOT);
  const files = new Set<string>();
  for (const path of paths) {
    const absolute = resolve(root, path);
    if (!statSync(absolute).isDirectory() && !statSync(absolute).isFile()) throw new Error(`Invalid scan path: ${path}`);
    let output: string;
    try {
      output = execFileSync(options.rgBinary ?? "rg", ["--files", "--null", "--hidden", "--no-ignore", "-g", "*.{ts,tsx,mts,cts}", "-g", "!**/node_modules/**", "-g", "!**/dist/**", "-g", "!**/build/**", "-g", "!**/generated/**", "--", absolute], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    } catch (error) {
      throw new Error(`Cannot enumerate wording scan path ${path} with ${options.rgBinary ?? "rg"}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const listed = output.split("\0").filter(Boolean).filter(file => !isWordingTestFile(file));
    if (!listed.length) throw new Error(`No product source files scanned for required path: ${path}`);
    listed.forEach(file => files.add(file));
  }
  return [...files].sort().filter(file => !isWordingTestFile(file)).map(file => parseWordingSource(relative(root, file).replaceAll("\\", "/"), readFileSync(file, "utf8")));
}

/** Potential copy: JSX text and runtime string/template literals. This does not
 * pretend to solve arbitrary dataflow; unknown runtime strings stay in scope.
 * Imports, type literals, property names and non-copy JSX attributes are syntax,
 * not user-visible prose. Comments and regular expressions are not literals. */
export function isNonCopyJsxAttribute(node: ts.JsxAttribute, file: ts.SourceFile): boolean {
  const name = node.name.getText(file);
  return ["className", "id", "key", "ref", "href", "src", "role", "data-testid", "data-test", "testId", "testid"].includes(name)
    || /^on[A-Z]/.test(name); // React event/callback props do not render their body.
}

export function copyFragments(input: WordingSource): CopyFragment[] {
  const result: CopyFragment[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isImportTypeNode(node) || ts.isTypeNode(node)) return;
    if (ts.isJsxAttribute(node) && isNonCopyJsxAttribute(node, input.file)) return;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && /^(?:console|logger|req\.log)$/.test(node.expression.expression.getText(input.file))
      && ["debug", "info", "warn", "error", "trace", "fatal", "log"].includes(node.expression.name.text)) return;
    if (ts.isJsxText(node)) result.push({ text: node.text, start: node.getFullStart() });
    else if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const parent = node.parent;
      if ((ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent)) && parent.name === node) return;
      result.push({ text: node.text, start: node.getStart(input.file) + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(input.file);
  return result;
}
export function wordingLocation(input: WordingSource, start: number): string {
  const { line, character } = input.file.getLineAndCharacterOfPosition(start);
  return `${input.path}:${line + 1}:${character + 1}`;
}
export function scanCopyPatterns(input: WordingSource, patterns: readonly string[], insensitive = false): Array<{ pattern: string; location: string; text: string }> {
  const hits: Array<{ pattern: string; location: string; text: string }> = [];
  for (const fragment of copyFragments(input)) for (const pattern of patterns) {
    const regex = new RegExp(pattern, insensitive ? "gi" : "g");
    for (const match of fragment.text.matchAll(regex)) hits.push({ pattern, location: wordingLocation(input, fragment.start + match.index), text: fragment.text.trim().slice(0, 200) });
  }
  return hits;
}
export function coverageFailure(error: unknown): string {
  return `[scan-coverage] ${error instanceof Error ? error.message : String(error)}`;
}

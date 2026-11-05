import { statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function missingExplicitTestPaths(paths, cwd = process.cwd()) {
  return paths.filter((path) => {
    try {
      return !statSync(resolve(cwd, path)).isFile();
    } catch {
      return true;
    }
  });
}

export function runTestPathPreflight(paths, { cwd = process.cwd(), stderr = process.stderr } = {}) {
  if (paths.length === 0) {
    stderr.write("No explicitly named test paths were provided.\n");
    return 2;
  }

  const missing = missingExplicitTestPaths(paths, cwd);
  if (missing.length === 0) return 0;

  stderr.write("Missing explicitly named test file(s):\n");
  for (const path of missing) stderr.write(`  - ${path}\n`);
  stderr.write("Test execution stopped before Node's test runner.\n");
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runTestPathPreflight(process.argv.slice(2));
}

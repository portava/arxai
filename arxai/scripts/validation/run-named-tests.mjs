import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Only suites with an explicit file inventory use this launcher. Shell glob
 * expansion happens before this entry point; an unexpanded glob fails closed. */
export function namedTestFiles(args) {
  const valueOptions = new Set([
    "--import", "--require", "-r", "--loader", "--experimental-loader",
    "--test-name-pattern", "--test-skip-pattern", "--test-reporter",
    "--test-reporter-destination", "--test-shard", "--test-concurrency",
    "--test-timeout", "--config", "-c", "--reporter", "--outputFile",
    "--maxWorkers", "--minWorkers", "--testNamePattern", "-t", "--project",
  ]);
  const files = [];
  for (let i = 0; i < args.length; i++) {
    if (valueOptions.has(args[i])) { i++; continue; }
    if (args[i].startsWith("-")) continue;
    if (/\.(?:[cm]?[jt]sx?)$/.test(args[i])) files.push(args[i]);
  }
  return files;
}

export function preflightNamedTests(args, cwd = process.cwd()) {
  const files = namedTestFiles(args);
  if (!files.length) throw new Error("No explicitly named test files; refusing an unmeasured suite.");
  const missing = files.filter(file => {
    try { return !statSync(resolve(cwd, file)).isFile(); } catch { return true; }
  });
  if (missing.length) throw new Error(`Missing named test files (${missing.length}/${files.length}):\n${missing.map(f => `  ${f}`).join("\n")}\nNo tests were started.`);
  return [...new Set(files)];
}

export function main(argv = process.argv.slice(2)) {
  const [runner, ...args] = argv;
  if (runner !== "node" && runner !== "vitest") {
    process.stderr.write("Expected node or vitest followed by an explicit test file list.\n");
    return 2;
  }
  try {
    const files = preflightNamedTests(args);
    process.stdout.write(`Named-test preflight: ${files.length} files present.\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  if (runner === "node" && !args.some(a => a.startsWith("--test-concurrency"))) {
    args.unshift("--test-concurrency=2");
  }
  const env = { ...process.env };
  // A launcher exercised by node:test must start a new runner, not inherit the
  // parent's child-worker mode (which otherwise suppresses nested discovery).
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(runner === "node" ? process.execPath : "vitest", args, {
    stdio: "inherit", env,
  });
  if (result.error) process.stderr.write(`${result.error.message}\n`);
  return result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}

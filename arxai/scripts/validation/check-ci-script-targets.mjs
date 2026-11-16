import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The workspace uses literal directory segments and single-segment * globs.
// Reject new syntax rather than silently omitting packages from validation.
export function workspaceManifests(root) {
  const yaml = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  const block = yaml.match(/^packages:\s*\n((?:[ \t]+[^\n]*\n?)*)/m)?.[1];
  if (!block) throw new Error("Missing workspace packages inventory");
  const patterns = block.split("\n").filter(line => line.trim()).map(line => {
    const match = line.match(/^\s+-\s+['"]?([\w/*.-]+)['"]?\s*$/);
    if (!match || match[1].includes("**") || match[1].includes("..") || match[1].startsWith("/")) {
      throw new Error(`Unsupported workspace pattern: ${line.trim()}`);
    }
    return match[1];
  });
  const paths = new Set([root]);
  for (const pattern of patterns) {
    let dirs = [root];
    for (const segment of pattern.split("/")) {
      dirs = dirs.flatMap(dir => segment === "*"
        ? readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(dir, entry.name))
        : [join(dir, segment)]);
    }
    for (const dir of dirs) if (existsSync(join(dir, "package.json"))) paths.add(dir);
  }
  const manifests = new Map();
  for (const dir of paths) {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    if (!manifest.name || manifests.has(manifest.name)) throw new Error(`Missing or duplicate package name: ${dir}`);
    manifests.set(manifest.name, { ...manifest, directory: dir });
  }
  return manifests;
}

// Validate the literal pnpm run calls used by CI, including their transitive
// local/filtered aliases. pnpm can exit 0 for an absent filtered script, so its
// exit code alone does not prove the intended test suite was executed.
export function checkScriptTargets(manifests, rootName, entrypoints = ["ci", "ci:integration"]) {
  const errors = [];
  const visited = new Set();
  function visit(packageName, scriptName, source) {
    const key = `${packageName}#${scriptName}`;
    if (visited.has(key)) return;
    visited.add(key);
    const manifest = manifests.get(packageName);
    if (!manifest) { errors.push(`${source}: missing package ${packageName}`); return; }
    const command = manifest.scripts?.[scriptName];
    if (typeof command !== "string" || !command.trim()) {
      errors.push(`${source}: missing or empty script ${packageName} run ${scriptName}`);
      return;
    }
    const calls = /\bpnpm\s+(?:--filter\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s+)?run\s+([A-Za-z0-9:_-]+)/g;
    for (const match of command.matchAll(calls)) {
      const target = match[1]?.replace(/^['"]|['"]$/g, "") ?? packageName;
      visit(target, match[2], key);
    }
  }
  for (const name of entrypoints) visit(rootName, name, "CI entrypoint");
  return { errors, checked: visited.size };
}

export function main(root = resolve(fileURLToPath(new URL("../..", import.meta.url)))) {
  try {
    const manifests = workspaceManifests(root);
    const rootName = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name;
    const result = checkScriptTargets(manifests, rootName);
    if (result.errors.length) throw new Error(result.errors.join("\n"));
    process.stdout.write(`CI script targets: ${result.checked} reachable scripts present.\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`CI script target preflight failed:\n${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main();

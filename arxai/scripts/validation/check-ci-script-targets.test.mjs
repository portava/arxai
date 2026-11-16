import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkScriptTargets, workspaceManifests } from "./check-ci-script-targets.mjs";

function inventory(rootScripts, apiScripts = {}) {
  return new Map([
    ["workspace", { scripts: rootScripts }],
    ["@workspace/api", { scripts: apiScripts }],
  ]);
}
test("absent filtered test alias is a failure even though pnpm may exit zero", () => {
  const result = checkScriptTargets(inventory({ ci: "pnpm --filter @workspace/api run test:missing" }), "workspace", ["ci"]);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /missing or empty script @workspace\/api run test:missing/);
});
test("transitive local and quoted filtered aliases are checked", () => {
  const manifests = inventory({ ci: "pnpm run gate", gate: "pnpm --filter '@workspace/api' run test:all" }, {
    "test:all": "pnpm run test:one && pnpm run test:two", "test:one": "node one.test.mjs",
  });
  assert.match(checkScriptTargets(manifests, "workspace", ["ci"]).errors[0], /test:two/);
  manifests.get("@workspace/api").scripts["test:two"] = "node two.test.mjs";
  assert.deepEqual(checkScriptTargets(manifests, "workspace", ["ci"]), { errors: [], checked: 5 });
});
test("missing packages and empty scripts fail with their calling alias", () => {
  const result = checkScriptTargets(inventory({ ci: "pnpm --filter @workspace/absent run test:a && pnpm run blank", blank: " " }), "workspace", ["ci"]);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0], /workspace#ci: missing package/);
  assert.match(result.errors[1], /workspace#ci: missing or empty script/);
});
test("cycles are bounded while other missing references still fail", () => {
  const result = checkScriptTargets(inventory({ ci: "pnpm run loop", loop: "pnpm run ci && pnpm run absent" }), "workspace", ["ci"]);
  assert.equal(result.checked, 3);
  assert.match(result.errors[0], /run absent/);
});
test("all CI entrypoints are included", () => {
  const result = checkScriptTargets(inventory({ ci: "node unit.mjs", "ci:integration": "pnpm run absent" }), "workspace");
  assert.match(result.errors[0], /workspace#ci:integration/);
});
test("workspace discovery uses declared single-segment globs and nested directories", () => {
  const root = mkdtempSync(join(tmpdir(), "arx-ci-targets-"));
  try {
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - artifacts/*\n  - lib/integrations/*\n  - scripts\n\ncatalog:\n  ignored: true\n");
    for (const [dir, name] of [["", "workspace"], ["artifacts/api", "api"], ["lib/integrations/feed", "feed"], ["scripts", "scripts"], ["unlisted", "unlisted"]]) {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, "package.json"), JSON.stringify({ name, scripts: { ci: "node suite.mjs" } }));
    }
    assert.deepEqual([...workspaceManifests(root).keys()], ["workspace", "api", "feed", "scripts"]);
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - artifacts/**\n");
    assert.throws(() => workspaceManifests(root), /Unsupported workspace pattern/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

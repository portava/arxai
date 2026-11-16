// Bot Control truth guard. The dashboard's Bot Control page tells the user
// that START / PAUSE / STOP / mode only save preferences, because the store
// behind /bot/status (bot_settings) is written by routes/bot.ts and read by no
// scanner, trading loop or execution path. This guard fails the moment any
// other server module starts reading that table, so the page copy is revisited
// together with the new consumer instead of silently going stale.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "__qa__" || name === "__tests__") continue;
      walk(full, out);
    } else if (/\.(ts|mts|js|mjs)$/.test(name) && !/\.test\.|\.spec\./.test(name)) {
      out.push(full);
    }
  }
  return out;
}

// Comments may mention the table (routes/learning.ts explains why it has no
// engine-facing store); only code counts.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|[^:"'`])\/\/.*$/, "$1"))
    .join("\n");
}

// A bare import of the table, or `void botSettingsTable;` kept to silence an
// unused-import warning, reads nothing.
function codeReferences(src: string): string {
  return stripComments(src)
    .replace(/import\s*\{[^}]*\}\s*from\s*["'][^"']+["'];?/g, "")
    .replace(/\bvoid\s+botSettingsTable\s*;/g, "");
}

describe("bot_settings has no engine reader", () => {
  const files = walk(SRC);

  it("scans a real source tree", () => {
    assert.ok(files.some((f) => f.endsWith("routes/bot.ts")), "routes/bot.ts not found by the walker");
  });

  it("only routes/bot.ts uses botSettingsTable", () => {
    const users = files
      .filter((f) => /\bbotSettingsTable\b/.test(codeReferences(readFileSync(f, "utf8"))))
      .map((f) => relative(SRC, f).split("\\").join("/"));
    assert.deepEqual(users, ["routes/bot.ts"]);
  });

  it("no module queries bot_settings by raw SQL", () => {
    const users = files
      .filter((f) => /\bbot_settings\b/.test(stripComments(readFileSync(f, "utf8"))))
      .map((f) => relative(SRC, f));
    assert.deepEqual(users, []);
  });
});

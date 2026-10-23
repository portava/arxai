// THEME G-CUT — the entry-sniper persistence layer is removed.
//
// `entrySniperRepo` (recent / bySymbol / append) and the `entry_sniper_results`
// table it wrapped had NO reader and NO writer anywhere in the repo. Nothing
// ever called append(), so the table could only ever be empty, and nothing ever
// called recent()/bySymbol(), so its emptiness was never observed. It was a
// schema + repo + barrel export carried for a feature that was never wired.
//
// IMPORTANT DISTINCTION — `entrySniperScore` is a DIFFERENT, LIVE thing: a
// computed score in aiBrain, consumed by autopilot and marketScanner. It shares
// only a name prefix with the deleted persistence layer and is untouched. This
// suite asserts that explicitly, because a careless cut on a name match would
// have taken a live scoring path with it.
//
// OWNER ACTION: the `entry_sniper_results` TABLE still exists in the database.
// Dropping it is a destructive migration and is deliberately not performed
// here; the code that referenced it is gone, so the table is now inert.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../../..");

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

describe("G-CUT — the unused entry-sniper repo and schema are gone", () => {
  it("the repository file is deleted", () => {
    assert.equal(existsSync(resolve(ROOT, "lib/db/src/repositories/entrySniperRepo.ts")), false);
  });

  it("the schema file is deleted", () => {
    assert.equal(existsSync(resolve(ROOT, "lib/db/src/schema/entrySniperResults.ts")), false);
  });

  it("neither barrel re-exports them", () => {
    assert.ok(!/entrySniperRepo/.test(read("lib/db/src/repositories/index.ts")));
    assert.ok(!/entrySniperResults/.test(read("lib/db/src/schema/index.ts")));
  });

  it("the @workspace/db package exposes no entry-sniper binding", async () => {
    const mod = (await import("@workspace/db")) as Record<string, unknown>;
    for (const key of Object.keys(mod)) {
      assert.ok(
        !/entrySniper/i.test(key),
        `@workspace/db still exports "${key}" from the deleted layer`,
      );
    }
  });

  it("the architecture map no longer lists the table", () => {
    assert.ok(!/entry_sniper_results/.test(read("docs/ARCHITECTURE_MAP.md")));
  });
});

describe("G-CUT — the LIVE entrySniperScore path is untouched", () => {
  it("aiBrain still exports entrySniperScore", () => {
    assert.ok(/export function entrySniperScore\(/.test(read("artifacts/api-server/src/lib/aiBrain.ts")));
  });

  it("autopilot still consumes it", () => {
    assert.ok(/entrySniperScore/.test(read("artifacts/api-server/src/lib/autopilot.ts")));
  });

  it("marketScanner still surfaces it", () => {
    assert.ok(/entrySniperScore/.test(read("artifacts/api-server/src/lib/marketScanner.ts")));
  });

  it("it is a computed score, not a persistence read", async () => {
    const mod = await import("../aiBrain.js");
    assert.equal(
      typeof mod.entrySniperScore,
      "function",
      "the live scorer must still be callable — it never used the deleted table",
    );
  });
});

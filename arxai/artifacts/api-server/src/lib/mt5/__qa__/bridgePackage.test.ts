import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bridgeFile, bridgePackageManifest, bridgePackageZip } from "../bridgePackage.js";

const dir = fileURLToPath(new URL("../../../../../../mt5-bridge/", import.meta.url));

function unpackStoredZip(zip: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(zip.readUInt16LE(offset + 8), 0);
    const size = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString();
    const start = offset + 30 + nameLength + extraLength;
    assert.ok(!entries.has(name));
    entries.set(name, zip.subarray(start, start + size));
    offset = start + size;
  }
  assert.equal(zip.readUInt32LE(offset), 0x02014b50);
  return entries;
}

test("downloaded ZIP agrees with the manifest, hashes and real EA version", async () => {
  const manifest = await bridgePackageManifest(dir);
  assert.equal(manifest.complete, true);
  assert.equal(manifest.demoLifecycleValidationReady, false);
  const entries = unpackStoredZip(await bridgePackageZip(dir));
  assert.equal(entries.size, manifest.files.length);
  assert.ok(!entries.has("ReplitMT5BridgeEA.mq5"), "do not silently ship the v1.27 baseline");
  for (const file of manifest.files) {
    const data = entries.get(file.name)!;
    assert.ok(data, file.name);
    assert.equal(data.length, file.size);
    assert.equal(createHash("sha256").update(data).digest("hex"), file.sha256);
  }
  const ea = entries.get("ReplitMT5BridgeEA_v131.mq5")!.toString();
  assert.equal(ea.match(/#property version\s+"([^"]+)"/)?.[1], manifest.version);
  assert.match(ea, /\/api\/mt5\/demo-commands-poll/);
  assert.match(manifest.note, /broker lifecycle evidence/);
  assert.ok(entries.has("ArxDemoExecution.mqh"));
  assert.ok(entries.has("ArxManagementTarget.mqh"));
});

test("settings contain no credentials and keep every trading arm off", async () => {
  const profile = await readFile(join(dir, "ARX_DEMO_READ_ONLY.set"), "utf8");
  const values = Object.fromEntries(profile.split(/\r?\n/).filter(line => line && !line.startsWith(";")).map(line => line.split("=")));
  assert.equal(values.ReadOnlyMode, "true");
  for (const key of ["AllowOrderExecution", "EnableDemoExecution", "EnableLiveExecution", "EnableSelfUpdate", "EnableRemoteConfig"]) {
    assert.equal(values[key], "false", key);
  }
  for (const key of ["BridgeToken", "AccountId", "ServerBaseUrl"]) assert.equal(values[key], "");
  const source = await readFile(join(dir, "ReplitMT5BridgeEA_v131.mq5"), "utf8");
  for (const key of Object.keys(values)) assert.match(source, new RegExp(`input\\s+\\w+\\s+${key}\\s*=`), key);
});

test("unknown keys, inherited properties and path traversal cannot select a file", () => {
  for (const key of ["__proto__", "constructor", "toString", "../README_SETUP.md", "ea/../../.env", ""]) {
    assert.equal(bridgeFile(key), null, key);
  }
  assert.equal(bridgeFile("ea")?.name, "ReplitMT5BridgeEA_v131.mq5");
});

test("missing package files are explicit and abort the ZIP", async () => {
  const empty = await mkdtemp(join(tmpdir(), "arx-mt5-package-"));
  try {
    const manifest = await bridgePackageManifest(empty);
    assert.equal(manifest.complete, false);
    assert.ok(manifest.files.every(file => !file.present && file.sha256 === null));
    await assert.rejects(bridgePackageZip(empty), /ENOENT/);
  } finally { await rm(empty, { recursive: true, force: true }); }
});

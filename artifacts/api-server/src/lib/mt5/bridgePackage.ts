import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildZip } from "../zipBuilder.js";

// This is a read-only connection package, not a certification for DEMO orders.
// The Universal Agent uses a different mailbox; never select it by version alone.
export const BRIDGE_PACKAGE_VERSION = "1.31";
export const BRIDGE_FILES = {
  tradeResultCore: { name: "ArxTradeResult.mqh", contentType: "text/plain; charset=utf-8" },
  managementCore: { name: "ArxManagementTarget.mqh", contentType: "text/plain; charset=utf-8" },
  ea: { name: "ReplitMT5BridgeEA_v131.mq5", contentType: "text/x-mql5; charset=utf-8" },
  "demo-core": { name: "ArxDemoExecution.mqh", contentType: "text/x-mql5; charset=utf-8" },
  profile: { name: "ARX_DEMO_READ_ONLY.set", contentType: "text/plain; charset=utf-8" },
  "webreq-test": { name: "ARXWebRequestTest.mq5", contentType: "text/x-mql5; charset=utf-8" },
  readme: { name: "README_SETUP.md", contentType: "text/markdown; charset=utf-8" },
  checklist: { name: "BRIDGE_TESTING_CHECKLIST.md", contentType: "text/markdown; charset=utf-8" },
  security: { name: "SECURITY_NOTES.md", contentType: "text/markdown; charset=utf-8" },
  troubleshooting: { name: "TROUBLESHOOTING.md", contentType: "text/markdown; charset=utf-8" },
} as const;

export function bridgeFile(key: string) {
  return Object.hasOwn(BRIDGE_FILES, key) ? BRIDGE_FILES[key as keyof typeof BRIDGE_FILES] : null;
}

export function bridgeDir() {
  return resolve(process.cwd(), "../../mt5-bridge");
}

export async function bridgePackageManifest(dir = bridgeDir()) {
  const files = await Promise.all(Object.entries(BRIDGE_FILES).map(async ([key, meta]) => {
    const base = { key, name: meta.name, downloadUrl: `/api/mt5/bridge-package/${key}` };
    try {
      const data = await readFile(resolve(dir, meta.name));
      return { ...base, size: data.length, sha256: createHash("sha256").update(data).digest("hex"), present: true };
    } catch {
      return { ...base, size: 0, sha256: null, present: false };
    }
  }));
  return {
    version: BRIDGE_PACKAGE_VERSION,
    readOnly: true, // Installation profile, not a claim that the EA has no execution code.
    readOnlyDefaults: true,
    purpose: "MT5 DEMO read-only connection setup",
    demoLifecycleValidationReady: false,
    files,
    complete: files.every(file => file.present),
    note: "Includes execution-capable EA source with every trading arm disabled. DEMO lifecycle validation is blocked: offline-tested volume-bounded execution requires a DEMO hedging account; broker lifecycle evidence and separate order approval are still required. Compile in MetaEditor and verify read-only settings before attaching.",
  };
}

export async function bridgePackageZip(dir = bridgeDir()) {
  // Missing files reject the entire download; never deliver an incomplete kit.
  const entries = await Promise.all(Object.values(BRIDGE_FILES).map(async meta => ({
    name: meta.name, data: await readFile(resolve(dir, meta.name)),
  })));
  return buildZip(entries);
}

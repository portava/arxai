// Task #31 — Pure unit test for the admin bridge-connection projection.
//
// Guarantees the allowlist projection NEVER leaks a token secret. Feeds a row
// stuffed with secret-shaped extra fields and asserts none survive, plus the
// declared FORBIDDEN_CONNECTION_FIELDS list is exhaustive and the grace-window
// flag is computed from previousTokenExpiresAt vs now.
//
// Run: pnpm --filter @workspace/scripts run test:bridge-connection-mask

import {
  maskConnection,
  FORBIDDEN_CONNECTION_FIELDS,
  type BridgeConnectionRow,
} from "../../artifacts/api-server/src/lib/live/bridgeConnectionView.js";

const NOW = new Date("2026-05-29T12:00:00.000Z");

function rowWithSecrets(overrides: Partial<BridgeConnectionRow> = {}): Record<string, unknown> {
  const base: BridgeConnectionRow = {
    id: 7,
    userId: 42,
    connectionName: "VPS Bridge",
    status: "active",
    accountType: "live",
    accountNumber: "1234567",
    brokerName: "Test Broker",
    serverName: "Test-Server",
    eaVersion: "1.28",
    tokenLast4: "ab12",
    tokenCreatedAt: new Date("2026-05-01T00:00:00.000Z"),
    tokenRevokedAt: null,
    tokenRotatedAt: null,
    tokenRotatedByAdminId: null,
    tokenRotationReason: null,
    previousTokenExpiresAt: null,
    lastHeartbeat: new Date(NOW.getTime() - 5000),
    ...overrides,
  };
  // Simulate a real DB row that ALSO carries secret columns the projection
  // must never echo.
  return {
    ...base,
    apiKeyHash: "DEADBEEF_SECRET_HASH",
    previousApiKeyHash: "OLD_SECRET_HASH",
    rawToken: "should-never-appear",
    bridgeToken: "should-never-appear",
    token: "should-never-appear",
  };
}

let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; return; }
  fail++; failures.push(`[${name}] ${detail}`);
}

// ── no secret survives the projection ───────────────────────────────────────
{
  const masked = maskConnection(rowWithSecrets() as unknown as BridgeConnectionRow, NOW);
  const keys = Object.keys(masked);
  for (const forbidden of FORBIDDEN_CONNECTION_FIELDS) {
    check(`no '${forbidden}' key`, !keys.includes(forbidden), `keys=${keys.join(",")}`);
  }
  const serialized = JSON.stringify(masked);
  check("no secret hash in JSON", !serialized.includes("DEADBEEF_SECRET_HASH"), serialized);
  check("no old secret hash in JSON", !serialized.includes("OLD_SECRET_HASH"), serialized);
  check("no raw token sentinel in JSON", !serialized.includes("should-never-appear"), serialized);
  check("tokenLast4 is preserved", masked.tokenLast4 === "ab12", `${masked.tokenLast4}`);
  check("heartbeat age computed", masked.heartbeatAgeSeconds === 5, `${masked.heartbeatAgeSeconds}`);
}

// ── grace-window flag ───────────────────────────────────────────────────────
{
  const future = new Date(NOW.getTime() + 60_000);
  const masked = maskConnection(rowWithSecrets({ previousTokenExpiresAt: future }) as unknown as BridgeConnectionRow, NOW);
  check("grace active when expiry in future", masked.graceWindowActive === true, `${masked.graceWindowActive}`);
}
{
  const past = new Date(NOW.getTime() - 60_000);
  const masked = maskConnection(rowWithSecrets({ previousTokenExpiresAt: past }) as unknown as BridgeConnectionRow, NOW);
  check("grace inactive when expiry in past", masked.graceWindowActive === false, `${masked.graceWindowActive}`);
}
{
  const masked = maskConnection(rowWithSecrets({ previousTokenExpiresAt: null }) as unknown as BridgeConnectionRow, NOW);
  check("grace inactive when no previous token", masked.graceWindowActive === false, `${masked.graceWindowActive}`);
}

console.log(`bridge-connection mask: ${pass}/${pass + fail} PASS`);
if (failures.length) {
  for (const f of failures) console.log("  FAIL " + f);
  process.exit(1);
}
process.exit(0);

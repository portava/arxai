// Dev/admin one-shot: generate or rotate a per-user MT5 bridge token.
//
// SECURITY:
//   - Token = 32 random bytes → base64url (~256 bits entropy).
//   - Only sha256(token) is persisted in mt5_connection.api_key_hash.
//     The raw token value is shown ONCE on stdout and must be copied into
//     the EA's "X-MT5-Bridge-Token" input.
//   - Refuses to run when NODE_ENV === "production" unless --allow-prod is
//     passed (defense-in-depth; real ownership check happens in DB CHECK).
//   - Never logs the raw token to pino/structured logs. Only writes it to
//     stdout for the operator. Subsequent reads (status, list) only ever
//     show last4.
//   - Mirrors the exact algorithm used by POST /me/mt5-connections and the
//     /regenerate-token endpoint (see meMt5Connections.ts), so heartbeats
//     authenticated with this token go through the SAME bridgeAuth and
//     bridgeAuthPerUserOnly middleware. No new auth code path is added.
//
// USAGE:
//   pnpm --filter @workspace/scripts run mt5:gen-token -- \
//     --user-id 4 --connection-id 184
//
// FLAGS:
//   --user-id <n>           required (numeric)
//   --connection-id <n>     required (numeric); the row to bind the token to
//   --allow-prod            allow run when NODE_ENV === "production"
//
// SAFETY: This script ONLY rotates an auth token. It does NOT change
// readOnlyMode, allowOrderExecution, liveLocked, or mode. Live execution
// stays locked. paper_only is preserved.

import { randomBytes, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

type Args = { userId: number; connectionId: number; allowProd: boolean };

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = { allowProd: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--user-id") out.userId = Number(argv[++i]);
    else if (a === "--connection-id") out.connectionId = Number(argv[++i]);
    else if (a === "--allow-prod") out.allowProd = true;
  }
  if (!Number.isFinite(out.userId) || !Number.isFinite(out.connectionId)) {
    process.stderr.write("Usage: mt5:gen-token -- --user-id <n> --connection-id <n> [--allow-prod]\n");
    process.exit(2);
  }
  return out as Args;
}

function psql(sql: string): string {
  const url = process.env.DATABASE_URL;
  if (!url) { process.stderr.write("DATABASE_URL not set\n"); process.exit(2); }
  return execFileSync("psql", [url, "-At", "-F", "|", "-c", sql], { encoding: "utf8" });
}

function sqlEscape(v: string | number): string {
  if (typeof v === "number") return String(v);
  return "'" + v.replace(/'/g, "''") + "'";
}

function maskToken(raw: string): string {
  // last4 only, mirroring tokenLast4 storage.
  return "…" + raw.slice(-4);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (process.env.NODE_ENV === "production" && !args.allowProd) {
    process.stderr.write("Refusing to run in production without --allow-prod.\n");
    process.exit(2);
  }

  // Verify the connection exists and belongs to the user.
  const ownerCheck = psql(
    `SELECT id, user_id, connection_name, mode, live_locked, read_only_mode, allow_order_execution, token_last4
       FROM mt5_connection
      WHERE id = ${sqlEscape(args.connectionId)} AND user_id = ${sqlEscape(args.userId)};`
  ).trim();
  if (!ownerCheck) {
    process.stderr.write(`No mt5_connection id=${args.connectionId} for user_id=${args.userId}.\n`);
    process.exit(1);
  }
  const [, , name, mode, liveLocked, readOnlyMode, allowOrderExecution, prevLast4] = ownerCheck.split("|");

  // Defense-in-depth: refuse to issue a token if safety flags are not in
  // their locked state. This script must NEVER ship a token while any
  // execution gate is open.
  if (liveLocked !== "t" || readOnlyMode !== "t" || allowOrderExecution !== "f") {
    process.stderr.write(
      `Refusing: connection ${args.connectionId} safety flags not locked ` +
      `(live_locked=${liveLocked}, read_only_mode=${readOnlyMode}, allow_order_execution=${allowOrderExecution}).\n`
    );
    process.exit(1);
  }

  const raw = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(raw).digest("hex");
  const last4 = raw.slice(-4);

  // Update apiKeyHash, tokenLast4, tokenCreatedAt; clear revocation;
  // reset status so derived status reflects the new handshake.
  psql(
    `UPDATE mt5_connection SET
       api_key_hash = ${sqlEscape(hash)},
       token_last4 = ${sqlEscape(last4)},
       token_created_at = NOW(),
       token_revoked_at = NULL,
       updated_at = NOW()
     WHERE id = ${sqlEscape(args.connectionId)} AND user_id = ${sqlEscape(args.userId)};`
  );

  // ── ONE-TIME RAW TOKEN DISPLAY ────────────────────────────────────────
  // After this block, the raw token is unrecoverable.
  process.stdout.write("\n");
  process.stdout.write("════════════════════════════════════════════════════════════════════════\n");
  process.stdout.write("  MT5 BRIDGE TOKEN (per-user) — SHOWN ONCE, NOT STORED IN ANY LOG\n");
  process.stdout.write("════════════════════════════════════════════════════════════════════════\n");
  process.stdout.write(`  user_id:        ${args.userId}\n`);
  process.stdout.write(`  connection_id:  ${args.connectionId}\n`);
  process.stdout.write(`  connection:     ${name}  (mode=${mode})\n`);
  process.stdout.write(`  previous last4: ${prevLast4 || "(none)"}\n`);
  process.stdout.write(`  new last4:      ${last4}\n`);
  process.stdout.write("\n");
  process.stdout.write("  RAW TOKEN (copy now — cannot be retrieved later):\n");
  process.stdout.write(`    ${raw}\n`);
  process.stdout.write("\n");
  process.stdout.write("  Paste into MT5 EA → Inputs → X-MT5-Bridge-Token  (HTTP header value).\n");
  process.stdout.write("  Send as request header:  X-MT5-Bridge-Token: <token>\n");
  process.stdout.write("════════════════════════════════════════════════════════════════════════\n");
  process.stdout.write(`  Masked preview (for any future reference): ${maskToken(raw)}\n`);
  process.stdout.write("  Safety unchanged: live_locked=true, read_only_mode=true,\n");
  process.stdout.write("                    allow_order_execution=false, mode unchanged.\n");
  process.stdout.write("════════════════════════════════════════════════════════════════════════\n\n");
}

main();

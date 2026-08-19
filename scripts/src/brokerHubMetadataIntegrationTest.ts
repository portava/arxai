import assert from "node:assert/strict";
import { pool } from "@workspace/db";

type PgError = Error & { code?: string };

async function connectTestClient() {
  return pool.connect();
}

type TestClient = Awaited<ReturnType<typeof connectTestClient>>;

async function expectConstraint(
  client: TestClient,
  name: string,
  query: string,
  params: readonly unknown[],
  code: "23503" | "23505" | "23514",
): Promise<void> {
  await client.query(`SAVEPOINT ${name}`);
  try {
    await client.query(query, [...params]);
    assert.fail(`${name} unexpectedly succeeded`);
  } catch (error) {
    assert.equal((error as PgError).code, code, `${name} must fail with PostgreSQL ${code}`);
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    await client.query(`RELEASE SAVEPOINT ${name}`);
  }
}

async function commandCounts(
  client: TestClient,
): Promise<readonly number[]> {
  const result = await client.query<{ live: string; demo: string; mailbox: string }>(`
    SELECT
      (SELECT count(*)::text FROM arx_live_commands) AS live,
      (SELECT count(*)::text FROM mt5_demo_commands) AS demo,
      (SELECT count(*)::text FROM mt5_commands) AS mailbox
  `);
  const row = result.rows[0];
  return [Number(row.live), Number(row.demo), Number(row.mailbox)];
}

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const commandBaseline = await commandCounts(client);
    const suffix = `${process.pid}_${Date.now()}`;
    const users = await client.query<{ id: number }>(`
      INSERT INTO users (email, name, role)
      VALUES ($1, 'Broker Hub QA A', 'USER'), ($2, 'Broker Hub QA B', 'USER')
      RETURNING id
    `, [`broker-hub-a-${suffix}@example.invalid`, `broker-hub-b-${suffix}@example.invalid`]);
    const [userA, userB] = users.rows.map((row) => row.id);

    const connectionA = await client.query<{
      id: string;
      status: string;
      trading_enabled: boolean;
      automation_enabled: boolean;
      can_place_live_trade: boolean;
    }>(`
      INSERT INTO broker_hub_connections (user_id, venue, native_connection_ref)
      VALUES ($1, 'MT5', 'native-41')
      RETURNING id, status, trading_enabled, automation_enabled, can_place_live_trade
    `, [userA]);
    const connectionB = await client.query<{ id: string }>(`
      INSERT INTO broker_hub_connections (user_id, venue, native_connection_ref)
      VALUES ($1, 'MT5', 'native-41')
      RETURNING id
    `, [userB]);
    const connA = connectionA.rows[0];
    const connB = connectionB.rows[0];
    assert.equal(connA.status, "NOT_IMPLEMENTED");
    assert.equal(connA.trading_enabled, false);
    assert.equal(connA.automation_enabled, false);
    assert.equal(connA.can_place_live_trade, false);
    for (const column of [
      "trading_enabled",
      "automation_enabled",
      "can_place_live_trade",
    ]) {
      await expectConstraint(
        client,
        `force_${column}`,
        `UPDATE broker_hub_connections SET ${column} = true WHERE id = $1`,
        [connA.id],
        "23514",
      );
    }

    await expectConstraint(
      client,
      "dup_connection",
      `INSERT INTO broker_hub_connections (user_id, venue, native_connection_ref)
       VALUES ($1, 'MT5', 'native-41')`,
      [userA],
      "23505",
    );

    const accountA = await client.query<{ id: string }>(`
      INSERT INTO broker_hub_accounts
        (user_id, connection_id, native_account_ref, account_ref_masked)
      VALUES ($1, $2, 'account-900', '••••0900')
      RETURNING id
    `, [userA, connA.id]);
    const accountB = await client.query<{ id: string }>(`
      INSERT INTO broker_hub_accounts
        (user_id, connection_id, native_account_ref, account_ref_masked)
      VALUES ($1, $2, 'account-900', '••••0900')
      RETURNING id
    `, [userB, connB.id]);

    await expectConstraint(
      client,
      "cross_owner_account",
      `INSERT INTO broker_hub_accounts
        (user_id, connection_id, native_account_ref)
       VALUES ($1, $2, 'cross-owner')`,
      [userB, connA.id],
      "23503",
    );
    await expectConstraint(
      client,
      "dup_account",
      `INSERT INTO broker_hub_accounts
        (user_id, connection_id, native_account_ref)
       VALUES ($1, $2, 'account-900')`,
      [userA, connA.id],
      "23505",
    );

    const instrumentA = await client.query<{ id: string }>(`
      INSERT INTO broker_hub_instruments
        (user_id, connection_id, account_id, native_instrument_ref, exact_broker_symbol)
      VALUES ($1, $2, $3, 'EURUSD-native', 'EURUSD.r')
      RETURNING id
    `, [userA, connA.id, accountA.rows[0].id]);
    await client.query(`
      INSERT INTO broker_hub_instruments
        (user_id, connection_id, account_id, native_instrument_ref, exact_broker_symbol)
      VALUES ($1, $2, $3, 'EURUSD-native', 'EURUSD.r')
    `, [userB, connB.id, accountB.rows[0].id]);
    await expectConstraint(
      client,
      "dup_symbol",
      `INSERT INTO broker_hub_instruments
        (user_id, connection_id, account_id, native_instrument_ref, exact_broker_symbol)
       VALUES ($1, $2, $3, 'EURUSD-other-native', 'EURUSD.r')`,
      [userA, connA.id, accountA.rows[0].id],
      "23505",
    );

    await client.query(`
      INSERT INTO broker_hub_discovery_evidence
        (user_id, connection_id, account_id, instrument_id, native_discovery_ref,
         observed_at, source)
      VALUES ($1, $2, $3, $4, 'enumeration-1', now(), 'mt5_ea')
    `, [userA, connA.id, accountA.rows[0].id, instrumentA.rows[0].id]);
    await expectConstraint(
      client,
      "cross_owner_account_discovery",
      `INSERT INTO broker_hub_discovery_evidence
        (user_id, connection_id, account_id, native_discovery_ref, observed_at, source)
       VALUES ($1, $2, $3, 'cross-owner-account', now(), 'mt5_ea')`,
      [userA, connA.id, accountB.rows[0].id],
      "23503",
    );
    await expectConstraint(
      client,
      "instrument_without_account",
      `INSERT INTO broker_hub_discovery_evidence
        (user_id, connection_id, instrument_id, native_discovery_ref, observed_at, source)
       VALUES ($1, $2, $3, 'orphan-instrument', now(), 'mt5_ea')`,
      [userA, connA.id, instrumentA.rows[0].id],
      "23514",
    );
    await expectConstraint(
      client,
      "cross_owner_discovery",
      `INSERT INTO broker_hub_discovery_evidence
        (user_id, connection_id, native_discovery_ref, observed_at, source)
       VALUES ($1, $2, 'cross-owner', now(), 'mt5_ea')`,
      [userB, connA.id],
      "23503",
    );

    const forbiddenColumns = await client.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name LIKE 'broker_hub_%'
        AND column_name ~ '(credential|oauth|token|secret|cipher|api_key)'
    `);
    assert.deepEqual(forbiddenColumns.rows, [], "Phase 0B must contain no credential columns");
    assert.deepEqual(
      await commandCounts(client),
      commandBaseline,
      "metadata writes must not touch live, demo, or MT5 command tables",
    );

    console.log("PASS broker-hub metadata ownership, uniqueness, redaction, and no-write contract");
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
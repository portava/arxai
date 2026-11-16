import { scanBrokerHubSourceForViolations } from "./check-broker-hub-no-execution.js";

export {};

type Fixture = {
  name: string;
  source: string;
  shouldFail: boolean;
};

const fixtures: Fixture[] = [
  {
    name: "read-only projection remains allowed",
    shouldFail: false,
    source: `
      const rows = await db.select().from(mt5CommandsTable);
      export const status = "NOT_IMPLEMENTED";
    `,
  },
  {
    name: "comments do not create false positives",
    shouldFail: false,
    source: `
      // never call executeInstant or fetch()
      /* never insert into mt5CommandsTable */
      export const enabled = false;
    `,
  },
  {
    name: "live pipeline import is rejected",
    shouldFail: true,
    source: `import { dispatchLive } from "../live/liveCommandPipeline.js";`,
  },
  {
    name: "instant execution alias is rejected",
    shouldFail: true,
    source: `import { executeInstant as readSnapshot } from "../live/instantTrade.js";`,
  },
  {
    name: "direct mailbox insert is rejected",
    shouldFail: true,
    source: `await db.insert(mt5CommandsTable).values({});`,
  },
  {
    name: "aliased mailbox update is rejected",
    shouldFail: true,
    source: `
      import { mt5CommandsTable as projectedRows } from "@workspace/db";
      await db.update(projectedRows).set({ status: "sent" });
    `,
  },
  {
    name: "computed mailbox delete is rejected",
    shouldFail: true,
    source: `await db["delete"](arxLiveCommandsTable).where(condition);`,
  },
  {
    name: "namespace-indirected mailbox insert is rejected",
    shouldFail: true,
    source: `await db.insert(schema.mt5CommandsTable).values({});`,
  },
  {
    name: "local-alias database mutation is rejected",
    shouldFail: true,
    source: `
      const target = schema.mt5CommandsTable;
      await db.update(target).set({ status: "sent" });
    `,
  },
  {
    name: "raw SQL mailbox write is rejected",
    shouldFail: true,
    source: "await db.execute(sql`INSERT INTO mt5_commands (action) VALUES ('OPEN')`);",
  },
  {
    name: "bound mutation method is rejected",
    shouldFail: true,
    source: `
      const write = db.insert.bind(db);
      await write(mt5CommandsTable);
    `,
  },
  {
    name: "computed mutation method is rejected",
    shouldFail: true,
    source: `await db["update"](mt5CommandsTable).set({ status: "sent" });`,
  },
  {
    name: "destructured mutation method is rejected",
    shouldFail: true,
    source: `
      const { delete: remove } = db;
      await remove(mt5CommandsTable);
    `,
  },
  {
    name: "demo mailbox mutation is rejected",
    shouldFail: true,
    source: `await tx.insert(mt5DemoCommandsTable).values({});`,
  },
  {
    name: "mailbox helper is rejected",
    shouldFail: true,
    source: `await enqueueLiveCommand(payload);`,
  },
  {
    name: "order mutation method is rejected",
    shouldFail: true,
    source: `interface BadAdapter { submitOrder(): Promise<void> }`,
  },
  {
    name: "credential mutation method is rejected",
    shouldFail: true,
    source: `await adapter.rotateCredentials();`,
  },
  {
    name: "mock fallback is rejected",
    shouldFail: true,
    source: `return new MockBrokerProvider();`,
  },
  {
    name: "legacy registry fallback is rejected",
    shouldFail: true,
    source: `const provider = getBrokerProvider();`,
  },
  {
    name: "demo-backed legacy service is rejected",
    shouldFail: true,
    source: `const snapshot = await brokerReadOnly.getSnapshot();`,
  },
  {
    name: "live eligibility claim is rejected",
    shouldFail: true,
    source: `return { canPlaceLiveTrade: true };`,
  },
  {
    name: "fetch is rejected",
    shouldFail: true,
    source: `await fetch("https://broker.example");`,
  },
  {
    name: "node https request is rejected",
    shouldFail: true,
    source: `https.request("https://broker.example");`,
  },
  {
    name: "shared token dependency is rejected",
    shouldFail: true,
    source: `const token = process.env.MT5_BRIDGE_TOKEN;`,
  },
  {
    name: "legacy global MT5 provider is rejected",
    shouldFail: true,
    source: `return new MT5BridgeProvider();`,
  },
];

let failed = 0;
for (const fixture of fixtures) {
  const violations = scanBrokerHubSourceForViolations(fixture.source);
  const didFail = violations.length > 0;
  const passed = didFail === fixture.shouldFail;
  if (!passed) failed += 1;
  console.log(
    `${passed ? "PASS" : "FAIL"} ${fixture.name} (${violations.length} violation${
      violations.length === 1 ? "" : "s"
    })`,
  );
}

console.log(`\n${fixtures.length - failed}/${fixtures.length} broker-hub guard fixtures passed`);
process.exit(failed === 0 ? 0 : 1);
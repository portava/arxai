// Minimal in-memory stand-in for the drizzle `db` used by route handlers in
// module-mocked route tests. select().from(table) resolves to the rows
// registered for that table name (every where/orderBy/limit in the chain is
// ignored, so a fixture must contain only the caller's rows, already in the
// order the query would return them). insert(table).values(v).returning()
// resolves to [{ id, ...v }] and records the write.
import { getTableName, type Table } from "drizzle-orm";
import express, { type Router } from "express";
import type { AddressInfo } from "node:net";

export type FakeRows = Record<string, unknown[]>;

export function createFakeDb(rows: FakeRows) {
  const inserts: Array<{ table: string; values: Record<string, unknown> }> = [];
  let nextId = 1000;
  const chainFor = (resolveRows: () => unknown[]) => {
    const chain: Record<string, unknown> = {};
    const self = new Proxy(chain, {
      get(_t, prop) {
        if (prop === "then") {
          return (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
            Promise.resolve(resolveRows()).then(ok, bad);
        }
        if (prop === "catch") return (bad: (e: unknown) => unknown) => Promise.resolve(resolveRows()).catch(bad);
        return () => self;
      },
    });
    return self;
  };
  const db = {
    select: (_cols?: unknown) => ({
      from: (table: Table) => chainFor(() => [...(rows[getTableName(table)] ?? [])]),
    }),
    insert: (table: Table) => ({
      values: (values: Record<string, unknown>) => {
        const row = { id: nextId++, createdAt: new Date(), ...values };
        inserts.push({ table: getTableName(table), values });
        return chainFor(() => [row]);
      },
    }),
    update: (_table: Table) => ({ set: () => chainFor(() => []) }),
    delete: (_table: Table) => chainFor(() => []),
  };
  return { db, inserts };
}

/** Mount `router` under /api with a fixed authUser and run `fn` against it. */
export async function withRouter(
  router: Router,
  authUser: { id: number; role?: string },
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { authUser: unknown }).authUser = authUser;
    (req as unknown as { log: unknown }).log = { info() {}, warn() {}, error() {} };
    next();
  });
  app.use("/api", router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  try {
    await fn(base);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
}

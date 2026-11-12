# Read-only deployment schema preflight

From `arxai/artifacts/api-server`, using the existing `DATABASE_URL`:

```
node --import tsx src/scripts/schemaCompatibility.ts
```

The checker opens `BEGIN READ ONLY`, reads only schema metadata, and rolls back. It imports exported Drizzle definitions without importing the application pool or starting workers. It does not display connection settings, application rows, or database default expressions. Exit 0 means the checked structure matches; exit 1 means structural mismatches; exit 2 means inspection could not complete. Run with the intended application's database role: invisible tables fail closed as missing.

It checks every exported PostgreSQL table and column, resolving unqualified names through the actual search path. It checks nullability, known primitive types, and the presence of required database defaults. Application `$defaultFn` values are not database defaults. Length/precision, arrays, enums, custom types, indexes, constraints, triggers, grants, and exact default expressions are **not certified**. A passing result is a structural preflight, not migration or runtime readiness certification. Prospective receipt capture still requires its explicit opt-in migration.

For an initial runtime release that intentionally leaves the opt-in prospective harness uninstalled, select the required changed tables (do not treat missing opt-in tables as a runtime failure):

```
node --import tsx src/scripts/schemaCompatibility.ts --tables=calibration_fits,validation_evidence_v1,economic_events,mt5_connection
```

To generate SQL without connecting to a database:

```
node --import tsx src/scripts/schemaCompatibility.ts --sql --tables=calibration_fits,economic_events,mt5_connection
```

The generated read-only transaction reports missing tables/columns only; zero result rows means none are missing among the selected requirements. Execute the whole transaction where supported. In a UI that already enforces read-only queries and allows only a single statement, execute its `WITH ... SELECT ...` statement. Do not enable database editing. Omitting `--tables` includes all exported tables; unknown table selections are refused.

Focused verification:

```
node --import tsx --test src/scripts/__qa__/schemaCompatibility.test.ts
# Disposable local QA database only:
node --import tsx --test src/scripts/__qa__/schemaCompatibility.db.test.ts
```

The database test makes no schema changes: it checks the current schema, then supplies deliberately nonexistent table/column requirements and verifies both checker and exported SQL report them.

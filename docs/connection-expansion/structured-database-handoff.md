# Structured database Connection Service handoff

Baseline: `8e38ca3cd205a05e1e9945fb7d95205c545ac7bf`.

The canonical providers are `mysql`, `postgresql`, `oracle_database`, `clickhouse`,
`doris`, `starrocks`, and `sql_server` (the last one remains beta). Each
structured provider exposes the same seven actions:

`validate_connection`, `list_databases`, `list_schemas`, `list_tables`,
`describe_table`, `preview_table`, and `execute_read_query`.

`/v1/catalog` reports provider tier, `verified`, capability status, and evidence
references. Provider inventory size is not used as support evidence. Current
default tiers are:

- MySQL, PostgreSQL, ClickHouse, Doris, and StarRocks: verified against the
  real-engine evidence files in `docs/connection-expansion/evidence/`.
- Oracle: beta. Canonical-provider real-engine lifecycle, permission-scope, and
  negative-security evidence is recorded in
  `docs/connection-expansion/evidence/oracle-database-real-engine.json`, but the
  end-to-end AutoSkill MCP smoke was not run because the expected
  `../autoskill-creator-baseline` checkout is absent in this workspace.
- SQL Server: beta because the official container acceptance gate is externally
  blocked; see `sql-server-external-blocker.json`.

All database actions run through the canonical Provider/Action executor,
parameterized native drivers, parser-first read-only gates, bounded result and
scan budgets, TLS/pool/timeout handling, and guarded database egress. Public
runtime access to private/VPC databases fails closed unless the deployment
private-network flag and database egress allowlist are both enabled; private
workloads must be placed on a security-domain runner.

Connection leases persist revision, action, and optional schema/table scope.
Runtime action execution verifies tenant/workspace/principal, expiry, revocation,
connection revision, action scope, and database resource scope before invoking
the canonical executor. Existing execution audit, idempotency, redaction, and
restart recovery behavior remains in the Connection Service.

The W3 Web Discovery files and runtime MCP routes were not modified by this
database convergence change. The Oracle adapter routes remain as backward-
compatible compatibility entry points and share the same guarded Oracle driver
and read-only policy boundary.

Verification performed in this checkout:

- `npm exec -- vitest run src/providers/oracle_database/runtime.test.ts src/control-plane/oracle-adapter.test.ts src/core/database/runtime.test.ts src/control-plane/server.test.ts --reporter=dot`:
  4 test files passed; 45 tests passed.
- `DATABASE_PROVIDER=oracle_database ... npm exec -- tsx scripts/verify-database-provider.ts`:
  passed against `gvenzl/oracle-free:23-slim` with `STEP3B.STEP3B_ORDERS`;
  evidence written to
  `docs/connection-expansion/evidence/oracle-database-real-engine.json`.
- `npm test`: 182 test files passed, 1 skipped; 1,652 tests passed, 4 skipped.
- `npm run typecheck`: passed.
- `npm run lint -- --deny-warnings`: passed.
- `npm run format`: passed.

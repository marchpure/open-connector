# Verification

Catalog coverage, local execution, and external API verification are separate states.

When documenting a provider, distinguish:

- Catalog-only actions: schemas and metadata are available for discovery.
- Locally executable actions: the open source runtime has an executor for the action.
- Verified coverage: maintainers have current evidence that the action or provider works against the real upstream API.

Do not imply that every catalog action is end-to-end verified unless that evidence is available in
public project artifacts. Prefer verification notes that users can reproduce from this repository,
such as example scripts, smoke tests, or public status pages.

## Database Runtime Drivers

PostgreSQL, MySQL, and Oracle Database are Node-only providers that require production database
drivers in the runtime image:

- PostgreSQL: `pg`
- MySQL: `mysql2`
- Oracle Database: `oracledb`

Oracle uses node-oracledb Thin mode for the current provider connection shape. The executor calls
`getConnection({ user, password, connectString })` with `host:port/service` and never calls
`initOracleClient()`, so the image must not depend on host Oracle Instant Client libraries for this
path. Thick mode would require Oracle Instant Client libraries installed in the image for each target
architecture plus a startup gate that fails when those libraries are unavailable.

Before publishing a W4-consumable image, verify the final Linux AMD64 image imports all database
drivers without credentials:

```sh
docker run --rm --platform linux/amd64 <image-ref> \
  node -e "await import('pg'); await import('mysql2/promise'); await import('oracledb'); console.log('driver import smoke ok: pg mysql2/promise oracledb')"
```

Real or approved-equivalent database fixtures are required for end-to-end coverage. Set these
environment variables and run the fixture verifier:

```sh
VERIFY_POSTGRESQL_HOST=127.0.0.1 \
VERIFY_POSTGRESQL_PORT=5432 \
VERIFY_POSTGRESQL_DATABASE=open_connector_test \
VERIFY_POSTGRESQL_USERNAME=reader \
VERIFY_POSTGRESQL_PASSWORD=... \
VERIFY_MYSQL_HOST=127.0.0.1 \
VERIFY_MYSQL_PORT=3306 \
VERIFY_MYSQL_DATABASE=open_connector_test \
VERIFY_MYSQL_USERNAME=reader \
VERIFY_MYSQL_PASSWORD=... \
VERIFY_ORACLE_DATABASE_HOST=127.0.0.1 \
VERIFY_ORACLE_DATABASE_PORT=1521 \
VERIFY_ORACLE_DATABASE_DATABASE=FREEPDB1 \
VERIFY_ORACLE_DATABASE_USERNAME=reader \
VERIFY_ORACLE_DATABASE_PASSWORD=... \
node scripts/verify-database-runtime.ts
```

The verifier performs connection validation, schema discovery, and a minimal read-only Action for
each database. Its output intentionally includes only service names, profile display names, granted
scopes, and result counts.

import { writeFile } from "node:fs/promises";
import { OracleDatabaseAdapter } from "../src/control-plane/oracle-adapter.ts";
import { OracleThinDriver } from "../src/control-plane/oracle-driver.ts";

const host = requiredEnv("STEP2B_ORACLE_HOST");
const port = Number(requiredEnv("STEP2B_ORACLE_PORT"));
const serviceName = requiredEnv("STEP2B_ORACLE_SERVICE");
const user = requiredEnv("STEP2B_ORACLE_USER");
const password = requiredEnv("STEP2B_ORACLE_PASSWORD");
const schema = requiredEnv("STEP2B_ORACLE_SCHEMA").toUpperCase();
const table = requiredEnv("STEP2B_ORACLE_TABLE").toUpperCase();
const output = process.env.STEP2B_ORACLE_EVIDENCE;

const driver = new OracleThinDriver({ host, port, serviceName }, { user, password, poolMin: 1, poolMax: 2 });
const adapter = new OracleDatabaseAdapter({ host, port, serviceName }, driver, {
  maxRows: 100,
  maxBytes: 1024 * 1024,
  timeoutMs: 10_000,
  maxConcurrent: 2,
  allowedSchemas: [schema],
});

try {
  const query = await adapter.query("select 1 as value from dual");
  const schemas = await adapter.discover();
  const tables = await adapter.discover({ schema });
  const columns = await adapter.discover({ schema, table });
  let writeRejected = false;
  try {
    await adapter.query(`select * from ${schema}.${table} for update`);
  } catch (error) {
    writeRejected = error instanceof Error && "code" in error && error.code === "write_query";
  }
  const evidence = {
    generatedAt: new Date().toISOString(),
    target: { host, port, serviceName, schema, table },
    credentialsRecorded: false,
    checks: {
      selectDual: query.rows,
      schemas,
      tables,
      columns,
      writeRejectedBeforeExecution: writeRejected,
    },
    status:
      query.rows.length === 1 &&
      "schemas" in schemas &&
      schemas.schemas.includes(schema) &&
      "tables" in tables &&
      tables.tables.includes(table) &&
      "columns" in columns &&
      columns.columns.length > 0 &&
      writeRejected,
  };
  const serialized = JSON.stringify(evidence, null, 2);
  if (output) await writeFile(output, serialized);
  console.log(serialized);
  if (!evidence.status) process.exitCode = 1;
} finally {
  await driver.close();
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

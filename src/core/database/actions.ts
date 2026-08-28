import type { ActionDefinition, JsonSchema } from "../types.ts";

import { s } from "../json-schema.ts";
import { defineProviderAction } from "../provider-definition.ts";

const pageInput = {
  cursor: s.string("Opaque offset cursor returned by the previous page."),
  pageSize: s.integer("Maximum items to return.", { minimum: 1, maximum: 200, default: 100 }),
};

const pageFields = {
  nextCursor: s.nullableString("Cursor for the next page, or null when this is the final page."),
  truncated: s.boolean("Whether more matching items exist."),
};

const parameterSchema = s.union(
  [
    s.string("String query parameter."),
    s.number("Numeric query parameter."),
    s.boolean("Boolean query parameter."),
    { type: "null", description: "Null query parameter." },
  ],
  { description: "One bound scalar query parameter." },
);

const rowSchema = s.looseObject("One database row keyed by column name.");

function pagedInput(description: string, fields: Record<string, JsonSchema> = {}): JsonSchema {
  return s.object(
    description,
    { ...fields, ...pageInput },
    { optional: [...Object.keys(fields), "cursor", "pageSize"] },
  );
}

function pagedOutput(description: string, itemName: string, item: JsonSchema): JsonSchema {
  return s.object(description, {
    [itemName]: s.array(`The returned ${itemName}.`, item),
    ...pageFields,
  });
}

export function createDatabaseActions(service: string, engineName: string): ActionDefinition[] {
  const database = s.object(`One ${engineName} database or catalog.`, {
    name: s.string("Database or catalog name."),
  });
  const schema = s.object(`One ${engineName} schema.`, {
    database: s.string("Containing database or catalog."),
    name: s.string("Schema name."),
  });
  const table = s.object(`One ${engineName} table or view.`, {
    database: s.string("Containing database or catalog."),
    schema: s.string("Containing schema."),
    name: s.string("Table or view name."),
    type: s.stringEnum("Object type.", ["table", "view"]),
  });
  const column = s.object(`One ${engineName} column.`, {
    name: s.string("Column name."),
    dataType: s.string("Provider-native data type."),
    nullable: s.boolean("Whether the column accepts null."),
    ordinal: s.integer("One-based column position."),
    defaultValue: s.nullableString("Provider-native default expression, if present."),
  });
  const queryOutput = s.object(`Bounded ${engineName} query result.`, {
    columns: s.array(
      "Result columns.",
      s.object("One result column.", {
        name: s.string("Column name."),
        dataType: s.nullableString("Provider-native data type, when available."),
      }),
    ),
    rows: s.array("Result rows.", rowSchema),
    rowCount: s.integer("Rows returned."),
    bytes: s.integer("Serialized result size in bytes."),
    truncated: s.boolean("Whether the configured row or byte budget truncated the result."),
  });

  return [
    defineProviderAction(service, {
      name: "validate_connection",
      description: `Validate the configured ${engineName} connection and report the server version.`,
      inputSchema: s.object("No input is required.", {}),
      outputSchema: s.object("Connection validation result.", {
        ok: s.boolean("Whether validation succeeded."),
        engine: s.string("Detected database engine."),
        version: s.string("Detected server version."),
        database: s.string("Current database or catalog."),
      }),
    }),
    defineProviderAction(service, {
      name: "list_databases",
      description: `List visible ${engineName} databases or catalogs with bounded offset pagination.`,
      inputSchema: pagedInput("Database listing options."),
      outputSchema: pagedOutput("Database listing page.", "databases", database),
    }),
    defineProviderAction(service, {
      name: "list_schemas",
      description: `List visible ${engineName} schemas with bounded offset pagination.`,
      inputSchema: pagedInput("Schema listing options.", {
        database: s.string("Database or catalog to inspect. Defaults to the connection database."),
      }),
      outputSchema: pagedOutput("Schema listing page.", "schemas", schema),
    }),
    defineProviderAction(service, {
      name: "list_tables",
      description: `List visible ${engineName} tables and views with bounded offset pagination.`,
      inputSchema: pagedInput("Table listing options.", {
        database: s.string("Database or catalog to inspect. Defaults to the connection database."),
        schema: s.string("Schema to inspect. Defaults to the engine's normal schema."),
      }),
      outputSchema: pagedOutput("Table listing page.", "tables", table),
    }),
    defineProviderAction(service, {
      name: "describe_table",
      description: `Describe columns for one ${engineName} table.`,
      inputSchema: s.object(
        "Table identity.",
        {
          database: s.string("Database or catalog. Defaults to the connection database."),
          schema: s.string("Schema. Defaults to the engine's normal schema."),
          table: s.nonWhitespaceString("Table name."),
        },
        { optional: ["database", "schema"] },
      ),
      outputSchema: s.object("Table description.", {
        database: s.string("Containing database or catalog."),
        schema: s.string("Containing schema."),
        table: s.string("Table name."),
        columns: s.array("Columns in ordinal order.", column),
      }),
    }),
    defineProviderAction(service, {
      name: "preview_table",
      description: `Preview a bounded page from one ${engineName} table using strictly quoted identifiers.`,
      inputSchema: s.object(
        "Table preview options.",
        {
          database: s.string("Database or catalog. Defaults to the connection database."),
          schema: s.string("Schema. Defaults to the engine's normal schema."),
          table: s.nonWhitespaceString("Table name."),
          cursor: s.string("Opaque offset cursor returned by the previous page."),
          pageSize: s.integer("Maximum rows to return.", { minimum: 1, maximum: 200, default: 100 }),
        },
        { optional: ["database", "schema", "cursor", "pageSize"] },
      ),
      outputSchema: s.object("Table preview page.", {
        result: queryOutput,
        ...pageFields,
      }),
    }),
    defineProviderAction(service, {
      name: "execute_read_query",
      description: `Execute one parameterized, read-only ${engineName} SELECT or WITH query.`,
      inputSchema: s.object(
        "Read query request.",
        {
          query: s.nonWhitespaceString("One read-only SELECT or WITH statement."),
          parameters: s.array("Scalar values bound through the native driver.", parameterSchema, { maxItems: 256 }),
          maxRows: s.integer("Maximum returned rows.", { minimum: 1, maximum: 1000, default: 1000 }),
          timeoutMs: s.integer("Query timeout in milliseconds.", {
            minimum: 100,
            maximum: 30_000,
            default: 30_000,
          }),
        },
        { optional: ["parameters", "maxRows", "timeoutMs"] },
      ),
      outputSchema: queryOutput,
    }),
  ];
}

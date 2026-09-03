import type { ActionDefinition, JsonSchema } from "../core/types.ts";

import { s } from "../core/json-schema.ts";
import { defineProviderAction } from "../core/provider-definition.ts";

const tableSchema = s.object("A database table or view discovered from the connected database.", {
  schema: s.string("Database schema or owner name."),
  name: s.string("Table or view name."),
  type: s.string("Database object type."),
});

const columnSchema = s.object(
  "A database column discovered from the connected database.",
  {
    schema: s.string("Database schema or owner name."),
    table: s.string("Table or view name."),
    name: s.string("Column name."),
    dataType: s.string("Database-native data type."),
    nullable: s.boolean("Whether the column permits NULL values."),
    ordinalPosition: s.integer("One-based column position."),
  },
  { optional: ["nullable", "ordinalPosition"] },
);

const resultSchema = s.looseRequiredObject("A SQL result row.", {});

export function databaseActions(service: string, displayName: string): ActionDefinition[] {
  return [
    defineProviderAction(service, {
      name: "discover_schema",
      description: `Discover ${displayName} schemas, tables, views, and columns visible to the configured connection.`,
      inputSchema: s.object(
        `Optional ${displayName} discovery filters.`,
        {
          schema: s.nonEmptyString("Optional schema or owner name to inspect."),
          table: s.nonEmptyString("Optional table or view name to inspect."),
          limit: s.positiveInteger("Maximum number of tables and columns to return.", { maximum: 500 }),
        },
        { optional: ["schema", "table", "limit"] },
      ),
      outputSchema: s.object(`The discovered ${displayName} schema metadata.`, {
        tables: s.array("Tables and views visible to the connection.", tableSchema),
        columns: s.array("Columns visible to the connection.", columnSchema),
      }),
    }),
    defineProviderAction(service, {
      name: "query_readonly",
      description: `Execute a read-only SELECT statement against ${displayName}.`,
      inputSchema: s.object(
        `A read-only ${displayName} query.`,
        {
          sql: s.nonEmptyString(
            "A single SELECT statement. Comments, multiple statements, and mutations are rejected.",
          ),
          parameters: {
            type: "array",
            items: {},
            description: "Optional positional query parameters.",
          } satisfies JsonSchema,
          maxRows: s.positiveInteger("Maximum rows to return.", { maximum: 1000 }),
        },
        { optional: ["parameters", "maxRows"] },
      ),
      outputSchema: s.object(`Rows returned by ${displayName}.`, {
        rows: s.array("Result rows.", resultSchema),
        rowCount: s.nonNegativeInteger("Number of rows returned."),
        truncated: s.boolean("Whether the result exceeded maxRows."),
      }),
    }),
  ];
}

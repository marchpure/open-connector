import type { ProviderActionDefinition } from "../../core/provider-definition.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "maxcompute";
const page = {
  cursor: s.string("Opaque MaxCompute marker returned by the previous page."),
  pageSize: s.integer("Maximum records to return.", { minimum: 1, maximum: 100, default: 100 }),
};
const paging = {
  nextCursor: s.nullableString("Marker for the next page."),
  truncated: s.boolean("Whether another page is available."),
};

export const maxcomputeActions: ProviderActionDefinition[] = [
  defineProviderAction(service, {
    name: "validate_connection",
    description: "Validate server-managed MaxCompute credentials and the configured project.",
    inputSchema: s.object("No input is required.", {}),
    outputSchema: s.object("Validation result.", {
      ok: s.boolean("Whether validation succeeded."),
      project: s.string("Validated project."),
      region: s.string("Configured region."),
    }),
  }),
  defineProviderAction(service, {
    name: "list_projects",
    description: "List visible MaxCompute projects through the official SDK.",
    inputSchema: s.object("Project page.", page, { optional: ["cursor", "pageSize"] }),
    outputSchema: s.object("Visible projects.", {
      projects: s.array("Projects.", s.object("One project.", { name: s.string("Project name.") })),
      ...paging,
    }),
  }),
  defineProviderAction(service, {
    name: "list_tables",
    description: "List tables in a MaxCompute project and schema.",
    inputSchema: s.object(
      "Table page.",
      {
        project: s.string("Project name; defaults to the configured project."),
        schema: s.string("Schema name; defaults to default."),
        ...page,
      },
      { optional: ["project", "schema", "cursor", "pageSize"] },
    ),
    outputSchema: s.object("Visible tables.", {
      tables: s.array(
        "Tables.",
        s.object("One table.", {
          project: s.string("Project name."),
          schema: s.string("Schema name."),
          name: s.string("Table name."),
          type: s.string("MaxCompute table type."),
        }),
      ),
      ...paging,
    }),
  }),
  defineProviderAction(service, {
    name: "describe_table",
    description: "Describe a MaxCompute table with native and partition columns.",
    inputSchema: s.object(
      "Table identity.",
      {
        project: s.string("Project name; defaults to the configured project."),
        schema: s.string("Schema name; defaults to default."),
        table: s.nonWhitespaceString("Table name."),
      },
      { optional: ["project", "schema"] },
    ),
    outputSchema: s.looseRequiredObject("MaxCompute table metadata.", {
      project: s.string("Project name."),
      schema: s.string("Schema name."),
      table: s.string("Table name."),
      columns: s.array(
        "Columns.",
        s.object("One column.", {
          name: s.string("Column name."),
          dataType: s.string("MaxCompute type."),
          partition: s.boolean("Whether this is a partition column."),
        }),
      ),
    }),
  }),
];

const sqlReadActions = new Set([
  "validate_connection",
  "list_databases",
  "list_schemas",
  "list_tables",
  "describe_table",
  "preview_table",
  "execute_read_query",
]);

const sqlServices = new Set([
  "postgresql",
  "mysql",
  "sql_server",
  "clickhouse",
  "doris",
  "starrocks",
  "oceanbase",
  "tidb_sql",
  "hologres",
  "hive",
  "trino",
]);
const maxcomputeReadActions = new Set(["validate_connection", "list_projects", "list_tables", "describe_table"]);

const elasticsearchReadActions = new Set([
  "ping_cluster",
  "list_indices",
  "get_index_schema",
  "query_index",
  "get_index_stats",
  "list_aliases",
  "get_cluster_health",
  "get_cluster_nodes",
  "list_shards",
  "get_document",
  "count_documents",
]);
const dataPlatformServices = new Set([...sqlServices, "maxcompute", "elasticsearch"]);

export function isDataPlatformService(service: string): boolean {
  return dataPlatformServices.has(service);
}

/**
 * Agent leases for knowledge-data connectors expose only reviewed bounded
 * reads. Provider management actions remain usable through normal owner flows.
 */
export function isAllowedDataPlatformLeaseAction(service: string, actionId: string): boolean {
  const prefix = `${service}.`;
  if (!actionId.startsWith(prefix)) return false;
  const action = actionId.slice(prefix.length);
  if (sqlServices.has(service)) return sqlReadActions.has(action);
  if (service === "maxcompute") return maxcomputeReadActions.has(action);
  if (service === "elasticsearch") return elasticsearchReadActions.has(action);
  return true;
}

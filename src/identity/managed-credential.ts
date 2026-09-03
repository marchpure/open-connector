import type { ResolvedCredential } from "../core/types.ts";

/**
 * Merge a broker response without allowing it to change the registered
 * connection boundary. Oracle brokers are intentionally limited to the
 * request-scoped database username and password.
 */
export function mergeManagedCredential(
  base: ResolvedCredential | undefined,
  resolved: ResolvedCredential,
  service: string,
): ResolvedCredential {
  if (
    service !== "oracle_database" ||
    base?.authType !== "custom_credential" ||
    resolved.authType !== "custom_credential"
  ) {
    return mergeResolvedCredential(base, resolved);
  }
  const secretValues = Object.fromEntries(
    Object.entries(resolved.values).filter(([key]) => key === "username" || key === "password"),
  );
  if (!secretValues.username || !secretValues.password) {
    throw new Error("Oracle Credential Broker must return username and password.");
  }
  return { ...resolved, values: { ...base.values, ...secretValues } };
}

function mergeResolvedCredential(
  base: ResolvedCredential | undefined,
  resolved: ResolvedCredential,
): ResolvedCredential {
  if (base?.authType === "custom_credential" && resolved.authType === "custom_credential") {
    return { ...resolved, values: { ...base.values, ...resolved.values } };
  }
  return resolved;
}

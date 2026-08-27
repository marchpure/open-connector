const sensitiveKey =
  /(password|secret|token|api[_-]?key|cookie|authorization|credential|private[_-]?key|client_secret|refresh)/i;

export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 8) {
    return "[REDACTED_DEPTH]";
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecrets(entry, depth + 1));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      sensitiveKey.test(key) ? "[REDACTED]" : redactSecrets(child, depth + 1),
    ]),
  );
}

export function safeConnectionProfile(profile: unknown): Record<string, unknown> {
  return redactSecrets(profile) as Record<string, unknown>;
}

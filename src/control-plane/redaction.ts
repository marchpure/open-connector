const sensitiveKey =
  /(password|secret|token|api[_-]?key|cookie|authorization|credential|private[_-]?key|client_secret|refresh|internal[_-]?url)/i;

export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 8) {
    return "[REDACTED_DEPTH]";
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecrets(entry, depth + 1));
  }
  if (!value || typeof value !== "object") {
    return typeof value === "string" && isInternalUrl(value) ? "[REDACTED]" : value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      sensitiveKey.test(key) ? "[REDACTED]" : redactSecrets(child, depth + 1),
    ]),
  );
}

function isInternalUrl(value: string): boolean {
  if (!/^https?:\/\//iu.test(value)) return false;
  try {
    const hostname = new URL(value).hostname.replace(/^\[|\]$/gu, "").toLowerCase();
    if (hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".internal")) return true;
    if (/^127\./u.test(hostname) || /^10\./u.test(hostname) || /^192\.168\./u.test(hostname)) return true;
    const match = /^172\.(\d+)\./u.exec(hostname);
    return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
  } catch {
    return false;
  }
}

export function safeConnectionProfile(profile: unknown): Record<string, unknown> {
  return redactSecrets(profile) as Record<string, unknown>;
}

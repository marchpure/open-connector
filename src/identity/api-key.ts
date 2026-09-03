import { createHash, timingSafeEqual } from "node:crypto";

/** Store only hashes of enterprise ingress keys; the clear key belongs in a secret manager. */
export function createApiKeyVerifier(expectedHashes: readonly string[]): (value: string | undefined) => boolean {
  const hashes = expectedHashes
    .map((value) => value.trim().toLowerCase())
    .filter((value) => /^[a-f0-9]{64}$/u.test(value))
    .map((value) => Buffer.from(value, "hex"));
  return (value) => {
    if (!value || hashes.length === 0) return false;
    const actual = createHash("sha256").update(value).digest();
    return hashes.some((expected) => expected.length === actual.length && timingSafeEqual(actual, expected));
  };
}

export function hashApiKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

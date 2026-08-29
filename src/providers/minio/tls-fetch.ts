import { createHash, X509Certificate } from "node:crypto";
import { Agent, fetch as undiciFetch } from "undici";
import { ProviderRequestError } from "../provider-runtime.ts";

const agents = new Map<string, Agent>();
const maxCachedAgents = 32;

/**
 * Build a Node-only fetch transport that trusts one connection-scoped CA.
 * The caller must wrap this transport with the shared egress guard.
 */
export async function createMinioTlsFetch(caCertificate: string): Promise<typeof fetch> {
  validateCertificate(caCertificate);
  const key = createHash("sha256").update(caCertificate).digest("hex");
  let agent = agents.get(key);
  if (!agent) {
    if (agents.size >= maxCachedAgents) {
      const oldest = agents.entries().next().value as [string, Agent] | undefined;
      if (oldest) {
        agents.delete(oldest[0]);
        void oldest[1].close();
      }
    }
    agent = new Agent({ connect: { ca: caCertificate, rejectUnauthorized: true } });
    agents.set(key, agent);
  }
  const dispatcher = agent;
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher,
    }) as unknown as Promise<Response>) as typeof fetch;
}

function validateCertificate(value: string): void {
  if (Buffer.byteLength(value, "utf8") > 64 * 1024) {
    throw new ProviderRequestError(400, "MinIO CA certificate exceeds 65536 bytes");
  }
  try {
    new X509Certificate(value);
  } catch {
    throw new ProviderRequestError(400, "MinIO CA certificate must be valid PEM-encoded X.509");
  }
}

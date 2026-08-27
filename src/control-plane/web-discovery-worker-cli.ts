import { runWebDiscoveryCapture } from "./web-discovery-worker.ts";

const serviceBaseUrl = new URL(requiredEnv("WEB_DISCOVERY_SERVICE_BASE_URL"));
const sessionId = requiredEnv("WEB_DISCOVERY_SESSION_ID");
const workerToken = requiredEnv("WEB_DISCOVERY_WORKER_TOKEN");
const serviceBearer = requiredEnv("WEB_DISCOVERY_SERVICE_BEARER");
const approvedOrigin = requiredEnv("WEB_DISCOVERY_APPROVED_ORIGIN");
const pageUrl = requiredEnv("WEB_DISCOVERY_PAGE_URL");

const result = await runWebDiscoveryCapture({
  pageUrl,
  approvedOrigin,
  executablePath: process.env.WEB_DISCOVERY_CHROME_PATH,
  storageStatePath: process.env.WEB_DISCOVERY_STORAGE_STATE_PATH,
  durationMs: positiveInteger(process.env.WEB_DISCOVERY_DURATION_MS, 60_000),
  submitObservation: async (observation) => {
    const response = await fetch(
      new URL(`/v1/web-discovery/sessions/${encodeURIComponent(sessionId)}/observations`, serviceBaseUrl),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${serviceBearer}`,
          "content-type": "application/json",
          "x-web-discovery-token": workerToken,
        },
        body: JSON.stringify(observation),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) throw new Error(`Observation submission failed with status ${response.status}.`);
  },
});

console.log(JSON.stringify({ worker: "web-discovery", status: "completed", ...result }));

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

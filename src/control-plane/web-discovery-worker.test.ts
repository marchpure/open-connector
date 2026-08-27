import { access } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createCatalogStore } from "../catalog-store.ts";
import { AesGcmSecretCodec } from "../server/secrets/secret-codec.ts";
import { createPrincipalToken } from "./auth.ts";
import { createConnectionControlApp } from "./server.ts";
import { runWebDiscoveryCapture } from "./web-discovery-worker.ts";

const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

describe("runWebDiscoveryCapture", () => {
  it("captures sanitized same-origin JSON traffic in an isolated real browser", async () => {
    await access(chromePath);
    const observations: unknown[] = [];

    const result = await runWebDiscoveryCapture({
      pageUrl: "https://app.example.test/",
      approvedOrigin: "https://app.example.test",
      executablePath: chromePath,
      durationMs: 100,
      submitObservation: async (observation) => {
        observations.push(observation);
      },
      interact: async (page) => {
        await page.route("https://app.example.test/**", async (route) => {
          if (new URL(route.request().url()).pathname === "/") {
            await route.fulfill({
              contentType: "text/html",
              body: `<script>
                fetch("/api/orders/123?access_token=query-secret", {
                  method: "POST",
                  headers: { "content-type": "application/json", "x-csrf-token": "secret" },
                  body: JSON.stringify({ amount: 42, password: "secret" })
                });
              </script>`,
            });
          } else {
            await route.fulfill({
              contentType: "application/json",
              status: 201,
              body: JSON.stringify({ id: "123", token: "secret", total: 42 }),
            });
          }
        });
      },
    });

    expect(result).toEqual({ observationsSubmitted: 1, crossOriginNavigationsBlocked: 0 });
    expect(observations).toEqual([
      {
        url: "https://app.example.test/api/orders/123",
        method: "POST",
        requestHeaders: { accept: "*/*", "content-type": "application/json" },
        requestSample: { amount: 42 },
        responseStatus: 201,
        responseContentType: "application/json",
        responseSample: { id: "123", total: 42 },
      },
    ]);
  }, 30_000);

  it("does not retain cookies between capture sessions", async () => {
    await access(chromePath);
    const cookieHeaders: Array<string | undefined> = [];
    const capture = () =>
      runWebDiscoveryCapture({
        pageUrl: "https://app.example.test/",
        approvedOrigin: "https://app.example.test",
        executablePath: chromePath,
        durationMs: 50,
        submitObservation: async () => undefined,
        interact: async (page) => {
          await page.route("https://app.example.test/**", async (route) => {
            const path = new URL(route.request().url()).pathname;
            if (path === "/") {
              cookieHeaders.push(route.request().headers().cookie);
              await route.fulfill({
                contentType: "text/html",
                headers: { "set-cookie": "session=isolated; Secure; SameSite=Strict" },
                body: "<html>isolated</html>",
              });
            }
          });
        },
      });

    await capture();
    await capture();

    expect(cookieHeaders).toEqual([undefined, undefined]);
  }, 30_000);

  it("blocks cross-origin browser traffic before capture", async () => {
    await access(chromePath);
    const observations: unknown[] = [];
    const result = await runWebDiscoveryCapture({
      pageUrl: "https://app.example.test/",
      approvedOrigin: "https://app.example.test",
      executablePath: chromePath,
      durationMs: 100,
      submitObservation: async (observation) => {
        observations.push(observation);
      },
      interact: async (page) => {
        await page.route("https://app.example.test/", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: '<script>fetch("https://evil.example.test/api/private")</script>',
          }),
        );
      },
    });

    expect(result).toEqual({ observationsSubmitted: 0, crossOriginNavigationsBlocked: 1 });
    expect(observations).toEqual([]);
  }, 30_000);

  it("does not submit redirected traffic that may carry query credentials", async () => {
    await access(chromePath);
    const observations: unknown[] = [];
    const requests: string[] = [];
    await runWebDiscoveryCapture({
      pageUrl: "https://app.example.test/",
      approvedOrigin: "https://app.example.test",
      executablePath: chromePath,
      durationMs: 500,
      submitObservation: async (observation) => {
        observations.push(observation);
      },
      interact: async (page) => {
        page.on("request", (request) => requests.push(request.url()));
        await page.route("https://app.example.test/**", async (route) => {
          const path = new URL(route.request().url()).pathname;
          if (path === "/") {
            await route.fulfill({
              contentType: "text/html",
              body: '<script>fetch("/api/start")</script>',
            });
          } else if (path === "/api/start") {
            await route.fulfill({
              status: 307,
              headers: { location: "https://app.example.test/api/result?access_token=query-secret" },
              body: "",
            });
          } else {
            await route.fulfill({
              contentType: "application/json",
              body: JSON.stringify({ id: "result" }),
            });
          }
        });
      },
    });

    expect(requests).toContain("https://app.example.test/api/result?access_token=query-secret");
    expect(observations).toEqual([]);
  }, 30_000);

  it("does not treat an HTML-only page as an API", async () => {
    await access(chromePath);
    const observations: unknown[] = [];
    const result = await runWebDiscoveryCapture({
      pageUrl: "https://app.example.test/",
      approvedOrigin: "https://app.example.test",
      executablePath: chromePath,
      durationMs: 50,
      submitObservation: async (observation) => {
        observations.push(observation);
      },
      interact: async (page) => {
        await page.route("https://app.example.test/", (route) =>
          route.fulfill({ contentType: "text/html", body: "<html><body>No API</body></html>" }),
        );
      },
    });

    expect(result.observationsSubmitted).toBe(0);
    expect(observations).toEqual([]);
  }, 30_000);

  it("submits a real-browser observation through the authenticated control API for explicit confirmation", async () => {
    await access(chromePath);
    const app = createConnectionControlApp({
      catalog: createCatalogStore([]),
      providerLoader: {
        loadActionExecutor: async () => undefined,
        loadProxyExecutor: async () => undefined,
        loadCredentialValidators: async () => undefined,
      },
      controlDatabase: new DatabaseSync(":memory:"),
      secretCodec: new AesGcmSecretCodec("web-worker-e2e-key"),
      authSecret: "web-worker-auth",
      publicOrigin: "http://localhost:3417",
      enablement: [],
    });
    const token = createPrincipalToken(
      {
        tenantId: "tenant-worker",
        workspaceId: "workspace-worker",
        subject: "user-worker",
        ownerId: "user-worker",
        audience: "runtime",
      },
      "web-worker-auth",
    );
    const authHeaders = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const started = await app.request("/v1/web-discovery/sessions", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ origin: "https://app.example.test" }),
    });
    const { session } = (await started.json()) as {
      session: { id: string; workerToken: string };
    };

    const captured = await runWebDiscoveryCapture({
      pageUrl: "https://app.example.test/",
      approvedOrigin: "https://app.example.test",
      executablePath: chromePath,
      durationMs: 500,
      submitObservation: async (observation) => {
        const response = await app.request(`/v1/web-discovery/sessions/${session.id}/observations`, {
          method: "POST",
          headers: { ...authHeaders, "x-web-discovery-token": session.workerToken },
          body: JSON.stringify(observation),
        });
        expect(response.status).toBe(201);
      },
      interact: async (page) => {
        await page.route("https://app.example.test/**", async (route) => {
          if (new URL(route.request().url()).pathname === "/") {
            await route.fulfill({
              contentType: "text/html",
              body: '<script>fetch("/api/orders/123").then(response => response.json())</script>',
            });
          } else {
            await route.fulfill({ contentType: "application/json", body: JSON.stringify({ id: "123", total: 42 }) });
          }
        });
      },
    });
    expect(captured.observationsSubmitted).toBe(1);

    const candidatesResponse = await app.request(`/v1/web-discovery/sessions/${session.id}/candidates`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const { items } = (await candidatesResponse.json()) as {
      items: Array<{ id: string; origin: string; path: string; readOnly: boolean }>;
    };
    expect(items).toMatchObject([{ origin: "https://app.example.test", path: "/api/orders/{id}", readOnly: true }]);
    const confirmed = await app.request(`/v1/web-discovery/sessions/${session.id}/confirm`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        candidateId: items[0].id,
        origin: items[0].origin,
        operationId: "getOrder",
        readOnly: true,
      }),
    });
    expect(confirmed.status).toBe(201);
    await expect(confirmed.json()).resolves.toMatchObject({
      definition: {
        baseUrl: "https://app.example.test",
        operations: [{ operationId: "getOrder", method: "GET", path: "/api/orders/{id}", readOnly: true }],
      },
    });
  }, 30_000);
});

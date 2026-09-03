import { describe, expect, it } from "vitest";
import { Hono } from "hono";

import { registerOAuthCompatRoutes } from "./oauth-compat.ts";

function createApp(): Hono {
  const app = new Hono();
  registerOAuthCompatRoutes(app, {
    origin: "https://connector.example",
    upstreamIssuer: "https://identity.example/",
    clientId: "workbuddy-public",
    stateSecret: "test-state-secret",
  });
  return app;
}

describe("OAuth compatibility routes", () => {
  it("publishes protected-resource metadata and maps registration to the approved client", async () => {
    const app = createApp();

    const metadata = await app.request("https://connector.example/.well-known/oauth-protected-resource/mcp");
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({
      resource: "https://connector.example",
      authorization_servers: ["https://connector.example"],
    });

    const registration = await app.request("https://connector.example/oauth/register", { method: "POST" });
    expect(registration.status).toBe(200);
    expect(await registration.json()).toMatchObject({
      client_id: "workbuddy-public",
      token_endpoint_auth_method: "none",
    });
  });

  it("rejects unsupported clients and redirects", async () => {
    const app = createApp();

    const unsupportedClient = await app.request(
      "https://connector.example/oauth/authorize?client_id=other&response_type=code",
    );
    expect(unsupportedClient.status).toBe(400);

    const unsupportedRedirect = await app.request(
      "https://connector.example/oauth/authorize?client_id=workbuddy-public&response_type=code&redirect_uri=https%3A%2F%2Fevil.example%2Fcallback",
    );
    expect(unsupportedRedirect.status).toBe(400);
  });
});

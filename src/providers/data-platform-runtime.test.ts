import { afterEach, describe, expect, it } from "vitest";
import { setPrivateNetworkAccessAllowed } from "../core/request.ts";
import { createOceanbaseBackend } from "./oceanbase/runtime.ts";
import { createTrinoBackend } from "./trino/runtime.ts";

describe("data platform runtime contracts", () => {
  afterEach(() => {
    setPrivateNetworkAccessAllowed(false);
  });

  it("requires an explicit OceanBase compatibility mode before network access", async () => {
    expect(() =>
      createOceanbaseBackend({
        host: "database.example.com",
        database: "test",
        username: "reader",
        password: "secret",
        mode: "postgresql",
      }),
    ).toThrow(
      expect.objectContaining({
        code: "database_query_rejected",
        message: expect.stringContaining("mysql or oracle"),
      }),
    );
  });

  it("requires explicit Trino auth and TLS for Basic credentials", async () => {
    await expect(
      createTrinoBackend({
        host: "trino.example.com",
        port: "8080",
        database: "system",
        username: "reader",
        password: "secret",
        tls: "disable",
        authMode: "basic",
      }),
    ).rejects.toMatchObject({
      code: "database_tls_failed",
    });
  });

  it("keeps private database endpoints fail closed without deployment opt-in", async () => {
    await expect(
      createTrinoBackend({
        host: "10.0.0.2",
        port: "8080",
        database: "system",
        username: "reader",
        password: "secret",
        tls: "disable",
        authMode: "none",
      }),
    ).rejects.toMatchObject({
      code: "database_network_failed",
    });
  });
});

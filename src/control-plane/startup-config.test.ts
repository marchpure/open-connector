import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConnectionServiceStartupConfig } from "./startup-config.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("connection service startup configuration", () => {
  it("accepts an HTTPS public origin, strong distinct secrets, and a writable store", async () => {
    const dataDir = await tempDir();
    await expect(
      loadConnectionServiceStartupConfig({
        NODE_ENV: "production",
        CONNECTION_SERVICE_DATA_DIR: dataDir,
        CONNECTION_SERVICE_PUBLIC_ORIGIN: "https://connection.example.com",
        CONNECTION_SERVICE_AUTH_SECRET: "auth-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ",
        CONNECTION_SERVICE_ENCRYPTION_KEY: "encrypt-ABCDEFGHIJKLMNOPQRSTUVWXYZ-9876543210",
        CONNECTION_SERVICE_EGRESS_POLICY: "public-only",
        OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK: "false",
      }),
    ).resolves.toMatchObject({
      publicOrigin: "https://connection.example.com",
      dataDir,
      allowPrivateNetwork: false,
    });
  });

  it.each([
    [{}, "CONNECTION_SERVICE_AUTH_SECRET"],
    [
      {
        CONNECTION_SERVICE_AUTH_SECRET: "auth-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      },
      "CONNECTION_SERVICE_ENCRYPTION_KEY",
    ],
    [
      {
        CONNECTION_SERVICE_AUTH_SECRET: "auth-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ",
        CONNECTION_SERVICE_ENCRYPTION_KEY: "encrypt-ABCDEFGHIJKLMNOPQRSTUVWXYZ-9876543210",
      },
      "CONNECTION_SERVICE_PUBLIC_ORIGIN",
    ],
  ])("fails before listening when required configuration is missing", async (partial, message) => {
    await expect(loadConnectionServiceStartupConfig(partial)).rejects.toThrow(message);
  });

  it("requires an explicit allowlist for private database egress", async () => {
    const dataDir = await tempDir();
    await expect(
      loadConnectionServiceStartupConfig({
        NODE_ENV: "production",
        CONNECTION_SERVICE_DATA_DIR: dataDir,
        CONNECTION_SERVICE_PUBLIC_ORIGIN: "https://connection.example.com",
        CONNECTION_SERVICE_AUTH_SECRET: "auth-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ",
        CONNECTION_SERVICE_ENCRYPTION_KEY: "encrypt-ABCDEFGHIJKLMNOPQRSTUVWXYZ-9876543210",
        CONNECTION_SERVICE_EGRESS_POLICY: "private-allowlist",
        OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK: "true",
      }),
    ).rejects.toThrow("CONNECTION_DATABASE_EGRESS_ALLOWLIST");
  });

  it("rejects an HTTP public origin and relative production data directory", async () => {
    const common = {
      NODE_ENV: "production",
      CONNECTION_SERVICE_AUTH_SECRET: "auth-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      CONNECTION_SERVICE_ENCRYPTION_KEY: "encrypt-ABCDEFGHIJKLMNOPQRSTUVWXYZ-9876543210",
    };
    await expect(
      loadConnectionServiceStartupConfig({
        ...common,
        CONNECTION_SERVICE_DATA_DIR: "/tmp/connection-test",
        CONNECTION_SERVICE_PUBLIC_ORIGIN: "http://connection.example.com",
      }),
    ).rejects.toThrow("HTTPS");
    await expect(
      loadConnectionServiceStartupConfig({
        ...common,
        CONNECTION_SERVICE_DATA_DIR: "relative",
        CONNECTION_SERVICE_PUBLIC_ORIGIN: "https://connection.example.com",
      }),
    ).rejects.toThrow("absolute");
  });
});

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "connection-startup-"));
  roots.push(root);
  return root;
}

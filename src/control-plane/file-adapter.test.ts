import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { TenantFileAdapter, FileAdapterError } from "./file-adapter.ts";

const transit = {
  maxBytes: 1024 * 1024,
  async create(file: File) {
    return { fileId: "file-1", downloadUrl: "/files/file-1", sizeBytes: file.size, name: file.name, mimeType: file.type };
  },
  async read() {
    return { file: new File(["hello"], "x.txt"), sizeBytes: 5, name: "x.txt", mimeType: "text/plain" };
  },
  async delete() { return true; },
  async cleanupExpired() {},
} as never;

describe("TenantFileAdapter", () => {
  it("accepts clean JSON and rejects malformed or unsupported content", async () => {
    const files = new TenantFileAdapter("tenant-a", "workspace-a", transit, new DatabaseSync(":memory:"));
    await expect(files.upload(new File(['{"ok":true}'], "data.json", { type: "application/json" }))).resolves.toMatchObject({
      kind: "json",
      scanStatus: "clean",
    });
    await expect(files.upload(new File(["not-json"], "data.json"))).rejects.toMatchObject({ code: "malicious_input" });
    await expect(files.upload(new File(["x"], "data.exe"))).rejects.toThrowError(
      new FileAdapterError("unsupported_type", "Only CSV, Excel, JSON, Parquet, PDF, Markdown, and text files are supported."),
    );
  });
});

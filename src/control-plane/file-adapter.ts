import type {
  IStagedTransitFileService,
  ITransitFileService,
  StagedTransitFile,
  TransitFileUpload,
} from "../server/files/transit-file-store.ts";
import type { DatabaseSync } from "node:sqlite";

import { strFromU8, unzipSync } from "fflate";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile } from "node:fs/promises";

export type SupportedFileKind = "csv" | "excel" | "json" | "parquet" | "pdf" | "md" | "txt";

const extensionKinds: Record<string, SupportedFileKind> = {
  ".csv": "csv",
  ".xls": "excel",
  ".xlsx": "excel",
  ".json": "json",
  ".parquet": "parquet",
  ".pdf": "pdf",
  ".md": "md",
  ".txt": "txt",
};

export interface FileProfile extends TransitFileUpload {
  tenantId: string;
  workspaceId: string;
  kind: SupportedFileKind;
  sha256: string;
  scanStatus: "clean";
}

export type FilePreview =
  | { kind: "csv"; columns: string[]; rows: string[][]; truncated: boolean }
  | { kind: "json"; value: unknown; truncated: boolean }
  | { kind: "md" | "txt"; text: string; truncated: boolean }
  | { kind: "excel"; sheets: Array<{ name: string; rows: string[][] }>; truncated: boolean }
  | { kind: "parquet"; columns: string[]; rows: Record<string, unknown>[]; truncated: boolean }
  | { kind: "pdf"; text: string; pageCount: number; truncated: boolean };

export class FileAdapterError extends Error {
  readonly code: "unsupported_type" | "malicious_input" | "file_too_large";

  constructor(code: FileAdapterError["code"], message: string) {
    super(message);
    this.name = "FileAdapterError";
    this.code = code;
  }
}

export class TenantFileAdapter {
  private readonly tenantId: string;
  private readonly workspaceId: string;
  private readonly transitFiles: ITransitFileService;
  private readonly database: DatabaseSync;

  constructor(tenantId: string, workspaceId: string, transitFiles: ITransitFileService, database: DatabaseSync) {
    this.tenantId = tenantId;
    this.workspaceId = workspaceId;
    this.transitFiles = transitFiles;
    this.database = database;
    this.database.exec(`
      create table if not exists tenant_files (
        file_id text primary key,
        tenant_id text not null,
        workspace_id text not null,
        name text not null,
        mime_type text not null,
        size_bytes integer not null,
        kind text not null,
        sha256 text not null,
        scan_status text not null,
        created_at text not null
      );
      create index if not exists idx_tenant_files_scope
        on tenant_files (tenant_id, workspace_id);
    `);
  }

  async upload(file: File): Promise<FileProfile> {
    const kind = detectKind(file.name);
    if (!kind) {
      throw new FileAdapterError(
        "unsupported_type",
        "Only CSV, Excel, JSON, Parquet, PDF, Markdown, and text files are supported.",
      );
    }
    if (file.size > this.transitFiles.maxBytes) {
      throw new FileAdapterError("file_too_large", "File exceeds the configured maximum size.");
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    scanBytes(kind, bytes);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = Buffer.from(digest).toString("hex");
    const duplicate = this.findDuplicate(sha256);
    if (duplicate) return duplicate;
    const upload = await this.transitFiles.create(new File([bytes], file.name, { type: file.type }));
    return this.persistProfile(upload, kind, sha256);
  }

  private findDuplicate(sha256: string): FileProfile | undefined {
    const duplicate = this.database
      .prepare(
        `select * from tenant_files
          where tenant_id=? and workspace_id=? and sha256=?
          order by created_at limit 1`,
      )
      .get(this.tenantId, this.workspaceId, sha256) as Record<string, unknown> | undefined;
    return duplicate ? rowToFileProfile(duplicate) : undefined;
  }

  private persistProfile(upload: TransitFileUpload, kind: SupportedFileKind, sha256: string): FileProfile {
    const profile: FileProfile = {
      ...upload,
      tenantId: this.tenantId,
      workspaceId: this.workspaceId,
      kind,
      sha256,
      scanStatus: "clean",
    };
    this.database
      .prepare(
        `insert into tenant_files
        (file_id, tenant_id, workspace_id, name, mime_type, size_bytes, kind, sha256, scan_status, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        profile.fileId,
        profile.tenantId,
        profile.workspaceId,
        profile.name,
        profile.mimeType,
        profile.sizeBytes,
        profile.kind,
        profile.sha256,
        profile.scanStatus,
        new Date().toISOString(),
      );
    return profile;
  }

  async uploadFromPath(file: StagedTransitFile): Promise<FileProfile> {
    const kind = detectKind(file.name);
    if (!kind) {
      throw new FileAdapterError(
        "unsupported_type",
        "Only CSV, Excel, JSON, Parquet, PDF, Markdown, and text files are supported.",
      );
    }
    if (file.sizeBytes > this.transitFiles.maxBytes) {
      throw new FileAdapterError("file_too_large", "File exceeds the configured maximum size.");
    }
    if (!isStagedTransitFileService(this.transitFiles)) {
      throw new FileAdapterError("unsupported_type", "Configured file storage does not accept staged uploads.");
    }
    await scanPath(kind, file.path);
    const sha256 = await hashPath(file.path);
    const duplicate = this.findDuplicate(sha256);
    if (duplicate) return duplicate;
    const upload = await this.transitFiles.createFromPath(file);
    return this.persistProfile(upload, kind, sha256);
  }

  list(): FileProfile[] {
    const rows = this.database
      .prepare("select * from tenant_files where tenant_id=? and workspace_id=? order by created_at")
      .all(this.tenantId, this.workspaceId) as Record<string, unknown>[];
    return rows.map(rowToFileProfile);
  }

  async read(fileId: string): Promise<File> {
    const profile = this.list().find((file) => file.fileId === fileId);
    if (!profile) {
      throw new FileAdapterError("malicious_input", "File is not owned by this tenant.");
    }
    return (await this.transitFiles.read(profile.fileId)).file;
  }

  async delete(fileId: string): Promise<boolean> {
    const profile = this.list().find((file) => file.fileId === fileId);
    if (!profile) return false;
    const deleted = await this.transitFiles.delete(profile.fileId);
    this.database
      .prepare("delete from tenant_files where file_id=? and tenant_id=? and workspace_id=?")
      .run(fileId, this.tenantId, this.workspaceId);
    return deleted;
  }

  async preview(fileId: string): Promise<FilePreview> {
    const profile = this.list().find((file) => file.fileId === fileId);
    if (!profile) {
      throw new FileAdapterError("malicious_input", "File is not owned by this tenant.");
    }
    const file = (await this.transitFiles.read(profile.fileId)).file;
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (profile.kind === "excel") return previewExcel(bytes);
    if (profile.kind === "parquet") return previewParquet(bytes);
    if (profile.kind === "pdf") return previewPdf(bytes);
    const text = await file.text();
    if (profile.kind === "csv") {
      const parsed = parseCsv(text);
      const [columns = [], ...rows] = parsed;
      return {
        kind: "csv",
        columns: columns.slice(0, 50),
        rows: rows.slice(0, 20).map((row) => row.slice(0, 50)),
        truncated: rows.length > 20 || parsed.some((row) => row.length > 50),
      };
    }
    if (profile.kind === "json") {
      return { kind: "json", value: JSON.parse(text), truncated: false };
    }
    const truncated = text.length > 10_000;
    return { kind: profile.kind, text: text.slice(0, 10_000), truncated };
  }
}

function isStagedTransitFileService(service: ITransitFileService): service is IStagedTransitFileService {
  return "createFromPath" in service && typeof service.createFromPath === "function";
}

async function hashPath(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function scanPath(kind: SupportedFileKind, path: string): Promise<void> {
  if (kind === "csv") {
    await scanCsvStream(path);
    return;
  }
  if (kind === "md" || kind === "txt") return;
  if (kind === "pdf" || kind === "parquet") {
    const handle = await open(path, "r");
    try {
      const prefix = new Uint8Array(kind === "pdf" ? 5 : 4);
      await handle.read(prefix, 0, prefix.length, 0);
      scanBytes(kind, prefix);
    } finally {
      await handle.close();
    }
    return;
  }
  scanBytes(kind, new Uint8Array(await readFile(path)));
}

async function scanCsvStream(path: string): Promise<void> {
  let atCellStart = true;
  let quoted = false;
  let pendingQuote = false;
  for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
    for (const character of chunk) {
      if (quoted) {
        if (pendingQuote) {
          if (character === '"') {
            pendingQuote = false;
            continue;
          }
          quoted = false;
          pendingQuote = false;
        } else if (character === '"') {
          pendingQuote = true;
          continue;
        } else if (atCellStart && /[\t\r ]/.test(character)) {
          continue;
        } else if (atCellStart) {
          if ("=+-@".includes(character))
            throw new FileAdapterError("malicious_input", "CSV spreadsheet formulas are not allowed.");
          atCellStart = false;
        }
      }
      if (!quoted) {
        if (character === '"' && atCellStart) {
          quoted = true;
        } else if (character === "," || character === "\n") {
          atCellStart = true;
        } else if (atCellStart && /[\t\r ]/.test(character)) {
          continue;
        } else if (atCellStart) {
          if ("=+-@".includes(character))
            throw new FileAdapterError("malicious_input", "CSV spreadsheet formulas are not allowed.");
          atCellStart = false;
        }
      }
    }
  }
  if (quoted && !pendingQuote) {
    throw new FileAdapterError("malicious_input", "CSV contains an unterminated quoted field.");
  }
}

function rowToFileProfile(row: Record<string, unknown>): FileProfile {
  return {
    fileId: String(row.file_id),
    downloadUrl: "",
    sizeBytes: Number(row.size_bytes),
    name: String(row.name),
    mimeType: String(row.mime_type),
    tenantId: String(row.tenant_id),
    workspaceId: String(row.workspace_id),
    kind: String(row.kind) as SupportedFileKind,
    sha256: String(row.sha256),
    scanStatus: "clean",
  };
}

function detectKind(name: string): SupportedFileKind | undefined {
  return extensionKinds[name.slice(name.lastIndexOf(".")).toLowerCase()];
}

function scanBytes(kind: SupportedFileKind, bytes: Uint8Array): void {
  if (kind === "csv") {
    const rows = parseCsv(new TextDecoder().decode(bytes));
    if (rows.some((row) => row.some(isFormulaCell))) {
      throw new FileAdapterError("malicious_input", "CSV spreadsheet formulas are not allowed.");
    }
  }
  if (kind === "json") {
    try {
      JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new FileAdapterError("malicious_input", "JSON file is malformed.");
    }
  }
  if (kind === "pdf" && !new TextDecoder().decode(bytes.slice(0, 5)).startsWith("%PDF-")) {
    throw new FileAdapterError("malicious_input", "PDF magic header is invalid.");
  }
  if ((kind === "excel" || kind === "parquet") && bytes.length < 4) {
    throw new FileAdapterError("malicious_input", "Binary file header is invalid.");
  }
  if (kind === "parquet" && new TextDecoder().decode(bytes.slice(0, 4)) !== "PAR1") {
    throw new FileAdapterError("malicious_input", "Parquet magic header is invalid.");
  }
  if (kind === "excel" && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    scanZipEntries(bytes);
    assertNoSpreadsheetFormulas(bytes);
  }
}

function assertNoSpreadsheetFormulas(bytes: Uint8Array): void {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new FileAdapterError("malicious_input", "Excel archive is malformed.");
  }
  for (const [name, content] of Object.entries(entries)) {
    if (/^xl\/worksheets\/[^/]+\.xml$/i.test(name) && /<f(?:\s|>)/i.test(strFromU8(content))) {
      throw new FileAdapterError("malicious_input", "Excel spreadsheet formulas are not allowed.");
    }
  }
}

async function previewExcel(bytes: Uint8Array): Promise<FilePreview> {
  const entries = unzipSync(bytes);
  const workbook = xmlText(entries["xl/workbook.xml"]);
  const relationships = xmlText(entries["xl/_rels/workbook.xml.rels"]);
  const sharedStrings = [...xmlText(entries["xl/sharedStrings.xml"]).matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)].map(
    (match) => decodeXml([...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map((part) => part[1]).join("")),
  );
  const sheets = [...workbook.matchAll(/<sheet\b[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/gi)].slice(0, 5).map((match) => {
    const target = relationships.match(
      new RegExp(`<Relationship\\b[^>]*Id="${escapeRegExp(match[2])}"[^>]*Target="([^"]+)"`, "i"),
    )?.[1];
    const xml = target ? xmlText(entries[`xl/${target.replace(/^\//, "")}`]) : "";
    return { name: decodeXml(match[1]), rows: worksheetRows(xml, sharedStrings) };
  });
  return { kind: "excel", sheets, truncated: sheets.length >= 5 };
}

function worksheetRows(xml: string, sharedStrings: string[]): string[][] {
  return [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)].slice(0, 20).map((row) =>
    [...row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)].slice(0, 50).map((cell) => {
      const value = cell[2].match(/<v\b[^>]*>([\s\S]*?)<\/v>/i)?.[1] ?? "";
      return /\bt="s"/i.test(cell[1]) ? (sharedStrings[Number(value)] ?? "") : decodeXml(value);
    }),
  );
}

async function previewParquet(bytes: Uint8Array): Promise<FilePreview> {
  const [{ parquetReadObjects }, { compressors }] = await Promise.all([
    import("hyparquet"),
    import("hyparquet-compressors"),
  ]);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const values = await parquetReadObjects({ file: buffer, rowEnd: 20, compressors });
  const rows = values.slice(0, 20).map((row) => normalizePreviewValue(row) as Record<string, unknown>);
  return { kind: "parquet", columns: Object.keys(rows[0] ?? {}), rows, truncated: values.length >= 20 };
}

async function previewPdf(bytes: Uint8Array): Promise<FilePreview> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await getDocument({ data: bytes }).promise;
  try {
    const pages: string[] = [];
    const pageCount = Math.min(document.numPages, 10);
    for (let index = 1; index <= pageCount; index += 1) {
      const content = await (await document.getPage(index)).getTextContent();
      pages.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
    }
    const text = pages.join("\n");
    return {
      kind: "pdf",
      text: text.slice(0, 10_000),
      pageCount: document.numPages,
      truncated: document.numPages > 10 || text.length > 10_000,
    };
  } finally {
    await document.destroy();
  }
}

function normalizePreviewValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizePreviewValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalizePreviewValue(child)]));
  }
  return value;
}

function xmlText(bytes: Uint8Array | undefined): string {
  return bytes ? strFromU8(bytes) : "";
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isFormulaCell(value: string): boolean {
  return /^[\t\r ]*[=+\-@]/.test(value);
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted) throw new FileAdapterError("malicious_input", "CSV contains an unterminated quoted field.");
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

function scanZipEntries(bytes: Uint8Array): void {
  // Read central-directory entries without extracting the archive. This keeps
  // the intake path safe from traversal and decompression bombs before XLSX
  // parsing. ZIP filenames are UTF-8 or CP437; ASCII traversal markers are
  // unambiguous in either encoding.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let foundEntry = false;
  for (let offset = 0; offset + 46 <= bytes.length; ) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      offset += 1;
      continue;
    }
    foundEntry = true;
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > bytes.length || nameEnd + extraLength + commentLength > bytes.length) {
      throw new FileAdapterError("malicious_input", "Archive central directory is malformed.");
    }
    const name = new TextDecoder("latin1").decode(bytes.slice(nameStart, nameEnd)).replaceAll("\\", "/");
    if (name.startsWith("/") || name.split("/").includes("..")) {
      throw new FileAdapterError("malicious_input", "Archive contains a traversal path.");
    }
    if (uncompressedSize > 100 * 1024 * 1024 || (compressedSize > 0 && uncompressedSize / compressedSize > 1000)) {
      throw new FileAdapterError("malicious_input", "Archive compression limits were exceeded.");
    }
    // Bit 3 permits a data descriptor after the entry, so the central
    // directory remains the authoritative bounded metadata.
    offset = nameEnd + extraLength + commentLength;
  }
  if (!foundEntry) {
    throw new FileAdapterError("malicious_input", "Archive central directory is missing.");
  }
}

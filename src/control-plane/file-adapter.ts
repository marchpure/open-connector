import type { ITransitFileService, TransitFileUpload } from "../server/files/transit-file-store.ts";
import type { DatabaseSync } from "node:sqlite";

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
      throw new FileAdapterError("unsupported_type", "Only CSV, Excel, JSON, Parquet, PDF, Markdown, and text files are supported.");
    }
    if (file.size > this.transitFiles.maxBytes) {
      throw new FileAdapterError("file_too_large", "File exceeds the configured maximum size.");
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    scanBytes(kind, bytes);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const upload = await this.transitFiles.create(new File([bytes], file.name, { type: file.type }));
    const profile: FileProfile = {
      ...upload,
      tenantId: this.tenantId,
      workspaceId: this.workspaceId,
      kind,
      sha256: Buffer.from(digest).toString("hex"),
      scanStatus: "clean",
    };
    this.database.prepare(
      `insert into tenant_files
        (file_id, tenant_id, workspace_id, name, mime_type, size_bytes, kind, sha256, scan_status, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
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

  list(): FileProfile[] {
    const rows = this.database.prepare(
      "select * from tenant_files where tenant_id=? and workspace_id=? order by created_at",
    ).all(this.tenantId, this.workspaceId) as Record<string, unknown>[];
    return rows.map((row) => ({
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
    }));
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
    this.database.prepare("delete from tenant_files where file_id=? and tenant_id=? and workspace_id=?")
      .run(fileId, this.tenantId, this.workspaceId);
    return deleted;
  }
}

function detectKind(name: string): SupportedFileKind | undefined {
  return extensionKinds[name.slice(name.lastIndexOf(".")).toLowerCase()];
}

function scanBytes(kind: SupportedFileKind, bytes: Uint8Array): void {
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
  }
}

function scanZipEntries(bytes: Uint8Array): void {
  // Read central-directory entries without extracting the archive. This keeps
  // the intake path safe from traversal and decompression bombs before XLSX
  // parsing. ZIP filenames are UTF-8 or CP437; ASCII traversal markers are
  // unambiguous in either encoding.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let foundEntry = false;
  for (let offset = 0; offset + 46 <= bytes.length;) {
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
    if (uncompressedSize > 100 * 1024 * 1024 ||
        (compressedSize > 0 && uncompressedSize / compressedSize > 1000)) {
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

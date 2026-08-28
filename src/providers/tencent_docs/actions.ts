import type { ActionDefinition } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

export const tencentDocsConnectorScopes = {
  userRead: "tencent_docs.user.read",
  driveRead: "tencent_docs.drive.read",
  driveCreate: "tencent_docs.drive.create",
  driveRename: "tencent_docs.drive.rename",
  driveExport: "tencent_docs.drive.export",
  docRead: "tencent_docs.doc.read",
  docWrite: "tencent_docs.doc.write",
  sheetRead: "tencent_docs.sheet.read",
  sheetWrite: "tencent_docs.sheet.write",
  smartsheetRead: "tencent_docs.smartsheet.read",
  formWrite: "tencent_docs.form.write",
} as const;

export const tencentDocsProviderScopes = {
  userInfoBase: "scope.user.info.base",
  driveCreatable: "scope.drive.creatable",
  driveEditable: "scope.drive.editable",
  driveFileMetadata: "scope.drive.file.metadata",
  driveFileMetadataReadonly: "scope.drive.file.metadata.readonly",
  driveReadonly: "scope.drive.readonly",
  driveExportable: "scope.drive.exportable",
  doc: "scope.doc",
  docReadonly: "scope.doc.readonly",
  sheet: "scope.sheet",
  sheetReadonly: "scope.sheet.readonly",
  sheetEditable: "scope.sheet.editable",
  smartsheet: "scope.smartsheet",
  smartsheetReadonly: "scope.smartsheet.readonly",
  form: "scope.form",
} as const;

const rawObjectSchema = s.looseObject("The raw object returned by Tencent Docs.");
const nonEmptyString = (description: string) => s.string(description, { minLength: 1 });
const nullableString = (description: string) => s.nullable(s.string(description));
const nullableInteger = (description: string) => s.nullable(s.integer(description));
const nullableBoolean = (description: string) => s.nullable(s.boolean(description));
const looseRequestObjectSchema = s.looseObject("A provider-defined Tencent Docs request object.");

function defineAction(
  input: Omit<Parameters<typeof defineProviderAction>[1], "name"> & { service?: string; name: string },
): ActionDefinition {
  const { service: _service, ...action } = input;
  return defineProviderAction("tencent_docs", action);
}

const tencentDocsUserSchema = s.object("A Tencent Docs user profile.", {
  openID: s.string("The Tencent Docs Open ID for the authorized user."),
  nick: nullableString("The display nickname returned by Tencent Docs."),
  avatar: nullableString("The user avatar URL returned by Tencent Docs."),
  source: nullableString("The user authorization source, such as wx or qq."),
  bindSource: nullableString("The account binding source, such as wx or qq."),
  unionID: nullableString("The developer-account scoped Tencent Docs union ID."),
  raw: rawObjectSchema,
});

const tencentDocsFileSchema = s.object("A Tencent Docs file or folder item.", {
  ID: s.string("The Tencent Docs file or folder ID."),
  title: nullableString("The file or folder title."),
  type: nullableString("The Tencent Docs file type, such as doc, sheet, form, or folder."),
  url: nullableString("The browser URL for opening the file or folder."),
  status: nullableString("The file or folder status returned by Tencent Docs."),
  isCreator: nullableBoolean("Whether the authorized user created the file or folder."),
  isOwner: nullableBoolean("Whether the authorized user owns the file or folder."),
  createTime: nullableInteger("The creation time returned by Tencent Docs."),
  creatorName: nullableString("The creator display name returned by Tencent Docs."),
  ownerName: nullableString("The owner display name returned by Tencent Docs."),
  ownerID: nullableString("The owner Open ID returned by Tencent Docs."),
  lastModifyTime: nullableInteger("The last modification time returned by Tencent Docs."),
  lastModifyName: nullableString("The last modifier display name returned by Tencent Docs."),
  lastBrowseTime: nullableInteger("The last browse time returned by Tencent Docs."),
  starred: s.nullable(s.boolean("Whether the file is starred.")),
  pinned: s.nullable(s.boolean("Whether the file is pinned.")),
  fileSource: nullableString("The source classification for the file when returned by search."),
  highlight: nullableString("The highlighted search snippet when returned by search."),
  raw: rawObjectSchema,
});

const tencentDocsSmartsheetSheetSchema = s.object("A Tencent Docs Smartsheet child sheet.", {
  sheetID: s.string("The Tencent Docs Smartsheet sheet ID."),
  title: nullableString("The sheet title returned by Tencent Docs."),
  isVisible: nullableBoolean("Whether the sheet is visible."),
  rowCount: nullableInteger("The row count returned by Tencent Docs."),
  columnCount: nullableInteger("The column count returned by Tencent Docs."),
  raw: rawObjectSchema,
});

const readSmartsheetRecordsInputSchema = s.object(
  "Input for reading one bounded page of Tencent Docs Smartsheet records.",
  {
    fileID: nonEmptyString("The Tencent Docs Smartsheet file ID."),
    sheetID: nonEmptyString("The child sheet ID returned by list_smartsheet_sheets."),
    limit: s.positiveInteger("The maximum number of records to return, capped at 100.", { maximum: 100 }),
    offset: s.nonNegativeInteger("The zero-based record offset."),
  },
  { optional: ["limit", "offset"] },
);

const createFileInputSchema = s.object(
  "Input for creating a Tencent Docs online file.",
  {
    title: nonEmptyString("The document title. Tencent Docs limits it to 36 characters."),
    type: s.stringEnum("The Tencent Docs file type to create.", [
      "doc",
      "sheet",
      "form",
      "slide",
      "mind",
      "flowchart",
      "addon",
      "smartsheet",
    ]),
    templateID: nonEmptyString("The Tencent Docs official template ID to use."),
    templateVersion: nonEmptyString("The template version to use. Defaults to 0."),
    folderID: nonEmptyString("The parent folder ID. Defaults to the root folder."),
    ext: nonEmptyString("The Drive plugin thumbnail type. Required only for addon documents."),
  },
  {
    optional: ["templateID", "templateVersion", "folderID", "ext"],
  },
);

const fileIdInputSchema = s.object("Input containing a Tencent Docs file ID.", {
  fileID: nonEmptyString("The Tencent Docs file ID."),
});

const renameFileInputSchema = s.object("Input for renaming a Tencent Docs file.", {
  fileID: nonEmptyString("The Tencent Docs file ID."),
  title: nonEmptyString("The new file title. Tencent Docs limits it to 36 characters."),
});

const formIdInputSchema = s.object("Input containing a Tencent Docs form ID.", {
  formID: nonEmptyString("The Tencent Docs form ID."),
});

const sheetRangeInputSchema = s.object("Input for reading a Tencent Docs spreadsheet range.", {
  fileID: nonEmptyString("The Tencent Docs spreadsheet file ID."),
  sheetID: nonEmptyString("The Tencent Docs spreadsheet sheet ID."),
  range: nonEmptyString("The A1-style range to read, such as A1:D10."),
});

const batchUpdateSheetInputSchema = s.object("Input for batch-updating a Tencent Docs sheet.", {
  fileID: nonEmptyString("The Tencent Docs spreadsheet file ID."),
  requests: s.array("The Tencent Docs spreadsheet batch update requests.", looseRequestObjectSchema, {
    minItems: 1,
    maxItems: 5,
  }),
});

const batchUpdateDocInputSchema = s.object(
  "Input for batch-updating a Tencent Docs document.",
  {
    fileID: nonEmptyString("The Tencent Docs document file ID."),
    requests: s.array("The Tencent Docs document batch update requests.", looseRequestObjectSchema, {
      minItems: 1,
      maxItems: 30,
    }),
    version: s.integer("The document version used for optimistic concurrency."),
  },
  {
    optional: ["version"],
  },
);

const updateFormCollectionDeadlineInputSchema = s.object(
  "Input for updating a Tencent Docs form collection deadline.",
  {
    formID: nonEmptyString("The Tencent Docs form ID."),
    endTime: s.nonNegativeInteger("The collection end timestamp in seconds. Use 0 to publish without an end time."),
  },
  {
    optional: ["endTime"],
  },
);

const listFolderInputSchema = s.object(
  "Input for listing Tencent Docs folder contents.",
  {
    folderID: nonEmptyString("The folder ID to list. Omit it to list the root folder."),
    sortType: nonEmptyString("The sort type, such as browse."),
    asc: s.integer("The sort direction. Use 1 for ascending or 0 for descending.", {
      minimum: 0,
      maximum: 1,
    }),
    start: s.nonNegativeInteger("The start offset. Defaults to 0."),
    limit: s.positiveInteger("The maximum number of items to return. Defaults to 20."),
  },
  {
    optional: ["folderID", "sortType", "asc", "start", "limit"],
  },
);

const searchFilesInputSchema = s.object(
  "Input for searching Tencent Docs files.",
  {
    searchKey: nonEmptyString("The keyword to search for."),
    searchType: s.stringEnum("The search mode.", ["title", "owner"]),
    resultType: s.stringEnum("The result type filter.", ["all", "folder"]),
    folderID: nonEmptyString("The folder ID that limits the search scope."),
    offset: s.nonNegativeInteger("The result offset. Defaults to 0."),
    size: s.integer("The maximum result count. Tencent Docs allows up to 50.", {
      minimum: 1,
      maximum: 50,
    }),
    sortType: s.stringEnum("The tie-break sort rule.", ["modify", "create", "browse"]),
    asc: s.integer("The sort direction. Use 1 for ascending or 0 for descending.", {
      minimum: 0,
      maximum: 1,
    }),
    byOwnership: s.integer("Whether to filter by files owned by the requester. Use 1 for yes or 0 for no.", {
      minimum: 0,
      maximum: 1,
    }),
    fileTypes: nonEmptyString("A Tencent Docs file-type filter. Use hyphen-separated values for multiple types."),
  },
  {
    optional: ["resultType", "folderID", "offset", "size", "sortType", "asc", "byOwnership", "fileTypes"],
  },
);

const startExportInputSchema = s.object(
  "Input for starting an asynchronous Tencent Docs export.",
  {
    fileID: nonEmptyString("The Tencent Docs file ID to export."),
    exportType: s.stringEnum("The target export type when converting document type.", ["doc", "pdf", "sheet", "slide"]),
  },
  {
    optional: ["exportType"],
  },
);

const exportProgressInputSchema = s.object("Input for checking Tencent Docs export progress.", {
  fileID: nonEmptyString("The Tencent Docs file ID being exported."),
  operationID: nonEmptyString("The export operation ID returned by start_export."),
});

const convertFileIdInputSchema = s.object("Input for converting Tencent Docs file IDs.", {
  type: s.integer("The conversion type. Use 1 for fileID to encodedID or 2 for encodedID to fileID.", {
    minimum: 1,
    maximum: 2,
  }),
  value: nonEmptyString("The ID value to convert."),
});

const apiResponseBaseSchema = {
  ret: s.integer("The Tencent Docs business response code. 0 means success."),
  msg: s.string("The Tencent Docs business response message."),
};

export const tencentDocsActions: ActionDefinition[] = [
  defineAction({
    service: "tencent_docs",
    name: "get_current_user",
    description: "Get the current Tencent Docs user profile for the OAuth access token.",
    requiredScopes: [tencentDocsConnectorScopes.userRead],
    providerPermissions: [tencentDocsProviderScopes.userInfoBase],
    inputSchema: s.object("No input is required to get the current Tencent Docs user.", {}),
    outputSchema: s.object("The current Tencent Docs user profile response.", {
      ...apiResponseBaseSchema,
      user: tencentDocsUserSchema,
    }),
  }),
  defineAction({
    service: "tencent_docs",
    name: "create_file",
    description: "Create a Tencent Docs online document, sheet, form, slide, or smart sheet.",
    requiredScopes: [tencentDocsConnectorScopes.driveCreate],
    providerPermissions: [tencentDocsProviderScopes.driveCreatable],
    inputSchema: createFileInputSchema,
    outputSchema: s.object("The Tencent Docs create-file response.", {
      ...apiResponseBaseSchema,
      file: tencentDocsFileSchema,
    }),
  }),
  defineAction({
    service: "tencent_docs",
    name: "get_file_metadata",
    description: "Get Tencent Docs metadata for one file by file ID.",
    requiredScopes: [tencentDocsConnectorScopes.driveRead],
    providerPermissions: [
      tencentDocsProviderScopes.driveReadonly,
      tencentDocsProviderScopes.driveFileMetadata,
      tencentDocsProviderScopes.driveFileMetadataReadonly,
    ],
    inputSchema: fileIdInputSchema,
    outputSchema: s.object("The Tencent Docs file metadata response.", {
      ...apiResponseBaseSchema,
      file: tencentDocsFileSchema,
    }),
    resourceBindings: { fileID: [] },
  }),
  defineAction({
    service: "tencent_docs",
    name: "rename_file",
    description: "Rename a Tencent Docs file by file ID.",
    requiredScopes: [tencentDocsConnectorScopes.driveRename],
    providerPermissions: [tencentDocsProviderScopes.driveEditable, tencentDocsProviderScopes.driveFileMetadata],
    inputSchema: renameFileInputSchema,
    outputSchema: s.object("The Tencent Docs rename-file response.", {
      ...apiResponseBaseSchema,
    }),
  }),
  defineAction({
    service: "tencent_docs",
    name: "list_folder",
    description: "List files and folders in a Tencent Docs folder.",
    requiredScopes: [tencentDocsConnectorScopes.driveRead],
    providerPermissions: [tencentDocsProviderScopes.driveReadonly],
    inputSchema: listFolderInputSchema,
    outputSchema: s.object("The Tencent Docs folder listing response.", {
      ...apiResponseBaseSchema,
      next: s.nullable(s.integer("The next offset returned by Tencent Docs.")),
      items: s.array("The files and folders in the folder.", tencentDocsFileSchema),
      raw: rawObjectSchema,
    }),
    resourceBindingsOptional: { folderID: ["application/vnd.tencent-docs.folder"] },
  }),
  defineAction({
    service: "tencent_docs",
    name: "search_files",
    description: "Search Tencent Docs files by title keyword or owner nickname.",
    requiredScopes: [tencentDocsConnectorScopes.driveRead],
    providerPermissions: [tencentDocsProviderScopes.driveReadonly],
    inputSchema: searchFilesInputSchema,
    outputSchema: s.object("The Tencent Docs search response.", {
      ...apiResponseBaseSchema,
      next: s.nullable(s.integer("The next offset returned by Tencent Docs.")),
      total: s.nullable(s.integer("The total matching item count returned by Tencent Docs.")),
      hasMore: s.nullable(s.boolean("Whether Tencent Docs has more search results.")),
      items: s.array("The search result files and folders.", tencentDocsFileSchema),
      raw: rawObjectSchema,
    }),
    resourceBindingsOptional: { folderID: ["application/vnd.tencent-docs.folder"] },
  }),
  defineAction({
    service: "tencent_docs",
    name: "start_export",
    description: "Start an asynchronous Tencent Docs file export and return the operation ID.",
    requiredScopes: [tencentDocsConnectorScopes.driveExport],
    providerPermissions: [tencentDocsProviderScopes.driveExportable],
    inputSchema: startExportInputSchema,
    outputSchema: s.object("The Tencent Docs export submission response.", {
      ...apiResponseBaseSchema,
      fileID: s.string("The Tencent Docs file ID being exported."),
      operationID: s.string("The Tencent Docs export operation ID."),
    }),
    resourceBindings: { fileID: [] },
  }),
  defineAction({
    service: "tencent_docs",
    name: "get_export_progress",
    description: "Check a Tencent Docs asynchronous export operation without exposing its temporary download URL.",
    requiredScopes: [tencentDocsConnectorScopes.driveExport],
    providerPermissions: [tencentDocsProviderScopes.driveExportable],
    inputSchema: exportProgressInputSchema,
    outputSchema: s.object("The Tencent Docs export progress response.", {
      ...apiResponseBaseSchema,
      status: s.stringEnum("The normalized export status.", ["running", "succeeded", "failed"]),
      progress: s.integer("The export progress from 0 to 100.", { minimum: 0, maximum: 100 }),
      downloadReady: s.boolean(
        "Whether Tencent Docs reports that the export is ready. Temporary provider URLs are not exposed.",
      ),
      raw: rawObjectSchema,
    }),
    resourceBindings: { fileID: [] },
  }),
  defineAction({
    service: "tencent_docs",
    name: "convert_file_id",
    description: "Convert between Tencent Docs fileID and encodedID values.",
    requiredScopes: [tencentDocsConnectorScopes.driveRead],
    providerPermissions: [
      tencentDocsProviderScopes.driveReadonly,
      tencentDocsProviderScopes.driveFileMetadata,
      tencentDocsProviderScopes.driveFileMetadataReadonly,
    ],
    inputSchema: convertFileIdInputSchema,
    outputSchema: s.object("The Tencent Docs file ID conversion response.", {
      ...apiResponseBaseSchema,
      fileID: nullableString("The Tencent Docs file ID when converting from encodedID."),
      encodedID: nullableString("The Tencent Docs encoded ID when converting from fileID."),
      raw: rawObjectSchema,
    }),
  }),
  defineAction({
    service: "tencent_docs",
    name: "get_sheet_range",
    description: "Read cell values and metadata from a Tencent Docs spreadsheet range.",
    requiredScopes: [tencentDocsConnectorScopes.sheetRead],
    providerPermissions: [tencentDocsProviderScopes.sheetReadonly],
    inputSchema: sheetRangeInputSchema,
    outputSchema: s.object("The Tencent Docs spreadsheet range response.", {
      ...apiResponseBaseSchema,
      gridData: rawObjectSchema,
      raw: rawObjectSchema,
    }),
    resourceBindings: { fileID: ["application/vnd.tencent-docs.sheet"] },
  }),
  defineAction({
    service: "tencent_docs",
    name: "batch_update_sheet",
    description: "Apply up to five Tencent Docs spreadsheet V3 batch update operations.",
    requiredScopes: [tencentDocsConnectorScopes.sheetWrite],
    providerPermissions: [tencentDocsProviderScopes.sheetEditable],
    inputSchema: batchUpdateSheetInputSchema,
    outputSchema: s.object("The Tencent Docs spreadsheet batch update response.", {
      ...apiResponseBaseSchema,
      responses: s.array("The per-operation responses returned by Tencent Docs.", rawObjectSchema),
      raw: rawObjectSchema,
    }),
  }),
  defineAction({
    service: "tencent_docs",
    name: "get_doc_content",
    description: "Get the structured content and version of a Tencent Docs document.",
    requiredScopes: [tencentDocsConnectorScopes.docRead],
    providerPermissions: [tencentDocsProviderScopes.docReadonly],
    inputSchema: fileIdInputSchema,
    outputSchema: s.object("The Tencent Docs document content response.", {
      ...apiResponseBaseSchema,
      document: rawObjectSchema,
      version: s.integer("The Tencent Docs document version."),
      raw: rawObjectSchema,
    }),
    resourceBindings: { fileID: ["application/vnd.tencent-docs.doc"] },
  }),
  defineAction({
    service: "tencent_docs",
    name: "batch_update_doc",
    description: "Apply up to thirty Tencent Docs document V3 batch update operations.",
    requiredScopes: [tencentDocsConnectorScopes.docWrite],
    providerPermissions: [tencentDocsProviderScopes.doc],
    inputSchema: batchUpdateDocInputSchema,
    outputSchema: s.object("The Tencent Docs document batch update response.", {
      ...apiResponseBaseSchema,
      raw: rawObjectSchema,
    }),
  }),
  defineAction({
    service: "tencent_docs",
    name: "list_smartsheet_sheets",
    description: "List child sheets inside a Tencent Docs Smartsheet file.",
    requiredScopes: [tencentDocsConnectorScopes.smartsheetRead],
    providerPermissions: [tencentDocsProviderScopes.smartsheetReadonly],
    inputSchema: fileIdInputSchema,
    outputSchema: s.object("The Tencent Docs Smartsheet sheet listing response.", {
      ...apiResponseBaseSchema,
      sheets: s.array("The Smartsheet child sheets returned by Tencent Docs.", tencentDocsSmartsheetSheetSchema),
      raw: rawObjectSchema,
    }),
    resourceBindings: { fileID: ["application/vnd.tencent-docs.smartsheet"] },
  }),
  defineAction({
    service: "tencent_docs",
    name: "get_smartsheet_records",
    description: "Read up to one hundred records from a discovered Tencent Docs Smartsheet child sheet.",
    requiredScopes: [tencentDocsConnectorScopes.smartsheetRead],
    providerPermissions: [tencentDocsProviderScopes.smartsheetReadonly],
    inputSchema: readSmartsheetRecordsInputSchema,
    outputSchema: s.object("One bounded Tencent Docs Smartsheet record page.", {
      ...apiResponseBaseSchema,
      records: s.array("The records returned by Tencent Docs.", rawObjectSchema, { maxItems: 100 }),
      total: nullableInteger("The total record count returned by Tencent Docs."),
      hasMore: nullableBoolean("Whether Tencent Docs reports more records."),
      offset: s.nonNegativeInteger("The zero-based record offset."),
      raw: rawObjectSchema,
    }),
    resourceBindings: {
      fileID: ["application/vnd.tencent-docs.smartsheet"],
      sheetID: ["application/vnd.tencent-docs.smartsheet.sheet"],
    },
  }),
  defineAction({
    service: "tencent_docs",
    name: "update_form_collection_deadline",
    description: "Publish, pause, or update the collection deadline for a Tencent Docs form.",
    requiredScopes: [tencentDocsConnectorScopes.formWrite],
    providerPermissions: [tencentDocsProviderScopes.form],
    inputSchema: updateFormCollectionDeadlineInputSchema,
    outputSchema: s.object("The Tencent Docs form deadline update response.", {
      ...apiResponseBaseSchema,
    }),
  }),
  defineAction({
    service: "tencent_docs",
    name: "generate_form_result",
    description: "Generate the result spreadsheet for a Tencent Docs form.",
    requiredScopes: [tencentDocsConnectorScopes.formWrite],
    providerPermissions: [tencentDocsProviderScopes.form],
    inputSchema: formIdInputSchema,
    outputSchema: s.object("The Tencent Docs form result generation response.", {
      ...apiResponseBaseSchema,
      file: tencentDocsFileSchema,
    }),
  }),
];

export const tencentDocsActionByName: Map<string, ActionDefinition> = new Map(
  tencentDocsActions.map((action) => [action.name, action]),
);

import type { DefineProviderActionInput, ProviderActionDefinition } from "../../../core/provider-definition.ts";

import { defineProviderAction } from "../../../core/provider-definition.ts";

const resourceKinds: Record<string, readonly string[]> = {
  appToken: ["application/vnd.feishu.bitable"],
  baseToken: ["application/vnd.feishu.bitable"],
  tableId: ["application/vnd.feishu.bitable.table"],
  fieldId: ["application/vnd.feishu.bitable.field"],
  fieldIds: ["application/vnd.feishu.bitable.field"],
  viewId: ["application/vnd.feishu.bitable.view"],
  recordId: ["application/vnd.feishu.bitable.record"],
  recordIds: ["application/vnd.feishu.bitable.record"],
  spreadsheetToken: [],
  sheetId: [],
  sheetIds: [],
  spaceId: ["application/vnd.feishu.wiki-space"],
  nodeToken: ["application/vnd.feishu.wiki-node"],
  parentNodeToken: ["application/vnd.feishu.wiki-node"],
  targetSpaceId: ["application/vnd.feishu.wiki-space"],
  targetParentToken: ["application/vnd.feishu.wiki-node"],
  folderToken: [],
  fileToken: [],
  resourceToken: [],
  minuteToken: ["application/vnd.feishu.minutes"],
  presentationToken: [],
  documentId: [],
  chatId: ["application/vnd.feishu.chat"],
  containerId: ["application/vnd.feishu.chat"],
  wikiToken: ["application/vnd.feishu.wiki-node"],
};

export function defineFeishuResourceAction<TName extends string>(
  service: string,
  input: DefineProviderActionInput<TName>,
): ProviderActionDefinition<TName> {
  const schema = input.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
  const required = new Set(schema.required ?? []);
  const requiredBindings: Record<string, readonly string[]> = {};
  const optionalBindings: Record<string, readonly string[]> = {};
  for (const [field, kinds] of Object.entries(resourceKinds)) {
    if (!Object.hasOwn(schema.properties ?? {}, field)) continue;
    (required.has(field) ? requiredBindings : optionalBindings)[field] = kinds;
  }
  const explicitRequired = input.resourceBindings ?? {};
  const explicitOptional = input.resourceBindingsOptional ?? {};
  return defineProviderAction(service, {
    ...input,
    resourceBindings: Object.keys({ ...requiredBindings, ...explicitRequired }).length
      ? { ...requiredBindings, ...explicitRequired }
      : undefined,
    resourceBindingsOptional: Object.keys({ ...optionalBindings, ...explicitOptional }).length
      ? { ...optionalBindings, ...explicitOptional }
      : undefined,
  });
}

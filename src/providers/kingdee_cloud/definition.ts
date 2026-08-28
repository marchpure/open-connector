import { defineErpVendor } from "../../core/erp/definition.ts";
import { kingdeeCloudVendor } from "../../core/erp/vendors.ts";

export const provider: ProviderDefinition = defineErpVendor(kingdeeCloudVendor, "https://www.kingdee.com/");
import type { ProviderDefinition } from "../../core/types.ts";

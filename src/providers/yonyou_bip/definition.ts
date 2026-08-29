import { defineErpVendor } from "../../core/erp/definition.ts";
import { yonyouBipVendor } from "../../core/erp/vendors.ts";

export const provider: ProviderDefinition = defineErpVendor(yonyouBipVendor, "https://www.yonyou.com/");
import type { ProviderDefinition } from "../../core/types.ts";

import { defineErpVendor } from "../../core/erp/definition.ts";
import { oracleFusionErpVendor } from "../../core/erp/vendors.ts";

export const provider: ProviderDefinition = defineErpVendor(oracleFusionErpVendor, "https://www.oracle.com/erp/");
import type { ProviderDefinition } from "../../core/types.ts";

import { defineErpVendor } from "../../core/erp/definition.ts";
import { dynamicsBusinessCentralVendor } from "../../core/erp/vendors.ts";

export const provider: ProviderDefinition = defineErpVendor(
  dynamicsBusinessCentralVendor,
  "https://www.microsoft.com/dynamics-365/products/business-central",
);
import type { ProviderDefinition } from "../../core/types.ts";

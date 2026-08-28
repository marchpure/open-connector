import { defineErpVendor } from "../../core/erp/definition.ts";
import { dynamicsFinanceVendor } from "../../core/erp/vendors.ts";

export const provider: ProviderDefinition = defineErpVendor(
  dynamicsFinanceVendor,
  "https://www.microsoft.com/dynamics-365/products/finance",
);
import type { ProviderDefinition } from "../../core/types.ts";

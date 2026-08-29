import { defineErpVendor } from "../../core/erp/definition.ts";
import { sapS4hanaVendor } from "../../core/erp/vendors.ts";

export const provider: ProviderDefinition = defineErpVendor(
  sapS4hanaVendor,
  "https://www.sap.com/products/erp/s4hana.html",
);
import type { ProviderDefinition } from "../../core/types.ts";

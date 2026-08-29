import { defineErpVendor } from "../../core/erp/definition.ts";
import { odooVendor } from "../../core/erp/vendors.ts";

export const provider: ProviderDefinition = defineErpVendor(odooVendor, "https://www.odoo.com/");
import type { ProviderDefinition } from "../../core/types.ts";

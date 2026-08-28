export const erpDomains = [
  "organization",
  "company",
  "account",
  "customer",
  "supplier",
  "item",
  "warehouse",
  "inventory_balance",
  "inventory_transaction",
  "purchase_order",
  "purchase_receipt",
  "sales_order",
  "delivery",
  "accounts_receivable",
  "accounts_payable",
  "journal_entry",
  "general_ledger",
  "cost_center",
  "project",
] as const;

export type ErpDomain = (typeof erpDomains)[number];

export interface ErpNativeEntity {
  /** Provider-native entity, model, resource, or entity-set name. */
  entity: string;
  /** Stable Agent-facing business vocabulary. */
  domain: ErpDomain;
  /** Provider-native fields that are safe to expose through bounded reads. */
  fields: readonly string[];
  /** Provider-native field used to enforce a configured company boundary. */
  companyField?: string;
  /** Provider-native field used for bounded incremental reads. */
  modifiedField?: string;
}

export interface ErpCapability {
  domain: ErpDomain;
  nativeEntity: string;
  fields: readonly string[];
  readable: true;
  writable: false;
}

export interface ErpPage {
  items: Array<Record<string, unknown>>;
  nextCursor?: string;
  native: Record<string, unknown>;
}

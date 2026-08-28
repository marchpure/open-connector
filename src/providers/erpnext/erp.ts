import type { ErpNativeEntity } from "../../core/erp/types.ts";

export const erpnextEntities: readonly ErpNativeEntity[] = [
  {
    domain: "company",
    entity: "Company",
    fields: ["name", "company_name", "abbr", "default_currency", "modified"],
    companyField: "name",
  },
  {
    domain: "account",
    entity: "Account",
    fields: ["name", "account_name", "account_number", "company", "modified"],
    companyField: "company",
  },
  { domain: "customer", entity: "Customer", fields: ["name", "customer_name", "customer_group", "modified"] },
  { domain: "supplier", entity: "Supplier", fields: ["name", "supplier_name", "supplier_group", "modified"] },
  { domain: "item", entity: "Item", fields: ["name", "item_code", "item_name", "stock_uom", "modified"] },
  {
    domain: "warehouse",
    entity: "Warehouse",
    fields: ["name", "warehouse_name", "company", "modified"],
    companyField: "company",
  },
  { domain: "inventory_balance", entity: "Bin", fields: ["name", "item_code", "warehouse", "actual_qty", "modified"] },
  {
    domain: "inventory_transaction",
    entity: "Stock Ledger Entry",
    fields: ["name", "item_code", "warehouse", "actual_qty", "posting_date", "modified"],
  },
  {
    domain: "purchase_order",
    entity: "Purchase Order",
    fields: ["name", "supplier", "company", "transaction_date", "status", "modified"],
    companyField: "company",
  },
  {
    domain: "purchase_receipt",
    entity: "Purchase Receipt",
    fields: ["name", "supplier", "company", "posting_date", "status", "modified"],
    companyField: "company",
  },
  {
    domain: "sales_order",
    entity: "Sales Order",
    fields: ["name", "customer", "company", "transaction_date", "status", "modified"],
    companyField: "company",
  },
  {
    domain: "delivery",
    entity: "Delivery Note",
    fields: ["name", "customer", "company", "posting_date", "modified"],
    companyField: "company",
  },
  {
    domain: "accounts_receivable",
    entity: "Sales Invoice",
    fields: ["name", "customer", "company", "grand_total", "outstanding_amount", "modified"],
    companyField: "company",
  },
  {
    domain: "accounts_payable",
    entity: "Purchase Invoice",
    fields: ["name", "supplier", "company", "grand_total", "outstanding_amount", "modified"],
    companyField: "company",
  },
  {
    domain: "journal_entry",
    entity: "Journal Entry",
    fields: ["name", "company", "posting_date", "voucher_type", "modified"],
    companyField: "company",
  },
  {
    domain: "cost_center",
    entity: "Cost Center",
    fields: ["name", "cost_center_name", "company", "modified"],
    companyField: "company",
  },
  {
    domain: "project",
    entity: "Project",
    fields: ["name", "project_name", "company", "status", "modified"],
    companyField: "company",
  },
];

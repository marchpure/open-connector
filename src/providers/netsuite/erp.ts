import type { ErpNativeEntity } from "../../core/erp/types.ts";

export const netsuiteEntities: readonly ErpNativeEntity[] = [
  { domain: "company", entity: "subsidiary", fields: ["id", "name", "legalname", "currency"], companyField: "id" },
  { domain: "account", entity: "account", fields: ["id", "acctnumber", "accountsearchdisplayname", "accttype"] },
  {
    domain: "customer",
    entity: "customer",
    fields: ["id", "entityid", "companyname", "email", "subsidiary"],
    companyField: "subsidiary",
  },
  {
    domain: "supplier",
    entity: "vendor",
    fields: ["id", "entityid", "companyname", "email", "subsidiary"],
    companyField: "subsidiary",
  },
  {
    domain: "item",
    entity: "item",
    fields: ["id", "itemid", "displayname", "itemtype", "subsidiary"],
    companyField: "subsidiary",
  },
  { domain: "warehouse", entity: "location", fields: ["id", "name", "subsidiary"], companyField: "subsidiary" },
  {
    domain: "purchase_order",
    entity: "purchaseorder",
    fields: ["id", "tranid", "entity", "trandate", "status", "subsidiary"],
    companyField: "subsidiary",
  },
  {
    domain: "purchase_receipt",
    entity: "itemreceipt",
    fields: ["id", "tranid", "entity", "trandate", "status", "subsidiary"],
    companyField: "subsidiary",
  },
  {
    domain: "sales_order",
    entity: "salesorder",
    fields: ["id", "tranid", "entity", "trandate", "status", "subsidiary"],
    companyField: "subsidiary",
  },
  {
    domain: "accounts_receivable",
    entity: "invoice",
    fields: ["id", "tranid", "entity", "trandate", "amount", "amountremaining", "subsidiary"],
    companyField: "subsidiary",
  },
  {
    domain: "accounts_payable",
    entity: "vendorbill",
    fields: ["id", "tranid", "entity", "trandate", "amount", "amountremaining", "subsidiary"],
    companyField: "subsidiary",
  },
  {
    domain: "journal_entry",
    entity: "journalentry",
    fields: ["id", "tranid", "trandate", "subsidiary", "memo"],
    companyField: "subsidiary",
  },
  {
    domain: "cost_center",
    entity: "department",
    fields: ["id", "name", "subsidiary"],
    companyField: "subsidiary",
  },
  { domain: "project", entity: "job", fields: ["id", "entityid", "companyname", "customer", "status"] },
];

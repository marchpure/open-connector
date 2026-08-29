import type { ErpNativeEntity } from "./types.ts";
import type { ErpRestVendor } from "./vendor-runtime.ts";

import { ProviderRequestError } from "../../providers/provider-runtime.ts";
import { optionalRecord } from "../cast.ts";
import { odataReadRequest, parseODataPage, parseOdooPage, parseOraclePage } from "./vendor-runtime.ts";

const commonMasterData: readonly ErpNativeEntity[] = [
  { domain: "company", entity: "companies", fields: ["id", "name", "number", "displayName"] },
  { domain: "customer", entity: "customers", fields: ["id", "number", "displayName", "email"] },
  { domain: "supplier", entity: "vendors", fields: ["id", "number", "displayName", "email"] },
  { domain: "item", entity: "items", fields: ["id", "number", "displayName", "type"] },
  { domain: "purchase_order", entity: "purchaseOrders", fields: ["id", "number", "vendorId", "status"] },
  { domain: "sales_order", entity: "salesOrders", fields: ["id", "number", "customerId", "status"] },
];

export const sapS4hanaVendor: ErpRestVendor = {
  service: "sap_s4hana",
  displayName: "SAP S/4HANA",
  apiVersion: "OData V2/V4 (SAP Business Accelerator Hub)",
  authStyle: "bearer",
  privateRunner: true,
  validationPath: "/sap/opu/odata/sap/API_COMPANYCODE_SRV/A_CompanyCode?$top=1",
  entities: [
    {
      domain: "company",
      entity: "sap/opu/odata/sap/API_COMPANYCODE_SRV/A_CompanyCode",
      fields: ["CompanyCode", "CompanyCodeName", "Country", "Currency"],
      companyField: "CompanyCode",
    },
    {
      domain: "customer",
      entity: "sap/opu/odata/sap/API_BUSINESS_PARTNER/A_Customer",
      fields: ["Customer", "CustomerName", "Country", "OrganizationBPName1"],
    },
    {
      domain: "supplier",
      entity: "sap/opu/odata/sap/API_BUSINESS_PARTNER/A_Supplier",
      fields: ["Supplier", "SupplierName", "Country", "OrganizationBPName1"],
    },
    {
      domain: "item",
      entity: "sap/opu/odata/sap/API_PRODUCT_SRV/A_Product",
      fields: ["Product", "ProductType", "BaseUnit", "ProductGroup"],
    },
    {
      domain: "purchase_order",
      entity: "sap/opu/odata/sap/API_PURCHASEORDER_PROCESS_SRV/A_PurchaseOrder",
      fields: ["PurchaseOrder", "CompanyCode", "Supplier", "DocumentCurrency", "CreationDate"],
      companyField: "CompanyCode",
    },
    {
      domain: "sales_order",
      entity: "sap/opu/odata/sap/API_SALES_ORDER_SRV/A_SalesOrder",
      fields: ["SalesOrder", "SalesOrganization", "SoldToParty", "TransactionCurrency", "CreationDate"],
    },
    {
      domain: "general_ledger",
      entity: "sap/opu/odata/sap/API_GLACCOUNTINCHARTOFACCOUNTS_SRV/A_GLAccountInChartOfAccounts",
      fields: ["ChartOfAccounts", "GLAccount", "AccountGroup", "IsBalanceSheetAccount"],
    },
    {
      domain: "cost_center",
      entity: "sap/opu/odata/sap/API_COSTCENTER_SRV/A_CostCenter",
      fields: ["ControllingArea", "CostCenter", "ValidityEndDate", "CompanyCode"],
      companyField: "CompanyCode",
    },
  ],
  buildReadRequest: odataReadRequest,
  parsePage: parseODataPage,
};

export const oracleFusionErpVendor: ErpRestVendor = {
  service: "oracle_fusion_erp",
  displayName: "Oracle Fusion Cloud ERP",
  apiVersion: "REST 11.13.18.05",
  authStyle: "bearer",
  validationPath: "/fscmRestApi/resources/11.13.18.05/ledgers?limit=1",
  entities: [
    {
      domain: "company",
      entity: "ledgers",
      fields: ["LedgerId", "Name", "LedgerCategoryCode", "CurrencyCode"],
      companyField: "LedgerId",
    },
    {
      domain: "supplier",
      entity: "suppliers",
      fields: ["SupplierId", "Supplier", "SupplierNumber", "TaxOrganizationType"],
    },
    {
      domain: "purchase_order",
      entity: "purchaseOrders",
      fields: ["POHeaderId", "OrderNumber", "SupplierId", "StatusCode", "CurrencyCode"],
    },
    {
      domain: "accounts_payable",
      entity: "invoices",
      fields: ["InvoiceId", "InvoiceNumber", "Supplier", "InvoiceAmount", "InvoiceDate"],
    },
    {
      domain: "accounts_receivable",
      entity: "receivablesInvoices",
      fields: ["CustomerTransactionId", "TransactionNumber", "BillToCustomerName", "EnteredAmount"],
    },
    {
      domain: "journal_entry",
      entity: "journals",
      fields: ["JeHeaderId", "BatchName", "JournalName", "AccountingPeriod", "Status"],
    },
    {
      domain: "project",
      entity: "projects",
      fields: ["ProjectId", "ProjectNumber", "ProjectName", "ProjectStatus"],
    },
  ],
  buildReadRequest(input) {
    const url = new URL(`fscmRestApi/resources/11.13.18.05/${input.entity.entity}`, `${input.baseUrl}/`);
    url.searchParams.set("limit", String(input.pageSize));
    url.searchParams.set("offset", input.cursor ?? "0");
    url.searchParams.set("onlyData", "true");
    if (input.fields) url.searchParams.set("fields", input.fields.join(","));
    const queries: string[] = [];
    if (input.modifiedFrom) queries.push(`LastUpdateDate>=${input.modifiedFrom}`);
    if (input.modifiedTo) queries.push(`LastUpdateDate<${input.modifiedTo}`);
    const companyField = requireCompanyField(input);
    if (input.companyId && companyField) queries.push(`${companyField}=${numericId(input.companyId, "Oracle Fusion")}`);
    if (queries.length) url.searchParams.set("q", queries.join(";"));
    return { url };
  },
  parsePage: parseOraclePage,
};

export const dynamicsFinanceVendor: ErpRestVendor = {
  service: "dynamics_365_finance",
  displayName: "Microsoft Dynamics 365 Finance & Operations",
  apiVersion: "OData v4 data entities",
  authStyle: "bearer",
  validationPath: "/data/LegalEntities?$top=1",
  entities: [
    {
      domain: "company",
      entity: "data/LegalEntities",
      fields: ["DataArea", "Name", "CountryRegionId"],
      companyField: "DataArea",
    },
    {
      domain: "customer",
      entity: "data/CustomersV3",
      fields: ["CustomerAccount", "OrganizationName", "CustomerGroupId", "dataAreaId"],
      companyField: "dataAreaId",
    },
    {
      domain: "supplier",
      entity: "data/VendorsV2",
      fields: ["VendorAccountNumber", "VendorOrganizationName", "VendorGroupId", "dataAreaId"],
      companyField: "dataAreaId",
    },
    {
      domain: "item",
      entity: "data/ReleasedProductsV2",
      fields: ["ItemNumber", "ProductName", "ProductType", "dataAreaId"],
      companyField: "dataAreaId",
    },
    {
      domain: "inventory_balance",
      entity: "data/InventoryOnhand",
      fields: ["ItemNumber", "InventorySiteId", "InventoryWarehouseId", "AvailableOnHandQuantity", "dataAreaId"],
      companyField: "dataAreaId",
    },
    {
      domain: "purchase_order",
      entity: "data/PurchaseOrderHeadersV2",
      fields: ["PurchaseOrderNumber", "OrderVendorAccountNumber", "PurchaseOrderStatus", "dataAreaId"],
      companyField: "dataAreaId",
    },
    {
      domain: "sales_order",
      entity: "data/SalesOrderHeadersV2",
      fields: ["SalesOrderNumber", "OrderingCustomerAccountNumber", "SalesOrderStatus", "dataAreaId"],
      companyField: "dataAreaId",
    },
  ],
  buildReadRequest: odataReadRequest,
  parsePage: parseODataPage,
};

export const dynamicsBusinessCentralVendor: ErpRestVendor = {
  service: "dynamics_365_business_central",
  displayName: "Microsoft Dynamics 365 Business Central",
  apiVersion: "API v2.0",
  authStyle: "bearer",
  validationPath: "/api/v2.0/companies?$top=1",
  entities: commonMasterData.map((entity) => ({
    ...entity,
    companyField: entity.domain === "company" ? "id" : undefined,
  })),
  buildReadRequest(input) {
    const companyPrefix =
      input.entity.domain === "company"
        ? "api/v2.0"
        : `api/v2.0/companies(${encodeURIComponent(requiredCompany(input.companyId))})`;
    return odataReadRequest({
      ...input,
      entity: { ...input.entity, entity: `${companyPrefix}/${input.entity.entity}` },
      companyId: input.entity.domain === "company" ? input.companyId : undefined,
    });
  },
  parsePage: parseODataPage,
};

export const odooVendor: ErpRestVendor = {
  service: "odoo",
  displayName: "Odoo",
  apiVersion: "JSON-2 (Odoo 19)",
  authStyle: "odoo-json2",
  privateRunner: true,
  validationPath: "/json/2/res.users/context_get",
  validationMethod: "POST",
  validationBody: () => ({}),
  entities: [
    {
      domain: "company",
      entity: "res.company",
      fields: ["id", "name", "currency_id", "country_id"],
      companyField: "id",
    },
    {
      domain: "account",
      entity: "account.account",
      fields: ["id", "code", "name", "account_type", "company_ids"],
      companyField: "company_ids",
    },
    {
      domain: "customer",
      entity: "res.partner",
      fields: ["id", "name", "email", "customer_rank", "company_id"],
      companyField: "company_id",
    },
    {
      domain: "supplier",
      entity: "res.partner",
      fields: ["id", "name", "email", "supplier_rank", "company_id"],
      companyField: "company_id",
    },
    {
      domain: "item",
      entity: "product.product",
      fields: ["id", "default_code", "name", "type", "uom_id", "company_id"],
      companyField: "company_id",
    },
    {
      domain: "warehouse",
      entity: "stock.warehouse",
      fields: ["id", "name", "code", "company_id"],
      companyField: "company_id",
    },
    {
      domain: "purchase_order",
      entity: "purchase.order",
      fields: ["id", "name", "partner_id", "state", "date_order", "company_id"],
      companyField: "company_id",
    },
    {
      domain: "sales_order",
      entity: "sale.order",
      fields: ["id", "name", "partner_id", "state", "date_order", "company_id"],
      companyField: "company_id",
    },
    {
      domain: "journal_entry",
      entity: "account.move",
      fields: ["id", "name", "move_type", "state", "date", "company_id"],
      companyField: "company_id",
    },
    {
      domain: "cost_center",
      entity: "account.analytic.account",
      fields: ["id", "name", "company_id", "active"],
      companyField: "company_id",
    },
    {
      domain: "project",
      entity: "project.project",
      fields: ["id", "name", "partner_id", "active", "company_id"],
      companyField: "company_id",
    },
  ],
  buildReadRequest(input) {
    const url = new URL(`json/2/${input.entity.entity}/search_read`, `${input.baseUrl}/`);
    const offset = input.cursor ? Number(input.cursor) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new ProviderRequestError(400, "cursor is invalid");
    const domain: unknown[] = [];
    if (input.entity.domain === "customer") domain.push(["customer_rank", ">", 0]);
    if (input.entity.domain === "supplier") domain.push(["supplier_rank", ">", 0]);
    if (input.modifiedFrom) domain.push(["write_date", ">=", input.modifiedFrom]);
    if (input.modifiedTo) domain.push(["write_date", "<", input.modifiedTo]);
    const companyField = requireCompanyField(input);
    if (input.companyId && companyField) {
      domain.push([companyField, "=", Number(input.companyId) || input.companyId]);
    }
    return {
      url,
      method: "POST",
      body: { domain, fields: input.fields ?? input.entity.fields, limit: input.pageSize, offset },
      headers: { "x-page-offset": String(offset) },
    };
  },
  parsePage(payload, pageSize, cursor) {
    const page = parseOdooPage(payload, pageSize);
    if (page.nextCursor) {
      page.nextCursor = String((cursor ? Number(cursor) : 0) + page.items.length);
    }
    return page;
  },
};

export const kingdeeCloudVendor: ErpRestVendor = {
  service: "kingdee_cloud",
  displayName: "Kingdee Cloud Galaxy / Cosmic",
  apiVersion: "Kingdee Cloud WebAPI",
  authStyle: "kingdee",
  privateRunner: true,
  validationPath: "/K3Cloud/Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.ExecuteBillQuery.common.kdsvc",
  validationMethod: "POST",
  validationBody: () => ({
    FormId: "ORG_Organizations",
    FieldKeys: "FOrgId,FNumber,FName",
    StartRow: 0,
    Limit: 1,
  }),
  entities: [
    {
      domain: "organization",
      entity: "ORG_Organizations",
      fields: ["FOrgId", "FNumber", "FName"],
      companyField: "FOrgId",
    },
    {
      domain: "customer",
      entity: "BD_Customer",
      fields: ["FCustId", "FNumber", "FName", "FUseOrgId"],
      companyField: "FUseOrgId",
    },
    {
      domain: "supplier",
      entity: "BD_Supplier",
      fields: ["FSupplierId", "FNumber", "FName", "FUseOrgId"],
      companyField: "FUseOrgId",
    },
    {
      domain: "item",
      entity: "BD_Material",
      fields: ["FMaterialId", "FNumber", "FName", "FUseOrgId"],
      companyField: "FUseOrgId",
    },
    {
      domain: "warehouse",
      entity: "BD_Stock",
      fields: ["FStockId", "FNumber", "FName", "FUseOrgId"],
      companyField: "FUseOrgId",
    },
    {
      domain: "purchase_order",
      entity: "PUR_PurchaseOrder",
      fields: ["FID", "FBillNo", "FSupplierId", "FDate", "FPurchaseOrgId"],
      companyField: "FPurchaseOrgId",
    },
    {
      domain: "sales_order",
      entity: "SAL_SaleOrder",
      fields: ["FID", "FBillNo", "FCustId", "FDate", "FSaleOrgId"],
      companyField: "FSaleOrgId",
    },
    {
      domain: "general_ledger",
      entity: "GL_Balance",
      fields: ["FID", "FAccountId", "FPeriod", "FDebit", "FCredit", "FAccountBookId"],
      companyField: "FAccountBookId",
    },
  ],
  buildReadRequest(input) {
    const url = new URL(
      "K3Cloud/Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.ExecuteBillQuery.common.kdsvc",
      `${input.baseUrl}/`,
    );
    const offset = input.cursor ? Number(input.cursor) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new ProviderRequestError(400, "cursor is invalid");
    return {
      url,
      method: "POST",
      body: {
        FormId: input.entity.entity,
        FieldKeys: (input.fields ?? input.entity.fields).join(","),
        FilterString: kingdeeFilter(input),
        StartRow: offset,
        Limit: input.pageSize,
      },
    };
  },
  parsePage(payload, pageSize, cursor, fields) {
    const rows = Array.isArray(payload) ? payload : [];
    const items = rows.map((row) => {
      if (!Array.isArray(row)) {
        throw new ProviderRequestError(502, "Kingdee response contained a non-array row");
      }
      return Object.fromEntries(fields.map((field, index) => [field, row[index]]));
    });
    return {
      items,
      nextCursor: items.length === pageSize ? String((cursor ? Number(cursor) : 0) + items.length) : undefined,
      native: { count: items.length },
    };
  },
};

export const yonyouBipVendor: ErpRestVendor = {
  service: "yonyou_bip",
  displayName: "Yonyou BIP / NC Cloud",
  apiVersion: "YonBIP OpenAPI",
  authStyle: "access-token-header",
  privateRunner: true,
  validationPath: "/yonbip/digitalModel/openapi/query/system/user/current",
  entities: [
    {
      domain: "organization",
      entity: "yonbip/digitalModel/openapi/query/organization",
      fields: ["id", "code", "name"],
      companyField: "orgId",
    },
    {
      domain: "customer",
      entity: "yonbip/sd/v1/customer/list",
      fields: ["id", "code", "name", "orgId"],
      companyField: "orgId",
    },
    {
      domain: "supplier",
      entity: "yonbip/scm/v1/supplier/list",
      fields: ["id", "code", "name", "orgId"],
      companyField: "orgId",
    },
    {
      domain: "item",
      entity: "yonbip/digitalModel/openapi/query/material",
      fields: ["id", "code", "name", "orgId"],
      companyField: "orgId",
    },
    {
      domain: "purchase_order",
      entity: "yonbip/scm/v1/purchaseorder/list",
      fields: ["id", "code", "supplierId", "orgId"],
      companyField: "orgId",
    },
    {
      domain: "sales_order",
      entity: "yonbip/sd/v1/salesorder/list",
      fields: ["id", "code", "customerId", "orgId"],
      companyField: "orgId",
    },
    {
      domain: "general_ledger",
      entity: "yonbip/fi/v1/voucher/list",
      fields: ["id", "code", "period", "orgId"],
      companyField: "orgId",
    },
  ],
  buildReadRequest(input) {
    const url = new URL(input.entity.entity, `${input.baseUrl}/`);
    url.searchParams.set("pageSize", String(input.pageSize));
    url.searchParams.set("pageIndex", input.cursor ?? "1");
    const companyField = requireCompanyField(input);
    if (input.companyId && companyField) url.searchParams.set(companyField, input.companyId);
    if (input.modifiedFrom) url.searchParams.set("modifiedFrom", input.modifiedFrom);
    if (input.modifiedTo) url.searchParams.set("modifiedTo", input.modifiedTo);
    return { url };
  },
  parsePage(payload, pageSize, cursor) {
    const body = optionalRecord(payload);
    const data = optionalRecord(body?.data);
    const values = Array.isArray(data?.recordList) ? data.recordList : Array.isArray(data?.items) ? data.items : [];
    const items = values
      .map((value) => optionalRecord(value))
      .filter((value): value is Record<string, unknown> => !!value);
    const cursorPage = cursor === undefined ? 1 : Number(cursor);
    const page =
      typeof data?.pageIndex === "number"
        ? data.pageIndex
        : Number.isSafeInteger(cursorPage) && cursorPage > 0
          ? cursorPage
          : 1;
    return {
      items,
      nextCursor: items.length === pageSize ? String(page + 1) : undefined,
      native: { page, count: items.length },
    };
  },
};

function requiredCompany(companyId: string | undefined): string {
  if (!companyId) throw new ProviderRequestError(400, "companyId is required for Business Central entity reads");
  return companyId;
}

function kingdeeFilter(input: Parameters<ErpRestVendor["buildReadRequest"]>[0]): string {
  const filters: string[] = [];
  const companyField = requireCompanyField(input);
  if (input.companyId && companyField) filters.push(`${companyField}=${numericId(input.companyId, "Kingdee")}`);
  if (input.modifiedFrom) filters.push(`FModifyDate>='${safeLiteral(input.modifiedFrom)}'`);
  if (input.modifiedTo) filters.push(`FModifyDate<'${safeLiteral(input.modifiedTo)}'`);
  return filters.join(" AND ");
}

function requireCompanyField(input: Parameters<ErpRestVendor["buildReadRequest"]>[0]): string | undefined {
  if (!input.companyId) return undefined;
  if (!input.entity.companyField) {
    throw new ProviderRequestError(422, `Company-scoped reads are unsupported for ERP domain ${input.entity.domain}`, {
      code: "unsupported",
      domain: input.entity.domain,
      feature: "companyId",
    });
  }
  return input.entity.companyField;
}

function numericId(value: string, provider: string): string {
  if (!/^\d+$/u.test(value)) throw new ProviderRequestError(400, `companyId must be numeric for ${provider}`);
  return value;
}

function safeLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

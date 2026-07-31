import { getPool } from "@/server/db";
import type {
  EtsyListingSummary,
  EtsyMoney,
  EtsyOrderDetail,
  EtsyReceiptSummary,
} from "@/shared/types/etsy";
import {
  getDashboardMetrics,
  getEtsyErpAccount,
  getInventorySummary,
  getOrderItemList,
  getOrderList,
  getProductList,
  type ErpChannelAccount,
} from "@/features/erp/db";

export type ErpCommerceSnapshot = {
  account: ErpChannelAccount;
  inventory: Awaited<ReturnType<typeof getInventorySummary>>;
  listings: EtsyListingSummary[];
  metrics: Awaited<ReturnType<typeof getDashboardMetrics>>;
  orderDetails: EtsyOrderDetail[];
  receipts: EtsyReceiptSummary[];
};

function numberFrom(value: string | number | null | undefined) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function timestampFromDate(value: Date | string | null | undefined) {
  if (!value) return null;

  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : null;
}

function moneyFromAmount(amount: number, currencyCode: string): EtsyMoney {
  return {
    amount: Math.round(amount * 100),
    currency_code: currencyCode || "USD",
    divisor: 100,
  };
}

function listingFromProduct(row: Awaited<ReturnType<typeof getProductList>>[number]): EtsyListingSummary {
  const source = row.productSourceData ?? ({} as Partial<EtsyListingSummary>);
  const listingId = numberFrom(row.externalListingId) ?? source.listing_id ?? row.productId;

  return {
    ...source,
    listing_id: listingId,
    quantity: Number.isFinite(row.available) ? Math.max(0, Math.round(row.available)) : source.quantity ?? null,
    sku: source.sku ?? row.skuCode,
    state: row.productStatus || source.state || "active",
    title: row.productTitle || source.title || row.skuTitle || row.skuCode,
    updated_timestamp: source.updated_timestamp ?? timestampFromDate(row.updatedAt),
  };
}

function receiptFromOrder(row: Awaited<ReturnType<typeof getOrderList>>[number]): EtsyReceiptSummary {
  const source = row.orderSourceData ?? ({} as Partial<EtsyReceiptSummary>);
  const receiptId = numberFrom(row.externalOrderId) ?? source.receipt_id ?? row.orderId;

  return {
    ...source,
    create_timestamp: source.create_timestamp ?? timestampFromDate(row.placedAt),
    grandtotal: source.grandtotal ?? moneyFromAmount(row.totalAmount, row.currencyCode),
    name: row.customerName ?? source.name ?? null,
    receipt_id: receiptId,
    status: row.orderStatus || source.status || "open",
  };
}

function detailFromOrderItem(row: Awaited<ReturnType<typeof getOrderItemList>>[number]): EtsyOrderDetail {
  const source = row.itemSourceData ?? ({} as Partial<EtsyOrderDetail>);
  const orderSource = row.orderSourceData ?? ({} as Partial<EtsyReceiptSummary>);
  const transactionId = numberFrom(row.externalLineItemId) ?? source.transaction_id ?? row.orderItemId;
  const receiptId = numberFrom(row.externalOrderId) ?? source.receipt_id ?? orderSource.receipt_id ?? 0;
  const listingId = numberFrom(row.externalListingId) ?? source.listing_id ?? null;

  return {
    ...source,
    listing_id: listingId,
    price: source.price ?? moneyFromAmount(row.unitPriceAmount, row.currencyCode),
    quantity: Number.isFinite(row.quantity) ? row.quantity : source.quantity ?? null,
    receipt_id: receiptId,
    title: row.title || source.title || null,
    transaction_id: transactionId,
  };
}

export async function getErpCommerceSnapshot(
  shopId: number | null | undefined,
  organizationId: number,
): Promise<ErpCommerceSnapshot | null> {
  if (!shopId) {
    return null;
  }

  const pool = getPool();
  if (!pool) {
    return null;
  }

  const account = await getEtsyErpAccount(pool, shopId, organizationId);
  if (!account) {
    return null;
  }

  const [metrics, inventory, productRows, orderRows, orderItemRows] = await Promise.all([
    getDashboardMetrics(pool, account.organizationId, account.accountId),
    getInventorySummary(pool, account.organizationId, account.accountId),
    getProductList(pool, account.organizationId, {
      accountId: account.accountId,
      limit: 200,
    }),
    getOrderList(pool, account.organizationId, {
      accountId: account.accountId,
      limit: 200,
    }),
    getOrderItemList(pool, account.organizationId, {
      accountId: account.accountId,
      limit: 500,
    }),
  ]);

  return {
    account,
    inventory,
    listings: productRows.map(listingFromProduct),
    metrics,
    orderDetails: orderItemRows.map(detailFromOrderItem),
    receipts: orderRows.map(receiptFromOrder),
  };
}

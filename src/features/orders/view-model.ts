import {
  currencyForShop,
  recentReceipts,
  receiptTotal,
} from "@/shared/format/commerce";
import type { EtsyOrderDetail, EtsyReceiptSummary, EtsyShopData } from "@/shared/types/etsy";

export type ReceiptOrderRow = {
  expectedShipDate: number | null;
  isPaid: boolean | null;
  receipt: EtsyReceiptSummary;
  transactions: EtsyOrderDetail[];
};

function paidFromReceipt(receipt: EtsyReceiptSummary) {
  const raw = receipt as unknown as Record<string, unknown>;

  if (typeof raw.is_paid === "boolean") return raw.is_paid;

  const status = receipt.status?.toLowerCase() ?? "";
  return status ? ["paid", "shipped", "delivered", "completed"].includes(status) : null;
}

export function buildReceiptOrderRows(
  receipts: EtsyReceiptSummary[],
  orderDetails: EtsyOrderDetail[],
  limit = 80,
): ReceiptOrderRow[] {
  const detailsByReceiptId = new Map<number, EtsyOrderDetail[]>();

  for (const detail of orderDetails) {
    const current = detailsByReceiptId.get(detail.receipt_id) ?? [];
    current.push(detail);
    detailsByReceiptId.set(detail.receipt_id, current);
  }

  return recentReceipts(receipts, limit).map((receipt) => {
    const transactions = detailsByReceiptId.get(receipt.receipt_id) ?? [];
    const expectedShipDates = transactions
      .map((transaction) => transaction.expected_ship_date)
      .filter((value): value is number => typeof value === "number" && value > 0);

    return {
      // An order with more than one item must meet its earliest item deadline.
      expectedShipDate: expectedShipDates.length ? Math.min(...expectedShipDates) : null,
      isPaid: paidFromReceipt(receipt),
      receipt,
      transactions,
    };
  });
}

export function receiptTone(status?: string | null) {
  const normalized = status?.toLowerCase() ?? "";
  if (["completed", "paid", "shipped", "delivered"].includes(normalized)) return "success" as const;
  if (!normalized) return "neutral" as const;
  return "warning" as const;
}

export function buildOrdersViewModel(selectedShop: EtsyShopData | null) {
  const receipts = selectedShop?.receipts ?? [];
  const orderDetails = selectedShop?.orderDetails ?? [];
  const currency = currencyForShop(selectedShop);
  const orderRows = buildReceiptOrderRows(receipts, orderDetails);
  const revenue = receiptTotal(receipts);
  const paidReceipts = receipts.filter((receipt) => {
    const raw = receipt as unknown as Record<string, unknown>;
    return raw.is_paid === true || receipt.status?.toLowerCase() === "paid";
  }).length;
  const shippedReceipts = receipts.filter((receipt) => {
    const raw = receipt as unknown as Record<string, unknown>;
    return raw.is_shipped === true || ["shipped", "delivered", "completed"].includes(receipt.status?.toLowerCase() ?? "");
  }).length;
  const listingById = new Map((selectedShop?.listings ?? []).map((listing) => [listing.listing_id, listing]));

  return {
    currency,
    listingById,
    orderRows,
    orderDetails,
    paidReceipts,
    receipts,
    revenue,
    shippedReceipts,
  };
}

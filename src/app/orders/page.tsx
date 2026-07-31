import { ListOrdered, ReceiptText, Truck, WalletCards } from "lucide-react";
import { AppShell, MetricCard, StatusBadge } from "@/components/app-shell";
import {
  compactNumber,
  dateFromTimestamp,
  money,
  shortText,
  variationText,
  type VariationLike,
} from "@/shared/format/commerce";
import { getErpCommerceSnapshot } from "@/features/erp/commerce-snapshot";
import { buildOrdersViewModel } from "@/features/orders/view-model";
import { getDictionary } from "@/shared/i18n";
import { markShopOrdersSeen } from "@/features/sync/db";
import { getWorkspace, type WorkspacePageProps } from "@/features/workspace/workspace";
import { requirePermission } from "@/features/auth/session";

export default async function OrdersPage({ searchParams }: WorkspacePageProps) {
  const user = await requirePermission("orders.read", "/orders");
  const workspace = await getWorkspace(searchParams, "/orders");

  if (workspace.selectedShopId) {
    await markShopOrdersSeen(workspace.selectedShopId).catch(() => undefined);
  }

  const { params } = workspace;
  const { locale, selectedShop, selectedShopId, store } = workspace.selectedShopId
    ? await getWorkspace(Promise.resolve(params ?? {}))
    : workspace;
  const erpSnapshot = await getErpCommerceSnapshot(selectedShopId, user.organizationId).catch(() => null);
  const selectedShopData =
    selectedShop && erpSnapshot
      ? {
          ...selectedShop,
          listings: erpSnapshot.listings,
          orderDetails: erpSnapshot.orderDetails,
          receipts: erpSnapshot.receipts,
        }
      : selectedShop;
  const t = getDictionary(locale);
  const {
    currency,
    listingById,
    orderDetails,
    orderRows,
    paidReceipts,
    receipts,
    revenue,
    shippedReceipts,
  } = buildOrdersViewModel(selectedShopData);
  const zh = locale === "zh";

  return (
    <AppShell
      activePath="/orders"
      kicker={t.orders.kicker}
      locale={locale}
      selectedShop={selectedShop}
      selectedShopId={selectedShopId}
      store={store}
      title={t.orders.title}
    >
      <section className="metricGrid fourUp" aria-label="Order metrics">
        <MetricCard
          icon={WalletCards}
          label={t.orders.metrics.revenue}
          meta={t.orders.metrics.syncedReceipts(compactNumber(receipts.length, locale))}
          tone="honey"
          value={new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en", {
            currency,
            maximumFractionDigits: revenue >= 1000 ? 0 : 2,
            style: "currency",
          }).format(revenue)}
        />
        <MetricCard
          icon={ReceiptText}
          label={t.orders.metrics.receipts}
          meta={t.orders.metrics.paidMeta(paidReceipts)}
          tone="blue"
          value={compactNumber(receipts.length, locale)}
        />
        <MetricCard
          icon={ListOrdered}
          label={t.orders.metrics.lineItems}
          meta={t.orders.metrics.syncedTransactions}
          tone="amber"
          value={compactNumber(orderDetails.length, locale)}
        />
        <MetricCard
          icon={Truck}
          label={t.orders.metrics.shipped}
          meta={t.orders.metrics.receiptStatus}
          tone="teal"
          value={compactNumber(shippedReceipts, locale)}
        />
      </section>

      <section className="panel">
        <div className="panelHeader">
          <div>
            <span className="tinyLabel">{t.orders.kicker}</span>
            <h2>{zh ? "订单信息" : "Order information"}</h2>
            <p className="orderInfoAddressNotice">
              {zh
                ? "收货地址受 Etsy API 权限限制，当前无法自动获取。"
                : "Delivery addresses cannot currently be synced because of Etsy API access restrictions."}
            </p>
          </div>
          <div className="panelHeaderActions">
            <span className="panelMeta">{t.orders.table.rows(compactNumber(orderRows.length, locale))}</span>
            {selectedShopId ? (
              <form action={`/api/etsy/sync?shopId=${selectedShopId}&lang=${locale}&forceFull=1`} method="post">
                <input name="_csrf" type="hidden" value={user.csrfToken} />
                <button className="button quiet compactButton" type="submit">
                  {zh ? "重新同步完整订单" : "Refresh full order details"}
                </button>
              </form>
            ) : null}
          </div>
        </div>
        <div className="tableWrap">
          <table className="table compactTable orderInfoTable">
            <thead>
              <tr>
                <th>{t.orders.table.orderId}</th>
                <th>{t.orders.table.name}</th>
                <th>{t.orders.table.price}</th>
                <th>{t.orders.table.items}</th>
                <th>{t.orders.table.orderDate}</th>
                <th>{t.orders.table.shipBy}</th>
                <th>{t.orders.table.paid}</th>
              </tr>
            </thead>
            <tbody>
              {orderRows.map((order) => {
                const { receipt, transactions } = order;
                const paidLabel = order.isPaid === null ? "-" : order.isPaid ? (zh ? "已支付" : "Paid") : (zh ? "未支付" : "Unpaid");
                const paidTone = order.isPaid === null ? "neutral" : order.isPaid ? "success" : "warning";

                return (
                  <tr key={receipt.receipt_id}>
                    <td><strong className="orderInfoId">#{receipt.receipt_id}</strong></td>
                    <td>{receipt.name ?? receipt.buyer_user_name ?? "-"}</td>
                    <td>{receipt.grandtotal ? money(receipt.grandtotal, currency, locale) : "-"}</td>
                    <td className="orderInfoItemsCell">
                      {transactions.length ? (
                        <div className="orderInfoItems">
                          {transactions.map((transaction) => {
                            const listing = listingById.get(transaction.listing_id ?? 0);
                            const variations = variationText(transaction.variations as VariationLike[]);

                            return (
                              <div className="orderInfoItem" key={transaction.transaction_id}>
                                <strong>{shortText(transaction.title ?? listing?.title, 74)}</strong>
                                <div className="orderInfoItemMeta">
                                  <span>{zh ? "数量" : "Qty"}: {transaction.quantity ?? "-"}</span>
                                  <span>SKU: {transaction.sku || "-"}</span>
                                  {variations !== "-" ? <span>{zh ? "变量" : "Variants"}: {variations}</span> : null}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <span className="orderInfoMissingItems">{zh ? "暂无已同步商品明细" : "No synced item details"}</span>
                      )}
                    </td>
                    <td className="orderInfoDate">{dateFromTimestamp(receipt.create_timestamp, locale)}</td>
                    <td className="orderInfoDate">{order.expectedShipDate ? dateFromTimestamp(order.expectedShipDate, locale) : "-"}</td>
                    <td><StatusBadge tone={paidTone}>{paidLabel}</StatusBadge></td>
                  </tr>
                );
              })}
              {orderRows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="mutedCell">{t.orders.emptyReceipts}</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </AppShell>
  );
}

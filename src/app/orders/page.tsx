import { ListOrdered, ReceiptText, Truck, WalletCards } from "lucide-react";
import { AppShell, MetricCard, StatusBadge } from "@/components/app-shell";
import {
  compactNumber,
  currencyForShop,
  dateFromTimestamp,
  money,
  recentOrderDetails,
  recentReceipts,
  receiptTotal,
  shortText,
  variationText,
  type VariationLike,
} from "@/lib/commerce-metrics";
import { getDictionary, statusLabel } from "@/lib/i18n";
import { markShopOrdersSeen } from "@/lib/sync-db";
import { getWorkspace, type WorkspacePageProps } from "@/lib/workspace";

function receiptTone(status?: string | null) {
  const normalized = status?.toLowerCase() ?? "";
  if (["completed", "paid", "shipped", "delivered"].includes(normalized)) return "success" as const;
  if (!normalized) return "neutral" as const;
  return "warning" as const;
}

export default async function OrdersPage({ searchParams }: WorkspacePageProps) {
  const workspace = await getWorkspace(searchParams);

  if (workspace.selectedShopId) {
    await markShopOrdersSeen(workspace.selectedShopId).catch(() => undefined);
  }

  const { params } = workspace;
  const { locale, selectedShop, selectedShopId, store } = workspace.selectedShopId
    ? await getWorkspace(Promise.resolve(params ?? {}))
    : workspace;
  const t = getDictionary(locale);
  const receipts = selectedShop?.receipts ?? [];
  const orderDetails = selectedShop?.orderDetails ?? [];
  const currency = currencyForShop(selectedShop);
  const receiptRows = recentReceipts(receipts, 80);
  const detailRows = recentOrderDetails(orderDetails, 80);
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
  const receiptById = new Map(receipts.map((receipt) => [receipt.receipt_id, receipt]));

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

      <section className="tableGrid">
        <div className="panel">
          <div className="panelHeader">
            <div>
              <span className="tinyLabel">{t.orders.kicker}</span>
              <h2>{t.orders.table.recentReceipts}</h2>
            </div>
            <span className="panelMeta">{t.orders.metrics.syncedReceipts(compactNumber(receipts.length, locale))}</span>
          </div>
          <div className="tableWrap">
            <table className="table compactTable">
              <thead>
                <tr>
                  <th>{t.orders.table.receipt}</th>
                  <th>{t.orders.table.buyer}</th>
                  <th>{t.orders.table.total}</th>
                  <th>{t.orders.table.status}</th>
                  <th>{t.orders.table.created}</th>
                </tr>
              </thead>
              <tbody>
                {receiptRows.map((receipt) => (
                  <tr key={receipt.receipt_id}>
                    <td>{receipt.receipt_id}</td>
                    <td>{receipt.name ?? "-"}</td>
                    <td>{money(receipt.grandtotal, currency, locale)}</td>
                    <td>
                      <StatusBadge tone={receiptTone(receipt.status)}>
                        {statusLabel(receipt.status ?? "-", locale)}
                      </StatusBadge>
                    </td>
                    <td>{dateFromTimestamp(receipt.create_timestamp, locale)}</td>
                  </tr>
                ))}
                {receiptRows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="mutedCell">
                      {t.orders.emptyReceipts}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel">
          <div className="panelHeader">
            <div>
              <span className="tinyLabel">{t.orders.lineItems}</span>
              <h2>{t.orders.lineItems}</h2>
            </div>
            <span className="panelMeta">{t.orders.table.rows(compactNumber(orderDetails.length, locale))}</span>
          </div>
          <div className="tableWrap">
            <table className="table compactTable">
              <thead>
                <tr>
                  <th>{t.orders.table.product}</th>
                  <th>{t.orders.table.quantity}</th>
                  <th>{t.orders.table.price}</th>
                  <th>{t.orders.table.variations}</th>
                  <th>{t.orders.table.paid}</th>
                </tr>
              </thead>
              <tbody>
                {detailRows.map((detail) => {
                  const receipt = receiptById.get(detail.receipt_id);
                  const listing = listingById.get(detail.listing_id ?? 0);

                  return (
                    <tr key={detail.transaction_id}>
                      <td>
                        {shortText(detail.title ?? listing?.title, 58)}
                        <small className="tableSub">
                          {t.orders.table.receiptPrefix} {detail.receipt_id}
                        </small>
                      </td>
                      <td>{detail.quantity ?? "-"}</td>
                      <td>{money(detail.price, currency, locale)}</td>
                      <td>{variationText(detail.variations as VariationLike[])}</td>
                      <td>{dateFromTimestamp(detail.paid_timestamp ?? receipt?.create_timestamp, locale)}</td>
                    </tr>
                  );
                })}
                {detailRows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="mutedCell">
                      {t.orders.emptyDetails}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </AppShell>
  );
}

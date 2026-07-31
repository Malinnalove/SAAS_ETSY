import { ChevronRight, Mail, MapPin, MessageSquareText, PackageCheck, UserRound } from "lucide-react";
import { buildReceiptDetail } from "@/features/orders/receipt-detail";
import { dateFromTimestamp, money, variationText, type VariationLike } from "@/shared/format/commerce";
import type { Locale } from "@/shared/i18n";
import type { EtsyOrderDetail, EtsyReceiptSummary } from "@/shared/types/etsy";

type DetailFieldProps = {
  label: string;
  value: string | null | undefined;
};

function DetailField({ label, value }: DetailFieldProps) {
  if (!value) return null;
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

export function ReceiptDetail({
  currency,
  locale,
  receipt,
  transactions,
}: {
  currency: string;
  locale: Locale;
  receipt: EtsyReceiptSummary;
  transactions: EtsyOrderDetail[];
}) {
  const detail = buildReceiptDetail(receipt, transactions);
  const zh = locale === "zh";
  const yes = zh ? "是" : "Yes";
  const no = zh ? "否" : "No";

  return (
    <details className="receiptDetailDisclosure">
      <summary>
        <span>{zh ? "查看完整买家、收货与商品信息" : "View buyer, delivery, and item details"}</span>
        <ChevronRight aria-hidden="true" size={16} />
      </summary>
      <div className="receiptDetailContent">
        <section className="receiptDetailCard">
          <h3><UserRound aria-hidden="true" size={16} />{zh ? "买家与收件人" : "Buyer & recipient"}</h3>
          <dl className="receiptDetailList">
            <DetailField label={zh ? "买家姓名" : "Buyer name"} value={detail.buyerName} />
            <DetailField label={zh ? "买家邮箱" : "Buyer email"} value={detail.buyerEmail} />
            <DetailField label={zh ? "买家 ID" : "Buyer ID"} value={detail.buyerId} />
            <DetailField label={zh ? "收件人姓名" : "Recipient name"} value={detail.recipientName} />
            <DetailField label={zh ? "联系电话" : "Phone"} value={detail.phone} />
            {!detail.buyerName && !detail.buyerEmail && !detail.buyerId && !detail.recipientName && !detail.phone ? <p>{zh ? "Etsy 未返回买家个人资料。" : "Etsy did not return buyer profile details."}</p> : null}
          </dl>
        </section>

        <section className="receiptDetailCard">
          <h3><MapPin aria-hidden="true" size={16} />{zh ? "收货地址" : "Delivery address"}</h3>
          {detail.addressLines.length ? <address>{detail.addressLines.map((line, index) => <span key={`${line}-${index}`}>{line}</span>)}</address> : <p>{zh ? "Etsy 未返回收货地址。" : "Etsy did not return a delivery address."}</p>}
          {detail.shipments.length ? <div className="receiptShipmentList">{detail.shipments.map((shipment, index) => <div key={`${shipment.trackingCode ?? shipment.carrier ?? "shipment"}-${index}`}><strong>{shipment.carrier || (zh ? "物流" : "Shipment")}</strong><span>{[shipment.service, shipment.trackingCode, shipment.mailedTimestamp ? dateFromTimestamp(shipment.mailedTimestamp, locale) : null].filter(Boolean).join(" · ")}</span></div>)}</div> : null}
        </section>

        <section className="receiptDetailCard">
          <h3><PackageCheck aria-hidden="true" size={16} />{zh ? "付款与订单状态" : "Payment & order status"}</h3>
          <dl className="receiptDetailList">
            <DetailField label={zh ? "订单状态" : "Order status"} value={receipt.status} />
            <DetailField label={zh ? "付款方式" : "Payment method"} value={detail.paymentMethod} />
            <DetailField label={zh ? "付款邮箱" : "Payment email"} value={detail.paymentEmail} />
            <DetailField label={zh ? "已付款" : "Paid"} value={detail.isPaid === null ? null : detail.isPaid ? yes : no} />
            <DetailField label={zh ? "已发货" : "Shipped"} value={detail.isShipped === null ? null : detail.isShipped ? yes : no} />
            <DetailField label={zh ? "礼品订单" : "Gift order"} value={detail.isGift === null ? null : detail.isGift ? yes : no} />
          </dl>
          <dl className="receiptDetailList receiptFinancialList">
            <DetailField label={zh ? "商品小计" : "Items subtotal"} value={receipt.subtotal ? money(receipt.subtotal, currency, locale) : null} />
            <DetailField label={zh ? "运费" : "Shipping"} value={receipt.total_shipping_cost ? money(receipt.total_shipping_cost, currency, locale) : null} />
            <DetailField label={zh ? "税费" : "Tax"} value={receipt.total_tax_cost ? money(receipt.total_tax_cost, currency, locale) : null} />
            <DetailField label={zh ? "优惠" : "Discount"} value={receipt.discount_amt ? money(receipt.discount_amt, currency, locale) : null} />
            <DetailField label={zh ? "订单总额" : "Order total"} value={receipt.grandtotal ? money(receipt.grandtotal, currency, locale) : null} />
          </dl>
        </section>

        {detail.messageFromBuyer || detail.messageFromSeller || detail.giftMessage ? (
          <section className="receiptDetailCard receiptMessages">
            <h3><MessageSquareText aria-hidden="true" size={16} />{zh ? "订单留言" : "Order messages"}</h3>
            {detail.messageFromBuyer ? <div><strong>{zh ? "买家留言" : "Buyer message"}</strong><p>{detail.messageFromBuyer}</p></div> : null}
            {detail.messageFromSeller ? <div><strong>{zh ? "卖家留言" : "Seller message"}</strong><p>{detail.messageFromSeller}</p></div> : null}
            {detail.giftMessage ? <div><strong>{zh ? "礼品留言" : "Gift message"}</strong><p>{detail.giftMessage}</p></div> : null}
          </section>
        ) : null}

        <section className="receiptDetailCard receiptItemDetailCard">
          <h3><Mail aria-hidden="true" size={16} />{zh ? "订单商品" : "Order items"}</h3>
          {detail.transactions.length ? <div className="receiptItemsTableWrap"><table className="table compactTable receiptItemsTable"><thead><tr><th>{zh ? "商品" : "Item"}</th><th>SKU</th><th>{zh ? "变体" : "Variations"}</th><th>{zh ? "数量" : "Qty"}</th><th>{zh ? "最晚发货" : "Ship by"}</th><th>{zh ? "单价" : "Unit price"}</th></tr></thead><tbody>{detail.transactions.map((transaction) => <tr key={transaction.transaction_id}><td>{transaction.title || "-"}</td><td>{transaction.sku || "-"}</td><td>{variationText(transaction.variations as VariationLike[])}</td><td>{transaction.quantity ?? "-"}</td><td>{transaction.expected_ship_date ? dateFromTimestamp(transaction.expected_ship_date, locale) : "-"}</td><td>{money(transaction.price, currency, locale)}</td></tr>)}</tbody></table></div> : <p>{zh ? "暂未同步到该订单的商品明细。" : "No line-item details have been synced for this receipt yet."}</p>}
        </section>
      </div>
    </details>
  );
}

import type { EtsyOrderDetail, EtsyReceiptSummary } from "@/shared/types/etsy";

type UnknownRecord = Record<string, unknown>;

export type ReceiptShipmentDetail = {
  carrier: string | null;
  mailedTimestamp: number | null;
  service: string | null;
  trackingCode: string | null;
};

export type ReceiptDetailView = {
  addressLines: string[];
  buyerEmail: string | null;
  buyerId: string | null;
  buyerName: string | null;
  giftMessage: string | null;
  isGift: boolean | null;
  isPaid: boolean | null;
  isShipped: boolean | null;
  messageFromBuyer: string | null;
  messageFromSeller: string | null;
  paymentEmail: string | null;
  paymentMethod: string | null;
  phone: string | null;
  recipientName: string | null;
  shipments: ReceiptShipmentDetail[];
  transactions: EtsyOrderDetail[];
};

function recordFrom(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}

function textFrom(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstText(record: UnknownRecord, keys: string[]) {
  for (const key of keys) {
    const value = textFrom(record[key]);
    if (value) return value;
  }
  return null;
}

function booleanFrom(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function timestampFrom(value: unknown) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

function shipmentDetails(receipt: EtsyReceiptSummary, raw: UnknownRecord): ReceiptShipmentDetail[] {
  const shipments = Array.isArray(receipt.shipments)
    ? receipt.shipments
    : Array.isArray(raw.shipments)
      ? raw.shipments
      : [];

  return shipments.map((shipment) => {
    const value = recordFrom(shipment);
    return {
      carrier: firstText(value, ["carrier_name", "carrier"]),
      mailedTimestamp: timestampFrom(value.mailed_timestamp ?? value.shipped_timestamp),
      service: firstText(value, ["mail_class", "service", "shipping_service"]),
      trackingCode: firstText(value, ["tracking_code", "tracking_number"]),
    };
  }).filter((shipment) => Boolean(shipment.carrier || shipment.mailedTimestamp || shipment.service || shipment.trackingCode));
}

export function buildReceiptDetail(receipt: EtsyReceiptSummary, transactions: EtsyOrderDetail[]): ReceiptDetailView {
  const raw = recordFrom(receipt);
  const formattedAddress = firstText(raw, ["formatted_address"]);
  const city = firstText(raw, ["city"]);
  const state = firstText(raw, ["state", "province"]);
  const postalCode = firstText(raw, ["zip", "postal_code"]);
  const country = firstText(raw, ["country_name", "country_iso"]);
  const locality = [city, state, postalCode, country].filter((value): value is string => Boolean(value)).join(", ");
  const addressLines = formattedAddress
    ? formattedAddress.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    : [
      firstText(raw, ["first_line", "address1"]),
      firstText(raw, ["second_line", "address2"]),
      locality || null,
    ].filter((value): value is string => Boolean(value));

  return {
    addressLines,
    buyerEmail: firstText(raw, ["buyer_email", "email"]),
    buyerId: raw.buyer_user_id === null || raw.buyer_user_id === undefined ? null : String(raw.buyer_user_id),
    buyerName: firstText(raw, ["buyer_name", "buyer_user_name"]),
    giftMessage: firstText(raw, ["gift_message"]),
    isGift: booleanFrom(raw.is_gift),
    isPaid: booleanFrom(raw.is_paid),
    isShipped: booleanFrom(raw.is_shipped),
    messageFromBuyer: firstText(raw, ["message_from_buyer", "buyer_message"]),
    messageFromSeller: firstText(raw, ["message_from_seller", "seller_message"]),
    paymentEmail: firstText(raw, ["payment_email"]),
    paymentMethod: firstText(raw, ["payment_method"]),
    phone: firstText(raw, ["phone", "phone_number"]),
    recipientName: firstText(raw, ["name", "recipient_name"]),
    shipments: shipmentDetails(receipt, raw),
    transactions,
  };
}

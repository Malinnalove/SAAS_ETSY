import type {
  EtsyListingSummary,
  EtsyMoney,
  EtsyOrderDetail,
  EtsyReceiptSummary,
  EtsyShopData,
} from "@/shared/types/etsy";
import { intlLocale, type Locale } from "@/shared/i18n";

export type VariationLike = {
  property_name?: string | null;
  value?: string | null;
  formatted_name?: string | null;
  formatted_value?: string | null;
  values?: string[] | null;
};

export function moneyValue(value?: EtsyMoney | null) {
  if (!value) return 0;
  return value.amount / value.divisor;
}

export function money(value?: EtsyMoney | null, fallbackCurrency = "USD", locale: Locale = "en") {
  const amount = moneyValue(value);
  const currency = value?.currency_code ?? fallbackCurrency;

  return new Intl.NumberFormat(intlLocale(locale), {
    style: "currency",
    currency,
    maximumFractionDigits: amount >= 1000 ? 0 : 2,
  }).format(amount);
}

export function currencyForShop(shopData: EtsyShopData | null) {
  return (
    shopData?.receipts[0]?.grandtotal?.currency_code ??
    shopData?.listings[0]?.price?.currency_code ??
    shopData?.shop?.currency_code ??
    "USD"
  );
}

export function compactNumber(value: number, locale: Locale = "en") {
  return new Intl.NumberFormat(intlLocale(locale), {
    maximumFractionDigits: value >= 1000 ? 1 : 0,
    notation: value >= 10000 ? "compact" : "standard",
  }).format(value);
}

export function percent(value: number, locale: Locale = "en") {
  return `${new Intl.NumberFormat(intlLocale(locale), { maximumFractionDigits: 1 }).format(value)}%`;
}

export function dateFromTimestamp(value?: number | null, locale: Locale = "en") {
  if (!value) return "-";
  return new Intl.DateTimeFormat(intlLocale(locale), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value * 1000));
}

export function dateFromString(value?: string | null, locale: Locale = "en") {
  if (!value) return locale === "zh" ? "尚未同步" : "Not synced yet";
  return new Intl.DateTimeFormat(intlLocale(locale), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function shortText(value?: string | null, maxLength = 58) {
  if (!value) return "-";
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}

export function initials(value?: string | null) {
  if (!value) return "ES";
  return value
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function variationText(variations?: VariationLike[] | null) {
  if (!variations?.length) return "-";

  return variations
    .map((variation) => {
      const name = variation.property_name ?? variation.formatted_name;
      const value = variation.value ?? variation.formatted_value ?? variation.values?.join(", ");
      return [name, value].filter(Boolean).join(": ");
    })
    .filter(Boolean)
    .join(", ");
}

export function receiptTotal(receipts: EtsyReceiptSummary[]) {
  return receipts.reduce((total, receipt) => total + moneyValue(receipt.grandtotal), 0);
}

export function recentReceipts(receipts: EtsyReceiptSummary[], limit = 20) {
  return receipts
    .slice()
    .sort((left, right) => (right.create_timestamp ?? 0) - (left.create_timestamp ?? 0))
    .slice(0, limit);
}

export function recentOrderDetails(orderDetails: EtsyOrderDetail[], limit = 20) {
  return orderDetails
    .slice()
    .sort((left, right) => (right.paid_timestamp ?? 0) - (left.paid_timestamp ?? 0))
    .slice(0, limit);
}

export function productRows(listings: EtsyListingSummary[], limit = 50) {
  return listings
    .slice()
    .sort((left, right) => (right.updated_timestamp ?? 0) - (left.updated_timestamp ?? 0))
    .slice(0, limit);
}

export function lowStockListings(listings: EtsyListingSummary[], limit = 8) {
  return listings
    .filter((listing) => typeof listing.quantity === "number" && listing.quantity <= 3)
    .sort((left, right) => (left.quantity ?? 0) - (right.quantity ?? 0))
    .slice(0, limit);
}

export function topListings(listings: EtsyListingSummary[], limit = 8) {
  return listings
    .slice()
    .sort(
      (left, right) =>
        (right.num_favorers ?? 0) - (left.num_favorers ?? 0) ||
        (right.views ?? 0) - (left.views ?? 0),
    )
    .slice(0, limit);
}

export function buildRevenueBars(receipts: EtsyReceiptSummary[], currency: string, locale: Locale = "en") {
  const grouped = new Map<string, { label: string; value: number; timestamp: number }>();

  for (const receipt of receipts) {
    if (!receipt.create_timestamp) continue;

    const date = new Date(receipt.create_timestamp * 1000);
    const key = date.toISOString().slice(0, 10);
    const current = grouped.get(key);
    const value = moneyValue(receipt.grandtotal);

    grouped.set(key, {
      label: new Intl.DateTimeFormat(intlLocale(locale), { month: "short", day: "numeric" }).format(date),
      timestamp: receipt.create_timestamp,
      value: (current?.value ?? 0) + value,
    });
  }

  const bars = Array.from(grouped.values())
    .sort((left, right) => left.timestamp - right.timestamp)
    .slice(-8);
  const maxValue = Math.max(...bars.map((bar) => bar.value), 1);

  return bars.length
    ? bars.map((bar) => ({
        ...bar,
        formatted: new Intl.NumberFormat(intlLocale(locale), {
          currency,
          maximumFractionDigits: 0,
          style: "currency",
        }).format(bar.value),
        height: Math.max(12, Math.round((bar.value / maxValue) * 100)),
        key: `${bar.timestamp}-${bar.label}`,
      }))
    : Array.from({ length: 8 }, (_, index) => ({
        key: `empty-${index}`,
        label: locale === "zh" ? `第 ${index + 1} 天` : `Day ${index + 1}`,
        value: 0,
        formatted: new Intl.NumberFormat(intlLocale(locale), {
          currency,
          maximumFractionDigits: 0,
          style: "currency",
        }).format(0),
        height: 12,
      }));
}

export function shopMetrics(shopData: EtsyShopData | null, locale: Locale = "en") {
  const listings = shopData?.listings ?? [];
  const receipts = shopData?.receipts ?? [];
  const currency = currencyForShop(shopData);
  const totalRevenue = receiptTotal(receipts);
  const totalViews = listings.reduce((total, listing) => total + (listing.views ?? 0), 0);
  const totalFavorites = listings.reduce((total, listing) => total + (listing.num_favorers ?? 0), 0);
  const totalInventory = listings.reduce((total, listing) => total + (listing.quantity ?? 0), 0);
  const activeListings = listings.filter((listing) => listing.state === "active").length;
  const pendingOrders = receipts.filter((receipt) => {
    const status = receipt.status?.toLowerCase() ?? "";
    return status && !["completed", "shipped", "delivered"].includes(status);
  }).length;

  return {
    activeListings,
    averageOrder: receipts.length > 0 ? totalRevenue / receipts.length : 0,
    conversionRate: totalViews > 0 ? (receipts.length / totalViews) * 100 : 0,
    currency,
    lowStockListings: lowStockListings(listings),
    pendingOrders,
    revenueBars: buildRevenueBars(receipts, currency, locale),
    topListings: topListings(listings),
    totalFavorites,
    totalInventory,
    totalRevenue,
    totalViews,
  };
}

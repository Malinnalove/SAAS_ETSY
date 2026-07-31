import { compactNumber, moneyValue } from "@/shared/format/commerce";
import { intlLocale, type Locale } from "@/shared/i18n";
import type { EtsyListingSummary, EtsyOrderDetail, EtsyReceiptSummary } from "@/shared/types/etsy";

export const chartMetrics = ["orders", "revenue", "listings"] as const;
export const chartRanges = ["week", "month", "quarter", "year"] as const;

export type ChartMetric = (typeof chartMetrics)[number];
export type ChartRange = (typeof chartRanges)[number];

type ChartBucket = {
  end: Date;
  key: string;
  label: string;
  start: Date;
  value: number;
};

export function selectedChartMetric(value?: string): ChartMetric {
  return chartMetrics.includes(value as ChartMetric) ? (value as ChartMetric) : "orders";
}

export function selectedChartRange(value?: string): ChartRange {
  return chartRanges.includes(value as ChartRange) ? (value as ChartRange) : "week";
}

function startOfDay(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function addDays(value: Date, days: number) {
  const next = new Date(value);
  next.setDate(next.getDate() + days);
  return next;
}

function addMonths(value: Date, months: number) {
  const next = new Date(value);
  next.setMonth(next.getMonth() + months);
  return next;
}

function rangeLabel(start: Date, end: Date, locale: Locale) {
  const dayFormatter = new Intl.DateTimeFormat(intlLocale(locale), { day: "numeric", month: "short" });
  const visibleEnd = addDays(end, -1);

  if (start.toDateString() === visibleEnd.toDateString()) {
    return dayFormatter.format(start);
  }

  return `${dayFormatter.format(start)}-${dayFormatter.format(visibleEnd)}`;
}

function buildBuckets(range: ChartRange, locale: Locale) {
  const today = startOfDay(new Date());

  if (range === "year") {
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

    return Array.from({ length: 12 }, (_, index) => {
      const start = addMonths(monthStart, index - 11);
      const end = addMonths(start, 1);

      return {
        end,
        key: start.toISOString(),
        label: new Intl.DateTimeFormat(intlLocale(locale), { month: "short" }).format(start),
        start,
        value: 0,
      };
    });
  }

  const config =
    range === "week"
      ? { count: 7, days: 1 }
      : range === "month"
        ? { count: 8, days: 4 }
        : { count: 13, days: 7 };
  const firstStart = addDays(today, -(config.count - 1) * config.days);

  return Array.from({ length: config.count }, (_, index) => {
    const start = addDays(firstStart, index * config.days);
    const end = addDays(start, config.days);

    return {
      end,
      key: start.toISOString(),
      label: rangeLabel(start, end, locale),
      start,
      value: 0,
    };
  });
}

function timestampFromSeconds(seconds?: number | null) {
  return seconds ? seconds * 1000 : null;
}

function addValueToBucket(buckets: ChartBucket[], timestamp: number | null, value: number) {
  if (!timestamp) return;

  const bucket = buckets.find((item) => timestamp >= item.start.getTime() && timestamp < item.end.getTime());

  if (bucket) {
    bucket.value += value;
  }
}

const chartBarPalettes: Record<ChartMetric, [string, string, string, string]> = {
  listings: ["#D9D9D9", "#A3A3A3", "#525252", "#0A0A0A"],
  orders: ["#E5E5E5", "#BDBDBD", "#737373", "#F5C400"],
  revenue: ["#D4D4D4", "#8C8C8C", "#404040", "#0A0A0A"],
};

function chartBarColor(metric: ChartMetric, value: number, maxValue: number) {
  if (value <= 0) return "#EDEDED";

  const ratio = maxValue > 0 ? value / maxValue : 0;
  const palette = chartBarPalettes[metric];

  if (ratio >= 0.82) return palette[3];
  if (ratio >= 0.6) return palette[2];
  if (ratio >= 0.38) return palette[1];
  return palette[0];
}

export function buildChartBars({
  currency,
  listings,
  locale,
  metric,
  range,
  receipts,
}: {
  currency: string;
  listings: EtsyListingSummary[];
  locale: Locale;
  metric: ChartMetric;
  range: ChartRange;
  receipts: EtsyReceiptSummary[];
}) {
  const buckets = buildBuckets(range, locale);

  if (metric === "listings") {
    for (const listing of listings) {
      if (listing.state !== "active") continue;
      addValueToBucket(buckets, timestampFromSeconds(listing.created_timestamp ?? listing.updated_timestamp), 1);
    }
  } else {
    for (const receipt of receipts) {
      const value = metric === "revenue" ? moneyValue(receipt.grandtotal) : 1;
      addValueToBucket(buckets, timestampFromSeconds(receipt.create_timestamp), value);
    }
  }

  const maxValue = Math.max(...buckets.map((bucket) => bucket.value), 1);

  return buckets.map((bucket) => ({
    ...bucket,
    color: chartBarColor(metric, bucket.value, maxValue),
    formatted:
      metric === "revenue"
        ? new Intl.NumberFormat(intlLocale(locale), {
            currency,
            maximumFractionDigits: bucket.value >= 1000 ? 0 : 2,
            style: "currency",
          }).format(bucket.value)
        : compactNumber(bucket.value, locale),
    height: Math.max(12, Math.round((bucket.value / maxValue) * 100)),
  }));
}

export function formatMetricValue(metric: ChartMetric, value: number, currency: string, locale: Locale) {
  if (metric === "revenue") {
    return new Intl.NumberFormat(intlLocale(locale), {
      currency,
      maximumFractionDigits: value >= 1000 ? 0 : 2,
      style: "currency",
    }).format(value);
  }

  return compactNumber(value, locale);
}

export function recentlyOrderedListings({
  limit = 8,
  listings,
  orderDetails,
  receiptById,
}: {
  limit?: number;
  listings: EtsyListingSummary[];
  orderDetails: EtsyOrderDetail[];
  receiptById: Map<number, EtsyReceiptSummary>;
}) {
  const listingById = new Map(listings.map((listing) => [listing.listing_id, listing]));
  const seen = new Set<number>();

  return orderDetails
    .slice()
    .sort((left, right) => {
      const leftReceipt = receiptById.get(left.receipt_id);
      const rightReceipt = receiptById.get(right.receipt_id);

      return (
        (right.paid_timestamp ?? rightReceipt?.create_timestamp ?? 0) -
        (left.paid_timestamp ?? leftReceipt?.create_timestamp ?? 0)
      );
    })
    .flatMap((detail) => {
      if (!detail.listing_id || seen.has(detail.listing_id)) return [];
      seen.add(detail.listing_id);

      const listing = listingById.get(detail.listing_id);

      return [
        {
          detail,
          key: detail.listing_id,
          listing,
          timestamp: detail.paid_timestamp ?? receiptById.get(detail.receipt_id)?.create_timestamp ?? null,
          title: detail.title ?? listing?.title ?? `Listing ${detail.listing_id}`,
          url: listing?.url ?? null,
        },
      ];
    })
    .slice(0, limit);
}

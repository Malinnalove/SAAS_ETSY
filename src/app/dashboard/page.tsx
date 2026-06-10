import { AppShell, EmptyState } from "@/components/app-shell";
import {
  compactNumber,
  currencyForShop,
  dateFromTimestamp,
  initials,
  money,
  moneyValue,
  percent,
  shopMetrics,
  shortText,
} from "@/lib/commerce-metrics";
import { getDictionary, intlLocale, type Locale } from "@/lib/i18n";
import type { EtsyListingSummary, EtsyOrderDetail, EtsyReceiptSummary } from "@/lib/types";
import { getWorkspace, hrefWithShop, type WorkspacePageProps } from "@/lib/workspace";

const chartMetrics = ["orders", "revenue", "listings"] as const;
const chartRanges = ["week", "month", "quarter", "year"] as const;

type ChartMetric = (typeof chartMetrics)[number];
type ChartRange = (typeof chartRanges)[number];

type ChartBucket = {
  end: Date;
  key: string;
  label: string;
  start: Date;
  value: number;
};

const dashboardCopy = {
  zh: {
    activity: {
      customerMessages: "客户消息",
      customerMessagesMeta: "待接入消息同步",
      emptyMessages: "暂无已同步客户消息。",
      emptyOrders: "近 24 小时暂无新增商品订单。",
      newProductOrders: "24 小时新增商品订单",
    },
    chart: {
      board: "数据图形看板",
      metricLabel: "指标",
      rangeLabel: "周期",
      total: "总计",
    },
    metrics: {
      listings: "上架 Listing",
      orders: "订单",
      revenue: "收入",
    },
    ranges: {
      month: "一月",
      quarter: "一季度",
      week: "一周",
      year: "一年",
    },
    shopFallback: "未连接店铺",
  },
  en: {
    activity: {
      customerMessages: "Customer messages",
      customerMessagesMeta: "Message sync not connected",
      emptyMessages: "No synced customer messages yet.",
      emptyOrders: "No new product orders in the last 24 hours.",
      newProductOrders: "New product orders in 24h",
    },
    chart: {
      board: "Data board",
      metricLabel: "Metric",
      rangeLabel: "Range",
      total: "Total",
    },
    metrics: {
      listings: "Active listings",
      orders: "Orders",
      revenue: "Revenue",
    },
    ranges: {
      month: "1 month",
      quarter: "1 quarter",
      week: "1 week",
      year: "1 year",
    },
    shopFallback: "No shop connected",
  },
} as const;

function selectedChartMetric(value?: string): ChartMetric {
  return chartMetrics.includes(value as ChartMetric) ? (value as ChartMetric) : "orders";
}

function selectedChartRange(value?: string): ChartRange {
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

function seriousHoneyBarColor(value: number, maxValue: number) {
  if (value <= 0) return "#E2DED5";

  const ratio = maxValue > 0 ? value / maxValue : 0;

  if (ratio >= 0.82) return "#B78317";
  if (ratio >= 0.6) return "#D39A23";
  if (ratio >= 0.38) return "#E0B34D";
  return "#CFC8B8";
}

function buildChartBars({
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
    color: seriousHoneyBarColor(bucket.value, maxValue),
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

function formatMetricValue(metric: ChartMetric, value: number, currency: string, locale: Locale) {
  if (metric === "revenue") {
    return new Intl.NumberFormat(intlLocale(locale), {
      currency,
      maximumFractionDigits: value >= 1000 ? 0 : 2,
      style: "currency",
    }).format(value);
  }

  return compactNumber(value, locale);
}

function dashboardLabels(locale: Locale) {
  return locale === "zh"
    ? {
        noRecentOrders: "最近一周暂无订单。",
        ordered: "出单",
        popularProducts: "热门商品",
        recentOrderLinks: "最近出单商品链接",
        recentWeek: "最近一周",
        thisWeekOrders: "本周订单",
        views: "浏览",
        weeklyOrderStatus: "最近一周订单状态",
      }
    : {
        noRecentOrders: "No orders in the last week.",
        ordered: "ordered",
        popularProducts: "Popular products",
        recentOrderLinks: "Recently ordered product links",
        recentWeek: "Last 7 days",
        thisWeekOrders: "This week orders",
        views: "views",
        weeklyOrderStatus: "Last week order status",
      };
}

function receiptStatusLabel(status: string, locale: Locale) {
  const normalized = status.toLowerCase();
  const labels =
    locale === "zh"
      ? {
          canceled: "已取消",
          completed: "已完成",
          delivered: "已送达",
          open: "待处理",
          paid: "已付款",
          shipped: "已发货",
          unknown: "未知",
        }
      : {
          canceled: "Canceled",
          completed: "Completed",
          delivered: "Delivered",
          open: "Open",
          paid: "Paid",
          shipped: "Shipped",
          unknown: "Unknown",
        };

  return (labels[normalized as keyof typeof labels] ?? status) || labels.unknown;
}

function weeklyOrderStatuses(receipts: EtsyReceiptSummary[], locale: Locale) {
  const grouped = new Map<string, number>();

  for (const receipt of receipts) {
    const key = receipt.status?.trim() || "unknown";
    grouped.set(key, (grouped.get(key) ?? 0) + 1);
  }

  return Array.from(grouped.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([status, count]) => ({
      count,
      key: status,
      label: receiptStatusLabel(status, locale),
    }));
}

function recentlyOrderedListings({
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

export default async function DashboardPage({ searchParams }: WorkspacePageProps) {
  const { locale, params, selectedShop, selectedShopId, store } = await getWorkspace(searchParams);
  const t = getDictionary(locale);
  const copy = dashboardCopy[locale];
  const labels = dashboardLabels(locale);
  const metrics = shopMetrics(selectedShop, locale);
  const currency = currencyForShop(selectedShop);
  const chartMetric = selectedChartMetric(params?.chartMetric);
  const chartRange = selectedChartRange(params?.chartRange);
  const listings = selectedShop?.listings ?? [];
  const receipts = selectedShop?.receipts ?? [];
  const chartBars = buildChartBars({
    currency,
    listings,
    locale,
    metric: chartMetric,
    range: chartRange,
    receipts,
  });
  const chartTotal = chartBars.reduce((total, bar) => total + bar.value, 0);
  const shopIcon =
    selectedShop?.shop && "icon_url_fullxfull" in selectedShop.shop
      ? String(selectedShop.shop.icon_url_fullxfull ?? "")
      : "";
  const shopName = selectedShop?.connection.shopName ?? copy.shopFallback;
  const orderDetails = selectedShop?.orderDetails ?? [];
  const receiptById = new Map(receipts.map((receipt) => [receipt.receipt_id, receipt]));
  const nowSeconds = Math.floor(new Date().getTime() / 1000);
  const twentyFourHoursAgo = nowSeconds - 24 * 60 * 60;
  const oneWeekAgo = nowSeconds - 7 * 24 * 60 * 60;
  const weeklyReceipts = receipts.filter((receipt) => (receipt.create_timestamp ?? 0) >= oneWeekAgo);
  const weeklyStatusRows = weeklyOrderStatuses(weeklyReceipts, locale);
  const recentOrderedListingRows = recentlyOrderedListings({
    listings,
    orderDetails,
    receiptById,
  });
  const newOrderRows = orderDetails
    .filter((detail) => {
      const receipt = receiptById.get(detail.receipt_id);
      return (detail.paid_timestamp ?? receipt?.create_timestamp ?? 0) >= twentyFourHoursAgo;
    })
    .sort((left, right) => {
      const leftReceipt = receiptById.get(left.receipt_id);
      const rightReceipt = receiptById.get(right.receipt_id);

      return (
        (right.paid_timestamp ?? rightReceipt?.create_timestamp ?? 0) -
        (left.paid_timestamp ?? leftReceipt?.create_timestamp ?? 0)
      );
    })
    .slice(0, 5);
  const newReceiptRows = receipts
    .filter((receipt) => (receipt.create_timestamp ?? 0) >= twentyFourHoursAgo)
    .sort((left, right) => (right.create_timestamp ?? 0) - (left.create_timestamp ?? 0))
    .slice(0, 5);
  const overviewStats = [
    {
      label: t.dashboard.metrics.revenue,
      meta: t.dashboard.meta.syncedOrders(compactNumber(receipts.length, locale)),
      value: new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en", {
        currency,
        maximumFractionDigits: metrics.totalRevenue >= 1000 ? 0 : 2,
        style: "currency",
      }).format(metrics.totalRevenue),
    },
    {
      label: t.dashboard.metrics.averageOrder,
      meta: t.dashboard.meta.ordersNeedAttention(metrics.pendingOrders),
      value: new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en", {
        currency,
        maximumFractionDigits: metrics.averageOrder >= 1000 ? 0 : 2,
        style: "currency",
      }).format(metrics.averageOrder),
    },
    {
      label: t.dashboard.metrics.products,
      meta: t.dashboard.meta.unitsInStock(compactNumber(metrics.totalInventory, locale)),
      value: compactNumber(listings.length, locale),
    },
    {
      label: t.dashboard.metrics.conversion,
      meta: t.dashboard.meta.listingViews(compactNumber(metrics.totalViews, locale)),
      value: percent(metrics.conversionRate, locale),
    },
    {
      label: labels.thisWeekOrders,
      meta: labels.recentWeek,
      value: compactNumber(weeklyReceipts.length, locale),
    },
  ];

  return (
    <AppShell
      activePath="/dashboard"
      kicker={t.nav.dashboard}
      locale={locale}
      preserveParams={{ chartMetric, chartRange }}
      selectedShop={selectedShop}
      selectedShopId={selectedShopId}
      store={store}
      title={shopName}
    >
      <section className="overviewBand">
        <div className="shopIdentity compactShopIdentity">
          <div className="shopAvatar" aria-hidden="true">
            {shopIcon ? (
              <span className="shopAvatarImage" style={{ backgroundImage: `url(${shopIcon})` }} />
            ) : (
              initials(shopName)
            )}
          </div>
          <div>
            <h2>{shopName}</h2>
          </div>
        </div>

        <div className="overviewMetrics" aria-label="Key metrics">
          {overviewStats.map((stat) => (
            <div className="overviewMetric" key={stat.label}>
              <span>{stat.label}</span>
              <strong>{stat.value}</strong>
              <small>{stat.meta}</small>
            </div>
          ))}
        </div>
      </section>

      <section className="analyticsGrid">
        <div className="panel chartPanel">
          <div className="panelHeader chartHeader">
            <div>
              <span className="tinyLabel">{copy.chart.board}</span>
              <h2>
                {copy.ranges[chartRange]} {copy.metrics[chartMetric]}
              </h2>
            </div>
            <div className="chartControls">
              <div className="segmentedControl" aria-label={copy.chart.metricLabel}>
                {chartMetrics.map((metric) => (
                  <a
                    className={metric === chartMetric ? "chartOption active" : "chartOption"}
                    href={hrefWithShop("/dashboard", selectedShopId, {
                      chartMetric: metric,
                      chartRange,
                      lang: locale,
                    })}
                    key={metric}
                  >
                    {copy.metrics[metric]}
                  </a>
                ))}
              </div>
              <div className="segmentedControl" aria-label={copy.chart.rangeLabel}>
                {chartRanges.map((range) => (
                  <a
                    className={range === chartRange ? "chartOption active" : "chartOption"}
                    href={hrefWithShop("/dashboard", selectedShopId, {
                      chartMetric,
                      chartRange: range,
                      lang: locale,
                    })}
                    key={range}
                  >
                    {copy.ranges[range]}
                  </a>
                ))}
              </div>
              <span className="panelMeta">
                {copy.chart.total} {formatMetricValue(chartMetric, chartTotal, currency, locale)}
              </span>
            </div>
          </div>
          <div
            className="barChart"
            aria-label={`${copy.ranges[chartRange]} ${copy.metrics[chartMetric]}`}
            style={{ gridTemplateColumns: `repeat(${chartBars.length}, minmax(42px, 1fr))` }}
          >
            {chartBars.map((bar) => (
              <div className="barItem" key={bar.key}>
                <span className="barValue">{bar.formatted}</span>
                <span className="barTrack">
                  <span className="barFill" style={{ backgroundColor: bar.color, height: `${bar.height}%` }} />
                </span>
                <span className="barLabel">{bar.label}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="panel activityPanel">
          <div className="activityBlock">
            <div className="panelHeader">
              <div>
                <span className="tinyLabel">{copy.ranges.week}</span>
                <h2>{copy.activity.newProductOrders}</h2>
              </div>
              <span className="panelMeta">{compactNumber(newOrderRows.length || newReceiptRows.length, locale)}</span>
            </div>
            <div className="activityList">
              {newOrderRows.map((detail) => {
                const receipt = receiptById.get(detail.receipt_id);

                return (
                  <div className="activityRow" key={detail.transaction_id}>
                    <span className="activityCount">{detail.quantity ?? 1}</span>
                    <div>
                      <strong>{shortText(detail.title, 44)}</strong>
                      <small>
                        {money(detail.price, currency, locale)} ·{" "}
                        {dateFromTimestamp(detail.paid_timestamp ?? receipt?.create_timestamp, locale)}
                      </small>
                    </div>
                  </div>
                );
              })}
              {newOrderRows.length === 0
                ? newReceiptRows.map((receipt) => (
                    <div className="activityRow" key={receipt.receipt_id}>
                      <span className="activityCount">1</span>
                      <div>
                        <strong>{receipt.name ?? `#${receipt.receipt_id}`}</strong>
                        <small>
                          {money(receipt.grandtotal, currency, locale)} ·{" "}
                          {dateFromTimestamp(receipt.create_timestamp, locale)}
                        </small>
                      </div>
                    </div>
                  ))
                : null}
              {newOrderRows.length === 0 && newReceiptRows.length === 0 ? (
                <EmptyState>{copy.activity.emptyOrders}</EmptyState>
              ) : null}
            </div>
          </div>

          <div className="activityBlock">
            <div className="panelHeader">
              <div>
                <span className="tinyLabel">{copy.activity.customerMessagesMeta}</span>
                <h2>{copy.activity.customerMessages}</h2>
              </div>
            </div>
            <div className="messagePlaceholder">
              <EmptyState>{copy.activity.emptyMessages}</EmptyState>
            </div>
          </div>
        </div>
      </section>

      <section className="dashboardInsights">
        <div className="panel orderStatusPanel">
          <div className="panelHeader">
            <div>
              <span className="tinyLabel">{labels.recentWeek}</span>
              <h2>{labels.weeklyOrderStatus}</h2>
            </div>
            <span className="panelMeta">{compactNumber(weeklyReceipts.length, locale)}</span>
          </div>
          {weeklyStatusRows.length > 0 ? (
            <div className="statusSummaryGrid">
              {weeklyStatusRows.map((row) => (
                <div className="statusSummaryItem" key={row.key}>
                  <strong>{compactNumber(row.count, locale)}</strong>
                  <span>{row.label}</span>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState>{labels.noRecentOrders}</EmptyState>
          )}
        </div>

        <div className="insightGrid">
          <div className="panel">
            <div className="panelHeader">
              <div>
                <span className="tinyLabel">{t.dashboard.sections.demand}</span>
                <h2>{labels.popularProducts}</h2>
              </div>
            </div>
            <div className="rankList">
              {metrics.topListings.map((listing, index) => (
                <a
                  className="rankRow"
                  href={listing.url ?? "#"}
                  key={listing.listing_id}
                  rel="noreferrer"
                  target={listing.url ? "_blank" : undefined}
                >
                  <span className="rankBadge">{String(index + 1).padStart(2, "0")}</span>
                  <strong>{shortText(listing.title, 52)}</strong>
                  <small>
                    {compactNumber(listing.views ?? 0, locale)} {labels.views}
                  </small>
                </a>
              ))}
              {metrics.topListings.length === 0 ? <EmptyState>{t.dashboard.empty.products}</EmptyState> : null}
            </div>
          </div>

          <div className="panel">
            <div className="panelHeader">
              <div>
                <span className="tinyLabel">{labels.ordered}</span>
                <h2>{labels.recentOrderLinks}</h2>
              </div>
            </div>
            <div className="rankList">
              {recentOrderedListingRows.map((row, index) => (
                <a
                  className="rankRow"
                  href={row.url ?? "#"}
                  key={row.key}
                  rel="noreferrer"
                  target={row.url ? "_blank" : undefined}
                >
                  <span className="rankBadge">{String(index + 1).padStart(2, "0")}</span>
                  <strong>{shortText(row.title, 52)}</strong>
                  <small>
                    {money(row.detail.price, currency, locale)} · {dateFromTimestamp(row.timestamp, locale)}
                  </small>
                </a>
              ))}
              {recentOrderedListingRows.length === 0 ? <EmptyState>{labels.noRecentOrders}</EmptyState> : null}
            </div>
          </div>
        </div>
      </section>
    </AppShell>
  );
}

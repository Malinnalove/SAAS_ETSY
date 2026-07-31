import { AppShell, EmptyState } from "@/components/app-shell";
import {
  compactNumber,
  currencyForShop,
  dateFromTimestamp,
  initials,
  money,
  percent,
  shopMetrics,
  shortText,
} from "@/shared/format/commerce";
import {
  buildChartBars,
  chartMetrics,
  chartRanges,
  formatMetricValue,
  recentlyOrderedListings,
  selectedChartMetric,
  selectedChartRange,
} from "@/features/dashboard/view-model";
import { getErpCommerceSnapshot } from "@/features/erp/commerce-snapshot";
import { getDictionary, type Locale } from "@/shared/i18n";
import type { EtsyReceiptSummary } from "@/shared/types/etsy";
import { getWorkspace, hrefWithShop, type WorkspacePageProps } from "@/features/workspace/workspace";
import { requirePermission } from "@/features/auth/session";

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

export default async function DashboardPage({ searchParams }: WorkspacePageProps) {
  const user = await requirePermission("dashboard.read", "/dashboard");
  const { locale, params, selectedShop, selectedShopId, store } = await getWorkspace(searchParams, "/dashboard");
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
  const copy = dashboardCopy[locale];
  const labels = dashboardLabels(locale);
  const rawMetrics = shopMetrics(selectedShopData, locale);
  const metrics = erpSnapshot
    ? {
        ...rawMetrics,
        activeListings: erpSnapshot.metrics.activeProducts,
        averageOrder: erpSnapshot.metrics.averageOrder,
        totalInventory: erpSnapshot.metrics.totalOnHand,
        totalRevenue: erpSnapshot.metrics.totalRevenue,
      }
    : rawMetrics;
  const currency = currencyForShop(selectedShopData);
  const chartMetric = selectedChartMetric(params?.chartMetric);
  const chartRange = selectedChartRange(params?.chartRange);
  const listings = selectedShopData?.listings ?? [];
  const receipts = selectedShopData?.receipts ?? [];
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
    selectedShopData?.shop && "icon_url_fullxfull" in selectedShopData.shop
      ? String(selectedShopData.shop.icon_url_fullxfull ?? "")
      : "";
  const shopName = selectedShopData?.connection.shopName ?? copy.shopFallback;
  const orderDetails = selectedShopData?.orderDetails ?? [];
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
      value: compactNumber(metrics.activeListings || listings.length, locale),
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
        <div className={`panel chartPanel chartMetric-${chartMetric}`}>
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

        <div className="insightGrid twoUp">
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

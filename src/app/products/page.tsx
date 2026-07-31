import { Archive, Eye, Heart, Package } from "lucide-react";
import { AppShell, EmptyState, MetricCard, StatusBadge } from "@/components/app-shell";
import { ListingThumbnail } from "@/components/products/listing-thumbnail";
import { getErpCommerceSnapshot } from "@/features/erp/commerce-snapshot";
import {
  compactNumber,
  currencyForShop,
  dateFromTimestamp,
  lowStockListings,
  money,
  productRows,
  shortText,
  topListings,
} from "@/shared/format/commerce";
import { getDictionary, statusLabel } from "@/shared/i18n";
import { getWorkspace, type WorkspacePageProps } from "@/features/workspace/workspace";
import { requirePermission } from "@/features/auth/session";

function listingTone(state?: string | null) {
  if (state === "active") return "success" as const;
  if (state === "inactive") return "neutral" as const;
  return "warning" as const;
}

export default async function ProductsPage({ searchParams }: WorkspacePageProps) {
  const user = await requirePermission("products.read", "/products");
  const { locale, params, selectedShop, selectedShopId, store } = await getWorkspace(searchParams, "/products");
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
  const listings = selectedShopData?.listings ?? [];
  const currency = currencyForShop(selectedShopData);
  const rows = productRows(listings, 80);
  const activeListings = erpSnapshot?.metrics.activeProducts ?? listings.filter((listing) => listing.state === "active").length;
  const inventory = erpSnapshot?.inventory.onHand ?? listings.reduce((total, listing) => total + (listing.quantity ?? 0), 0);
  const views = listings.reduce((total, listing) => total + (listing.views ?? 0), 0);
  const favorites = listings.reduce((total, listing) => total + (listing.num_favorers ?? 0), 0);
  const lowStock = lowStockListings(listings, 20);
  const topProducts = topListings(listings, 6);
  const listingStatus = params?.listingStatus;
  const listingDetail = params?.listingDetail;

  return (
    <AppShell
      activePath="/products"
      kicker={t.products.kicker}
      locale={locale}
      preserveParams={
        listingStatus && listingDetail
          ? { listingDetail, listingStatus }
          : undefined
      }
      selectedShop={selectedShop}
      selectedShopId={selectedShopId}
      store={store}
      title={t.products.title}
    >
      <section className="metricGrid fourUp" aria-label="Product metrics">
        <MetricCard
          icon={Package}
          label={t.products.metrics.listings}
          meta={t.products.metrics.active(activeListings)}
          tone="blue"
          value={compactNumber(listings.length, locale)}
        />
        <MetricCard
          icon={Archive}
          label={t.products.metrics.inventory}
          meta={t.products.metrics.syncedUnits}
          tone="teal"
          value={compactNumber(inventory, locale)}
        />
        <MetricCard
          icon={Eye}
          label={t.products.metrics.views}
          meta={t.products.metrics.listingTraffic}
          tone="amber"
          value={compactNumber(views, locale)}
        />
        <MetricCard
          icon={Heart}
          label={t.products.metrics.favorites}
          meta={t.products.metrics.lowStockAlerts(lowStock.length)}
          tone="coral"
          value={compactNumber(favorites, locale)}
        />
      </section>

      {listingStatus && listingDetail ? (
        <div className={listingStatus === "failed" ? "notice errorNotice" : "notice successNotice"}>
          {listingDetail}
        </div>
      ) : null}

      <section className="insightGrid twoUp">
        <div className="panel">
          <div className="panelHeader">
            <div>
              <span className="tinyLabel">{t.products.sections.inventory}</span>
              <h2>{t.products.sections.lowStock}</h2>
            </div>
            <span className="panelMeta">{compactNumber(lowStock.length, locale)}</span>
          </div>
          <div className="rankList">
            {lowStock.map((listing) => (
              <a
                className="rankRow thumbRankRow"
                href={listing.url ?? "#"}
                key={listing.listing_id}
                rel="noreferrer"
                target={listing.url ? "_blank" : undefined}
              >
                <ListingThumbnail listing={listing} />
                <span className="rankBadge">{listing.quantity ?? 0}</span>
                <strong>{shortText(listing.title, 52)}</strong>
                <small>{money(listing.price, currency, locale)}</small>
              </a>
            ))}
            {lowStock.length === 0 ? <EmptyState>{t.products.emptyLowStock}</EmptyState> : null}
          </div>
        </div>

        <div className="panel">
          <div className="panelHeader">
            <div>
              <span className="tinyLabel">{t.products.sections.demand}</span>
              <h2>{t.products.sections.mostFavorited}</h2>
            </div>
          </div>
          <div className="rankList">
            {topProducts.map((listing, index) => (
              <a
                className="rankRow thumbRankRow"
                href={listing.url ?? "#"}
                key={listing.listing_id}
                rel="noreferrer"
                target={listing.url ? "_blank" : undefined}
              >
                <ListingThumbnail listing={listing} />
                <span className="rankBadge">{String(index + 1).padStart(2, "0")}</span>
                <strong>{shortText(listing.title, 52)}</strong>
                <small>{compactNumber(listing.num_favorers ?? 0, locale)} {t.products.metrics.favorites}</small>
              </a>
            ))}
            {topProducts.length === 0 ? <EmptyState>{t.products.emptySignals}</EmptyState> : null}
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panelHeader">
          <div>
            <span className="tinyLabel">{t.products.sections.products}</span>
            <h2>{t.products.sections.syncedCatalog}</h2>
          </div>
          <span className="panelMeta">{compactNumber(listings.length, locale)}</span>
        </div>
        <div className="tableWrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t.products.table.product}</th>
                <th>{t.products.table.status}</th>
                <th>{t.products.table.stock}</th>
                <th>{t.products.table.price}</th>
                <th>{t.products.table.views}</th>
                <th>{t.products.table.favorites}</th>
                <th>{t.products.table.updated}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((listing) => (
                <tr key={listing.listing_id}>
                  <td>
                    <div className="listingProductCell">
                      <ListingThumbnail listing={listing} />
                      <div>
                        {listing.url ? (
                          <a className="textLink" href={listing.url} target="_blank" rel="noreferrer">
                            {shortText(listing.title, 76)}
                          </a>
                        ) : (
                          shortText(listing.title, 76)
                        )}
                        <small className="tableSub">ID {listing.listing_id}</small>
                      </div>
                    </div>
                  </td>
                  <td>
                    <StatusBadge tone={listingTone(listing.state)}>{statusLabel(listing.state, locale)}</StatusBadge>
                  </td>
                  <td>{listing.quantity ?? "-"}</td>
                  <td>{money(listing.price, currency, locale)}</td>
                  <td>{compactNumber(listing.views ?? 0, locale)}</td>
                  <td>{compactNumber(listing.num_favorers ?? 0, locale)}</td>
                  <td>{dateFromTimestamp(listing.updated_timestamp, locale)}</td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="mutedCell">
                    {t.products.emptyProducts}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </AppShell>
  );
}

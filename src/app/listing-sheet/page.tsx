import { AppShell } from "@/components/app-shell";
import { ListingWorkbench } from "@/components/products/listing-workbench";
import { hasShopAccess, requirePermission } from "@/features/auth/session";
import {
  getListingShopDefaults,
  listListingSavedViews,
  listListingWorkspaceRows,
} from "@/features/products/listing-workbench-db";
import {
  getListingWorkspaceContext,
  type WorkspacePageProps,
} from "@/features/workspace/workspace";
import { getDictionary } from "@/shared/i18n";

export default async function ListingSheetPage({ searchParams }: WorkspacePageProps) {
  const user = await requirePermission("listings.read", "/listing-sheet");
  const resolvedParams = await searchParams;
  const { admin, locale, params, selectedShop, selectedShopId, store } = await getListingWorkspaceContext(
    Promise.resolve(resolvedParams ?? {}),
  );
  const t = getDictionary(locale);
  const requestedView = params?.workbenchView;
  const initialView = requestedView === "changed" || requestedView === "attention" || requestedView === "failed" || requestedView === "inactive"
    ? "changed"
    : "all";
  const requestedSort = params?.workbenchSort;
  const initialSort = requestedSort === "title_asc" || requestedSort === "price_desc" || requestedSort === "quantity_asc"
    ? requestedSort
    : "updated_desc";
  const initialSearch = params?.workbenchSearch ?? "";
  const initialState = initialView === "all" ? params?.workbenchState?.trim().toLowerCase() ?? "" : "";
  const initialPage = selectedShopId
    ? await listListingWorkspaceRows({
        limit: 100,
        organizationId: admin.organizationId,
        search: initialSearch,
        shopId: selectedShopId,
        sort: initialSort,
        state: initialState,
        view: initialView,
      })
    : { hasMore: false, nextCursor: null, rows: [], states: [] };
  const canEditSelectedShop = Boolean(
    selectedShopId && await hasShopAccess(user, selectedShopId, "listings.write"),
  );

  if (!canEditSelectedShop) {
    return (
      <AppShell
        activePath="/listing-sheet"
        kicker={t.products.sheet.kicker}
        locale={locale}
        selectedShop={selectedShop}
        selectedShopId={selectedShopId}
        store={store}
        title={t.products.sheet.title}
      >
        <div className="panel">
          <div className="panelHeader">
            <div><span className="tinyLabel">Viewer</span><h2>Listing 只读视图</h2></div>
          </div>
          <div className="tableWrap">
            <table className="table">
              <thead><tr><th>Listing</th><th>状态</th><th>SKU</th><th>价格</th><th>库存</th></tr></thead>
              <tbody>
                {initialPage.rows.map((row) => (
                  <tr key={row.rowId}>
                    <td>{row.values.title || row.listingId || "-"}</td>
                    <td>{row.values.state}</td>
                    <td>{row.values.sku || "-"}</td>
                    <td>{row.values.price?.amount ?? "-"}</td>
                    <td>{row.values.quantity ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </AppShell>
    );
  }

  const savedViews = selectedShopId
    ? await listListingSavedViews({ organizationId: admin.organizationId, shopId: selectedShopId })
    : [];
  const shopDefaults = selectedShopId
    ? await getListingShopDefaults({ organizationId: admin.organizationId, shopId: selectedShopId })
    : null;

  return (
    <AppShell
      activePath="/listing-sheet"
      kicker={t.products.sheet.kicker}
      locale={locale}
      preserveParams={{
        workbenchSearch: initialSearch,
        workbenchSort: initialSort,
        workbenchState: initialState,
        workbenchView: initialView,
      }}
      selectedShop={selectedShop}
      selectedShopId={selectedShopId}
      store={store}
      title={t.products.sheet.title}
    >
      {selectedShopId ? (
        <ListingWorkbench
          initialPage={initialPage}
          initialSearch={initialSearch}
          initialSort={initialSort}
          initialState={initialState}
          initialView={initialView}
          locale={locale}
          savedViews={savedViews}
          selectedShopId={selectedShopId}
          shopDefaults={shopDefaults!}
        />
      ) : (
        <div className="notice errorNotice">
          {locale === "zh" ? "请先连接并选择 Etsy 店铺。" : "Connect and select an Etsy shop first."}
        </div>
      )}
    </AppShell>
  );
}

import { readStore, selectShop } from "@/lib/store";
import { getLocaleFromParams } from "@/lib/i18n";

export type WorkspaceSearchParams = Promise<{
  chartMetric?: string;
  chartRange?: string;
  lang?: string;
  listingDetail?: string;
  listingId?: string;
  listingPanel?: string;
  listingStatus?: string;
  shopId?: string;
  settingsDetail?: string;
  settingsStatus?: string;
  writeDetail?: string;
  writeStatus?: string;
}>;

export type WorkspacePageProps = {
  searchParams?: WorkspaceSearchParams;
};

export function selectedShopIdFromParams(params?: { shopId?: string }) {
  const requestedShopId = Number(params?.shopId);
  return Number.isFinite(requestedShopId) && requestedShopId > 0 ? requestedShopId : null;
}

export async function getWorkspace(searchParams?: WorkspaceSearchParams) {
  const params = await searchParams;
  const locale = getLocaleFromParams(params);
  const requestedShopId = selectedShopIdFromParams(params);
  const store = await readStore();
  const selectedShop = selectShop(store, requestedShopId);

  return {
    locale,
    params,
    requestedShopId,
    selectedShop,
    selectedShopId: selectedShop?.connection.shopId ?? null,
    store,
  };
}

export type WorkspaceLinkParams = Record<string, number | string | null | undefined>;

export function hrefWithParams(pathname: string, params: WorkspaceLinkParams = {}) {
  const searchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") continue;
    searchParams.set(key, String(value));
  }

  const query = searchParams.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function hrefWithShop(
  pathname: string,
  shopId?: number | null,
  params: WorkspaceLinkParams = {},
) {
  return hrefWithParams(pathname, {
    shopId: shopId ?? undefined,
    ...params,
  });
}

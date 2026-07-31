import { filterStoreByShopIds, readOrganizationStore, selectShop } from "@/lib/store";
import { listAccessibleShopIds, requireUser } from "@/features/auth/session";
import { getLocaleFromParams } from "@/shared/i18n";
import { readWorkspaceShellStore } from "@/features/sync/db";

export type WorkspaceSearchParams = Promise<{
  error?: string;
  chartMetric?: string;
  chartRange?: string;
  lang?: string;
  listingDetail?: string;
  listingEdit?: string;
  listingId?: string;
  listingPanel?: string;
  listingStatus?: string;
  shopId?: string;
  skuQueued?: string;
  next?: string;
  workbenchView?: string;
  workbenchSearch?: string;
  workbenchSort?: string;
  workbenchState?: string;
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

export async function getListingWorkspaceContext(searchParams?: WorkspaceSearchParams) {
  const params = await searchParams;
  const admin = await requireUser(hrefWithParams("/listing-sheet", params));
  const locale = getLocaleFromParams(params);
  const requestedShopId = selectedShopIdFromParams(params);
  const store = filterStoreByShopIds(
    await readWorkspaceShellStore(admin.organizationId),
    await listAccessibleShopIds(admin),
  );
  const selectedShop = selectShop(store, requestedShopId);

  return {
    admin,
    locale,
    params,
    requestedShopId,
    selectedShop,
    selectedShopId: selectedShop?.connection.shopId ?? null,
    store,
  };
}

export async function getWorkspace(searchParams?: WorkspaceSearchParams, pathname = "/dashboard") {
  const params = await searchParams;
  const admin = await requireUser(hrefWithParams(pathname, params));
  const locale = getLocaleFromParams(params);
  const requestedShopId = selectedShopIdFromParams(params);
  const store = filterStoreByShopIds(
    await readOrganizationStore(admin.organizationId),
    await listAccessibleShopIds(admin),
  );
  const selectedShop = selectShop(store, requestedShopId);

  return {
    admin,
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

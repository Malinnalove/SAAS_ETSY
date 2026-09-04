import { NextResponse } from "next/server";
import { listAccessibleShopIds, requireUserApi } from "@/features/auth/session";
import { filterStoreByShopIds, readOrganizationStore } from "@/lib/store";
import { getSyncStatus } from "@/features/sync/db";
import { etsyApiSlotForConnection } from "@/features/etsy/api-config";

export async function GET(request: Request) {
  const guard = await requireUserApi(request, "products.read");
  if (guard.response) {
    return guard.response;
  }

  const shopIds = await listAccessibleShopIds(guard.user!);
  const store = filterStoreByShopIds(await readOrganizationStore(guard.user!.organizationId), shopIds);
  const syncStatus = await getSyncStatus(undefined, shopIds).catch(() => null);

  return NextResponse.json({
    connected: Boolean(store.connection),
    shop: store.connection
      ? {
          shopId: store.connection.shopId,
          apiSlot: etsyApiSlotForConnection(store.connection),
          shopName: store.connection.shopName,
          userId: store.connection.userId,
          scopes: store.connection.scopes,
          tokenExpiresAt: new Date(store.connection.expiresAt).toISOString(),
        }
      : null,
    counts: {
      listings: store.listings.length,
      receipts: store.receipts.length,
      orderDetails: store.orderDetails.length,
      ads: store.ads.length,
    },
    apiQuota: store.apiQuota,
    shops: store.shops.map((shopData) => ({
      shopId: shopData.connection.shopId,
      apiSlot: etsyApiSlotForConnection(shopData.connection),
      shopName: shopData.connection.shopName,
      userId: shopData.connection.userId,
      active: shopData.connection.shopId === store.activeShopId,
      lastSyncAt: shopData.lastSyncAt,
      newOrderCount: shopData.newOrderCount,
      apiQuota: shopData.apiQuota,
      counts: {
        listings: shopData.listings.length,
        receipts: shopData.receipts.length,
        orderDetails: shopData.orderDetails.length,
        ads: shopData.ads.length,
      },
    })),
    syncStatus,
    adsSyncNote: store.adsSyncNote,
    lastSyncAt: store.lastSyncAt,
  });
}

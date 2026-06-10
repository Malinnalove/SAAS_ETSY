import { NextResponse } from "next/server";
import { readStore } from "@/lib/store";
import { getSyncStatus } from "@/lib/sync-db";

export async function GET() {
  const store = await readStore();
  const syncStatus = await getSyncStatus().catch(() => null);

  return NextResponse.json({
    connected: Boolean(store.connection),
    shop: store.connection
      ? {
          shopId: store.connection.shopId,
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
    shops: store.shops.map((shopData) => ({
      shopId: shopData.connection.shopId,
      shopName: shopData.connection.shopName,
      userId: shopData.connection.userId,
      active: shopData.connection.shopId === store.activeShopId,
      lastSyncAt: shopData.lastSyncAt,
      newOrderCount: shopData.newOrderCount,
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

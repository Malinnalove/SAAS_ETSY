import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import { getPool } from "@/lib/db";
import { readDatabaseStore, replaceDatabaseStore } from "@/lib/sync-db";
import type { AppStore, EtsyShopData } from "@/lib/types";

const storePath = path.join(process.cwd(), "data", "app.json");

const emptyStore: AppStore = {
  connection: null,
  shop: null,
  listings: [],
  receipts: [],
  orderDetails: [],
  ads: [],
  adsSyncNote: null,
  lastSyncAt: null,
  activeShopId: null,
  shops: [],
};

function mirrorActiveShop(store: AppStore, activeShop: EtsyShopData | null): AppStore {
  return {
    ...store,
    connection: activeShop?.connection ?? null,
    shop: activeShop?.shop ?? null,
    listings: activeShop?.listings ?? [],
    receipts: activeShop?.receipts ?? [],
    orderDetails: activeShop?.orderDetails ?? [],
    ads: activeShop?.ads ?? [],
    adsSyncNote: activeShop?.adsSyncNote ?? null,
    lastSyncAt: activeShop?.lastSyncAt ?? null,
  };
}

export function normalizeStore(raw: Partial<AppStore>): AppStore {
  const merged = { ...emptyStore, ...raw };
  let shops = Array.isArray(merged.shops)
    ? merged.shops.map((shop) => ({
        ...shop,
        newOrderCount: shop.newOrderCount ?? 0,
      }))
    : [];

  if (merged.connection && !shops.some((shop) => shop.connection.shopId === merged.connection?.shopId)) {
    shops = [
      ...shops,
      {
        connection: merged.connection,
        shop: merged.shop,
        listings: merged.listings ?? [],
        receipts: merged.receipts ?? [],
        orderDetails: merged.orderDetails ?? [],
        ads: merged.ads ?? [],
        adsSyncNote: merged.adsSyncNote ?? null,
        lastSyncAt: merged.lastSyncAt ?? null,
        newOrderCount: 0,
      },
    ];
  }

  const requestedActiveShopId =
    merged.activeShopId ?? merged.connection?.shopId ?? shops[0]?.connection.shopId ?? null;
  const activeShop =
    shops.find((shop) => shop.connection.shopId === requestedActiveShopId) ?? shops[0] ?? null;

  return mirrorActiveShop(
    {
      ...merged,
      shops,
      activeShopId: activeShop?.connection.shopId ?? null,
    },
    activeShop,
  );
}

export function selectShop(store: AppStore, shopId?: number | null) {
  const normalized = normalizeStore(store);
  const selectedShopId = shopId ?? normalized.activeShopId;
  return (
    normalized.shops.find((shop) => shop.connection.shopId === selectedShopId) ??
    normalized.shops[0] ??
    null
  );
}

export function upsertShop(store: AppStore, shopData: EtsyShopData) {
  const normalized = normalizeStore(store);
  const shops = [
    ...normalized.shops.filter((shop) => shop.connection.shopId !== shopData.connection.shopId),
    shopData,
  ].sort((left, right) => left.connection.shopName.localeCompare(right.connection.shopName));

  return mirrorActiveShop(
    {
      ...normalized,
      shops,
      activeShopId: shopData.connection.shopId,
    },
    shopData,
  );
}

export function removeShop(store: AppStore, shopId: number) {
  const normalized = normalizeStore(store);
  const shops = normalized.shops.filter((shop) => shop.connection.shopId !== shopId);
  const activeShop =
    normalized.activeShopId === shopId
      ? shops[0] ?? null
      : shops.find((shop) => shop.connection.shopId === normalized.activeShopId) ?? shops[0] ?? null;

  return mirrorActiveShop(
    {
      ...normalized,
      shops,
      activeShopId: activeShop?.connection.shopId ?? null,
    },
    activeShop,
  );
}

export async function readStore(): Promise<AppStore> {
  const pool = getPool();

  if (pool) {
    const databaseStore = normalizeStore(await readDatabaseStore(pool));

    if (databaseStore.shops.length > 0) {
      return databaseStore;
    }

    try {
      const raw = await readFile(storePath, "utf8");
      const fileStore = normalizeStore(JSON.parse(raw) as Partial<AppStore>);
      if (fileStore.shops.length > 0) {
        await replaceDatabaseStore(fileStore, pool);
        return fileStore;
      }
    } catch {
      return databaseStore;
    }

    return databaseStore;
  }

  try {
    const raw = await readFile(storePath, "utf8");
    return normalizeStore(JSON.parse(raw) as Partial<AppStore>);
  } catch {
    return emptyStore;
  }
}

export async function writeStore(store: AppStore) {
  const pool = getPool();
  const normalized = normalizeStore(store);

  if (pool) {
    await replaceDatabaseStore(normalized, pool);
    return;
  }

  await mkdir(path.dirname(storePath), { recursive: true });
  await writeFile(storePath, JSON.stringify(normalized, null, 2), "utf8");
}

export async function updateStore(updater: (store: AppStore) => AppStore | Promise<AppStore>) {
  const current = await readStore();
  const next = await updater(current);
  const normalized = normalizeStore(next);
  await writeStore(normalized);
  return normalized;
}

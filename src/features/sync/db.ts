import type { Pool } from "pg";
import { getPool } from "@/server/db";
import {
  ensureErpAccountForShop,
  markMissingListingsDeletedForShop,
  normalizeListingsToErp,
  normalizeReceiptsToErp,
  normalizeTransactionsToErp,
} from "@/features/erp/db";
import type {
  AppStore,
  EtsyApiQuota,
  EtsyConnection,
  EtsyListingSummary,
  EtsyOrderDetail,
  EtsyReceiptSummary,
  EtsyShopData,
  EtsyShopSummary,
} from "@/shared/types/etsy";
import type { EtsyInventoryUpdateInput, EtsyListingInventory } from "@/features/etsy/client";
import { sourceVersionForListing } from "@/features/products/listing-workbench-model";
import { etsyApiSlotForConnection } from "@/features/etsy/api-config";

const ADS_SYNC_NOTE =
  "Etsy Open API v3 does not expose a public Etsy Ads performance endpoint in the standard reference. Add a provider/import here when ad data is available.";

const syncSchemaPromises = new WeakMap<Pool, Promise<void>>();

export type SyncJobType =
  | "sync_shop_full"
  | "sync_listings"
  | "sync_receipts_incremental"
  | "sync_receipt_detail"
  | "update_listing_skus"
  | "publish_listing_draft"
  | "delete_listing";

export type ListingSkuUpdate = {
  productId?: number;
  productIndex: number;
  propertySignature: string;
  sku: string;
};

export type ListingSkuUpdatePayload = {
  listingId: number;
  requestedAt?: string;
  updates: ListingSkuUpdate[];
};

export type SyncJob = {
  id: number;
  shopId: number;
  jobType: SyncJobType;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
};

type ShopRow = {
  shop_id: string;
  user_id: string;
  shop_name: string;
  connection: EtsyConnection;
  shop_data: EtsyShopSummary | null;
  last_sync_at: Date | string | null;
  listings_sync_at: Date | string | null;
  receipts_sync_at: Date | string | null;
  api_quota: EtsyApiQuota | null;
  new_order_count: number | string | null;
};

type ListingRow = {
  data: EtsyListingSummary;
};

type ReceiptRow = {
  data: EtsyReceiptSummary;
};

type TransactionRow = {
  data: EtsyOrderDetail;
};

function requirePool() {
  const pool = getPool();

  if (!pool) {
    throw new Error("DATABASE_URL is required for the queued sync system.");
  }

  return pool;
}

function toIso(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function numericId(value: string | number) {
  return typeof value === "number" ? value : Number(value);
}

function moneyAmount(value?: { amount: number; divisor: number; currency_code: string } | null) {
  if (!value) {
    return {
      amount: null,
      currency: null,
    };
  }

  return {
    amount: value.amount / value.divisor,
    currency: value.currency_code,
  };
}

function boolFromRaw(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function timestampFromRaw(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function rawObject(value: unknown) {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function rawShopId(value: unknown) {
  const raw = rawObject(value);
  const shopId = Number(raw.shop_id);
  return Number.isFinite(shopId) && shopId > 0 ? shopId : null;
}

function listingBelongsToShop(shopId: number, listing: EtsyListingSummary) {
  const listingShopId = rawShopId(listing);
  return listingShopId === null || listingShopId === shopId;
}

function nonEmptyStringList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function inventoryProducts(value: unknown) {
  const inventory = rawObject(value);
  return Array.isArray(inventory.products) ? inventory.products : [];
}

function hasInventoryProducts(listing: EtsyListingSummary | null | undefined) {
  return inventoryProducts(listing?.inventory).length > 0;
}

async function preserveExistingListingEnrichment(
  shopId: number,
  listing: EtsyListingSummary,
  pool: Pool,
) {
  const shouldPreserveMultiProductSku =
    hasInventoryProducts(listing) &&
    inventoryProducts(listing.inventory).length > 1 &&
    !listing.sku;

  if (listing.materials?.length && hasInventoryProducts(listing) && !shouldPreserveMultiProductSku) return listing;

  const existing = await pool.query<{ data: EtsyListingSummary }>(
    `
      select data
      from etsy_listings
      where shop_id = $1
        and listing_id = $2
      limit 1
    `,
    [shopId, listing.listing_id],
  );
  const existingData = existing.rows[0]?.data;
  const materials = nonEmptyStringList(existingData?.materials);
  let nextListing: EtsyListingSummary = listing;

  if (!listing.materials?.length && materials.length > 0) {
    nextListing = {
      ...nextListing,
      listing_properties: nextListing.listing_properties ?? existingData?.listing_properties,
      materials,
    };
  }

  if (!hasInventoryProducts(nextListing) && hasInventoryProducts(existingData)) {
    nextListing = {
      ...nextListing,
      inventory: existingData?.inventory,
      sku: nextListing.sku ?? existingData?.sku ?? null,
      skus: nextListing.skus ?? existingData?.skus,
    };
  }

  const existingSku = typeof existingData?.sku === "string" ? existingData.sku.trim() : "";

  if (inventoryProducts(nextListing.inventory).length > 1 && !nextListing.sku && existingSku) {
    nextListing = {
      ...nextListing,
      sku: existingSku,
    };
  }

  return nextListing;
}

async function tryUpdateErp(label: string, update: () => Promise<void>) {
  try {
    await update();
  } catch (error) {
    console.error(`ERP normalization skipped for ${label}:`, error);
  }
}

function getReceiptShipments(receipt: EtsyReceiptSummary) {
  const raw = rawObject(receipt);
  return Array.isArray(raw.shipments) ? raw.shipments.map(rawObject) : [];
}

function shipmentKey(shipment: Record<string, unknown>, index: number) {
  return String(
    shipment.receipt_shipping_id ??
      shipment.tracking_code ??
      shipment.shipment_notification_timestamp ??
      index,
  );
}

export async function ensureSyncSchema(pool = requirePool()) {
  const existing = syncSchemaPromises.get(pool);
  if (existing) return existing;
  const verification = pool.query("select 1 from etsy_shops limit 0").then(() => undefined);
  syncSchemaPromises.set(pool, verification);
  try {
    await verification;
  } catch (error) {
    syncSchemaPromises.delete(pool);
    throw new Error("Database migrations are incomplete. Run npm run db:migrate before starting the app.", {
      cause: error,
    });
  }
}

export async function ensureShopUiState(shopId: number, pool = requirePool()) {
  await ensureSyncSchema(pool);

  await pool.query(
    `
      insert into etsy_shop_ui_state (shop_id)
      values ($1)
      on conflict (shop_id) do nothing
    `,
    [shopId],
  );
}

export async function ensureAllShopUiStates(pool = requirePool()) {
  await ensureSyncSchema(pool);

  await pool.query(`
    insert into etsy_shop_ui_state (shop_id)
    select shop_id
    from etsy_shops
    where active = true
    on conflict (shop_id) do nothing
  `);
}

export async function refreshShopNewOrderCount(shopId: number, pool = requirePool()) {
  await ensureShopUiState(shopId, pool);

  await pool.query(
    `
      update etsy_shop_ui_state ui
      set new_order_count = (
            select count(*)::integer
            from etsy_receipts receipt
            where receipt.shop_id = $1
              and coalesce(receipt.create_timestamp, receipt.update_timestamp, 0) > 0
              and to_timestamp(coalesce(receipt.create_timestamp, receipt.update_timestamp)) > ui.last_orders_seen_at
          ),
          updated_at = now()
      where ui.shop_id = $1
    `,
    [shopId],
  );
}

export async function markShopOrdersSeen(shopId: number, pool = requirePool()) {
  await ensureSyncSchema(pool);

  await pool.query(
    `
      insert into etsy_shop_ui_state (shop_id, last_orders_seen_at, new_order_count, updated_at)
      values ($1, now(), 0, now())
      on conflict (shop_id)
      do update set last_orders_seen_at = now(),
                    new_order_count = 0,
                    updated_at = now()
    `,
    [shopId],
  );
}

export async function getShopOrderBadges(pool = requirePool()) {
  await ensureSyncSchema(pool);

  const result = await pool.query<{ shop_id: string; new_order_count: number }>(
    `
      select shop_id::text, new_order_count
      from etsy_shop_ui_state
    `,
  );

  return Object.fromEntries(
    result.rows.map((row) => [numericId(row.shop_id), Number(row.new_order_count ?? 0)]),
  );
}

export async function migrateLegacyStore(pool = requirePool()) {
  await ensureSyncSchema(pool);

  const existing = await pool.query<{ count: string }>("select count(*)::text as count from etsy_shops");
  if (Number(existing.rows[0]?.count ?? 0) > 0) {
    return;
  }

  const legacy = await pool.query<{ data: Partial<AppStore> }>(
    `
      select data
      from app_store
      where key = $1
      limit 1
    `,
    ["default"],
  );

  const data = legacy.rows[0]?.data;
  const shops = data?.shops ?? (data?.connection ? [{
    connection: data.connection,
    shop: data.shop ?? null,
    listings: data.listings ?? [],
    receipts: data.receipts ?? [],
    orderDetails: data.orderDetails ?? [],
    ads: data.ads ?? [],
    adsSyncNote: data.adsSyncNote ?? null,
    apiQuota: data.apiQuota ?? null,
    lastSyncAt: data.lastSyncAt ?? null,
    newOrderCount: 0,
  }] : []);

  if (!shops.length) return;

  for (const shopData of shops) {
    await upsertShopData(shopData, pool);
  }
}

export async function upsertShopData(shopData: EtsyShopData, pool = requirePool()) {
  await ensureSyncSchema(pool);

  await pool.query(
    `
      insert into etsy_shops (
        shop_id,
        user_id,
        shop_name,
        connection,
        shop_data,
        active,
        connected_at,
        updated_at,
        last_sync_at,
        api_quota
      )
      values ($1, $2, $3, $4, $5, true, $6, now(), $7, $8)
      on conflict (shop_id)
      do update set
        user_id = excluded.user_id,
        shop_name = excluded.shop_name,
        connection = excluded.connection,
        shop_data = coalesce(excluded.shop_data, etsy_shops.shop_data),
        active = true,
        updated_at = now(),
        last_sync_at = coalesce(excluded.last_sync_at, etsy_shops.last_sync_at),
        api_quota = coalesce(excluded.api_quota, etsy_shops.api_quota)
    `,
    [
      shopData.connection.shopId,
      shopData.connection.userId,
      shopData.connection.shopName,
      JSON.stringify(shopData.connection),
      JSON.stringify(shopData.shop),
      shopData.connection.connectedAt,
      shopData.lastSyncAt,
      shopData.apiQuota ? JSON.stringify(shopData.apiQuota) : null,
    ],
  );

  await ensureShopUiState(shopData.connection.shopId, pool);
  await tryUpdateErp(`shop ${shopData.connection.shopId}`, async () => {
    await ensureErpAccountForShop(shopData.connection, shopData.shop, pool);
  });

  if (shopData.listings.length) {
    await upsertListings(shopData.connection.shopId, shopData.listings, pool);
  }
  if (shopData.receipts.length) {
    await upsertReceipts(shopData.connection.shopId, shopData.receipts, pool);
  }
  if (shopData.orderDetails.length) {
    await upsertTransactions(shopData.connection.shopId, shopData.orderDetails, pool);
  }
}

export async function updateConnection(connection: EtsyConnection, pool = requirePool()) {
  await ensureSyncSchema(pool);
  await pool.query(
    `
      update etsy_shops
      set connection = $2,
          shop_name = $3,
          user_id = $4,
          updated_at = now()
      where shop_id = $1
    `,
    [connection.shopId, JSON.stringify(connection), connection.shopName, connection.userId],
  );
  await tryUpdateErp(`connection ${connection.shopId}`, async () => {
    await ensureErpAccountForShop(connection, null, pool);
  });
}

export async function updateShopMetadata(
  shopId: number,
  shop: EtsyShopSummary | null,
  connection?: EtsyConnection,
  pool = requirePool(),
) {
  await ensureSyncSchema(pool);

  await pool.query(
    `
      update etsy_shops
      set shop_data = coalesce($2::jsonb, shop_data),
          connection = coalesce($3::jsonb, connection),
          shop_name = coalesce($4, shop_name),
          user_id = coalesce($5, user_id),
          updated_at = now()
      where shop_id = $1
    `,
    [
      shopId,
      JSON.stringify(shop),
      connection ? JSON.stringify(connection) : null,
      connection?.shopName ?? shop?.shop_name ?? null,
      connection?.userId ?? null,
    ],
  );

  if (connection) {
    await tryUpdateErp(`shop metadata ${shopId}`, async () => {
      await ensureErpAccountForShop(connection, shop, pool);
    });
  }
}

export async function updateEtsyApiQuota(
  shopId: number,
  apiSlot: 1 | 2,
  apiQuota: EtsyApiQuota,
  pool = requirePool(),
) {
  await ensureSyncSchema(pool);

  await pool.query(
    `
      update etsy_shops
      set api_quota = $2::jsonb,
          updated_at = now()
      where (active = true or shop_id = $1)
        and coalesce(connection->>'apiSlot', '1') = $3
    `,
    [shopId, JSON.stringify(apiQuota), String(apiSlot)],
  );
}

export async function upsertListings(
  shopId: number,
  listings: EtsyListingSummary[],
  pool = requirePool(),
  options: { replaceMissing?: boolean } = {},
) {
  await ensureSyncSchema(pool);
  const ownedListings = listings.filter((listing) => listingBelongsToShop(shopId, listing));
  const persistedListings: EtsyListingSummary[] = [];

  for (const rawListing of ownedListings) {
    const listing = await preserveExistingListingEnrichment(shopId, rawListing, pool);
    const price = moneyAmount(listing.price);
    persistedListings.push(listing);

    await pool.query(
      `
        insert into etsy_listings (
          shop_id,
          listing_id,
          title,
          state,
          quantity,
          price_amount,
          currency_code,
          views,
          num_favorers,
          updated_timestamp,
          source_version,
          data,
          synced_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
        on conflict (shop_id, listing_id)
        do update set
          title = excluded.title,
          state = excluded.state,
          quantity = excluded.quantity,
          price_amount = excluded.price_amount,
          currency_code = excluded.currency_code,
          views = excluded.views,
          num_favorers = excluded.num_favorers,
          updated_timestamp = excluded.updated_timestamp,
          source_version = excluded.source_version,
          data = excluded.data,
          synced_at = now()
      `,
      [
        shopId,
        listing.listing_id,
        listing.title,
        listing.state,
        listing.quantity ?? null,
        price.amount,
        price.currency,
        listing.views ?? null,
        listing.num_favorers ?? null,
        listing.updated_timestamp ?? null,
        sourceVersionForListing(listing),
        JSON.stringify(listing),
      ],
    );
  }

  if (options.replaceMissing) {
    const currentListingIds = ownedListings.map((listing) => listing.listing_id);
    await pool.query(
      `
        delete from etsy_listings
        where shop_id = $1
          and not (listing_id = any($2::bigint[]))
      `,
      [shopId, currentListingIds],
    );

    await tryUpdateErp(`deleted listings ${shopId}`, async () => {
      await markMissingListingsDeletedForShop(shopId, currentListingIds, pool);
    });
  }

  await pool.query(
    `
      update etsy_shops
      set listings_sync_at = now(),
          updated_at = now()
      where shop_id = $1
    `,
    [shopId],
  );

  await tryUpdateErp(`listings ${shopId}`, async () => {
    await normalizeListingsToErp(shopId, persistedListings, pool);
  });
}

export async function getSyncedListings(
  shopId: number,
  listingIds: number[],
  pool = requirePool(),
) {
  await ensureSyncSchema(pool);

  if (listingIds.length === 0) {
    return new Map<number, EtsyListingSummary>();
  }

  const result = await pool.query<{
    listing_id: string;
    data: EtsyListingSummary;
  }>(
    `
      select listing_id::text, data
      from etsy_listings
      where shop_id = $1
        and listing_id = any($2::bigint[])
    `,
    [shopId, listingIds],
  );

  return new Map(
    result.rows.map((row) => [
      numericId(row.listing_id),
      row.data,
    ]),
  );
}

export async function listSyncedListingIds(shopId: number, pool = requirePool()) {
  await ensureSyncSchema(pool);

  const result = await pool.query<{ listing_id: string }>(
    `
      select listing_id::text
      from etsy_listings
      where shop_id = $1
    `,
    [shopId],
  );

  return result.rows.map((row) => numericId(row.listing_id));
}

export async function deleteListingsForShop(
  shopId: number,
  listingIds: number[],
  pool = requirePool(),
) {
  if (listingIds.length === 0) return;

  await ensureSyncSchema(pool);

  await pool.query(
    `
      delete from etsy_listings
      where shop_id = $1
        and listing_id = any($2::bigint[])
    `,
    [shopId, listingIds],
  );

  const remaining = await pool.query<{ listing_id: string }>(
    `
      select listing_id
      from etsy_listings
      where shop_id = $1
    `,
    [shopId],
  );

  await tryUpdateErp(`deleted selected listings ${shopId}`, async () => {
    await markMissingListingsDeletedForShop(
      shopId,
      remaining.rows.map((row) => row.listing_id),
      pool,
    );
  });
}

function inventorySkus(inventory: EtsyInventoryUpdateInput | EtsyListingInventory) {
  return inventory.products
    .map((product) => product.sku?.trim() ?? "")
    .filter(Boolean);
}

function uniqueStringValues(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function inventorySkuVariesByProperty(inventory: EtsyInventoryUpdateInput | EtsyListingInventory) {
  return Array.isArray(inventory.sku_on_property) && inventory.sku_on_property.length > 0;
}

export async function updateListingInventoryData(
  shopId: number,
  listingId: number,
  inventory: EtsyInventoryUpdateInput | EtsyListingInventory,
  pool = requirePool(),
) {
  await ensureSyncSchema(pool);

  const existing = await pool.query<ListingRow>(
    `
      select data
      from etsy_listings
      where shop_id = $1
        and listing_id = $2
      limit 1
    `,
    [shopId, listingId],
  );
  const currentListing = existing.rows[0]?.data;

  if (!currentListing) {
    throw new Error(`Listing ${listingId} is not synced locally.`);
  }

  const nextListing = {
    ...currentListing,
    inventory,
    updated_timestamp: Math.floor(Date.now() / 1000),
  } as EtsyListingSummary & {
    inventory: EtsyInventoryUpdateInput | EtsyListingInventory;
    skus?: string[];
  };
  const skus = inventorySkus(inventory);
  const uniqueSkus = uniqueStringValues(skus);
  const hasSkuVariation = inventorySkuVariesByProperty(inventory);

  if (inventory.products.length === 1) {
    nextListing.sku = skus[0] ?? null;
    delete nextListing.skus;
  } else {
    nextListing.sku = !hasSkuVariation && uniqueSkus.length === 1 ? uniqueSkus[0] : null;
    nextListing.skus = uniqueSkus;
  }

  await pool.query(
    `
      update etsy_listings
      set data = $3::jsonb,
          updated_timestamp = $4,
          source_version = $5,
          synced_at = now()
      where shop_id = $1
        and listing_id = $2
    `,
    [shopId, listingId, JSON.stringify(nextListing), nextListing.updated_timestamp, sourceVersionForListing(nextListing)],
  );

  await tryUpdateErp(`listing inventory ${shopId}/${listingId}`, async () => {
    await normalizeListingsToErp(shopId, [nextListing], pool);
  });

  return nextListing;
}

export async function upsertReceipts(shopId: number, receipts: EtsyReceiptSummary[], pool = requirePool()) {
  await ensureSyncSchema(pool);

  for (const receipt of receipts) {
    const raw = rawObject(receipt);
    const grandtotal = moneyAmount(receipt.grandtotal);

    await pool.query(
      `
        insert into etsy_receipts (
          shop_id,
          receipt_id,
          status,
          buyer_name,
          city,
          state,
          country_iso,
          is_paid,
          is_shipped,
          grandtotal_amount,
          currency_code,
          create_timestamp,
          update_timestamp,
          data,
          synced_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now())
        on conflict (shop_id, receipt_id)
        do update set
          status = excluded.status,
          buyer_name = excluded.buyer_name,
          city = excluded.city,
          state = excluded.state,
          country_iso = excluded.country_iso,
          is_paid = excluded.is_paid,
          is_shipped = excluded.is_shipped,
          grandtotal_amount = excluded.grandtotal_amount,
          currency_code = excluded.currency_code,
          create_timestamp = excluded.create_timestamp,
          update_timestamp = excluded.update_timestamp,
          data = excluded.data,
          synced_at = now()
      `,
      [
        shopId,
        receipt.receipt_id,
        receipt.status ?? null,
        receipt.name ?? null,
        receipt.city ?? null,
        raw.state ?? null,
        receipt.country_iso ?? null,
        boolFromRaw(raw.is_paid),
        boolFromRaw(raw.is_shipped),
        grandtotal.amount,
        grandtotal.currency,
        receipt.create_timestamp ?? null,
        receipt.update_timestamp ?? timestampFromRaw(raw.updated_timestamp),
        JSON.stringify(receipt),
      ],
    );

    await upsertShipments(shopId, receipt, pool);
  }

  await pool.query(
    `
      update etsy_shops
      set receipts_sync_at = now(),
          last_sync_at = now(),
          updated_at = now()
      where shop_id = $1
    `,
    [shopId],
  );

  await refreshShopNewOrderCount(shopId, pool);
  await tryUpdateErp(`receipts ${shopId}`, async () => {
    await normalizeReceiptsToErp(shopId, receipts, pool);
  });
}

export async function upsertTransactions(shopId: number, transactions: EtsyOrderDetail[], pool = requirePool()) {
  await ensureSyncSchema(pool);

  for (const transaction of transactions) {
    const price = moneyAmount(transaction.price);
    await pool.query(
      `
        insert into etsy_receipt_transactions (
          shop_id,
          receipt_id,
          transaction_id,
          listing_id,
          title,
          sku,
          quantity,
          price_amount,
          currency_code,
          paid_timestamp,
          shipped_timestamp,
          data,
          synced_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
        on conflict (shop_id, transaction_id)
        do update set
          receipt_id = excluded.receipt_id,
          listing_id = excluded.listing_id,
          title = excluded.title,
          sku = excluded.sku,
          quantity = excluded.quantity,
          price_amount = excluded.price_amount,
          currency_code = excluded.currency_code,
          paid_timestamp = excluded.paid_timestamp,
          shipped_timestamp = excluded.shipped_timestamp,
          data = excluded.data,
          synced_at = now()
      `,
      [
        shopId,
        transaction.receipt_id,
        transaction.transaction_id,
        transaction.listing_id ?? null,
        transaction.title ?? null,
        transaction.sku ?? null,
        transaction.quantity ?? null,
        price.amount,
        price.currency,
        transaction.paid_timestamp ?? null,
        transaction.shipped_timestamp ?? null,
        JSON.stringify(transaction),
      ],
    );
  }

  await tryUpdateErp(`transactions ${shopId}`, async () => {
    await normalizeTransactionsToErp(shopId, transactions, pool);
  });
}

async function upsertShipments(shopId: number, receipt: EtsyReceiptSummary, pool: Pool) {
  const shipments = getReceiptShipments(receipt);

  for (const [index, shipment] of shipments.entries()) {
    await pool.query(
      `
        insert into etsy_shipments (
          shop_id,
          receipt_id,
          shipment_key,
          carrier_name,
          tracking_code,
          shipped_timestamp,
          data,
          synced_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, now())
        on conflict (shop_id, receipt_id, shipment_key)
        do update set
          carrier_name = excluded.carrier_name,
          tracking_code = excluded.tracking_code,
          shipped_timestamp = excluded.shipped_timestamp,
          data = excluded.data,
          synced_at = now()
      `,
      [
        shopId,
        receipt.receipt_id,
        shipmentKey(shipment, index),
        shipment.carrier_name ?? null,
        shipment.tracking_code ?? null,
        timestampFromRaw(shipment.shipment_notification_timestamp),
        JSON.stringify(shipment),
      ],
    );
  }
}

export async function readDatabaseStore(pool = requirePool(), organizationId?: number | null): Promise<AppStore> {
  await ensureSyncSchema(pool);
  await migrateLegacyStore(pool);
  await ensureAllShopUiStates(pool);

  const shopsResult = await pool.query<ShopRow>(
    `
      select
        shops.shop_id,
        shops.user_id,
        shops.shop_name,
        shops.connection,
        shops.shop_data,
        shops.last_sync_at,
        shops.listings_sync_at,
        shops.receipts_sync_at,
        shops.api_quota,
        coalesce(ui.new_order_count, 0) as new_order_count
      from etsy_shops shops
      left join etsy_shop_ui_state ui on ui.shop_id = shops.shop_id
      where shops.active = true
        and ($1::bigint is null or shops.organization_id = $1)
      order by shops.shop_name asc
    `,
    [organizationId ?? null],
  );

  const shops: EtsyShopData[] = [];

  for (const shopRow of shopsResult.rows) {
    const shopId = numericId(shopRow.shop_id);
    const [listingsResult, receiptsResult, transactionsResult] = await Promise.all([
      pool.query<ListingRow>(
        `
          select data
          from etsy_listings
          where shop_id = $1
            and (not (data ? 'shop_id') or data->>'shop_id' = $1::text)
          order by updated_timestamp desc nulls last, listing_id desc
        `,
        [shopId],
      ),
      pool.query<ReceiptRow>(
        `
          select data
          from etsy_receipts
          where shop_id = $1
          order by create_timestamp desc nulls last, receipt_id desc
        `,
        [shopId],
      ),
      pool.query<TransactionRow>(
        `
          select data
          from etsy_receipt_transactions
          where shop_id = $1
          order by paid_timestamp desc nulls last, transaction_id desc
        `,
        [shopId],
      ),
    ]);

    shops.push({
      connection: shopRow.connection,
      shop: shopRow.shop_data,
      listings: listingsResult.rows.map((row) => row.data),
      receipts: receiptsResult.rows.map((row) => row.data),
      orderDetails: transactionsResult.rows.map((row) => row.data),
      ads: [],
      adsSyncNote: ADS_SYNC_NOTE,
      apiQuota: shopRow.api_quota ?? null,
      lastSyncAt: toIso(shopRow.last_sync_at),
      newOrderCount: Number(shopRow.new_order_count ?? 0),
    });
  }

  const quotasByApiSlot = new Map<number, EtsyApiQuota>();
  for (const shopData of shops) {
    if (!shopData.apiQuota) continue;
    const apiSlot = etsyApiSlotForConnection(shopData.connection);
    const current = quotasByApiSlot.get(apiSlot);
    if (!current || new Date(shopData.apiQuota.updatedAt).getTime() > new Date(current.updatedAt).getTime()) {
      quotasByApiSlot.set(apiSlot, shopData.apiQuota);
    }
  }
  const normalizedShops = shops.map((shopData) => ({
    ...shopData,
    connection: {
      ...shopData.connection,
      apiSlot: etsyApiSlotForConnection(shopData.connection),
    },
    apiQuota: quotasByApiSlot.get(etsyApiSlotForConnection(shopData.connection)) ?? shopData.apiQuota,
  }));
  const activeShop = normalizedShops[0] ?? null;

  return {
    connection: activeShop?.connection ?? null,
    shop: activeShop?.shop ?? null,
    listings: activeShop?.listings ?? [],
    receipts: activeShop?.receipts ?? [],
    orderDetails: activeShop?.orderDetails ?? [],
    ads: [],
    adsSyncNote: activeShop?.adsSyncNote ?? ADS_SYNC_NOTE,
    apiQuota: activeShop?.apiQuota ?? null,
    lastSyncAt: activeShop?.lastSyncAt ?? null,
    activeShopId: activeShop?.connection.shopId ?? null,
    shops: normalizedShops,
  };
}

export async function readWorkspaceShellStore(
  organizationId: number,
  pool = requirePool(),
): Promise<AppStore> {
  await ensureSyncSchema(pool);
  await ensureAllShopUiStates(pool);

  await pool.query(
    `
      update etsy_shops
      set organization_id = $1,
          updated_at = now()
      where organization_id is null
        and (select count(*) from organizations where deleted_at is null and status = 'active') = 1
        and (select id from organizations where deleted_at is null and status = 'active' limit 1) = $1
    `,
    [organizationId],
  );

  const result = await pool.query<ShopRow>(
    `
      select
        shops.shop_id,
        shops.user_id,
        shops.shop_name,
        shops.connection,
        shops.shop_data,
        shops.last_sync_at,
        shops.listings_sync_at,
        shops.receipts_sync_at,
        shops.api_quota,
        coalesce(ui.new_order_count, 0) as new_order_count
      from etsy_shops shops
      left join etsy_shop_ui_state ui on ui.shop_id = shops.shop_id
      where shops.active = true
        and shops.organization_id = $1
      order by shops.shop_name asc
    `,
    [organizationId],
  );

  const shops: EtsyShopData[] = result.rows.map((shopRow) => ({
    connection: shopRow.connection,
    shop: shopRow.shop_data,
    listings: [],
    receipts: [],
    orderDetails: [],
    ads: [],
    adsSyncNote: ADS_SYNC_NOTE,
    apiQuota: shopRow.api_quota ?? null,
    lastSyncAt: toIso(shopRow.last_sync_at),
    newOrderCount: Number(shopRow.new_order_count ?? 0),
  }));
  const activeShop = shops[0] ?? null;

  return {
    connection: activeShop?.connection ?? null,
    shop: activeShop?.shop ?? null,
    listings: [],
    receipts: [],
    orderDetails: [],
    ads: [],
    adsSyncNote: ADS_SYNC_NOTE,
    apiQuota: activeShop?.apiQuota ?? null,
    lastSyncAt: activeShop?.lastSyncAt ?? null,
    activeShopId: activeShop?.connection.shopId ?? null,
    shops,
  };
}

export async function assertShopOrganizationAvailable(
  shopId: number,
  organizationId: number,
  pool = requirePool(),
) {
  await ensureSyncSchema(pool);
  const result = await pool.query<{ organization_id: string | number | null }>(
    `select organization_id from etsy_shops where shop_id = $1 limit 1`,
    [shopId],
  );
  const current = result.rows[0]?.organization_id;
  if (current !== null && current !== undefined && Number(current) !== organizationId) {
    throw new Error("This Etsy shop is already connected to another organization.");
  }
}

export async function assignShopToOrganization(
  shopId: number,
  organizationId: number,
  pool = requirePool(),
) {
  await ensureSyncSchema(pool);
  const result = await pool.query(
    `update etsy_shops
     set organization_id = $2, updated_at = now()
     where shop_id = $1 and (organization_id is null or organization_id = $2)`,
    [shopId, organizationId],
  );
  if (!result.rowCount) throw new Error("Unable to assign this Etsy shop to the current organization.");
}

export async function replaceDatabaseStore(store: AppStore, pool = requirePool()) {
  await ensureSyncSchema(pool);

  if (!store.shops.length) {
    await pool.query("delete from etsy_shops");
    return;
  }

  for (const shopData of store.shops) {
    await upsertShopData(shopData, pool);
  }

  await pool.query(
    `
      update etsy_shops
      set active = false,
          updated_at = now()
      where not (shop_id = any($1::bigint[]))
    `,
    [store.shops.map((shop) => shop.connection.shopId)],
  );
}

export async function deactivateShop(shopId: number, pool = requirePool()) {
  await ensureSyncSchema(pool);

  await pool.query(
    `
      update etsy_shops
      set active = false,
          updated_at = now()
      where shop_id = $1
    `,
    [shopId],
  );
}

export async function enqueueSyncJob(
  shopId: number,
  jobType: SyncJobType,
  payload: Record<string, unknown> = {},
  priority = 100,
  pool = requirePool(),
) {
  await ensureSyncSchema(pool);

  const result = await pool.query<{ id: string }>(
    `
      insert into etsy_sync_jobs (shop_id, job_type, payload, priority)
      values ($1, $2, $3, $4)
      returning id
    `,
    [shopId, jobType, JSON.stringify(payload), priority],
  );

  return numericId(result.rows[0].id);
}

export async function enqueueListingSkuUpdateJob(
  shopId: number,
  payload: ListingSkuUpdatePayload,
  pool = requirePool(),
) {
  await ensureSyncSchema(pool);

  const queued = await pool.query<{ id: string }>(
    `
      select id
      from etsy_sync_jobs
      where shop_id = $1
        and job_type = 'update_listing_skus'
        and status = 'queued'
        and payload->>'listingId' = $2
      order by created_at desc
      limit 1
    `,
    [shopId, String(payload.listingId)],
  );

  if (queued.rows[0]) {
    await pool.query(
      `
        update etsy_sync_jobs
        set payload = $2::jsonb,
            attempts = 0,
            error = null,
            run_after = now(),
            updated_at = now()
        where id = $1
      `,
      [queued.rows[0].id, JSON.stringify(payload)],
    );

    return {
      enqueued: false,
      jobId: numericId(queued.rows[0].id),
      updated: true,
    };
  }

  const result = await pool.query<{ id: string }>(
    `
      insert into etsy_sync_jobs (
        shop_id,
        job_type,
        payload,
        priority,
        max_attempts
      )
      values ($1, 'update_listing_skus', $2, 35, 6)
      returning id
    `,
    [shopId, JSON.stringify(payload)],
  );

  return {
    enqueued: true,
    jobId: numericId(result.rows[0].id),
    updated: false,
  };
}

export async function enqueueSyncJobIfNotPending(
  shopId: number,
  jobType: SyncJobType,
  payload: Record<string, unknown> = {},
  priority = 100,
  pool = requirePool(),
) {
  await ensureSyncSchema(pool);

  const pending = await pool.query<{ id: string }>(
    `
      select id
      from etsy_sync_jobs
      where shop_id = $1
        and job_type = $2
        and status in ('queued', 'running')
      order by priority asc, created_at asc
      limit 1
    `,
    [shopId, jobType],
  );

  if (pending.rows[0]) {
    return {
      enqueued: false,
      jobId: numericId(pending.rows[0].id),
    };
  }

  return {
    enqueued: true,
    jobId: await enqueueSyncJob(shopId, jobType, payload, priority, pool),
  };
}

export async function claimSyncJobs(limit = 5, pool = requirePool()): Promise<SyncJob[]> {
  await ensureSyncSchema(pool);

  const result = await pool.query<{
    id: string;
    shop_id: string;
    job_type: SyncJobType;
    payload: Record<string, unknown>;
    attempts: number;
    max_attempts: number;
  }>(
    `
      update etsy_sync_jobs
      set status = 'running',
          attempts = attempts + 1,
          locked_at = now(),
          started_at = now(),
          updated_at = now()
      where id in (
        select id
        from etsy_sync_jobs
        where status = 'queued'
          and run_after <= now()
        order by priority asc, created_at asc
        limit $1
        for update skip locked
      )
      returning id, shop_id, job_type, payload, attempts, max_attempts
    `,
    [limit],
  );

  return result.rows.map((row) => ({
    id: numericId(row.id),
    shopId: numericId(row.shop_id),
    jobType: row.job_type,
    maxAttempts: row.max_attempts,
    payload: row.payload ?? {},
    attempts: row.attempts,
  }));
}

export async function claimSyncJobById(jobId: number, pool = requirePool()): Promise<SyncJob | null> {
  await ensureSyncSchema(pool);

  const result = await pool.query<{
    id: string;
    shop_id: string;
    job_type: SyncJobType;
    payload: Record<string, unknown>;
    attempts: number;
    max_attempts: number;
  }>(
    `
      update etsy_sync_jobs
      set status = 'running',
          attempts = attempts + 1,
          locked_at = now(),
          started_at = now(),
          updated_at = now()
      where id in (
        select id
        from etsy_sync_jobs
        where id = $1
          and status = 'queued'
          and run_after <= now()
        for update skip locked
      )
      returning id, shop_id, job_type, payload, attempts, max_attempts
    `,
    [jobId],
  );

  const row = result.rows[0];

  if (!row) {
    return null;
  }

  return {
    id: numericId(row.id),
    shopId: numericId(row.shop_id),
    jobType: row.job_type,
    maxAttempts: row.max_attempts,
    payload: row.payload ?? {},
    attempts: row.attempts,
  };
}

export async function completeSyncJob(jobId: number, pool = requirePool()) {
  await pool.query(
    `
      update etsy_sync_jobs
      set status = 'completed',
          finished_at = now(),
          updated_at = now()
      where id = $1
    `,
    [jobId],
  );
}

export async function failSyncJob(job: SyncJob, error: Error, pool = requirePool()) {
  const errorMessage = syncErrorDetail(error);
  const nextStatus = isRetryableSyncError(errorMessage) && job.attempts < job.maxAttempts ? "queued" : "failed";
  const retryDelayMinutes = Math.min(60, Math.max(1, job.attempts) * job.attempts * 5);

  await pool.query(
    `
      update etsy_sync_jobs
      set status = $4,
          error = $2,
          run_after = case when $4 = 'queued' then now() + ($3 || ' minutes')::interval else run_after end,
          locked_at = null,
          finished_at = case when $4 = 'failed' then now() else null end,
          updated_at = now()
      where id = $1
    `,
    [job.id, errorMessage, retryDelayMinutes, nextStatus],
  );
}

function isRetryableSyncError(message: string) {
  if (/Etsy API error (400|401|403|404):/.test(message)) {
    return false;
  }

  if (/Listing source version conflict|Draft changed after publishing was queued/.test(message)) {
    return false;
  }

  return true;
}

export function syncErrorDetail(error: Error) {
  const errorWithCause = error as Error & {
    cause?: unknown;
    code?: string;
  };
  const cause = errorWithCause.cause;

  if (cause instanceof Error && cause.message && cause.message !== error.message) {
    const causeWithCode = cause as Error & { code?: string };
    return causeWithCode.code
      ? `${error.message}: ${cause.message} (${causeWithCode.code})`
      : `${error.message}: ${cause.message}`;
  }

  if (cause && typeof cause === "object" && "message" in cause) {
    const causeRecord = cause as { code?: string; message?: string };
    if (causeRecord.message && causeRecord.message !== error.message) {
      return causeRecord.code
        ? `${error.message}: ${causeRecord.message} (${causeRecord.code})`
        : `${error.message}: ${causeRecord.message}`;
    }
  }

  return errorWithCause.code ? `${error.message} (${errorWithCause.code})` : error.message;
}

export async function rescheduleSyncJobNow(jobId: number, pool = requirePool()) {
  await pool.query(
    `
      update etsy_sync_jobs
      set run_after = now(),
          updated_at = now()
      where id = $1
        and status = 'queued'
    `,
    [jobId],
  );
}

export async function getShopConnection(shopId: number, pool = requirePool()) {
  await ensureSyncSchema(pool);
  const result = await pool.query<{ connection: EtsyConnection }>(
    `
      select connection
      from etsy_shops
      where shop_id = $1
        and active = true
      limit 1
    `,
    [shopId],
  );

  return result.rows[0]?.connection ?? null;
}

export async function getEtsyApiSlotShopCount(
  apiSlot: 1 | 2,
  excludingShopId?: number,
  pool = requirePool(),
) {
  await ensureSyncSchema(pool);
  const result = await pool.query<{ count: string }>(
    `
      select count(*)::text as count
      from etsy_shops
      where active = true
        and coalesce(connection->>'apiSlot', '1') = $1
        and ($2::bigint is null or shop_id <> $2)
    `,
    [String(apiSlot), excludingShopId ?? null],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function listActiveShopIds(pool = requirePool()) {
  await ensureSyncSchema(pool);
  const result = await pool.query<{ shop_id: string }>(
    `
      select shop_id
      from etsy_shops
      where active = true
      order by shop_name asc
    `,
  );

  return result.rows.map((row) => numericId(row.shop_id));
}

export async function listActiveShopSyncStates(pool = requirePool()) {
  await ensureSyncSchema(pool);
  const result = await pool.query<{
    shop_id: string;
    listings_sync_at: Date | string | null;
    receipts_sync_at: Date | string | null;
  }>(
    `
      select shop_id, listings_sync_at, receipts_sync_at
      from etsy_shops
      where active = true
      order by shop_name asc
    `,
  );

  return result.rows.map((row) => ({
    shopId: numericId(row.shop_id),
    listingsSyncAt: toIso(row.listings_sync_at),
    receiptsSyncAt: toIso(row.receipts_sync_at),
  }));
}

export async function getShopSyncState(shopId: number, pool = requirePool()) {
  await ensureSyncSchema(pool);
  const result = await pool.query<{
    shop_id: string;
    listings_sync_at: Date | string | null;
    receipts_sync_at: Date | string | null;
  }>(
    `
      select shop_id, listings_sync_at, receipts_sync_at
      from etsy_shops
      where shop_id = $1
        and active = true
      limit 1
    `,
    [shopId],
  );
  const row = result.rows[0];

  if (!row) {
    return null;
  }

  return {
    shopId: numericId(row.shop_id),
    listingsSyncAt: toIso(row.listings_sync_at),
    receiptsSyncAt: toIso(row.receipts_sync_at),
  };
}

export async function getPendingSyncJob(
  shopId: number,
  jobTypes: SyncJobType[],
  pool = requirePool(),
) {
  await ensureSyncSchema(pool);

  if (jobTypes.length === 0) {
    return null;
  }

  const result = await pool.query<{
    id: string;
    job_type: SyncJobType;
    status: string;
  }>(
    `
      select id, job_type, status
      from etsy_sync_jobs
      where shop_id = $1
        and job_type = any($2::text[])
        and status in ('queued', 'running')
      order by priority asc, created_at asc
      limit 1
    `,
    [shopId, jobTypes],
  );
  const row = result.rows[0];

  if (!row) {
    return null;
  }

  return {
    id: numericId(row.id),
    jobType: row.job_type,
    status: row.status,
  };
}

export async function getCursor(shopId: number, cursorName: string, pool = requirePool()) {
  await ensureSyncSchema(pool);
  const result = await pool.query<{ cursor_timestamp: string | number | null }>(
    `
      select cursor_timestamp
      from etsy_sync_cursors
      where shop_id = $1
        and cursor_name = $2
    `,
    [shopId, cursorName],
  );
  const value = result.rows[0]?.cursor_timestamp;

  return value == null ? null : Number(value);
}

export async function getReceiptSyncStates(
  shopId: number,
  receiptIds: number[],
  pool = requirePool(),
) {
  await ensureSyncSchema(pool);

  if (receiptIds.length === 0) {
    return new Map<number, number>();
  }

  const result = await pool.query<{
    receipt_id: string;
    sync_timestamp: string | number | null;
  }>(
    `
      select
        receipt_id::text,
        greatest(
          coalesce(update_timestamp, 0),
          coalesce(create_timestamp, 0)
        ) as sync_timestamp
      from etsy_receipts
      where shop_id = $1
        and receipt_id = any($2::bigint[])
    `,
    [shopId, receiptIds],
  );

  return new Map(
    result.rows.map((row) => [
      numericId(row.receipt_id),
      row.sync_timestamp == null ? 0 : Number(row.sync_timestamp),
    ]),
  );
}

export async function setCursor(
  shopId: number,
  cursorName: string,
  cursorTimestamp: number,
  pool = requirePool(),
) {
  await ensureSyncSchema(pool);
  await pool.query(
    `
      insert into etsy_sync_cursors (shop_id, cursor_name, cursor_timestamp, updated_at)
      values ($1, $2, $3, now())
      on conflict (shop_id, cursor_name)
      do update set cursor_timestamp = excluded.cursor_timestamp,
                    updated_at = now()
    `,
    [shopId, cursorName, cursorTimestamp],
  );
}

export async function recordWebhookEvent(
  webhookId: string | null,
  payload: Record<string, unknown>,
  pool = requirePool(),
) {
  await ensureSyncSchema(pool);

  if (webhookId) {
    const insert = await pool.query<{ id: string }>(
      `
        insert into etsy_webhook_events (
          webhook_id,
          event_type,
          shop_id,
          resource_url,
          payload
        )
        values ($1, $2, $3, $4, $5)
        on conflict (webhook_id) do nothing
        returning id
      `,
      [
        webhookId,
        String(payload.event_type ?? "unknown"),
        payload.shop_id ?? null,
        payload.resource_url ?? null,
        JSON.stringify(payload),
      ],
    );

    if (insert.rows[0]) {
      return {
        duplicate: false,
        eventId: numericId(insert.rows[0].id),
      };
    }

    await pool.query(
      `
        update etsy_webhook_events
        set delivery_count = delivery_count + 1,
            received_at = now()
        where webhook_id = $1
      `,
      [webhookId],
    );

    return {
      duplicate: true,
      eventId: null,
    };
  }

  const result = await pool.query<{ id: string }>(
    `
      insert into etsy_webhook_events (
        event_type,
        shop_id,
        resource_url,
        payload
      )
      values ($1, $2, $3, $4)
      returning id
    `,
    [
      String(payload.event_type ?? "unknown"),
      payload.shop_id ?? null,
      payload.resource_url ?? null,
      JSON.stringify(payload),
    ],
  );

  return {
    duplicate: false,
    eventId: numericId(result.rows[0].id),
  };
}

export async function markWebhookProcessed(eventId: number, pool = requirePool()) {
  await pool.query(
    `
      update etsy_webhook_events
      set status = 'processed',
          processed_at = now()
      where id = $1
    `,
    [eventId],
  );
}

export async function markWebhookFailed(eventId: number, error: Error, pool = requirePool()) {
  await pool.query(
    `
      update etsy_webhook_events
      set status = 'failed',
          error = $2
      where id = $1
    `,
    [eventId, error.message],
  );
}

export async function getSyncStatus(pool = requirePool(), shopIds?: number[]) {
  await ensureSyncSchema(pool);

  if (shopIds && shopIds.length === 0) return { jobs: {}, webhooks: {} };
  const scope = shopIds ? "where shop_id = any($1::bigint[])" : "";
  const params = shopIds ? [shopIds] : [];

  const [jobs, events] = await Promise.all([
    pool.query<{ status: string; count: string }>(
      `
        select status, count(*)::text as count
        from etsy_sync_jobs
        ${scope}
        group by status
      `,
      params,
    ),
    pool.query<{ status: string; count: string }>(
      `
        select status, count(*)::text as count
        from etsy_webhook_events
        ${scope}
        group by status
      `,
      params,
    ),
  ]);

  return {
    jobs: Object.fromEntries(jobs.rows.map((row) => [row.status, Number(row.count)])),
    webhooks: Object.fromEntries(events.rows.map((row) => [row.status, Number(row.count)])),
  };
}

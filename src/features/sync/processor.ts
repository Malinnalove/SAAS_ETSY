import { EtsyClient, type EtsyInventoryUpdateInput, type EtsyListingProperty } from "@/features/etsy/client";
import { ensureFreshConnection } from "@/features/etsy/oauth";
import {
  claimSyncJobById,
  claimSyncJobs,
  completeSyncJob,
  enqueueSyncJob,
  enqueueSyncJobIfNotPending,
  failSyncJob,
  getCursor,
  getPendingSyncJob,
  getReceiptSyncStates,
  getShopConnection,
  getShopSyncState,
  getSyncedListings,
  listSyncedListingIds,
  listActiveShopSyncStates,
  setCursor,
  syncErrorDetail,
  updateConnection,
  updateListingInventoryData,
  updateShopMetadata,
  upsertListings,
  upsertReceipts,
  upsertTransactions,
  type ListingSkuUpdate,
  type ListingSkuUpdatePayload,
  type SyncJob,
  type SyncJobType,
} from "@/features/sync/db";
import { processListingDeleteAttempt } from "@/features/products/listing-delete-db";
import type { EtsyConnection, EtsyListingSummary, EtsyReceiptSummary } from "@/shared/types/etsy";
import { processListingDraftPublish } from "@/features/products/listing-workbench-publisher";

const RECEIPT_CURSOR = "receipts:last_modified";
const RECEIPT_LOOKBACK_SECONDS = 2 * 60 * 60;
const LISTING_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

type UnknownRecord = Record<string, unknown>;

type ManualSyncJob = {
  shopId: number;
  jobType: SyncJobType;
  jobId?: number;
  skipped?: boolean;
  reason?: string;
};

function receiptIdFromResourceUrl(resourceUrl?: unknown) {
  if (typeof resourceUrl !== "string") return null;
  const match = /\/receipts\/(\d+)/.exec(resourceUrl);
  if (!match) return null;
  const receiptId = Number(match[1]);
  return Number.isFinite(receiptId) ? receiptId : null;
}

function latestReceiptTimestamp(receipts: EtsyReceiptSummary[]) {
  return receipts.reduce((latest, receipt) => {
    const timestamp = receipt.update_timestamp ?? receipt.create_timestamp ?? 0;
    return Math.max(latest, timestamp);
  }, 0);
}

function receiptSyncTimestamp(receipt: EtsyReceiptSummary) {
  return Math.max(receipt.update_timestamp ?? 0, receipt.create_timestamp ?? 0);
}

function listingSyncTimestamp(listing: EtsyListingSummary) {
  return listing.updated_timestamp ?? null;
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function recordFrom(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function recordsFrom(value: unknown) {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringFrom(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function numberFrom(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function booleanFrom(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function materialValuesFromProperties(properties: EtsyListingProperty[]) {
  return Array.from(
    new Set(
      properties
        .filter((property) => property.property_name?.toLowerCase().includes("material"))
        .flatMap((property) => property.values ?? [])
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
}

function inventoryProductsFromUnknown(value: unknown) {
  return recordsFrom(recordFrom(value).products);
}

function skusFromInventory(inventory: unknown) {
  return inventoryProductsFromUnknown(inventory)
    .map((product) => stringFrom(product.sku))
    .filter(Boolean);
}

function uniqueStringValues(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function skuVariesByProperty(inventory: unknown) {
  return numberListFrom(recordFrom(inventory).sku_on_property).length > 0;
}

function listingWithInventory(listing: EtsyListingSummary, inventory: Awaited<ReturnType<EtsyClient["getListingInventory"]>>) {
  const products = inventoryProductsFromUnknown(inventory);
  const skus = skusFromInventory(inventory);
  const uniqueSkus = uniqueStringValues(skus);
  const hasSkuVariation = skuVariesByProperty(inventory);

  if (products.length === 1) {
    return {
      ...listing,
      inventory,
      sku: skus[0] ?? listing.sku ?? null,
      skus: undefined,
    };
  }

  return {
    ...listing,
    inventory,
    sku: products.length > 1 && !hasSkuVariation && uniqueSkus.length === 1 ? uniqueSkus[0] : listing.sku ?? null,
    skus: uniqueSkus.length ? uniqueSkus : undefined,
  };
}

function numberListFrom(value: unknown) {
  return Array.isArray(value)
    ? value
        .map(numberFrom)
        .filter((item): item is number => item !== null)
    : [];
}

function propertySignatureFromProduct(product: UnknownRecord) {
  return JSON.stringify(
    recordsFrom(product.property_values).map((property) => ({
      propertyId: numberFrom(property.property_id) ?? 0,
      scaleId: numberFrom(property.scale_id),
      valueIds: numberListFrom(property.value_ids),
      values: Array.isArray(property.values)
        ? property.values.map(stringFrom).filter(Boolean)
        : [stringFrom(property.value)].filter(Boolean),
    })),
  );
}

function priceFromUnknown(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  const price = recordFrom(value);
  const amount = numberFrom(price.amount);
  const divisor = numberFrom(price.divisor);

  if (amount !== null && divisor !== null && divisor > 0) {
    return Number((amount / divisor).toFixed(2));
  }

  throw new Error("Etsy inventory offering is missing price.");
}

function sanitizeOffering(offering: UnknownRecord) {
  const quantity = numberFrom(offering.quantity);
  const readinessStateId = numberFrom(offering.readiness_state_id);

  if (quantity === null) {
    throw new Error("Etsy inventory offering is missing quantity.");
  }

  const sanitized: EtsyInventoryUpdateInput["products"][number]["offerings"][number] = {
    is_enabled: booleanFrom(offering.is_enabled, true),
    price: priceFromUnknown(offering.price),
    quantity: Math.max(0, Math.round(quantity)),
  };

  if (readinessStateId !== null) {
    sanitized.readiness_state_id = readinessStateId;
  }

  return sanitized;
}

function sanitizePropertyValue(property: UnknownRecord) {
  const propertyId = numberFrom(property.property_id);

  if (propertyId === null) {
    throw new Error("Etsy inventory property value is missing property_id.");
  }

  return {
    property_id: propertyId,
    property_name: stringFrom(property.property_name) || undefined,
    scale_id: numberFrom(property.scale_id),
    value_ids: numberListFrom(property.value_ids),
    values: Array.isArray(property.values)
      ? property.values.map(stringFrom).filter(Boolean)
      : [stringFrom(property.value)].filter(Boolean),
  };
}

function sanitizeProduct(product: UnknownRecord) {
  const offerings = recordsFrom(product.offerings).map(sanitizeOffering);

  if (offerings.length === 0) {
    throw new Error("Etsy inventory product is missing offerings.");
  }

  const sanitized: EtsyInventoryUpdateInput["products"][number] = {
    offerings,
    property_values: recordsFrom(product.property_values).map(sanitizePropertyValue),
  };
  const sku = stringFrom(product.sku);

  if (sku) {
    sanitized.sku = sku;
  }

  return sanitized;
}

function parseListingSkuUpdatePayload(payload: Record<string, unknown>): ListingSkuUpdatePayload {
  const listingId = numberFrom(payload.listingId);
  const rawUpdates = Array.isArray(payload.updates) ? payload.updates : [];
  const updates = rawUpdates
    .filter(isRecord)
    .map((update): ListingSkuUpdate | null => {
      const productIndex = numberFrom(update.productIndex);
      const productId = numberFrom(update.productId);
      const sku = stringFrom(update.sku);

      if (productIndex === null || productIndex < 0 || !sku) {
        return null;
      }

      return {
        productId: productId ?? undefined,
        productIndex: Math.round(productIndex),
        propertySignature: stringFrom(update.propertySignature),
        sku,
      };
    })
    .filter((update): update is ListingSkuUpdate => update !== null);

  if (listingId === null || listingId <= 0) {
    throw new Error("update_listing_skus requires listingId.");
  }

  if (updates.length === 0) {
    throw new Error("update_listing_skus requires at least one SKU update.");
  }

  return {
    listingId,
    requestedAt: stringFrom(payload.requestedAt) || undefined,
    updates,
  };
}

function findSkuUpdate(
  product: UnknownRecord,
  productIndex: number,
  updates: ListingSkuUpdate[],
  matchedUpdateIndexes: Set<number>,
) {
  const productId = numberFrom(product.product_id);
  const signature = propertySignatureFromProduct(product);
  const productIdIndex =
    productId === null
      ? -1
      : updates.findIndex((update, index) => !matchedUpdateIndexes.has(index) && update.productId === productId);

  if (productIdIndex >= 0) {
    return { index: productIdIndex, update: updates[productIdIndex] };
  }

  const signatureIndex = updates.findIndex(
    (update, index) =>
      !matchedUpdateIndexes.has(index) &&
      Boolean(update.propertySignature) &&
      update.propertySignature === signature,
  );

  if (signatureIndex >= 0) {
    return { index: signatureIndex, update: updates[signatureIndex] };
  }

  const fallbackIndex = updates.findIndex(
    (update, index) => !matchedUpdateIndexes.has(index) && update.productIndex === productIndex,
  );

  return fallbackIndex >= 0 ? { index: fallbackIndex, update: updates[fallbackIndex] } : null;
}

function applySkuUpdatesToInventory(rawInventory: unknown, updates: ListingSkuUpdate[]): EtsyInventoryUpdateInput {
  const inventory = recordFrom(rawInventory);
  const rawProducts = recordsFrom(inventory.products);
  const matchedUpdateIndexes = new Set<number>();

  if (rawProducts.length === 0) {
    throw new Error("Etsy inventory has no products to update.");
  }

  const products = rawProducts.map((product, index) => {
    const sanitized = sanitizeProduct(product);
    const match = findSkuUpdate(product, index, updates, matchedUpdateIndexes);

    if (match) {
      sanitized.sku = match.update.sku;
      matchedUpdateIndexes.add(match.index);
    }

    return sanitized;
  });

  if (matchedUpdateIndexes.size !== updates.length) {
    throw new Error("Some SKU updates no longer match the latest Etsy inventory.");
  }

  return {
    products,
    price_on_property: numberListFrom(inventory.price_on_property),
    quantity_on_property: numberListFrom(inventory.quantity_on_property),
    readiness_state_on_property: numberListFrom(inventory.readiness_state_on_property),
    sku_on_property: numberListFrom(inventory.sku_on_property),
  };
}

async function enrichListingsWithEtsyDetails(
  client: EtsyClient,
  shopId: number,
  listings: Awaited<ReturnType<EtsyClient["getShopListings"]>>,
) {
  const enriched: EtsyListingSummary[] = [];

  for (const listing of listings) {
    let nextListing = listing;

    if (!nextListing.materials?.length) {
      try {
        const properties = await client.getListingProperties(shopId, listing.listing_id);
        const materials = materialValuesFromProperties(properties.results ?? []);

        if (materials.length > 0) {
          nextListing = {
            ...nextListing,
            listing_properties: properties.results,
            materials,
          };
        }
      } catch (error) {
        console.error(`Listing properties sync skipped for ${listing.listing_id}:`, error);
      }
    }

    if (nextListing.has_variations || inventoryProductsFromUnknown(nextListing.inventory).length === 0) {
      try {
        const inventory = await client.getListingInventory(listing.listing_id);

        if (inventoryProductsFromUnknown(inventory).length > 0) {
          nextListing = listingWithInventory(nextListing, inventory);
        }
      } catch (error) {
        console.error(`Listing inventory sync skipped for ${listing.listing_id}:`, error);
      }
    }

    enriched.push(nextListing);
  }

  return enriched;
}

function shouldRefreshListingDetails(
  listing: EtsyListingSummary,
  existingListing: EtsyListingSummary | undefined,
) {
  if (!existingListing) return true;

  const currentTimestamp = listingSyncTimestamp(listing);
  const existingTimestamp = listingSyncTimestamp(existingListing);

  if (currentTimestamp !== null || existingTimestamp !== null) {
    return currentTimestamp !== existingTimestamp;
  }

  return false;
}

function listingWithExistingDetails(
  listing: EtsyListingSummary,
  existingListing: EtsyListingSummary | undefined,
) {
  if (!existingListing) return listing;

  let nextListing = listing;
  const existingMaterials = Array.isArray(existingListing.materials)
    ? existingListing.materials.filter(Boolean)
    : [];
  const existingProperties = Array.isArray(existingListing.listing_properties)
    ? existingListing.listing_properties
    : null;

  if (!nextListing.materials?.length && existingMaterials.length > 0) {
    nextListing = {
      ...nextListing,
      listing_properties: nextListing.listing_properties ?? existingProperties,
      materials: existingMaterials,
    };
  } else if (!nextListing.listing_properties && existingProperties) {
    nextListing = {
      ...nextListing,
      listing_properties: existingProperties,
    };
  }

  if (
    inventoryProductsFromUnknown(nextListing.inventory).length === 0 &&
    inventoryProductsFromUnknown(existingListing.inventory).length > 0
  ) {
    nextListing = {
      ...nextListing,
      inventory: existingListing.inventory,
      sku: nextListing.sku ?? existingListing.sku ?? null,
      skus: nextListing.skus ?? existingListing.skus,
    };
  }

  return nextListing;
}

async function enrichChangedListingsWithEtsyDetails(
  client: EtsyClient,
  shopId: number,
  listings: Awaited<ReturnType<EtsyClient["getShopListings"]>>,
) {
  const listingIds = listings.map((listing) => listing.listing_id);
  const [existingListings, existingListingIds] = await Promise.all([
    getSyncedListings(shopId, listingIds),
    listSyncedListingIds(shopId),
  ]);
  const changedListings: EtsyListingSummary[] = [];
  const reusedListings = new Map<number, EtsyListingSummary>();
  const currentListingIds = new Set(listingIds);
  const deletedCount = existingListingIds.filter((listingId) => !currentListingIds.has(listingId)).length;

  for (const listing of listings) {
    const existingListing = existingListings.get(listing.listing_id);

    if (shouldRefreshListingDetails(listing, existingListing)) {
      changedListings.push(listing);
      continue;
    }

    reusedListings.set(listing.listing_id, listingWithExistingDetails(listing, existingListing));
  }

  const enrichedChangedListings = await enrichListingsWithEtsyDetails(client, shopId, changedListings);
  const enrichedChangedById = new Map(
    enrichedChangedListings.map((listing) => [listing.listing_id, listing]),
  );

  console.info(
    `Listing sync for shop ${shopId}: ${changedListings.length} new/changed, ` +
      `${reusedListings.size} unchanged, ` +
      `${deletedCount} deleted.`,
  );

  return listings.map((listing) =>
    enrichedChangedById.get(listing.listing_id) ??
    reusedListings.get(listing.listing_id) ??
    listing,
  );
}

async function getFreshClient(shopId: number) {
  const currentConnection = await getShopConnection(shopId);

  if (!currentConnection) {
    throw new Error(`Shop ${shopId} is not connected.`);
  }

  const connection = await ensureFreshConnection(currentConnection);

  if (connection.accessToken !== currentConnection.accessToken) {
    await updateConnection(connection);
  }

  return {
    client: new EtsyClient(connection),
    connection,
  };
}

export async function enqueueManualSyncJobs(
  shopId: number,
  options: { forceFull?: boolean } = {},
): Promise<ManualSyncJob[]> {
  const requestedAt = new Date().toISOString();
  const pendingFullSync = await getPendingSyncJob(shopId, ["sync_shop_full"]);

  if (pendingFullSync) {
    return [
      {
        shopId,
        jobType: pendingFullSync.jobType,
        jobId: pendingFullSync.id,
        skipped: true,
        reason: "covered_by_pending_full_sync",
      },
    ];
  }

  const [state, cursor] = await Promise.all([
    getShopSyncState(shopId),
    getCursor(shopId, RECEIPT_CURSOR),
  ]);
  const needsInitialFullSync = !state?.receiptsSyncAt && !state?.listingsSyncAt && cursor == null;

  if (options.forceFull || needsInitialFullSync) {
    const job = await enqueueSyncJobIfNotPending(
      shopId,
      "sync_shop_full",
      {
        requestedBy: "manual",
        requestedAt,
        reason: options.forceFull ? "force_full" : "initial_sync",
      },
      20,
    );

    return [
      {
        shopId,
        jobType: "sync_shop_full",
        jobId: job.jobId,
        skipped: !job.enqueued,
        reason: options.forceFull ? "force_full" : "initial_sync",
      },
    ];
  }

  const receiptJob = await enqueueSyncJobIfNotPending(
    shopId,
    "sync_receipts_incremental",
    {
      requestedBy: "manual",
      requestedAt,
    },
    20,
  );
  const jobs: ManualSyncJob[] = [
    {
      shopId,
      jobType: "sync_receipts_incremental",
      jobId: receiptJob.jobId,
      skipped: !receiptJob.enqueued,
    },
  ];

  const listingJob = await enqueueSyncJobIfNotPending(
    shopId,
    "sync_listings",
    {
      requestedBy: "manual",
      requestedAt,
      previousListingsSyncAt: state?.listingsSyncAt ?? null,
    },
    60,
  );

  jobs.push({
    shopId,
    jobType: "sync_listings",
    jobId: listingJob.jobId,
    skipped: !listingJob.enqueued,
  });

  return jobs;
}

async function syncShopFull(job: SyncJob, client: EtsyClient, connection: EtsyConnection) {
  const [shop, rawListings, receiptSummaries] = await Promise.all([
    client.getShop(job.shopId),
    client.getShopListings(job.shopId),
    client.getReceipts(job.shopId),
  ]);
  const [listings, receipts] = await Promise.all([
    enrichListingsWithEtsyDetails(client, job.shopId, rawListings),
    client.getRecentReceiptDetails(job.shopId, receiptSummaries),
  ]);

  await updateShopMetadata(job.shopId, shop, connection);
  await upsertListings(job.shopId, listings, undefined, { replaceMissing: true });
  await upsertReceipts(job.shopId, receipts);

  const transactions = await client.getRecentOrderDetails(job.shopId, receipts);
  await upsertTransactions(job.shopId, transactions);

  const latest = latestReceiptTimestamp(receipts);
  if (latest > 0) {
    await setCursor(job.shopId, RECEIPT_CURSOR, latest);
  }
}

async function syncListings(job: SyncJob, client: EtsyClient) {
  const rawListings = await client.getShopListings(job.shopId);
  const listings = await enrichChangedListingsWithEtsyDetails(client, job.shopId, rawListings);
  await upsertListings(job.shopId, listings, undefined, { replaceMissing: true });
}

async function syncReceiptDetail(job: SyncJob, client: EtsyClient) {
  const receiptId =
    typeof job.payload.receiptId === "number"
      ? job.payload.receiptId
      : receiptIdFromResourceUrl(job.payload.resourceUrl);

  if (!receiptId) {
    throw new Error("sync_receipt_detail requires receiptId or resourceUrl.");
  }

  const receipt = await client.getReceipt(job.shopId, receiptId);
  const transactions = await client.getReceiptTransactions(job.shopId, receiptId);

  await upsertReceipts(job.shopId, [receipt]);
  await upsertTransactions(job.shopId, transactions);

  const latest = receipt.update_timestamp ?? receipt.create_timestamp ?? 0;
  const currentCursor = await getCursor(job.shopId, RECEIPT_CURSOR);
  if (latest > 0 && latest > (currentCursor ?? 0)) {
    await setCursor(job.shopId, RECEIPT_CURSOR, latest);
  }
}

async function syncReceiptsIncremental(job: SyncJob, client: EtsyClient) {
  const cursor = await getCursor(job.shopId, RECEIPT_CURSOR);
  const fallbackCursor = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
  const requestedMinLastModified =
    typeof job.payload.minLastModified === "number"
      ? job.payload.minLastModified
      : cursor ?? fallbackCursor;
  const minLastModified = Math.max(0, requestedMinLastModified - RECEIPT_LOOKBACK_SECONDS);
  const receipts = await client.getReceipts(job.shopId, 100, {
    minLastModified,
    maxPages: 5,
  });
  const existingSyncStates = await getReceiptSyncStates(
    job.shopId,
    receipts.map((receipt) => receipt.receipt_id),
  );
  const changedReceipts = receipts.filter((receipt) => {
    const localTimestamp = existingSyncStates.get(receipt.receipt_id);
    return localTimestamp == null || receiptSyncTimestamp(receipt) > localTimestamp;
  });

  await upsertReceipts(job.shopId, receipts);

  for (const receipt of changedReceipts) {
    await enqueueSyncJob(
      job.shopId,
      "sync_receipt_detail",
      {
        receiptId: receipt.receipt_id,
        source: "incremental_receipt_change",
      },
      20,
    );
  }

  const latest = latestReceiptTimestamp(receipts);
  if (latest > 0 && latest > (cursor ?? 0)) {
    await setCursor(job.shopId, RECEIPT_CURSOR, latest);
  }
}

async function updateListingSkus(job: SyncJob, client: EtsyClient) {
  const payload = parseListingSkuUpdatePayload(job.payload);
  const rawInventory = await client.getListingInventory(payload.listingId);
  const nextInventory = applySkuUpdatesToInventory(rawInventory, payload.updates);

  await client.updateListingInventory(payload.listingId, nextInventory);
  await updateListingInventoryData(job.shopId, payload.listingId, await client.getListingInventory(payload.listingId));
}

function publishAttemptIdFromJob(job: SyncJob) {
  const value = Number(job.payload.publishAttemptId);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("publish_listing_draft requires publishAttemptId.");
  }
  return Math.round(value);
}

function deleteAttemptIdFromJob(job: SyncJob) {
  const value = Number(job.payload.deleteAttemptId);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("delete_listing requires deleteAttemptId.");
  }
  return Math.round(value);
}

async function runJob(job: SyncJob) {
  const { client, connection } = await getFreshClient(job.shopId);

  if (job.jobType === "sync_shop_full") {
    await syncShopFull(job, client, connection);
    return;
  }

  if (job.jobType === "sync_listings") {
    await syncListings(job, client);
    return;
  }

  if (job.jobType === "sync_receipts_incremental") {
    await syncReceiptsIncremental(job, client);
    return;
  }

  if (job.jobType === "sync_receipt_detail") {
    await syncReceiptDetail(job, client);
    return;
  }

  if (job.jobType === "update_listing_skus") {
    await updateListingSkus(job, client);
    return;
  }

  if (job.jobType === "publish_listing_draft") {
    await processListingDraftPublish(publishAttemptIdFromJob(job), client);
    return;
  }

  if (job.jobType === "delete_listing") {
    await processListingDeleteAttempt(deleteAttemptIdFromJob(job), client);
    return;
  }

  throw new Error(`Unsupported sync job type: ${job.jobType}`);
}

export async function processSyncJobs(limit = 5) {
  const jobs = await claimSyncJobs(limit);
  const results: Array<{ id: number; status: "completed" | "failed"; error?: string }> = [];

  for (const job of jobs) {
    results.push(await processClaimedJob(job));
  }

  return {
    processed: jobs.length,
    results,
  };
}

async function processClaimedJob(job: SyncJob) {
  try {
    await runJob(job);
    await completeSyncJob(job.id);
    return { id: job.id, status: "completed" as const };
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error("Unknown sync job error.");
    await failSyncJob(job, normalizedError);
    return { id: job.id, status: "failed" as const, error: syncErrorDetail(normalizedError) };
  }
}

export async function processSyncJobById(jobId: number) {
  const job = await claimSyncJobById(jobId);

  if (!job) {
    return {
      processed: 0,
      results: [],
    };
  }

  return {
    processed: 1,
    results: [await processClaimedJob(job)],
  };
}

export async function enqueueScheduledSyncJobs() {
  const shops = await listActiveShopSyncStates();
  const enqueued: Array<{ shopId: number; jobType: string; jobId: number; skipped?: boolean }> = [];

  for (const shop of shops) {
    const shopId = shop.shopId;
    const receiptJob = await enqueueSyncJobIfNotPending(shopId, "sync_receipts_incremental", {}, 30);
    enqueued.push({
      shopId,
      jobType: "sync_receipts_incremental",
      jobId: receiptJob.jobId,
      skipped: !receiptJob.enqueued,
    });

    const lastListingSync = shop.listingsSyncAt ? new Date(shop.listingsSyncAt).getTime() : 0;
    const listingSyncDue = Date.now() - lastListingSync >= LISTING_SYNC_INTERVAL_MS;

    if (listingSyncDue) {
      const listingJob = await enqueueSyncJobIfNotPending(
        shopId,
        "sync_listings",
        {
          requestedAt: new Date().toISOString(),
          intervalMs: LISTING_SYNC_INTERVAL_MS,
        },
        80,
      );
      enqueued.push({
        shopId,
        jobType: "sync_listings",
        jobId: listingJob.jobId,
        skipped: !listingJob.enqueued,
      });
    }
  }

  return enqueued;
}

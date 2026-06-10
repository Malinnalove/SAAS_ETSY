import { ensureFreshConnection, EtsyClient } from "@/lib/etsy";
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
  listActiveShopSyncStates,
  setCursor,
  updateConnection,
  updateShopMetadata,
  upsertListings,
  upsertReceipts,
  upsertTransactions,
  type SyncJob,
  type SyncJobType,
} from "@/lib/sync-db";
import type { EtsyConnection, EtsyReceiptSummary } from "@/lib/types";

const RECEIPT_CURSOR = "receipts:last_modified";
const RECEIPT_LOOKBACK_SECONDS = 2 * 60 * 60;
const LISTING_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

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

function isListingSyncDue(listingsSyncAt?: string | null) {
  if (!listingsSyncAt) return true;

  const timestamp = new Date(listingsSyncAt).getTime();
  if (!Number.isFinite(timestamp)) return true;

  return Date.now() - timestamp >= LISTING_SYNC_INTERVAL_MS;
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

  if (isListingSyncDue(state?.listingsSyncAt)) {
    const listingJob = await enqueueSyncJobIfNotPending(
      shopId,
      "sync_listings",
      {
        requestedBy: "manual",
        requestedAt,
        intervalMs: LISTING_SYNC_INTERVAL_MS,
      },
      60,
    );

    jobs.push({
      shopId,
      jobType: "sync_listings",
      jobId: listingJob.jobId,
      skipped: !listingJob.enqueued,
    });
  } else {
    jobs.push({
      shopId,
      jobType: "sync_listings",
      skipped: true,
      reason: "listing_sync_not_due",
    });
  }

  return jobs;
}

async function syncShopFull(job: SyncJob, client: EtsyClient, connection: EtsyConnection) {
  const [shop, listings, receipts] = await Promise.all([
    client.getShop(job.shopId),
    client.getActiveListings(job.shopId),
    client.getReceipts(job.shopId),
  ]);

  await updateShopMetadata(job.shopId, shop, connection);
  await upsertListings(job.shopId, listings);
  await upsertReceipts(job.shopId, receipts);

  const transactions = await client.getRecentOrderDetails(job.shopId, receipts);
  await upsertTransactions(job.shopId, transactions);

  const latest = latestReceiptTimestamp(receipts);
  if (latest > 0) {
    await setCursor(job.shopId, RECEIPT_CURSOR, latest);
  }
}

async function syncListings(job: SyncJob, client: EtsyClient) {
  const listings = await client.getActiveListings(job.shopId);
  await upsertListings(job.shopId, listings);
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
    return { id: job.id, status: "failed" as const, error: normalizedError.message };
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

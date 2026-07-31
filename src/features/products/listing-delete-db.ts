import type { Pool } from "pg";
import { getPool } from "@/server/db";
import { EtsyClient } from "@/features/etsy/client";
import {
  assertListingShopAccess,
  ensureListingWorkbenchSchema,
  ListingWorkbenchError,
} from "@/features/products/listing-workbench-db";
import type { ListingDeleteAttempt } from "@/shared/types/listing-workbench";

function requirePool() {
  const pool = getPool();
  if (!pool) throw new ListingWorkbenchError("PostgreSQL DATABASE_URL is required for Listing deletion.", 503);
  return pool;
}

function deleteAttemptStatus(row: {
  attempt_status: string;
  job_status: string | null;
}): ListingDeleteAttempt["status"] {
  if (row.attempt_status === "succeeded") return "succeeded";
  if (row.job_status === "running" || row.attempt_status === "running") return "running";
  if (row.job_status === "queued") return "queued";
  if (row.job_status === "failed" || row.attempt_status === "failed") return "failed";
  return "queued";
}

async function closeStaleListingDeleteAttempts(organizationId: number, pool: Pool) {
  const client = await pool.connect();
  const message = "Delete job expired after waiting 15 minutes without being started.";
  try {
    await client.query("begin");
    const stale = await client.query<{ attempt_id: string; job_id: string }>(
      `select attempt.id as attempt_id, job.id as job_id
       from listing_delete_attempts attempt
       join etsy_sync_jobs job on job.id = attempt.job_id
       where attempt.organization_id = $1 and attempt.status = 'queued'
         and job.job_type = 'delete_listing' and job.status = 'queued' and job.attempts = 0
         and job.created_at < now() - interval '15 minutes'
       for update of attempt, job skip locked`,
      [organizationId],
    );
    if (stale.rows.length) {
      await client.query(
        `update etsy_sync_jobs set status = 'failed', error = $2, finished_at = now(), updated_at = now()
         where id = any($1::bigint[])`,
        [stale.rows.map((row) => Number(row.job_id)), message],
      );
      await client.query(
        `update listing_delete_attempts set status = 'failed', error = $2, finished_at = now(), updated_at = now()
         where id = any($1::bigint[])`,
        [stale.rows.map((row) => Number(row.attempt_id)), message],
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function queueListingDeletes(input: {
  items: Array<{ draftId: number | null; listingId: number | null }>;
  mode: "all" | "changed";
  organizationId: number;
  shopId: number;
  userId: number;
}) {
  const pool = requirePool();
  await ensureListingWorkbenchSchema(pool);
  await closeStaleListingDeleteAttempts(input.organizationId, pool);
  const client = await pool.connect();
  const results: Array<{
    attemptId: number | null;
    draftId: number | null;
    error: string | null;
    jobId: number | null;
    listingId: number | null;
    status: "discarded" | "queued" | "rejected";
  }> = [];
  try {
    await client.query("begin");
    await assertListingShopAccess(input.organizationId, input.shopId, client);
    for (const item of input.items.slice(0, 100)) {
      const draftId = item.draftId;
      let listingId = item.listingId;
      if (draftId) {
        const draftResult = await client.query<{
          draft_kind: "existing" | "new";
          id: string;
          listing_id: string | null;
          status: string;
        }>(
          `select id, listing_id, draft_kind, status from listing_drafts
           where id = $1 and organization_id = $2 and shop_id = $3 and deleted_at is null for update`,
          [draftId, input.organizationId, input.shopId],
        );
        const draft = draftResult.rows[0];
        if (!draft) {
          results.push({ attemptId: null, draftId, error: "Draft not found.", jobId: null, listingId, status: "rejected" });
          continue;
        }
        if (["queued", "publishing"].includes(draft.status)) {
          results.push({ attemptId: null, draftId, error: "Publishing Listings cannot be deleted.", jobId: null, listingId, status: "rejected" });
          continue;
        }
        listingId = listingId ?? (draft.listing_id ? Number(draft.listing_id) : null);
        if (input.mode === "changed" && draft.draft_kind === "new" && !listingId) {
          await client.query(`update listing_drafts set deleted_at = now(), status = 'archived', updated_at = now() where id = $1`, [draft.id]);
          await client.query(`delete from listing_draft_media where draft_id = $1`, [draft.id]);
          results.push({ attemptId: null, draftId, error: null, jobId: null, listingId, status: "discarded" });
          continue;
        }
      }

      if (input.mode === "changed") {
        results.push({
          attemptId: null,
          draftId,
          error: "Batch upload can only discard local products that have not been uploaded to Etsy.",
          jobId: null,
          listingId,
          status: "rejected",
        });
        continue;
      }

      if (!listingId || !Number.isSafeInteger(listingId) || listingId <= 0) {
        results.push({ attemptId: null, draftId, error: "A remote Listing ID is required.", jobId: null, listingId, status: "rejected" });
        continue;
      }
      if (input.mode === "all") {
        const source = await client.query<{ state: string }>(
          `select coalesce(data->>'state','') as state from etsy_listings where shop_id = $1 and listing_id = $2 for update`,
          [input.shopId, listingId],
        );
        if (!source.rows[0]) {
          results.push({ attemptId: null, draftId, error: "Only synced Etsy Listings can be deleted from All Listings.", jobId: null, listingId, status: "rejected" });
          continue;
        }
      }
      const active = await client.query<{ id: string; job_id: string | null }>(
        `select id, job_id from listing_delete_attempts
         where organization_id = $1 and shop_id = $2 and listing_id = $3 and status in ('queued','running')
         order by id desc limit 1`,
        [input.organizationId, input.shopId, listingId],
      );
      if (active.rows[0]) {
        results.push({
          attemptId: Number(active.rows[0].id),
          draftId,
          error: null,
          jobId: active.rows[0].job_id ? Number(active.rows[0].job_id) : null,
          listingId,
          status: "queued",
        });
        continue;
      }
      const attemptResult = await client.query<{ id: string }>(
        `insert into listing_delete_attempts (
           organization_id, shop_id, listing_id, draft_id, status, requested_by_user_id
         ) values ($1,$2,$3,$4,'queued',$5) returning id`,
        [input.organizationId, input.shopId, listingId, draftId, input.userId],
      );
      const attemptId = Number(attemptResult.rows[0].id);
      const jobResult = await client.query<{ id: string }>(
        `insert into etsy_sync_jobs (shop_id, job_type, payload, priority, max_attempts)
         values ($1,'delete_listing',$2::jsonb,20,4) returning id`,
        [input.shopId, JSON.stringify({ deleteAttemptId: attemptId })],
      );
      const jobId = Number(jobResult.rows[0].id);
      await client.query(`update listing_delete_attempts set job_id = $2, updated_at = now() where id = $1`, [attemptId, jobId]);
      results.push({ attemptId, draftId, error: null, jobId, listingId, status: "queued" });
    }
    await client.query("commit");
    return results;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function listListingDeleteAttempts(input: {
  attemptIds: number[];
  organizationId: number;
}) {
  const pool = requirePool();
  await ensureListingWorkbenchSchema(pool);
  await closeStaleListingDeleteAttempts(input.organizationId, pool);
  const ids = Array.from(new Set(input.attemptIds.filter((id) => Number.isSafeInteger(id) && id > 0))).slice(0, 100);
  if (!ids.length) return [];
  const result = await pool.query<{
    attempt_error: string | null;
    attempt_id: string;
    attempt_status: string;
    draft_id: string | null;
    job_id: string | null;
    job_status: string | null;
    listing_id: string;
    shop_id: string;
  }>(
    `select attempt.id as attempt_id, attempt.shop_id, attempt.listing_id, attempt.draft_id,
            attempt.status as attempt_status, attempt.error as attempt_error,
            attempt.job_id, job.status as job_status
     from listing_delete_attempts attempt
     left join etsy_sync_jobs job on job.id = attempt.job_id
     where attempt.organization_id = $1 and attempt.id = any($2::bigint[])
     order by attempt.id`,
    [input.organizationId, ids],
  );
  return result.rows.map((row) => ({
    attemptId: Number(row.attempt_id),
    draftId: row.draft_id ? Number(row.draft_id) : null,
    error: row.attempt_error,
    jobId: row.job_id ? Number(row.job_id) : null,
    listingId: Number(row.listing_id),
    shopId: Number(row.shop_id),
    status: deleteAttemptStatus(row),
  }));
}

async function startListingDeleteAttempt(attemptId: number, pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await client.query<{
      draft_id: string | null;
      listing_id: string;
      organization_id: string;
      shop_id: string;
      status: string;
    }>(
      `select id, organization_id, shop_id, listing_id, draft_id, status
       from listing_delete_attempts where id = $1 and status in ('queued','failed') for update`,
      [attemptId],
    );
    const row = result.rows[0];
    if (!row) throw new ListingWorkbenchError("Delete attempt is no longer runnable.", 409);
    await assertListingShopAccess(Number(row.organization_id), Number(row.shop_id), client);
    await client.query(
      `update listing_delete_attempts set status = 'running', error = null,
       started_at = coalesce(started_at, now()), updated_at = now() where id = $1`,
      [attemptId],
    );
    await client.query("commit");
    return {
      draftId: row.draft_id ? Number(row.draft_id) : null,
      listingId: Number(row.listing_id),
      organizationId: Number(row.organization_id),
      shopId: Number(row.shop_id),
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function completeListingDeleteAttempt(attemptId: number, work: Awaited<ReturnType<typeof startListingDeleteAttempt>>, pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`delete from etsy_listings where shop_id = $1 and listing_id = $2`, [work.shopId, work.listingId]);
    await client.query(
      `update listing_drafts set deleted_at = now(), status = 'archived', updated_at = now()
       where organization_id = $1 and shop_id = $2 and (id = $3 or listing_id = $4) and deleted_at is null`,
      [work.organizationId, work.shopId, work.draftId, work.listingId],
    );
    await client.query(
      `delete from listing_draft_media media using listing_drafts draft
       where media.draft_id = draft.id and draft.organization_id = $1 and draft.shop_id = $2 and draft.deleted_at is not null
         and (draft.id = $3 or draft.listing_id = $4)`,
      [work.organizationId, work.shopId, work.draftId, work.listingId],
    );
    await client.query(
      `update listing_delete_attempts set status = 'succeeded', error = null,
       finished_at = now(), updated_at = now() where id = $1`,
      [attemptId],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function failListingDeleteAttempt(attemptId: number, error: unknown, pool: Pool) {
  const message = error instanceof Error ? error.message.slice(0, 2000) : "Listing deletion failed.";
  await pool.query(
    `update listing_delete_attempts set status = 'failed', error = $2,
     finished_at = now(), updated_at = now() where id = $1`,
    [attemptId, message],
  );
}

export async function processListingDeleteAttempt(attemptId: number, client: EtsyClient) {
  const pool = requirePool();
  await ensureListingWorkbenchSchema(pool);
  const work = await startListingDeleteAttempt(attemptId, pool);
  try {
    await client.deleteListing(work.listingId);
    await completeListingDeleteAttempt(attemptId, work, pool);
  } catch (error) {
    await failListingDeleteAttempt(attemptId, error, pool);
    throw error;
  }
}

import type { Pool, PoolClient } from "pg";
import { getPool } from "@/server/db";
import { ensureSyncSchema } from "@/features/sync/db";
import {
  applyListingPatch,
  blankListingValues,
  listingImageUrlFromSource,
  listingValuesFromSource,
  parseListingPatch,
  sourceVersionForListing,
  validateListingValues,
} from "@/features/products/listing-workbench-model";
import type { EtsyListingImage, EtsyListingSummary } from "@/shared/types/etsy";
import type {
  ListingDraftPatch,
  ListingDraftValues,
  ListingImageOrderItem,
  ListingLifecycle,
  ListingPublishState,
  ListingRowsPage,
  ListingSavedView,
  ListingSavedViewDefinition,
  ListingShopDefaults,
  ListingSort,
  ListingValidationErrors,
  ListingViewFilter,
  ListingWorkspaceImage,
  ListingWorkspaceRow,
} from "@/shared/types/listing-workbench";

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

const schemaPromises = new WeakMap<Pool, Promise<void>>();
const STALE_LISTING_PUBLISH_MINUTES = 15;
const STALE_LISTING_PUBLISH_ERROR = `Publish job expired after waiting ${STALE_LISTING_PUBLISH_MINUTES} minutes without being started.`;

type WorkbenchRowRecord = {
  attempt_error: string | null;
  attempt_id: string | number | null;
  attempt_status: string | null;
  draft_id: string | number | null;
  draft_kind: "existing" | "new" | null;
  draft_status: string | null;
  draft_updated_at: Date | string | null;
  draft_version: number | null;
  job_id: string | number | null;
  job_status: string | null;
  image_order: ListingImageOrderItem[] | null;
  listing_id: string | number | null;
  patch: ListingDraftPatch | null;
  page_row_id?: string | number;
  page_sort_value?: Date | string | number;
  source_data: EtsyListingSummary | null;
  source_synced_at: Date | string | null;
  source_version: string | null;
  validation_errors: ListingValidationErrors | null;
};

type ListingDraftMediaRecord = {
  alt_text: string;
  byte_size: number;
  content_type: string;
  created_at: Date | string;
  data?: Buffer;
  draft_id: string | number;
  filename: string;
  id: string | number;
  position: number;
  uploaded_at: Date | string | null;
  uploaded_image_id: string | number | null;
  uploaded_listing_id: string | number | null;
};

export class ListingWorkbenchError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ListingWorkbenchError";
    this.status = status;
  }
}

function requirePool() {
  const pool = getPool();
  if (!pool) throw new ListingWorkbenchError("PostgreSQL DATABASE_URL is required for Listing Workbench.", 503);
  return pool;
}

function numericId(value: string | number | null | undefined) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toIso(value: Date | string | null | undefined) {
  if (!value) return new Date(0).toISOString();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function backfillMissingSourceVersions(pool: Pool) {
  while (true) {
    const missing = await pool.query<{ shop_id: string | number; listing_id: string | number; data: EtsyListingSummary }>(
      `select shop_id, listing_id, data
       from etsy_listings
       where source_version is null
       order by shop_id, listing_id
       limit 500`,
    );
    if (!missing.rows.length) return;

    const params: unknown[] = [];
    const tuples = missing.rows.map((row, index) => {
      const offset = index * 3;
      params.push(row.shop_id, row.listing_id, sourceVersionForListing(row.data));
      return `($${offset + 1}::bigint, $${offset + 2}::bigint, $${offset + 3}::text)`;
    });
    await pool.query(
      `update etsy_listings as listing
       set source_version = source.version
       from (values ${tuples.join(", ")}) as source(shop_id, listing_id, version)
       where listing.shop_id = source.shop_id
         and listing.listing_id = source.listing_id
         and listing.source_version is null`,
      params,
    );
  }
}

export async function ensureListingWorkbenchSchema(pool: Pool = requirePool()) {
  const existing = schemaPromises.get(pool);
  if (existing) return existing;

  const preparation = (async () => {
    await ensureSyncSchema(pool);
    await pool.query("select 1 from listing_drafts limit 0");
    await pool.query("select 1 from listing_draft_media limit 0");
    await backfillMissingSourceVersions(pool);
  })();
  schemaPromises.set(pool, preparation);
  try {
    await preparation;
  } catch (error) {
    schemaPromises.delete(pool);
    throw error;
  }
}

export async function closeStaleListingPublishAttempts(input: {
  organizationId: number;
  shopId?: number;
}, pool: Pool = requirePool()) {
  await ensureListingWorkbenchSchema(pool);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const stale = await client.query<{ attempt_id: string; draft_id: string; job_id: string }>(
      `select attempt.id as attempt_id, attempt.draft_id, job.id as job_id
       from listing_publish_attempts attempt
       join etsy_sync_jobs job on job.id = attempt.job_id
       where attempt.organization_id = $1
         and ($2::bigint is null or attempt.shop_id = $2)
         and attempt.status = 'queued'
         and job.job_type = 'publish_listing_draft'
         and job.status = 'queued'
         and job.attempts = 0
         and job.created_at < now() - ($3 || ' minutes')::interval
       for update of attempt, job skip locked`,
      [input.organizationId, input.shopId ?? null, STALE_LISTING_PUBLISH_MINUTES],
    );
    if (!stale.rows.length) {
      await client.query("commit");
      return 0;
    }
    const jobIds = stale.rows.map((row) => Number(row.job_id));
    const attemptIds = stale.rows.map((row) => Number(row.attempt_id));
    const draftIds = stale.rows.map((row) => Number(row.draft_id));
    await client.query(
      `update etsy_sync_jobs
       set status = 'failed', error = $2, finished_at = now(), locked_at = null, updated_at = now()
       where id = any($1::bigint[]) and status = 'queued' and attempts = 0`,
      [jobIds, STALE_LISTING_PUBLISH_ERROR],
    );
    await client.query(
      `update listing_publish_attempts
       set status = 'failed', error = $2, finished_at = now(), updated_at = now()
       where id = any($1::bigint[]) and status = 'queued'`,
      [attemptIds, STALE_LISTING_PUBLISH_ERROR],
    );
    await client.query(
      `update listing_drafts
       set status = 'failed', updated_at = now()
       where id = any($1::bigint[]) and status = 'queued'`,
      [draftIds],
    );
    await client.query("commit");
    return stale.rows.length;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function claimLegacyShopsForOrganization(organizationId: number, pool: Pool = requirePool()) {
  await ensureListingWorkbenchSchema(pool);
  await pool.query(
    `update etsy_shops
     set organization_id = $1, updated_at = now()
     where organization_id is null
       and (select count(*) from organizations where deleted_at is null and status = 'active') = 1
       and (select id from organizations where deleted_at is null and status = 'active' limit 1) = $1`,
    [organizationId],
  );
}

export async function assertListingShopAccess(
  organizationId: number,
  shopId: number,
  queryable: Queryable = requirePool(),
) {
  const result = await queryable.query(
    `select shop_id from etsy_shops where shop_id = $1 and organization_id = $2 and active = true limit 1`,
    [shopId, organizationId],
  );
  if (!result.rows[0]) throw new ListingWorkbenchError("Shop not found.", 404);
}

export async function assertListingSourceAccess(
  organizationId: number,
  shopId: number,
  listingId: number,
  queryable: Queryable = requirePool(),
) {
  await assertListingShopAccess(organizationId, shopId, queryable);
  const result = await queryable.query(
    `select 1
     where exists (select 1 from etsy_listings where shop_id = $1 and listing_id = $2)
        or exists (
          select 1 from listing_drafts
          where organization_id = $3 and shop_id = $1 and listing_id = $2 and deleted_at is null
        )`,
    [shopId, listingId, organizationId],
  );
  if (!result.rows[0]) throw new ListingWorkbenchError("Listing not found.", 404);
}

function skuSummary(values: ListingDraftValues) {
  if (!values.inventory?.sku_on_property?.length) return values.sku;
  const skus = Array.from(
    new Set((values.inventory?.products ?? []).map((product) => product.sku?.trim()).filter(Boolean) as string[]),
  );
  if (!skus.length) return values.sku;
  if (skus.length <= 2) return skus.join(" / ");
  return `${skus.slice(0, 2).join(" / ")} +${skus.length - 2}`;
}

function publishState(row: WorkbenchRowRecord): ListingPublishState {
  const attemptId = numericId(row.attempt_id);
  if (!attemptId) return null;
  let status = row.attempt_status;
  if (row.job_status === "running") status = "running";
  if (row.job_status === "queued" && status !== "conflict") status = "queued";
  if (row.job_status === "failed" && status !== "conflict" && status !== "succeeded") status = "failed";
  if (row.job_status === "completed" && status !== "succeeded") status = row.attempt_status;
  if (!status || !["queued", "running", "succeeded", "failed", "conflict"].includes(status)) return null;
  return {
    attemptId,
    error: row.attempt_error,
    jobId: numericId(row.job_id),
    status: status as NonNullable<ListingPublishState>["status"],
  };
}

function lifecycleForRow(
  row: WorkbenchRowRecord,
  errors: ListingValidationErrors,
  publish: ListingPublishState,
): ListingLifecycle {
  if (row.draft_status === "conflict" || publish?.status === "conflict") return "conflict";
  if (publish?.status === "running" || row.draft_status === "publishing") return "publishing";
  if (publish?.status === "queued" || row.draft_status === "queued") return "queued";
  if (publish?.status === "failed" || row.draft_status === "failed") return "failed";
  if (Object.keys(errors).length) return "invalid";
  if (row.draft_id) return row.draft_kind === "new" ? "draft" : "changed";
  return "live";
}

function listingImages(source: EtsyListingSummary | null): ListingWorkspaceImage[] {
  if (!source) return [];
  const images: EtsyListingImage[] = source.images?.length
    ? source.images
    : [source.main_image, source.MainImage, source.image].filter((image): image is EtsyListingImage => Boolean(image));
  const seen = new Set<string>();
  return images.flatMap((image) => {
    const url = image.url_570xN || image.url_fullxfull || image.url_170x135 || image.url_75x75 || image.image_url || "";
    const id = numericId(image.listing_image_id ?? image.image_id);
    const key = `${id ?? "url"}:${url}`;
    if (!url || seen.has(key)) return [];
    seen.add(key);
    return [{ altText: image.alt_text ?? "", id, rank: numericId(image.rank), source: "etsy" as const, url }];
  });
}

function orderedListingImages(
  images: ListingWorkspaceImage[],
  order: ListingImageOrderItem[] | null,
) {
  if (!order?.length) return images;
  const byId = new Map(images.flatMap((image) => image.id ? [[image.id, image] as const] : []));
  const ordered = order.flatMap((item) => {
    const image = byId.get(item.id);
    if (!image) return [];
    byId.delete(item.id);
    return [image];
  });
  return [...ordered, ...images.filter((image) => !image.id || byId.has(image.id))];
}

function draftMediaImages(records: ListingDraftMediaRecord[]): ListingWorkspaceImage[] {
  return records.map((record) => ({
    altText: record.alt_text ?? "",
    id: Number(record.id),
    rank: record.position + 1,
    source: "draft" as const,
    url: `/api/listing-workbench/media?draftId=${record.draft_id}&mediaId=${record.id}`,
  }));
}

async function draftMediaByDraftIds(queryable: Queryable, draftIds: number[]) {
  const uniqueIds = Array.from(new Set(draftIds.filter((id) => Number.isSafeInteger(id) && id > 0)));
  const grouped = new Map<number, ListingDraftMediaRecord[]>();
  if (!uniqueIds.length) return grouped;
  const result = await queryable.query<ListingDraftMediaRecord>(
    `select id, draft_id, filename, content_type, byte_size, alt_text, position,
            uploaded_listing_id, uploaded_image_id, uploaded_at, created_at
     from listing_draft_media
     where draft_id = any($1::bigint[])
     order by draft_id, position, id`,
    [uniqueIds],
  );
  for (const record of result.rows) {
    const draftId = Number(record.draft_id);
    grouped.set(draftId, [...(grouped.get(draftId) ?? []), record]);
  }
  return grouped;
}

function mapWorkspaceRow(row: WorkbenchRowRecord, draftMedia: ListingDraftMediaRecord[] = []): ListingWorkspaceRow {
  const source = row.source_data;
  const baseValues = source ? listingValuesFromSource(source) : blankListingValues();
  const patch = row.patch ?? {};
  const values = applyListingPatch(baseValues, patch);
  const products = values.inventory?.products ?? [];
  const publish = publishState(row);
  const validationErrors = row.validation_errors ?? {};
  const draftId = numericId(row.draft_id);
  const listingId = numericId(row.listing_id);
  const sourceImages = orderedListingImages(listingImages(source), row.image_order);
  const stagedImages = draftMediaImages(draftMedia);
  const images = [...sourceImages, ...stagedImages];
  return {
    dirtyFields: Object.keys(patch) as Array<keyof ListingDraftValues>,
    draftId,
    draftVersion: row.draft_version,
    hasVariations: Boolean(source?.has_variations) || products.length > 1,
    imageUrl: images[0]?.url ?? (source ? listingImageUrlFromSource(source) : ""),
    images,
    kind: row.draft_kind === "new" || !listingId ? "new" : "existing",
    lifecycle: lifecycleForRow(row, validationErrors, publish),
    listingId,
    publish,
    rowId: listingId ? `listing:${listingId}` : `draft:${draftId}`,
    skuSummary: skuSummary(values),
    sourceVersion: row.source_version ?? (source ? sourceVersionForListing(source) : null),
    updatedAt: toIso(row.draft_updated_at ?? row.source_synced_at),
    validationErrors,
    values,
    variantCount: products.length,
  };
}

function safeView(value?: string | null): ListingViewFilter {
  if (["changed", "attention", "failed", "inactive"].includes(value ?? "")) return "changed";
  return "all";
}

function safeSort(value?: string | null): ListingSort {
  return ["updated_desc", "title_asc", "price_desc", "quantity_asc"].includes(value ?? "")
    ? (value as ListingSort)
    : "updated_desc";
}

const selectWorkspaceRowsSql = `
  with source_rows as (
    select
      listing.listing_id,
      listing.data as source_data,
      listing.source_version,
      listing.synced_at as source_synced_at,
      listing.price_amount,
      listing.quantity as source_quantity,
      draft.id as draft_id,
      draft.draft_kind,
      draft.status as draft_status,
      draft.patch,
      draft.image_order,
      draft.validation_errors,
      draft.version as draft_version,
      draft.updated_at as draft_updated_at,
      attempt.id as attempt_id,
      attempt.status as attempt_status,
      attempt.error as attempt_error,
      attempt.job_id,
      job.status as job_status
    from etsy_listings listing
    left join listing_drafts draft
      on draft.organization_id = $1
     and draft.shop_id = listing.shop_id
     and draft.listing_id = listing.listing_id
     and draft.deleted_at is null
    left join lateral (
      select candidate.*
      from listing_publish_attempts candidate
      where candidate.draft_id = draft.id
      order by candidate.created_at desc, candidate.id desc
      limit 1
    ) attempt on true
    left join etsy_sync_jobs job on job.id = attempt.job_id
    where listing.shop_id = $2
  ),
  new_rows as (
    select
      draft.listing_id,
      null::jsonb as source_data,
      null::text as source_version,
      draft.created_at as source_synced_at,
      null::numeric as price_amount,
      null::integer as source_quantity,
      draft.id as draft_id,
      draft.draft_kind,
      draft.status as draft_status,
      draft.patch,
      draft.image_order,
      draft.validation_errors,
      draft.version as draft_version,
      draft.updated_at as draft_updated_at,
      attempt.id as attempt_id,
      attempt.status as attempt_status,
      attempt.error as attempt_error,
      attempt.job_id,
      job.status as job_status
    from listing_drafts draft
    left join lateral (
      select candidate.*
      from listing_publish_attempts candidate
      where candidate.draft_id = draft.id
      order by candidate.created_at desc, candidate.id desc
      limit 1
    ) attempt on true
    left join etsy_sync_jobs job on job.id = attempt.job_id
    where draft.organization_id = $1
      and draft.shop_id = $2
      and draft.draft_kind = 'new'
      and not exists (
        select 1 from etsy_listings listing
        where listing.shop_id = draft.shop_id and listing.listing_id = draft.listing_id
      )
      and draft.deleted_at is null
  ),
  workspace_rows as (
    select * from source_rows
    union all
    select * from new_rows
  )
`;

function sortExpression(sort: ListingSort) {
  if (sort === "title_asc") return `lower(coalesce(patch->>'title', source_data->>'title', ''))`;
  if (sort === "price_desc") return `coalesce((patch#>>'{price,amount}')::numeric, price_amount, 0)`;
  if (sort === "quantity_asc") return `coalesce((patch->>'quantity')::integer, source_quantity, 0)`;
  return `coalesce(draft_updated_at, source_synced_at)`;
}

function cursorProjection(sort: ListingSort) {
  const expression = sortExpression(sort);
  return sort === "updated_desc"
    ? `to_char(${expression} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
    : expression;
}

const pageRowIdExpression = `case when listing_id is not null then listing_id * 2 else draft_id * 2 + 1 end`;

function orderClause(sort: ListingSort) {
  const direction = sort === "title_asc" || sort === "quantity_asc" ? "asc" : "desc";
  return `${sortExpression(sort)} ${direction}, ${pageRowIdExpression} desc`;
}

function cursorClause(sort: ListingSort) {
  const expression = sortExpression(sort);
  const value = sort === "updated_desc"
    ? "$6::timestamptz"
    : sort === "price_desc"
      ? "$6::numeric"
      : sort === "quantity_asc"
        ? "$6::integer"
        : "$6::text";
  const comparison = sort === "title_asc" || sort === "quantity_asc" ? ">" : "<";
  return `(${value} is null or ${expression} ${comparison} ${value} or (${expression} = ${value} and ${pageRowIdExpression} < $7::bigint))`;
}

function decodeRowsCursor(cursor: string | null | undefined, sort: ListingSort) {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { id?: unknown; sort?: unknown; value?: unknown };
    const id = Number(value.id);
    if (value.sort !== sort || !Number.isSafeInteger(id) || id <= 0 || typeof value.value !== "string" || value.value.length > 500) return null;
    if (sort === "updated_desc" && !Number.isFinite(new Date(value.value).getTime())) return null;
    if ((sort === "price_desc" || sort === "quantity_asc") && !Number.isFinite(Number(value.value))) return null;
    return { id, value: value.value };
  } catch {
    return null;
  }
}

function encodeRowsCursor(row: WorkbenchRowRecord, sort: ListingSort) {
  const id = numericId(row.page_row_id);
  if (!id || row.page_sort_value === null || row.page_sort_value === undefined) return null;
  const value = row.page_sort_value instanceof Date ? row.page_sort_value.toISOString() : String(row.page_sort_value);
  return Buffer.from(JSON.stringify({ id, sort, value }), "utf8").toString("base64url");
}

export async function listListingWorkspaceRows(input: {
  cursor?: string | null;
  limit?: number;
  organizationId: number;
  search?: string | null;
  shopId: number;
  sort?: string | null;
  state?: string | null;
  view?: string | null;
}): Promise<ListingRowsPage> {
  const pool = requirePool();
  await ensureListingWorkbenchSchema(pool);
  await closeStaleListingPublishAttempts({ organizationId: input.organizationId, shopId: input.shopId }, pool);
  await claimLegacyShopsForOrganization(input.organizationId, pool);
  await assertListingShopAccess(input.organizationId, input.shopId, pool);
  const limit = Math.max(1, Math.min(100, input.limit ?? 100));
  const search = input.search?.trim().toLowerCase() ?? "";
  const state = input.state?.trim().toLowerCase().slice(0, 64) ?? "";
  const view = safeView(input.view);
  const sort = safeSort(input.sort);
  const cursor = decodeRowsCursor(input.cursor, sort);
  const result = await pool.query<WorkbenchRowRecord>(
    `${selectWorkspaceRowsSql}
      select *, ${cursorProjection(sort)} as page_sort_value, ${pageRowIdExpression} as page_row_id
      from workspace_rows
      where (
        $3 = ''
        or lower(coalesce(patch->>'title', source_data->>'title', '')) like '%' || $3 || '%'
        or lower(coalesce(patch->>'sku', source_data->>'sku', '')) like '%' || $3 || '%'
        or coalesce(listing_id::text, '') = $3
      )
      and (
        ($4 = 'all' and (source_data is not null or listing_id is not null))
        or ($4 = 'changed' and source_data is null and draft_id is not null
          and draft_kind = 'new' and listing_id is null)
      )
      and ($8 = '' or coalesce(source_data->>'state', '') = $8)
      and ${cursorClause(sort)}
      order by ${orderClause(sort)}
      limit $5`,
    [input.organizationId, input.shopId, search, view, limit + 1, cursor?.value ?? null, cursor?.id ?? null, state],
  );
  const statesResult = await pool.query<{ state: string }>(
    `select distinct lower(data->>'state') as state
     from etsy_listings
     where shop_id = $1 and coalesce(data->>'state', '') <> ''
     order by state`,
    [input.shopId],
  );
  const hasMore = result.rows.length > limit;
  const pageRows = result.rows.slice(0, limit);
  const draftMedia = await draftMediaByDraftIds(
    pool,
    pageRows.map((row) => numericId(row.draft_id)).filter((id): id is number => id !== null),
  );
  const rows = pageRows.map((row) => {
    const draftId = numericId(row.draft_id);
    return mapWorkspaceRow(row, draftId ? draftMedia.get(draftId) : undefined);
  });
  return {
    hasMore,
    nextCursor: hasMore ? encodeRowsCursor(pageRows[pageRows.length - 1], sort) : null,
    rows,
    states: statesResult.rows.map((row) => row.state),
  };
}

async function getDraftRecord(draftId: number, organizationId: number, queryable: Queryable) {
  const result = await queryable.query(
    `select * from listing_drafts where id = $1 and organization_id = $2 and deleted_at is null limit 1 for update`,
    [draftId, organizationId],
  );
  return result.rows[0] as {
    base_snapshot: ListingDraftValues;
    base_source_version: string | null;
    draft_kind: "existing" | "new";
    id: string | number;
    image_order: ListingImageOrderItem[];
    listing_id: string | number | null;
    patch: ListingDraftPatch;
    shop_id: string | number;
    status: string;
    validation_errors: ListingValidationErrors;
    version: number;
  } | undefined;
}

export async function getListingDraftShopId(draftId: number, organizationId: number) {
  const pool = requirePool();
  await ensureListingWorkbenchSchema(pool);
  const result = await pool.query<{ shop_id: string }>(
    `select shop_id::text as shop_id
     from listing_drafts
     where id = $1 and organization_id = $2 and deleted_at is null
     limit 1`,
    [draftId, organizationId],
  );
  const shopId = Number(result.rows[0]?.shop_id);
  if (!Number.isSafeInteger(shopId) || shopId <= 0) throw new ListingWorkbenchError("Draft not found.", 404);
  return shopId;
}

export async function createListingDraftMedia(input: {
  altText?: string;
  contentType: string;
  data: Buffer;
  draftId: number;
  filename: string;
  organizationId: number;
  shopId: number;
  userId: number;
}) {
  const pool = requirePool();
  await ensureListingWorkbenchSchema(pool);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const draft = await getDraftRecord(input.draftId, input.organizationId, client);
    if (!draft || Number(draft.shop_id) !== input.shopId) throw new ListingWorkbenchError("Draft not found.", 404);
    if (draft.draft_kind !== "new" || draft.listing_id) {
      throw new ListingWorkbenchError("Only new local drafts can stage images before Etsy creation.", 409);
    }
    if (["queued", "publishing"].includes(draft.status)) {
      throw new ListingWorkbenchError("Publishing drafts cannot change images.", 409);
    }
    const usage = await client.query<{ count: string; total: string }>(
      `select count(*)::text as count, coalesce(sum(byte_size), 0)::text as total
       from listing_draft_media where draft_id = $1`,
      [input.draftId],
    );
    if (Number(usage.rows[0]?.count ?? 0) >= 10) {
      throw new ListingWorkbenchError("A Listing can have at most 10 staged images.", 409);
    }
    if (Number(usage.rows[0]?.total ?? 0) + input.data.byteLength > 100 * 1024 * 1024) {
      throw new ListingWorkbenchError("Staged images can use at most 100 MB per Listing.", 413);
    }
    const position = await client.query<{ next_position: number }>(
      `select coalesce(max(position), -1) + 1 as next_position from listing_draft_media where draft_id = $1`,
      [input.draftId],
    );
    const inserted = await client.query<ListingDraftMediaRecord>(
      `insert into listing_draft_media (
         organization_id, shop_id, draft_id, filename, content_type, byte_size,
         data, alt_text, position, created_by_user_id
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       returning id, draft_id, filename, content_type, byte_size, alt_text, position,
                 uploaded_listing_id, uploaded_image_id, uploaded_at, created_at`,
      [
        input.organizationId,
        input.shopId,
        input.draftId,
        input.filename.slice(0, 240),
        input.contentType,
        input.data.byteLength,
        input.data,
        (input.altText ?? "").trim().slice(0, 500),
        Number(position.rows[0]?.next_position ?? 0),
        input.userId,
      ],
    );
    await client.query(`update listing_drafts set updated_at = now() where id = $1`, [input.draftId]);
    await client.query("commit");
    return draftMediaImages(inserted.rows)[0];
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function getListingDraftMedia(input: {
  draftId: number;
  mediaId: number;
  organizationId: number;
}) {
  const pool = requirePool();
  await ensureListingWorkbenchSchema(pool);
  const result = await pool.query<ListingDraftMediaRecord>(
    `select media.id, media.draft_id, media.filename, media.content_type, media.byte_size, media.alt_text,
            media.position, media.data, media.uploaded_listing_id, media.uploaded_image_id,
            media.uploaded_at, media.created_at
     from listing_draft_media media
     join listing_drafts draft on draft.id = media.draft_id
     where media.id = $1 and media.draft_id = $2
       and draft.organization_id = $3 and draft.deleted_at is null
     limit 1`,
    [input.mediaId, input.draftId, input.organizationId],
  );
  const media = result.rows[0];
  if (!media?.data) throw new ListingWorkbenchError("Draft image not found.", 404);
  return {
    contentType: media.content_type,
    data: media.data,
    filename: media.filename,
    size: Number(media.byte_size),
  };
}

export async function updateListingDraftMediaAltText(input: {
  altText: string;
  draftId: number;
  mediaId: number;
  organizationId: number;
  shopId: number;
}) {
  const altText = input.altText.trim();
  if (altText.length > 500) throw new ListingWorkbenchError("Image alt text must be 500 characters or fewer.");
  const pool = requirePool();
  await ensureListingWorkbenchSchema(pool);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const draft = await getDraftRecord(input.draftId, input.organizationId, client);
    if (!draft || Number(draft.shop_id) !== input.shopId) throw new ListingWorkbenchError("Draft not found.", 404);
    if (["queued", "publishing"].includes(draft.status)) {
      throw new ListingWorkbenchError("Publishing drafts cannot change image alt text.", 409);
    }
    const updated = await client.query<ListingDraftMediaRecord>(
      `update listing_draft_media
       set alt_text = $5
       where id = $1 and draft_id = $2 and organization_id = $3 and shop_id = $4
       returning id, draft_id, filename, content_type, byte_size, alt_text, position,
                 uploaded_listing_id, uploaded_image_id, uploaded_at, created_at`,
      [input.mediaId, input.draftId, input.organizationId, input.shopId, altText],
    );
    if (!updated.rows[0]) throw new ListingWorkbenchError("Draft image not found.", 404);
    await client.query(`update listing_drafts set updated_at = now() where id = $1`, [input.draftId]);
    await client.query("commit");
    return draftMediaImages(updated.rows)[0];
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function reorderListingDraftMedia(input: {
  draftId: number;
  mediaIds: number[];
  organizationId: number;
  shopId: number;
}) {
  const mediaIds = input.mediaIds.filter((id) => Number.isSafeInteger(id) && id > 0);
  if (!mediaIds.length || mediaIds.length > 10 || new Set(mediaIds).size !== mediaIds.length) {
    throw new ListingWorkbenchError("A valid unique image order is required.");
  }
  const pool = requirePool();
  await ensureListingWorkbenchSchema(pool);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const draft = await getDraftRecord(input.draftId, input.organizationId, client);
    if (!draft || Number(draft.shop_id) !== input.shopId) throw new ListingWorkbenchError("Draft not found.", 404);
    if (["queued", "publishing"].includes(draft.status)) {
      throw new ListingWorkbenchError("Publishing drafts cannot reorder images.", 409);
    }
    const current = await client.query<{ id: string }>(
      `select id::text as id from listing_draft_media
       where draft_id = $1 and organization_id = $2 and shop_id = $3
       order by position, id for update`,
      [input.draftId, input.organizationId, input.shopId],
    );
    const currentIds = current.rows.map((row) => Number(row.id));
    if (currentIds.length !== mediaIds.length || currentIds.some((id) => !mediaIds.includes(id))) {
      throw new ListingWorkbenchError("Image order changed. Reload and retry.", 409);
    }
    await client.query(
      `update listing_draft_media media
       set position = ordered.position
       from (
         select id, ordinality::integer - 1 as position
         from unnest($2::bigint[]) with ordinality as requested(id, ordinality)
       ) ordered
       where media.draft_id = $1 and media.id = ordered.id`,
      [input.draftId, mediaIds],
    );
    await client.query(`update listing_drafts set updated_at = now() where id = $1`, [input.draftId]);
    const updated = await client.query<ListingDraftMediaRecord>(
      `select id, draft_id, filename, content_type, byte_size, alt_text, position,
              uploaded_listing_id, uploaded_image_id, uploaded_at, created_at
       from listing_draft_media where draft_id = $1 order by position, id`,
      [input.draftId],
    );
    await client.query("commit");
    return draftMediaImages(updated.rows);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function saveListingImageOrderDraft(input: {
  images: ListingImageOrderItem[];
  listingId: number;
  organizationId: number;
  shopId: number;
  userId: number;
}) {
  const images = input.images.map((image) => ({
    altText: image.altText.trim().slice(0, 500),
    id: Number(image.id),
  }));
  if (!images.length || images.length > 20 || images.some((image) => !Number.isSafeInteger(image.id) || image.id <= 0)) {
    throw new ListingWorkbenchError("A valid Listing image order is required.");
  }
  if (new Set(images.map((image) => image.id)).size !== images.length) {
    throw new ListingWorkbenchError("Listing image order must contain unique images.");
  }
  const pool = requirePool();
  await ensureListingWorkbenchSchema(pool);
  const client = await pool.connect();
  let draftId: number;
  try {
    await client.query("begin");
    await assertListingShopAccess(input.organizationId, input.shopId, client);
    const sourceResult = await client.query<{ data: EtsyListingSummary; source_version: string | null }>(
      `select data, source_version from etsy_listings
       where shop_id = $1 and listing_id = $2 limit 1 for update`,
      [input.shopId, input.listingId],
    );
    const source = sourceResult.rows[0];
    if (!source) throw new ListingWorkbenchError("Listing not found.", 404);
    const sourceIds = listingImages(source.data).flatMap((image) => image.id ? [image.id] : []);
    if (sourceIds.length !== images.length || sourceIds.some((id) => !images.some((image) => image.id === id))) {
      throw new ListingWorkbenchError("Image order changed. Reload and retry.", 409);
    }
    const existing = await client.query(
      `select * from listing_drafts
       where organization_id = $1 and shop_id = $2 and listing_id = $3 and deleted_at is null
       limit 1 for update`,
      [input.organizationId, input.shopId, input.listingId],
    );
    const draft = existing.rows[0];
    if (draft && ["queued", "publishing"].includes(draft.status)) {
      throw new ListingWorkbenchError("Publishing drafts cannot reorder images.", 409);
    }
    if (draft) {
      const updated = await client.query<{ id: string }>(
        `update listing_drafts
         set image_order = $2::jsonb,
             status = case when validation_errors = '{}'::jsonb then 'draft' else 'invalid' end,
             version = version + 1,
             updated_at = now()
         where id = $1
         returning id`,
        [draft.id, JSON.stringify(images)],
      );
      draftId = Number(updated.rows[0].id);
    } else {
      const baseValues = listingValuesFromSource(source.data);
      const inserted = await client.query<{ id: string }>(
        `insert into listing_drafts (
           organization_id, shop_id, listing_id, draft_kind, status, base_source_version,
           base_snapshot, patch, image_order, validation_errors, created_by_user_id
         ) values ($1,$2,$3,'existing','draft',$4,$5::jsonb,'{}'::jsonb,$6::jsonb,'{}'::jsonb,$7)
         returning id`,
        [
          input.organizationId,
          input.shopId,
          input.listingId,
          source.source_version ?? sourceVersionForListing(source.data),
          JSON.stringify(baseValues),
          JSON.stringify(images),
          input.userId,
        ],
      );
      draftId = Number(inserted.rows[0].id);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
  return workspaceRowForDraft(draftId, input.organizationId, pool);
}

export async function deleteListingDraftMedia(input: {
  draftId: number;
  mediaId: number;
  organizationId: number;
  shopId: number;
}) {
  const pool = requirePool();
  await ensureListingWorkbenchSchema(pool);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const draft = await getDraftRecord(input.draftId, input.organizationId, client);
    if (!draft || Number(draft.shop_id) !== input.shopId) throw new ListingWorkbenchError("Draft not found.", 404);
    if (["queued", "publishing"].includes(draft.status)) {
      throw new ListingWorkbenchError("Publishing drafts cannot change images.", 409);
    }
    const removed = await client.query(
      `delete from listing_draft_media
       where id = $1 and draft_id = $2 and organization_id = $3 and shop_id = $4
       returning id`,
      [input.mediaId, input.draftId, input.organizationId, input.shopId],
    );
    if (!removed.rows[0]) throw new ListingWorkbenchError("Draft image not found.", 404);
    await client.query(`update listing_drafts set updated_at = now() where id = $1`, [input.draftId]);
    await client.query("commit");
    return { deleted: true };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function listPendingListingDraftMedia(draftId: number) {
  const pool = requirePool();
  await ensureListingWorkbenchSchema(pool);
  const result = await pool.query<ListingDraftMediaRecord>(
    `select id, draft_id, filename, content_type, byte_size, data, alt_text, position,
            uploaded_listing_id, uploaded_image_id, uploaded_at, created_at
     from listing_draft_media
     where draft_id = $1
     order by position, id`,
    [draftId],
  );
  return result.rows.map((record) => ({
    altText: record.alt_text ?? "",
    contentType: record.content_type,
    data: record.data ?? Buffer.alloc(0),
    filename: record.filename,
    id: Number(record.id),
    uploadedAt: record.uploaded_at ? toIso(record.uploaded_at) : null,
    uploadedImageId: numericId(record.uploaded_image_id),
    uploadedListingId: numericId(record.uploaded_listing_id),
  }));
}

export async function markListingDraftMediaUploaded(input: {
  draftId: number;
  listingId: number;
  mediaId: number;
  uploadedImageId: number | null;
}) {
  const pool = requirePool();
  await ensureListingWorkbenchSchema(pool);
  await pool.query(
    `update listing_draft_media
     set uploaded_listing_id = $3, uploaded_image_id = $4, uploaded_at = now()
     where id = $1 and draft_id = $2`,
    [input.mediaId, input.draftId, input.listingId, input.uploadedImageId],
  );
}

async function workspaceRowForDraft(draftId: number, organizationId: number, queryable: Queryable) {
  const result = await queryable.query<WorkbenchRowRecord>(
    `select
      draft.listing_id,
      listing.data as source_data,
      listing.source_version,
      listing.synced_at as source_synced_at,
      draft.id as draft_id,
      draft.draft_kind,
      draft.status as draft_status,
      draft.patch,
      draft.image_order,
      draft.validation_errors,
      draft.version as draft_version,
      draft.updated_at as draft_updated_at,
      attempt.id as attempt_id,
      attempt.status as attempt_status,
      attempt.error as attempt_error,
      attempt.job_id,
      job.status as job_status
    from listing_drafts draft
    left join etsy_listings listing on listing.shop_id = draft.shop_id and listing.listing_id = draft.listing_id
    left join lateral (
      select candidate.* from listing_publish_attempts candidate
      where candidate.draft_id = draft.id order by candidate.created_at desc, candidate.id desc limit 1
    ) attempt on true
    left join etsy_sync_jobs job on job.id = attempt.job_id
    where draft.id = $1 and draft.organization_id = $2 and draft.deleted_at is null
    limit 1`,
    [draftId, organizationId],
  );
  if (!result.rows[0]) throw new ListingWorkbenchError("Draft not found.", 404);
  const draftMedia = await draftMediaByDraftIds(queryable, [draftId]);
  return mapWorkspaceRow(result.rows[0], draftMedia.get(draftId));
}

async function inferredDefaultValuesForShop(shopId: number, queryable: Queryable) {
  const shopResult = await queryable.query(
    `select coalesce(shop_data->>'currency_code', 'USD') as currency from etsy_shops where shop_id = $1 limit 1`,
    [shopId],
  );
  const currency = String(shopResult.rows[0]?.currency || "USD");
  const values = blankListingValues(currency);
  const listingResult = await queryable.query<{ data: EtsyListingSummary }>(
    `select data from etsy_listings where shop_id = $1 order by updated_timestamp desc nulls last, synced_at desc limit 1`,
    [shopId],
  );
  const source = listingResult.rows[0]?.data;
  if (!source) return values;
  const defaults = listingValuesFromSource(source);
  return {
    ...values,
    isSupply: defaults.isSupply,
    price: { amount: values.price?.amount ?? 0, currency: defaults.price?.currency || currency },
    readinessStateId: defaults.readinessStateId,
    returnPolicyId: defaults.returnPolicyId,
    shippingProfileId: defaults.shippingProfileId,
    shopSectionId: defaults.shopSectionId,
    taxonomyId: defaults.taxonomyId,
    type: defaults.type,
    whenMade: defaults.whenMade,
    whoMade: defaults.whoMade,
  } satisfies ListingDraftValues;
}

export async function listingDefaultValuesForShop(
  organizationId: number,
  shopId: number,
  queryable: Queryable,
): Promise<ListingDraftValues> {
  const inferred = await inferredDefaultValuesForShop(shopId, queryable);
  const result = await queryable.query<{ values: ListingDraftPatch }>(
    `select values from listing_shop_defaults where organization_id = $1 and shop_id = $2 limit 1`,
    [organizationId, shopId],
  );
  const saved = result.rows[0]?.values ? parseListingPatch(result.rows[0].values) : {};
  return {
    ...inferred,
    ...saved,
    sku: "",
    title: "",
  } satisfies ListingDraftValues;
}

export async function getListingShopDefaults(input: {
  organizationId: number;
  shopId: number;
}): Promise<ListingShopDefaults> {
  const pool = requirePool();
  await ensureListingWorkbenchSchema(pool);
  await claimLegacyShopsForOrganization(input.organizationId, pool);
  await assertListingShopAccess(input.organizationId, input.shopId, pool);
  const result = await pool.query<{ version: number }>(
    `select version from listing_shop_defaults where organization_id = $1 and shop_id = $2 limit 1`,
    [input.organizationId, input.shopId],
  );
  return {
    values: await listingDefaultValuesForShop(input.organizationId, input.shopId, pool),
    version: Number(result.rows[0]?.version ?? 0),
  };
}

export async function saveListingShopDefaults(input: {
  expectedVersion: number;
  organizationId: number;
  shopId: number;
  userId: number;
  values: unknown;
}): Promise<ListingShopDefaults> {
  const pool = requirePool();
  await ensureListingWorkbenchSchema(pool);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await assertListingShopAccess(input.organizationId, input.shopId, client);
    const current = await client.query<{ version: number }>(
      `select version from listing_shop_defaults where organization_id = $1 and shop_id = $2 for update`,
      [input.organizationId, input.shopId],
    );
    const currentVersion = Number(current.rows[0]?.version ?? 0);
    if (currentVersion !== input.expectedVersion) {
      throw new ListingWorkbenchError("Shop defaults changed. Reload and retry.", 409);
    }
    const patch = parseListingPatch(input.values);
    const inferred = await inferredDefaultValuesForShop(input.shopId, client);
    const values: ListingDraftValues = {
      ...inferred,
      ...patch,
      sku: "",
      title: "",
    };
    const nextVersion = currentVersion + 1;
    await client.query(
      `insert into listing_shop_defaults (organization_id, shop_id, values, version, updated_by_user_id)
       values ($1,$2,$3::jsonb,$4,$5)
       on conflict (organization_id, shop_id) do update set
         values = excluded.values,
         version = excluded.version,
         updated_by_user_id = excluded.updated_by_user_id,
         updated_at = now()`,
      [input.organizationId, input.shopId, JSON.stringify(values), nextVersion, input.userId],
    );
    await client.query("commit");
    return { values, version: nextVersion };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function createListingDraft(input: {
  changes?: unknown;
  listingId?: number | null;
  migrationKey?: string | null;
  organizationId: number;
  shopId: number;
  userId: number;
}) {
  const pool = requirePool();
  await ensureListingWorkbenchSchema(pool);
  await claimLegacyShopsForOrganization(input.organizationId, pool);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await assertListingShopAccess(input.organizationId, input.shopId, client);
    const migrationKey = input.migrationKey?.trim().slice(0, 160) || null;
    if (migrationKey) {
      const migrated = await client.query<{ id: string }>(
        `select id from listing_drafts where organization_id = $1 and shop_id = $2 and migration_key = $3 and deleted_at is null limit 1`,
        [input.organizationId, input.shopId, migrationKey],
      );
      if (migrated.rows[0]) {
        await client.query("commit");
        return workspaceRowForDraft(Number(migrated.rows[0].id), input.organizationId, pool);
      }
    }
    const changes = parseListingPatch(input.changes ?? {});
    let kind: "existing" | "new" = "new";
    let listingId: number | null = null;
    let baseSourceVersion: string | null = null;
    let baseValues = await listingDefaultValuesForShop(input.organizationId, input.shopId, client);
    if (input.listingId) {
      const sourceResult = await client.query<{ data: EtsyListingSummary; source_version: string | null }>(
        `select data, source_version from etsy_listings where shop_id = $1 and listing_id = $2 limit 1`,
        [input.shopId, input.listingId],
      );
      const source = sourceResult.rows[0];
      if (!source) throw new ListingWorkbenchError("Listing not found.", 404);
      kind = "existing";
      listingId = input.listingId;
      baseValues = listingValuesFromSource(source.data);
      baseSourceVersion = source.source_version ?? sourceVersionForListing(source.data);
    }
    const patch = kind === "new" ? { ...baseValues, ...changes } : changes;
    const values = applyListingPatch(baseValues, patch);
    const errors = validateListingValues(values, kind);
    const result = await client.query<{ id: string }>(
      `insert into listing_drafts (
         organization_id, shop_id, listing_id, draft_kind, status, base_source_version,
         base_snapshot, patch, validation_errors, migration_key, created_by_user_id
       ) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11)
       on conflict (organization_id, shop_id, listing_id)
         where listing_id is not null and deleted_at is null
       do nothing
       returning id`,
      [
        input.organizationId,
        input.shopId,
        listingId,
        kind,
        Object.keys(errors).length ? "invalid" : "draft",
        baseSourceVersion,
        JSON.stringify(baseValues),
        JSON.stringify(patch),
        JSON.stringify(errors),
        migrationKey,
        input.userId,
      ],
    );
    if (!result.rows[0]) {
      throw new ListingWorkbenchError("A draft already exists for this Listing. Refresh the row and retry.", 409);
    }
    await client.query("commit");
    return workspaceRowForDraft(Number(result.rows[0].id), input.organizationId, pool);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

function compactExistingPatch(base: ListingDraftValues, patch: ListingDraftPatch) {
  return Object.fromEntries(
    Object.entries(patch).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(base[key as keyof ListingDraftValues])),
  ) as ListingDraftPatch;
}

export async function updateListingDraft(input: {
  changes: unknown;
  draftId: number;
  expectedVersion: number;
  organizationId: number;
}) {
  const pool = requirePool();
  await ensureListingWorkbenchSchema(pool);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const draft = await getDraftRecord(input.draftId, input.organizationId, client);
    if (!draft) throw new ListingWorkbenchError("Draft not found.", 404);
    if (["queued", "publishing"].includes(draft.status)) {
      throw new ListingWorkbenchError("Publishing drafts cannot be edited.", 409);
    }
    if (draft.version !== input.expectedVersion) {
      throw new ListingWorkbenchError("Draft version changed. Refresh this row and retry.", 409);
    }
    const changes = parseListingPatch(input.changes);
    const merged = { ...draft.patch, ...changes };
    const patch = draft.draft_kind === "existing" ? compactExistingPatch(draft.base_snapshot, merged) : merged;
    const values = applyListingPatch(draft.base_snapshot, patch);
    const errors = validateListingValues(values, draft.draft_kind);
    await client.query(
      `update listing_drafts
       set patch = $3::jsonb, validation_errors = $4::jsonb, status = $5,
           version = version + 1, updated_at = now()
       where id = $1 and organization_id = $2`,
      [input.draftId, input.organizationId, JSON.stringify(patch), JSON.stringify(errors), Object.keys(errors).length ? "invalid" : "draft"],
    );
    await client.query("commit");
    return workspaceRowForDraft(input.draftId, input.organizationId, pool);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function discardListingDraft(input: { draftId: number; organizationId: number }) {
  const pool = requirePool();
  await ensureListingWorkbenchSchema(pool);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const draft = await getDraftRecord(input.draftId, input.organizationId, client);
    if (!draft) throw new ListingWorkbenchError("Draft not found.", 404);
    if (["queued", "publishing"].includes(draft.status)) {
      throw new ListingWorkbenchError("A publishing draft cannot be discarded.", 409);
    }
    if (draft.draft_kind === "new" && draft.listing_id) {
      throw new ListingWorkbenchError(
        "An Etsy draft has already been created for this row. Retry publishing or manage that Etsy draft before discarding it.",
        409,
      );
    }
    await client.query(
      `update listing_drafts set deleted_at = now(), status = 'archived', updated_at = now() where id = $1`,
      [input.draftId],
    );
    await client.query(`delete from listing_draft_media where draft_id = $1`, [input.draftId]);
    await client.query("commit");
    return { discarded: true, listingId: numericId(draft.listing_id) };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

const systemViews: ListingSavedView[] = [
  { id: null, name: "全部 Listing", systemKey: "all", definition: { columns: [], density: "comfortable", filter: "all", pinnedColumns: ["lifecycle", "image", "sku"], sort: "updated_desc" } },
];

export async function listListingSavedViews(input: { organizationId: number; shopId: number }) {
  const pool = requirePool();
  await ensureListingWorkbenchSchema(pool);
  const result = await pool.query<{ definition: ListingSavedViewDefinition; id: string; name: string }>(
    `select id, name, definition from listing_saved_views
     where organization_id = $1 and deleted_at is null and (shop_id is null or shop_id = $2)
     order by updated_at desc, id desc`,
    [input.organizationId, input.shopId],
  );
  return [...systemViews, ...result.rows.map((row) => ({ definition: row.definition, id: Number(row.id), name: row.name, systemKey: null }))];
}

export async function saveListingView(input: {
  definition: ListingSavedViewDefinition;
  name: string;
  organizationId: number;
  shopId: number;
  userId: number;
}) {
  const pool = requirePool();
  await ensureListingWorkbenchSchema(pool);
  const name = input.name.trim().slice(0, 80);
  if (!name) throw new ListingWorkbenchError("View name is required.");
  const client = await pool.connect();
  try {
    await client.query("begin");
    await assertListingShopAccess(input.organizationId, input.shopId, client);
    const existing = await client.query<{ id: string }>(
      `select id from listing_saved_views
       where organization_id = $1 and coalesce(shop_id, 0) = $2 and lower(name) = lower($3) and deleted_at is null
       for update limit 1`,
      [input.organizationId, input.shopId, name],
    );
    const result = existing.rows[0]
      ? await client.query<{ id: string }>(
          `update listing_saved_views set definition = $2::jsonb, updated_at = now() where id = $1 returning id`,
          [existing.rows[0].id, JSON.stringify(input.definition)],
        )
      : await client.query<{ id: string }>(
          `insert into listing_saved_views (organization_id, shop_id, name, definition, created_by_user_id)
           values ($1,$2,$3,$4::jsonb,$5) returning id`,
          [input.organizationId, input.shopId, name, JSON.stringify(input.definition), input.userId],
        );
    await client.query("commit");
    return { id: Number(result.rows[0].id), name };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteListingView(input: { id: number; organizationId: number; shopId: number }) {
  const pool = requirePool();
  await ensureListingWorkbenchSchema(pool);
  const result = await pool.query(
    `update listing_saved_views set deleted_at = now(), updated_at = now()
     where id = $1 and organization_id = $2 and shop_id = $3 and deleted_at is null`,
    [input.id, input.organizationId, input.shopId],
  );
  if (!result.rowCount) throw new ListingWorkbenchError("Saved view not found.", 404);
}

export async function queueListingPublishAttempts(input: {
  items: Array<{ draftId: number; version: number }>;
  organizationId: number;
  shopId: number;
  userId: number;
}) {
  const pool = requirePool();
  await ensureListingWorkbenchSchema(pool);
  await closeStaleListingPublishAttempts({ organizationId: input.organizationId, shopId: input.shopId }, pool);
  const client = await pool.connect();
  const queued: Array<{ attemptId: number; draftId: number; jobId: number | null; status: string }> = [];
  try {
    await client.query("begin");
    await assertListingShopAccess(input.organizationId, input.shopId, client);
    for (const item of input.items.slice(0, 100)) {
      const draft = await getDraftRecord(item.draftId, input.organizationId, client);
      if (!draft || Number(draft.shop_id) !== input.shopId) throw new ListingWorkbenchError("Draft not found.", 404);
      if (draft.version !== item.version) throw new ListingWorkbenchError(`Draft ${item.draftId} has changed.`, 409);
      if (Object.keys(draft.validation_errors ?? {}).length) throw new ListingWorkbenchError(`Draft ${item.draftId} has validation errors.`, 422);
      const active = await client.query<{ id: string; job_id: string | null }>(
        `select attempt.id, attempt.job_id
         from listing_publish_attempts attempt
         left join etsy_sync_jobs job on job.id = attempt.job_id
         where attempt.draft_id = $1
           and (attempt.status in ('queued','running') or job.status in ('queued','running'))
         order by attempt.id desc
         limit 1`,
        [item.draftId],
      );
      if (active.rows[0]) {
        queued.push({ attemptId: Number(active.rows[0].id), draftId: item.draftId, jobId: numericId(active.rows[0].job_id), status: "queued" });
        continue;
      }
      let conflict = false;
      if (draft.draft_kind === "existing" && draft.listing_id) {
        const current = await client.query<{ data: EtsyListingSummary; source_version: string | null }>(
          `select data, source_version from etsy_listings where shop_id = $1 and listing_id = $2 limit 1`,
          [input.shopId, draft.listing_id],
        );
        const currentVersion = current.rows[0]?.source_version ?? (current.rows[0]?.data ? sourceVersionForListing(current.rows[0].data) : null);
        conflict = !currentVersion || currentVersion !== draft.base_source_version;
      }
      const attemptResult = await client.query<{ id: string }>(
        `insert into listing_publish_attempts (
           organization_id, shop_id, draft_id, draft_version, base_source_version,
           patch_snapshot, image_order_snapshot, status, error, requested_by_user_id, finished_at
         ) values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,case when $8 = 'conflict' then now() else null end)
         returning id`,
        [input.organizationId, input.shopId, item.draftId, item.version, draft.base_source_version, JSON.stringify(draft.patch), JSON.stringify(draft.image_order ?? []), conflict ? "conflict" : "queued", conflict ? "Etsy Listing changed after this draft was created." : null, input.userId],
      );
      const attemptId = Number(attemptResult.rows[0].id);
      if (conflict) {
        await client.query(`update listing_drafts set status = 'conflict', updated_at = now() where id = $1`, [item.draftId]);
        queued.push({ attemptId, draftId: item.draftId, jobId: null, status: "conflict" });
        continue;
      }
      const jobResult = await client.query<{ id: string }>(
        `insert into etsy_sync_jobs (shop_id, job_type, payload, priority, max_attempts)
         values ($1, 'publish_listing_draft', $2::jsonb, 25, 4) returning id`,
        [input.shopId, JSON.stringify({ publishAttemptId: attemptId })],
      );
      const jobId = Number(jobResult.rows[0].id);
      await client.query(`update listing_publish_attempts set job_id = $2, updated_at = now() where id = $1`, [attemptId, jobId]);
      await client.query(`update listing_drafts set status = 'queued', updated_at = now() where id = $1`, [item.draftId]);
      queued.push({ attemptId, draftId: item.draftId, jobId, status: "queued" });
    }
    await client.query("commit");
    return queued;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function listListingPublishAttempts(input: { attemptIds: number[]; organizationId: number }) {
  if (!input.attemptIds.length) return [];
  const pool = requirePool();
  await ensureListingWorkbenchSchema(pool);
  await closeStaleListingPublishAttempts({ organizationId: input.organizationId }, pool);
  const result = await pool.query(
    `select attempt.id, attempt.draft_id, attempt.shop_id, attempt.status as attempt_status, attempt.error,
            attempt.job_id, job.status as job_status, job.error as job_error
     from listing_publish_attempts attempt
     left join etsy_sync_jobs job on job.id = attempt.job_id
     where attempt.organization_id = $1 and attempt.id = any($2::bigint[])
     order by attempt.id`,
    [input.organizationId, input.attemptIds],
  );
  return result.rows.map((row) => ({
    attemptId: Number(row.id),
    draftId: Number(row.draft_id),
    error: row.error ?? row.job_error ?? null,
    jobId: numericId(row.job_id),
    shopId: Number(row.shop_id),
    status: row.attempt_status === "conflict" || row.attempt_status === "succeeded"
      ? row.attempt_status
      : row.job_status === "running"
        ? "running"
        : row.job_status === "queued"
          ? "queued"
          : row.job_status === "failed"
            ? "failed"
            : row.attempt_status,
  }));
}

export type ListingPublishWork = {
  attemptId: number;
  baseSourceVersion: string | null;
  baseValues: ListingDraftValues;
  draftId: number;
  draftKind: "existing" | "new";
  draftVersion: number;
  imageOrder: ListingImageOrderItem[];
  listingId: number | null;
  organizationId: number;
  patch: ListingDraftPatch;
  resultListingId: number | null;
  shopId: number;
  values: ListingDraftValues;
};

export async function startListingPublishAttempt(attemptId: number): Promise<ListingPublishWork> {
  const pool = requirePool();
  await ensureListingWorkbenchSchema(pool);
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query("begin");
    const result = await client.query(
      `select attempt.id, attempt.organization_id, attempt.shop_id, attempt.draft_id,
              attempt.draft_version, attempt.base_source_version, attempt.patch_snapshot, attempt.result_listing_id,
              attempt.image_order_snapshot,
              attempt.requested_by_user_id,
              draft.draft_kind, draft.listing_id, draft.base_snapshot, draft.version
       from listing_publish_attempts attempt
       join listing_drafts draft on draft.id = attempt.draft_id
       where attempt.id = $1 and attempt.status in ('queued','failed') and draft.deleted_at is null
       limit 1
       for update of attempt, draft`,
      [attemptId],
    );
    const row = result.rows[0];
    if (!row) throw new ListingWorkbenchError("Publish attempt not found.", 404);
    const authorized = await client.query(
      `select 1
       from organization_memberships memberships
       join users on users.id = memberships.user_id
       join roles on roles.id = memberships.role_id
       where memberships.organization_id = $1
         and memberships.user_id = $2
         and memberships.status = 'active'
         and users.status = 'active'
         and (
           roles.code = 'admin'
           or exists (
             select 1 from member_shop_access access
             where access.organization_id = $1
               and access.user_id = $2
               and access.shop_id = $3
               and access.access_level = 'edit'
           )
         )
       limit 1`,
      [row.organization_id, row.requested_by_user_id, row.shop_id],
    );
    if (!authorized.rowCount) {
      const message = "Shop edit access was revoked before publishing started.";
      await client.query(`update listing_publish_attempts set status = 'failed', error = $2, finished_at = now(), updated_at = now() where id = $1`, [attemptId, message]);
      await client.query(`update listing_drafts set status = 'failed', updated_at = now() where id = $1`, [row.draft_id]);
      await client.query("commit");
      committed = true;
      throw new ListingWorkbenchError(message, 403);
    }
    if (Number(row.version) !== Number(row.draft_version)) {
      const message = "Draft changed after publishing was queued.";
      await client.query(`update listing_publish_attempts set status = 'conflict', error = $2, finished_at = now(), updated_at = now() where id = $1`, [attemptId, message]);
      await client.query(`update listing_drafts set status = 'conflict', updated_at = now() where id = $1`, [row.draft_id]);
      await client.query("commit");
      committed = true;
      throw new ListingWorkbenchError(message, 409);
    }
    const baseValues = row.base_snapshot as ListingDraftValues;
    const patch = row.patch_snapshot as ListingDraftPatch;
    await client.query(`update listing_publish_attempts set status = 'running', error = null, started_at = now(), updated_at = now() where id = $1`, [attemptId]);
    await client.query(`update listing_drafts set status = 'publishing', updated_at = now() where id = $1`, [row.draft_id]);
    await client.query("commit");
    committed = true;
    return {
      attemptId,
      baseSourceVersion: row.base_source_version,
      baseValues,
      draftId: Number(row.draft_id),
      draftKind: row.draft_kind,
      draftVersion: Number(row.draft_version),
      imageOrder: Array.isArray(row.image_order_snapshot) ? row.image_order_snapshot : [],
      listingId: numericId(row.listing_id),
      organizationId: Number(row.organization_id),
      patch,
      resultListingId: numericId(row.result_listing_id) ?? (row.draft_kind === "new" ? numericId(row.listing_id) : null),
      shopId: Number(row.shop_id),
      values: applyListingPatch(baseValues, patch),
    };
  } catch (error) {
    if (!committed) await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function rememberListingPublishResult(attemptId: number, draftId: number, listingId: number) {
  const pool = requirePool();
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `update listing_publish_attempts
       set result_listing_id = coalesce(result_listing_id, $2), updated_at = now()
       where id = $1`,
      [attemptId, listingId],
    );
    await client.query(
      `update listing_drafts
       set listing_id = coalesce(listing_id, $2), updated_at = now()
       where id = $1`,
      [draftId, listingId],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function assertPublishSourceVersion(work: ListingPublishWork) {
  if (!work.listingId) return;
  const pool = requirePool();
  const result = await pool.query<{ data: EtsyListingSummary; source_version: string | null }>(
    `select data, source_version from etsy_listings where shop_id = $1 and listing_id = $2 limit 1`,
    [work.shopId, work.listingId],
  );
  const current = result.rows[0];
  const version = current?.source_version ?? (current?.data ? sourceVersionForListing(current.data) : null);
  if (!version || version !== work.baseSourceVersion) {
    await markListingPublishConflict(work.attemptId, work.draftId, "Etsy Listing changed after this draft was created.");
    throw new ListingWorkbenchError("Listing source version conflict.", 409);
  }
}

export async function completeListingPublish(work: ListingPublishWork, listingId: number) {
  const pool = requirePool();
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `update listing_publish_attempts set status = 'succeeded', result_listing_id = $2, error = null,
         finished_at = now(), updated_at = now() where id = $1`,
      [work.attemptId, listingId],
    );
    await client.query(
      `update listing_drafts set status = 'archived', listing_id = coalesce(listing_id, $2), deleted_at = now(), updated_at = now()
       where id = $1`,
      [work.draftId, listingId],
    );
    await client.query(`delete from listing_draft_media where draft_id = $1`, [work.draftId]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function failListingPublish(attemptId: number, draftId: number, error: unknown) {
  const pool = requirePool();
  const message = error instanceof Error ? error.message : "Unknown Listing publish error.";
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`update listing_publish_attempts set status = 'failed', error = $2, finished_at = now(), updated_at = now() where id = $1`, [attemptId, message]);
    await client.query(`update listing_drafts set status = 'failed', updated_at = now() where id = $1`, [draftId]);
    await client.query("commit");
  } catch (failure) {
    await client.query("rollback");
    throw failure;
  } finally {
    client.release();
  }
}

async function markListingPublishConflict(attemptId: number, draftId: number, message: string) {
  const pool = requirePool();
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`update listing_publish_attempts set status = 'conflict', error = $2, finished_at = now(), updated_at = now() where id = $1`, [attemptId, message]);
    await client.query(`update listing_drafts set status = 'conflict', updated_at = now() where id = $1`, [draftId]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

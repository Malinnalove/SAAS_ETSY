import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeStaleListingPublishAttempts,
  createListingDraftMedia,
  createListingDraft,
  getListingShopDefaults,
  reorderListingDraftMedia,
  saveListingImageOrderDraft,
  saveListingShopDefaults,
  updateListingDraftMediaAltText,
} from "@/features/products/listing-workbench-db";
import { getPool } from "@/server/db";
import {
  commitListingUploadRows,
  getListingUploadWorkspace,
  updateListingUploadCell,
} from "@/features/products/listing-upload-db";
import { listListingWorkspaceRows } from "@/features/products/listing-workbench-db";
import { queueListingDeletes } from "@/features/products/listing-delete-db";

const hasDatabase = Boolean(process.env.DATABASE_URL || process.env.DATABASE_POSTGRES_URL);

describe.skipIf(!hasDatabase)("Listing Workbench database integration", () => {
  const migrationKey = `integration-bulk-${Date.now()}`;
  let context: { organizationId: number; shopId: number; userId: number };
  let originalDefaults: Record<string, unknown> | null = null;
  let staleAttemptId: number | null = null;
  let staleDraftId: number | null = null;
  let staleJobId: number | null = null;
  const uploadDraftIds: number[] = [];

  beforeAll(async () => {
    const pool = getPool();
    if (!pool) throw new Error("Database pool unavailable.");
    const result = await pool.query(
      `select shop.shop_id, shop.organization_id, membership.user_id
       from etsy_shops shop
       join organization_memberships membership on membership.organization_id = shop.organization_id
       where shop.active = true and shop.organization_id is not null and membership.status = 'active'
       order by shop.shop_id
       limit 1`,
    );
    if (!result.rows[0]) throw new Error("An active organization shop is required for integration tests.");
    context = {
      organizationId: Number(result.rows[0].organization_id),
      shopId: Number(result.rows[0].shop_id),
      userId: Number(result.rows[0].user_id),
    };
    const backup = await pool.query(
      `select * from listing_shop_defaults where organization_id = $1 and shop_id = $2`,
      [context.organizationId, context.shopId],
    );
    originalDefaults = backup.rows[0] ?? null;
  });

  afterAll(async () => {
    const pool = getPool();
    if (!pool || !context) return;
    if (staleJobId) await pool.query("delete from etsy_sync_jobs where id = $1", [staleJobId]);
    if (staleAttemptId) await pool.query("delete from listing_publish_attempts where id = $1", [staleAttemptId]);
    if (staleDraftId) await pool.query("delete from listing_drafts where id = $1", [staleDraftId]);
    if (uploadDraftIds.length) await pool.query("delete from listing_drafts where id = any($1::bigint[])", [uploadDraftIds]);
    await pool.query(
      `delete from listing_drafts where organization_id = $1 and shop_id = $2 and migration_key = $3`,
      [context.organizationId, context.shopId, migrationKey],
    );
    await pool.query(
      `delete from listing_drafts where organization_id = $1 and shop_id = $2 and migration_key like $3`,
      [context.organizationId, context.shopId, `${migrationKey}-%`],
    );
    if (originalDefaults) {
      await pool.query(
        `insert into listing_shop_defaults (
           organization_id, shop_id, values, version, updated_by_user_id, created_at, updated_at
         ) values ($1,$2,$3::jsonb,$4,$5,$6,$7)
         on conflict (organization_id, shop_id) do update set
           values = excluded.values,
           version = excluded.version,
           updated_by_user_id = excluded.updated_by_user_id,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at`,
        [
          originalDefaults.organization_id,
          originalDefaults.shop_id,
          JSON.stringify(originalDefaults.values),
          originalDefaults.version,
          originalDefaults.updated_by_user_id,
          originalDefaults.created_at,
          originalDefaults.updated_at,
        ],
      );
    } else {
      await pool.query(
        `delete from listing_shop_defaults where organization_id = $1 and shop_id = $2`,
        [context.organizationId, context.shopId],
      );
    }
  });

  it("persists shop defaults with optimistic versions", async () => {
    const current = await getListingShopDefaults(context);
    const saved = await saveListingShopDefaults({
      ...context,
      expectedVersion: current.version,
      values: {
        ...current.values,
        description: "Integration default description",
        price: { amount: 11.5, currency: "USD" },
        quantity: 3,
        taxonomyId: 2098,
      },
    });
    expect(saved.version).toBe(current.version + 1);
    expect((await getListingShopDefaults(context)).values.description).toBe("Integration default description");
  });

  it("keeps fifty stable database-backed upload row slots", async () => {
    const first = await getListingUploadWorkspace(context);
    const second = await getListingUploadWorkspace(context);
    expect(first.rows.length).toBeGreaterThanOrEqual(50);
    expect(second.rows.map((row) => row.id)).toEqual(first.rows.map((row) => row.id));
  });

  it("applies shop defaults when a staging row joins Batch upload", async () => {
    const workspace = await getListingUploadWorkspace(context);
    const emptyRow = workspace.rows.find((row) => Object.keys(row.values).length === 0);
    if (!emptyRow) throw new Error("An empty batch upload row is required for integration tests.");
    const titleRow = await updateListingUploadCell({
      ...context,
      expectedVersion: emptyRow.version,
      field: "title",
      rowId: emptyRow.id,
      value: "Upload defaults integration listing",
    });
    const skuRow = await updateListingUploadCell({
      ...context,
      expectedVersion: titleRow.version,
      field: "sku",
      rowId: titleRow.id,
      value: `UPLOAD-DEFAULTS-${Date.now()}`,
    });
    const result = await commitListingUploadRows({
      ...context,
      requestKey: `${migrationKey}-upload-defaults`,
      rowIds: [skuRow.id],
    });
    uploadDraftIds.push(...result.draftIds);
    const pool = getPool();
    if (!pool) throw new Error("Database pool unavailable.");
    const draft = await pool.query<{ patch: Record<string, unknown> }>(
      "select patch from listing_drafts where id = $1",
      [result.draftIds[0]],
    );
    expect(draft.rows[0]?.patch).toMatchObject({
      description: "Integration default description",
      quantity: 3,
      taxonomyId: 2098,
    });
  });

  it("returns every synced Etsy state in All Listings", async () => {
    const page = await listListingWorkspaceRows({ ...context, limit: 100, view: "all" });
    const listingIds = page.rows.flatMap((row) => row.listingId ? [row.listingId] : []);
    if (!listingIds.length) return;
    const pool = getPool();
    if (!pool) throw new Error("Database pool unavailable.");
    const states = await pool.query<{ state: string }>(
      `select coalesce(data->>'state','') as state from etsy_listings
       where shop_id = $1 and listing_id = any($2::bigint[])`,
      [context.shopId, listingIds],
    );
    expect(states.rows.length).toBeGreaterThan(0);
    expect(states.rows.every((row) => row.state.length > 0)).toBe(true);
  });

  it("filters All Listings by Etsy state at the database layer", async () => {
    const pool = getPool();
    if (!pool) throw new Error("Database pool unavailable.");
    const source = await pool.query<{ state: string }>(
      `select lower(data->>'state') as state from etsy_listings
       where shop_id = $1 and coalesce(data->>'state', '') <> ''
       order by listing_id limit 1`,
      [context.shopId],
    );
    const state = source.rows[0]?.state;
    if (!state) return;
    const page = await listListingWorkspaceRows({ ...context, limit: 100, state, view: "all" });
    expect(page.states).toContain(state);
    expect(page.rows.every((row) => row.values.state.toLowerCase() === state)).toBe(true);
  });

  it("keeps Batch upload limited to local products without an Etsy Listing ID", async () => {
    const draft = await createListingDraft({
      ...context,
      changes: { title: "Unuploaded integration product" },
      migrationKey: `${migrationKey}-batch-only`,
    });
    const page = await listListingWorkspaceRows({ ...context, limit: 100, view: "changed" });
    expect(page.rows.some((row) => row.draftId === draft.draftId)).toBe(true);
    expect(page.rows.every((row) => row.kind === "new" && row.listingId === null)).toBe(true);
  });

  it("never lets Batch upload delete a synced Etsy Listing", async () => {
    const pool = getPool();
    if (!pool) throw new Error("Database pool unavailable.");
    const source = await pool.query<{ listing_id: string }>(
      `select listing_id::text from etsy_listings where shop_id = $1 order by listing_id limit 1`,
      [context.shopId],
    );
    if (!source.rows[0]) return;
    const result = await queueListingDeletes({
      items: [{ draftId: null, listingId: Number(source.rows[0].listing_id) }],
      mode: "changed",
      ...context,
    });
    expect(result).toMatchObject([{ attemptId: null, status: "rejected" }]);
  });

  it("discards local upload drafts without queueing a remote delete", async () => {
    const draft = await createListingDraft({
      ...context,
      changes: {
        description: "Temporary delete integration draft",
        price: { amount: 10, currency: "USD" },
        quantity: 1,
        taxonomyId: 1,
        title: "Temporary delete integration draft",
      },
      migrationKey: `${migrationKey}-delete-local`,
    });
    const result = await queueListingDeletes({
      items: [{ draftId: draft.draftId, listingId: null }],
      mode: "changed",
      ...context,
    });
    expect(result).toMatchObject([{ attemptId: null, status: "discarded" }]);
    const pool = getPool();
    if (!pool) throw new Error("Database pool unavailable.");
    const archived = await pool.query<{ deleted: boolean }>(
      `select deleted_at is not null as deleted from listing_drafts where id = $1`,
      [draft.draftId],
    );
    expect(archived.rows[0]?.deleted).toBe(true);
  });

  it("rejects deletion while a draft is publishing", async () => {
    const draft = await createListingDraft({
      ...context,
      changes: {
        description: "Temporary publishing lock draft",
        price: { amount: 10, currency: "USD" },
        quantity: 1,
        taxonomyId: 1,
        title: "Temporary publishing lock draft",
      },
      migrationKey: `${migrationKey}-delete-locked`,
    });
    const pool = getPool();
    if (!pool) throw new Error("Database pool unavailable.");
    await pool.query(`update listing_drafts set status = 'publishing' where id = $1`, [draft.draftId]);
    const result = await queueListingDeletes({
      items: [{ draftId: draft.draftId, listingId: null }],
      mode: "changed",
      ...context,
    });
    expect(result[0]).toMatchObject({ status: "rejected" });
    expect(result[0].error).toMatch(/Publishing/i);
    await pool.query(`update listing_drafts set status = 'draft' where id = $1`, [draft.draftId]);
  });

  it("applies shop defaults and keeps a bulk request idempotent", async () => {
    const first = await createListingDraft({
      ...context,
      changes: { sku: "INTEGRATION-SKU", title: "Integration bulk listing" },
      migrationKey,
    });
    const repeated = await createListingDraft({
      ...context,
      changes: { sku: "INTEGRATION-SKU", title: "Integration bulk listing" },
      migrationKey,
    });
    expect(repeated.draftId).toBe(first.draftId);
    expect(first.values.description).toBe("Integration default description");
    expect(first.lifecycle).toBe("draft");
  });

  it("persists alt text for a staged draft image", async () => {
    const draft = await createListingDraft({
      ...context,
      changes: { sku: "ALT-TEXT-INTEGRATION", title: "Alt text integration listing" },
      migrationKey: `${migrationKey}-alt-text`,
    });
    if (!draft.draftId) throw new Error("A new draft ID is required for the alt text test.");
    const image = await createListingDraftMedia({
      contentType: "image/png",
      data: Buffer.from("integration-image"),
      draftId: draft.draftId,
      filename: "integration.png",
      organizationId: context.organizationId,
      shopId: context.shopId,
      userId: context.userId,
    });
    const updated = await updateListingDraftMediaAltText({
      altText: "Yellow handmade cookie stamp with a cartoon design",
      draftId: draft.draftId,
      mediaId: image.id!,
      organizationId: context.organizationId,
      shopId: context.shopId,
    });
    expect(updated.altText).toBe("Yellow handmade cookie stamp with a cartoon design");
    const secondImage = await createListingDraftMedia({
      contentType: "image/png",
      data: Buffer.from("integration-image-two"),
      draftId: draft.draftId,
      filename: "integration-two.png",
      organizationId: context.organizationId,
      shopId: context.shopId,
      userId: context.userId,
    });
    const reordered = await reorderListingDraftMedia({
      draftId: draft.draftId,
      mediaIds: [secondImage.id!, image.id!],
      organizationId: context.organizationId,
      shopId: context.shopId,
    });
    expect(reordered.map((item) => item.id)).toEqual([secondImage.id, image.id]);
    expect(reordered.map((item) => item.rank)).toEqual([1, 2]);
  });

  it("stages an existing Listing image order locally without changing the synced Etsy source", async () => {
    const pool = getPool();
    if (!pool) throw new Error("Database pool unavailable.");
    const source = await pool.query<{ data: { images?: Array<Record<string, unknown>> }; listing_id: string }>(
      `select listing.listing_id::text, listing.data
       from etsy_listings listing
       where listing.shop_id = $1
         and jsonb_array_length(case when jsonb_typeof(listing.data->'images') = 'array' then listing.data->'images' else '[]'::jsonb end) between 2 and 20
         and not exists (
           select 1 from listing_drafts draft
           where draft.organization_id = $2 and draft.shop_id = listing.shop_id
             and draft.listing_id = listing.listing_id and draft.deleted_at is null
         )
       order by listing.listing_id
       limit 1`,
      [context.shopId, context.organizationId],
    );
    const listing = source.rows[0];
    if (!listing?.data.images?.length) return;
    const currentImages = listing.data.images.flatMap((image) => {
      const id = Number(image.listing_image_id ?? image.image_id);
      return Number.isSafeInteger(id) && id > 0
        ? [{ altText: String(image.alt_text ?? ""), id }]
        : [];
    });
    if (currentImages.length !== listing.data.images.length || new Set(currentImages.map((image) => image.id)).size !== currentImages.length) return;
    const originalSource = JSON.stringify(listing.data.images);
    const row = await saveListingImageOrderDraft({
      ...context,
      images: [...currentImages].reverse(),
      listingId: Number(listing.listing_id),
    });
    if (!row.draftId) throw new Error("An image-order draft ID is required.");
    uploadDraftIds.push(row.draftId);

    expect(row.images.map((image) => image.id)).toEqual([...currentImages].reverse().map((image) => image.id));
    expect(row.lifecycle).toBe("changed");
    const persisted = await pool.query<{ image_order: unknown; source_images: unknown }>(
      `select draft.image_order, listing.data->'images' as source_images
       from listing_drafts draft
       join etsy_listings listing on listing.shop_id = draft.shop_id and listing.listing_id = draft.listing_id
       where draft.id = $1`,
      [row.draftId],
    );
    expect(persisted.rows[0]?.image_order).toEqual([...currentImages].reverse());
    expect(JSON.stringify(persisted.rows[0]?.source_images)).toBe(originalSource);
  });

  it("closes publish jobs that were never claimed within fifteen minutes", async () => {
    const pool = getPool();
    if (!pool) throw new Error("Database pool unavailable.");
    const draft = await pool.query<{ id: string }>(
      `insert into listing_drafts (
         organization_id, shop_id, draft_kind, status, base_snapshot, patch,
         validation_errors, version, migration_key, created_by_user_id
       ) values ($1,$2,'new','queued','{}'::jsonb,'{}'::jsonb,'{}'::jsonb,1,$3,$4)
       returning id`,
      [context.organizationId, context.shopId, `${migrationKey}-stale`, context.userId],
    );
    staleDraftId = Number(draft.rows[0].id);
    const attempt = await pool.query<{ id: string }>(
      `insert into listing_publish_attempts (
         organization_id, shop_id, draft_id, draft_version, patch_snapshot,
         status, requested_by_user_id
       ) values ($1,$2,$3,1,'{}'::jsonb,'queued',$4) returning id`,
      [context.organizationId, context.shopId, staleDraftId, context.userId],
    );
    staleAttemptId = Number(attempt.rows[0].id);
    const job = await pool.query<{ id: string }>(
      `insert into etsy_sync_jobs (
         shop_id, job_type, payload, status, attempts, max_attempts, created_at, updated_at
       ) values ($1,'publish_listing_draft',$2::jsonb,'queued',0,4,now() - interval '16 minutes',now() - interval '16 minutes')
       returning id`,
      [context.shopId, JSON.stringify({ publishAttemptId: staleAttemptId })],
    );
    staleJobId = Number(job.rows[0].id);
    await pool.query("update listing_publish_attempts set job_id = $2 where id = $1", [staleAttemptId, staleJobId]);

    await expect(closeStaleListingPublishAttempts(context, pool)).resolves.toBe(1);
    const states = await pool.query(
      `select attempt.status as attempt_status, draft.status as draft_status, job.status as job_status
       from listing_publish_attempts attempt
       join listing_drafts draft on draft.id = attempt.draft_id
       join etsy_sync_jobs job on job.id = attempt.job_id
       where attempt.id = $1`,
      [staleAttemptId],
    );
    expect(states.rows[0]).toMatchObject({ attempt_status: "failed", draft_status: "failed", job_status: "failed" });
  });
});

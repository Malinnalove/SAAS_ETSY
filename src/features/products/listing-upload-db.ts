import type { PoolClient } from "pg";
import { getPool } from "@/server/db";
import {
  assertListingShopAccess,
  ensureListingWorkbenchSchema,
  listingDefaultValuesForShop,
  ListingWorkbenchError,
} from "@/features/products/listing-workbench-db";
import {
  applyListingPatch,
} from "@/features/products/listing-workbench-model";
import {
  applyListingUploadCells,
  isListingUploadRowEmpty,
  listingUploadRowErrors,
  LISTING_UPLOAD_FIELDS,
  LISTING_UPLOAD_MAX_NON_EMPTY_ROWS,
  LISTING_UPLOAD_MINIMUM_ROWS,
} from "@/features/products/listing-upload-model";
import type {
  ListingDraftPatch,
  ListingUploadField,
  ListingUploadRow,
  ListingUploadWorkspace,
  ListingValidationErrors,
} from "@/shared/types/listing-workbench";

type UploadRowRecord = {
  id: string | number;
  position: number;
  updated_at: Date | string;
  validation_errors: ListingValidationErrors;
  values: ListingDraftPatch;
  version: number;
};

type WorkspaceRecord = {
  id: string | number;
  minimum_rows: number;
  shop_id: string | number;
  version: number;
};

export class ListingUploadValidationError extends ListingWorkbenchError {
  rowErrors: Array<{ errors: ListingValidationErrors; rowId: number }>;

  constructor(rowErrors: Array<{ errors: ListingValidationErrors; rowId: number }>) {
    super("Some selected rows need corrections before they can become drafts.", 422);
    this.name = "ListingUploadValidationError";
    this.rowErrors = rowErrors;
  }
}

function requirePool() {
  const pool = getPool();
  if (!pool) throw new ListingWorkbenchError("PostgreSQL DATABASE_URL is required for batch upload.", 503);
  return pool;
}

function mapRow(row: UploadRowRecord): ListingUploadRow {
  return {
    id: Number(row.id),
    position: row.position,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : new Date(row.updated_at).toISOString(),
    validationErrors: row.validation_errors ?? {},
    values: row.values ?? {},
    version: row.version,
  };
}

async function ensureWorkspace(
  client: PoolClient,
  organizationId: number,
  shopId: number,
  forUpdate = false,
) {
  await assertListingShopAccess(organizationId, shopId, client);
  await client.query(
    `insert into listing_upload_workspaces (organization_id, shop_id, minimum_rows)
     values ($1,$2,$3) on conflict (organization_id, shop_id) do nothing`,
    [organizationId, shopId, LISTING_UPLOAD_MINIMUM_ROWS],
  );
  const result = await client.query<WorkspaceRecord>(
    `select id, shop_id, minimum_rows, version from listing_upload_workspaces
     where organization_id = $1 and shop_id = $2${forUpdate ? " for update" : ""}`,
    [organizationId, shopId],
  );
  const workspace = result.rows[0];
  if (!workspace) throw new ListingWorkbenchError("Batch upload workspace could not be created.", 500);
  return workspace;
}

async function refillRows(client: PoolClient, workspaceId: number, minimumRows: number) {
  const countResult = await client.query<{ count: string }>(
    `select count(*)::text as count from listing_upload_rows where workspace_id = $1`,
    [workspaceId],
  );
  const count = Number(countResult.rows[0]?.count ?? 0);
  if (count >= minimumRows) return;
  await client.query(
    `insert into listing_upload_rows (workspace_id, position)
     select $1, value from generate_series($2::integer, $3::integer) value
     on conflict (workspace_id, position) do nothing`,
    [workspaceId, count, minimumRows - 1],
  );
}

async function workspaceRows(client: PoolClient, workspaceId: number, forUpdate = false) {
  return client.query<UploadRowRecord>(
    `select id, position, values, validation_errors, version, updated_at
     from listing_upload_rows where workspace_id = $1 order by position, id${forUpdate ? " for update" : ""}`,
    [workspaceId],
  );
}

async function compactAndRefill(client: PoolClient, workspaceId: number, minimumRows: number) {
  await client.query(`update listing_upload_rows set position = position + 1000000 where workspace_id = $1`, [workspaceId]);
  await client.query(
    `with ordered as (
       select id, row_number() over (order by position, id) - 1 as next_position
       from listing_upload_rows where workspace_id = $1
     )
     update listing_upload_rows row set position = ordered.next_position
     from ordered where row.id = ordered.id`,
    [workspaceId],
  );
  await refillRows(client, workspaceId, minimumRows);
}

function validateFields(fields: unknown): ListingUploadField[] {
  if (!Array.isArray(fields) || !fields.length) throw new ListingWorkbenchError("Visible field order is required.");
  const result = fields.map(String) as ListingUploadField[];
  if (new Set(result).size !== result.length || result.some((field) => !LISTING_UPLOAD_FIELDS.includes(field))) {
    throw new ListingWorkbenchError("Invalid batch upload field order.");
  }
  return result;
}

function validateMatrix(matrix: unknown) {
  if (!Array.isArray(matrix) || !matrix.length) throw new ListingWorkbenchError("Paste at least one row.");
  const result = matrix.map((row) => {
    if (!Array.isArray(row)) throw new ListingWorkbenchError("Invalid paste matrix.");
    return row.map((cell) => String(cell ?? "").slice(0, 50000));
  });
  const nonEmptyRows = result.filter((row) => row.some((cell) => cell.trim())).length;
  if (nonEmptyRows > LISTING_UPLOAD_MAX_NON_EMPTY_ROWS) {
    throw new ListingWorkbenchError(`Paste at most ${LISTING_UPLOAD_MAX_NON_EMPTY_ROWS} non-empty rows at a time.`);
  }
  return result;
}

export async function getListingUploadWorkspace(input: {
  organizationId: number;
  shopId: number;
}): Promise<ListingUploadWorkspace> {
  const pool = requirePool();
  await ensureListingWorkbenchSchema(pool);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const workspace = await ensureWorkspace(client, input.organizationId, input.shopId, true);
    await refillRows(client, Number(workspace.id), workspace.minimum_rows);
    const rows = await workspaceRows(client, Number(workspace.id));
    await client.query("commit");
    return {
      id: Number(workspace.id),
      minimumRows: workspace.minimum_rows,
      rows: rows.rows.map(mapRow),
      shopId: Number(workspace.shop_id),
      version: workspace.version,
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function updateListingUploadCell(input: {
  expectedVersion: number;
  field: ListingUploadField;
  organizationId: number;
  rowId: number;
  shopId: number;
  value: string;
}) {
  const pool = requirePool();
  await ensureListingWorkbenchSchema(pool);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const workspace = await ensureWorkspace(client, input.organizationId, input.shopId, true);
    if (!LISTING_UPLOAD_FIELDS.includes(input.field)) throw new ListingWorkbenchError("Invalid upload field.");
    const result = await client.query<UploadRowRecord>(
      `select id, position, values, validation_errors, version, updated_at
       from listing_upload_rows where id = $1 and workspace_id = $2 for update`,
      [input.rowId, workspace.id],
    );
    const row = result.rows[0];
    if (!row) throw new ListingWorkbenchError("Upload row not found.", 404);
    if (row.version !== input.expectedVersion) throw new ListingWorkbenchError("Upload row changed. Reload and retry.", 409);
    const applied = applyListingUploadCells({
      cells: [input.value],
      errors: row.validation_errors,
      fields: [input.field],
      startFieldIndex: 0,
      values: row.values,
    });
    const updated = await client.query<UploadRowRecord>(
      `update listing_upload_rows set values = $2::jsonb, validation_errors = $3::jsonb,
         version = version + 1, updated_at = now()
       where id = $1 returning id, position, values, validation_errors, version, updated_at`,
      [row.id, JSON.stringify(applied.values), JSON.stringify(applied.errors)],
    );
    await client.query(`update listing_upload_workspaces set version = version + 1, updated_at = now() where id = $1`, [workspace.id]);
    await client.query("commit");
    return mapRow(updated.rows[0]);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function pasteListingUploadCells(input: {
  fields: unknown;
  matrix: unknown;
  organizationId: number;
  shopId: number;
  startField: string;
  startRowId: number;
}) {
  const fields = validateFields(input.fields);
  const matrix = validateMatrix(input.matrix);
  const startFieldIndex = fields.indexOf(input.startField as ListingUploadField);
  if (startFieldIndex < 0) throw new ListingWorkbenchError("Paste start field is not visible.");
  const pool = requirePool();
  await ensureListingWorkbenchSchema(pool);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const workspace = await ensureWorkspace(client, input.organizationId, input.shopId, true);
    await refillRows(client, Number(workspace.id), workspace.minimum_rows);
    let rows = (await workspaceRows(client, Number(workspace.id), true)).rows;
    const startIndex = rows.findIndex((row) => Number(row.id) === input.startRowId);
    if (startIndex < 0) throw new ListingWorkbenchError("Paste start row was not found.", 404);
    const requiredCount = startIndex + matrix.length;
    if (requiredCount > rows.length) {
      await client.query(
        `insert into listing_upload_rows (workspace_id, position)
         select $1, value from generate_series($2::integer, $3::integer) value`,
        [workspace.id, rows.length, requiredCount - 1],
      );
      rows = (await workspaceRows(client, Number(workspace.id), true)).rows;
    }
    for (const [offset, cells] of matrix.entries()) {
      const row = rows[startIndex + offset];
      if (!row) break;
      const applied = applyListingUploadCells({
        cells,
        errors: row.validation_errors,
        fields,
        startFieldIndex,
        values: row.values,
      });
      await client.query(
        `update listing_upload_rows set values = $2::jsonb, validation_errors = $3::jsonb,
           version = version + 1, updated_at = now() where id = $1`,
        [row.id, JSON.stringify(applied.values), JSON.stringify(applied.errors)],
      );
    }
    await client.query(`update listing_upload_workspaces set version = version + 1, updated_at = now() where id = $1`, [workspace.id]);
    const updatedRows = await workspaceRows(client, Number(workspace.id));
    await client.query("commit");
    return updatedRows.rows.map(mapRow);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteListingUploadRows(input: {
  organizationId: number;
  rowIds: number[];
  shopId: number;
}) {
  const rowIds = Array.from(new Set(input.rowIds.filter((id) => Number.isSafeInteger(id) && id > 0))).slice(0, 100);
  if (!rowIds.length) throw new ListingWorkbenchError("Select at least one upload row.");
  const pool = requirePool();
  await ensureListingWorkbenchSchema(pool);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const workspace = await ensureWorkspace(client, input.organizationId, input.shopId, true);
    await client.query(`delete from listing_upload_rows where workspace_id = $1 and id = any($2::bigint[])`, [workspace.id, rowIds]);
    await compactAndRefill(client, Number(workspace.id), workspace.minimum_rows);
    await client.query(`update listing_upload_workspaces set version = version + 1, updated_at = now() where id = $1`, [workspace.id]);
    const rows = await workspaceRows(client, Number(workspace.id));
    await client.query("commit");
    return rows.rows.map(mapRow);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function commitListingUploadRows(input: {
  organizationId: number;
  requestKey: string;
  rowIds: number[];
  shopId: number;
  userId: number;
}) {
  const requestKey = input.requestKey.trim().slice(0, 120);
  if (!requestKey) throw new ListingWorkbenchError("An idempotency key is required.");
  const rowIds = Array.from(new Set(input.rowIds.filter((id) => Number.isSafeInteger(id) && id > 0))).slice(0, 100);
  if (!rowIds.length) throw new ListingWorkbenchError("Select at least one upload row.");
  const pool = requirePool();
  await ensureListingWorkbenchSchema(pool);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const workspace = await ensureWorkspace(client, input.organizationId, input.shopId, true);
    const previous = await client.query<{ result: { converted: number; draftIds: number[] } }>(
      `select result from listing_upload_commits where workspace_id = $1 and request_key = $2`,
      [workspace.id, requestKey],
    );
    if (previous.rows[0]) {
      await client.query("commit");
      return previous.rows[0].result;
    }
    const selected = await client.query<UploadRowRecord>(
      `select id, position, values, validation_errors, version, updated_at
       from listing_upload_rows where workspace_id = $1 and id = any($2::bigint[])
       order by position for update`,
      [workspace.id, rowIds],
    );
    const nonEmpty = selected.rows.filter((row) => !isListingUploadRowEmpty(row.values));
    if (!nonEmpty.length) throw new ListingWorkbenchError("Selected rows are empty.");
    if (nonEmpty.length > LISTING_UPLOAD_MAX_NON_EMPTY_ROWS) throw new ListingWorkbenchError("Convert at most 100 rows at a time.");
    const defaults = await listingDefaultValuesForShop(input.organizationId, input.shopId, client);
    const rowErrors = nonEmpty.flatMap((row) => {
      const errors = listingUploadRowErrors(row.values, row.validation_errors ?? {}, defaults);
      return Object.keys(errors).length ? [{ errors, rowId: Number(row.id) }] : [];
    });
    if (rowErrors.length) {
      for (const item of rowErrors) {
        await client.query(`update listing_upload_rows set validation_errors = $2::jsonb, updated_at = now() where id = $1`, [item.rowId, JSON.stringify(item.errors)]);
      }
      await client.query("commit");
      throw new ListingUploadValidationError(rowErrors);
    }
    const draftIds: number[] = [];
    for (const row of nonEmpty) {
      const values = applyListingPatch(defaults, row.values);
      const result = await client.query<{ id: string }>(
        `insert into listing_drafts (
           organization_id, shop_id, listing_id, draft_kind, status, base_source_version,
           base_snapshot, patch, validation_errors, migration_key, created_by_user_id
         ) values ($1,$2,null,'new','draft',null,$3::jsonb,$4::jsonb,'{}'::jsonb,$5,$6)
         returning id`,
        [
          input.organizationId,
          input.shopId,
          JSON.stringify(defaults),
          JSON.stringify(values),
          `upload:${workspace.id}:${requestKey}:${row.id}`,
          input.userId,
        ],
      );
      draftIds.push(Number(result.rows[0].id));
    }
    await client.query(`delete from listing_upload_rows where workspace_id = $1 and id = any($2::bigint[])`, [workspace.id, nonEmpty.map((row) => Number(row.id))]);
    await compactAndRefill(client, Number(workspace.id), workspace.minimum_rows);
    const result = { converted: draftIds.length, draftIds };
    await client.query(
      `insert into listing_upload_commits (workspace_id, request_key, result) values ($1,$2,$3::jsonb)`,
      [workspace.id, requestKey, JSON.stringify(result)],
    );
    await client.query(`update listing_upload_workspaces set version = version + 1, updated_at = now() where id = $1`, [workspace.id]);
    await client.query("commit");
    return result;
  } catch (error) {
    if (!(error instanceof ListingUploadValidationError)) await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

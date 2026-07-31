import type { Pool } from "pg";
import type {
  EtsyConnection,
  EtsyListingSummary,
  EtsyMoney,
  EtsyOrderDetail,
  EtsyReceiptSummary,
  EtsyShopSummary,
} from "@/shared/types/etsy";

export type ErpAccountContext = {
  organizationId: number;
  channelId: number;
  channelAccountId: number;
  defaultLocationId: number;
};

const DEFAULT_ORGANIZATION_NAME = "成都云杉科技";
const DEFAULT_ORGANIZATION_SLUG = "chengdu-yunshan";

export type ProductListOptions = {
  accountId?: number | null;
  limit?: number;
  offset?: number;
  status?: string;
  search?: string;
};

export type OrderListOptions = {
  accountId?: number | null;
  limit?: number;
  offset?: number;
  status?: string;
};

export type OrderItemListOptions = {
  accountId?: number | null;
  limit?: number;
  offset?: number;
};

export type ErpChannelAccount = {
  accountId: number;
  channelCode: string;
  channelId: number;
  displayName: string;
  externalAccountId: string;
  organizationId: number;
  status: string;
};

export type ErpProductListRow = {
  available: number;
  externalListingId: string | null;
  onHand: number;
  productId: number;
  productSourceData: EtsyListingSummary | null;
  productStatus: string;
  productTitle: string;
  reserved: number;
  skuCode: string;
  skuId: number;
  skuTitle: string;
  updatedAt: Date | string | null;
};

export type ErpOrderListRow = {
  currencyCode: string;
  customerName: string | null;
  externalOrderId: string | null;
  fulfillmentStatus: string;
  orderId: number;
  orderNumber: string;
  orderSourceData: EtsyReceiptSummary | null;
  orderStatus: string;
  paymentStatus: string;
  placedAt: Date | string | null;
  totalAmount: number;
};

export type ErpOrderItemListRow = {
  currencyCode: string;
  externalLineItemId: string | null;
  externalListingId: string | null;
  externalOrderId: string | null;
  itemSourceData: EtsyOrderDetail | null;
  orderItemId: number;
  orderSourceData: EtsyReceiptSummary | null;
  quantity: number;
  title: string;
  unitPriceAmount: number;
};

function numericId(value: string | number) {
  return typeof value === "number" ? value : Number(value);
}

function moneyAmount(value?: EtsyMoney | null) {
  if (!value) {
    return {
      amount: 0,
      currency: "USD",
    };
  }

  return {
    amount: value.amount / value.divisor,
    currency: value.currency_code,
  };
}

function timestampDate(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? new Date(value * 1000)
    : null;
}

function boolFromRaw(value: unknown) {
  return typeof value === "boolean" ? value : null;
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

function safeSkuCode(shopId: number, listing: EtsyListingSummary) {
  const raw = rawObject(listing);
  const rawSku = typeof raw.sku === "string" ? raw.sku.trim() : "";
  return rawSku || `ETSY-${shopId}-${listing.listing_id}`;
}

async function erpSchemaReady(pool: Pool) {
  const result = await pool.query<{ ready: boolean }>(
    "select to_regclass('public.products') is not null as ready",
  );

  return result.rows[0]?.ready === true;
}

async function getId(
  pool: Pool,
  sql: string,
  params: unknown[],
) {
  const result = await pool.query<{ id: string | number }>(sql, params);
  return numericId(result.rows[0].id);
}

async function ensureDefaultOrganization(pool: Pool) {
  return getId(
    pool,
    `
      insert into organizations (name, slug)
      values ($1, $2)
      on conflict (slug)
      do update set updated_at = now()
      returning id
    `,
    [DEFAULT_ORGANIZATION_NAME, DEFAULT_ORGANIZATION_SLUG],
  );
}

async function ensureSalesChannel(pool: Pool, code = "etsy", name = "Etsy") {
  return getId(
    pool,
    `
      insert into sales_channels (code, name)
      values ($1, $2)
      on conflict (code)
      do update set name = excluded.name,
                    updated_at = now()
      returning id
    `,
    [code, name],
  );
}

async function ensureDefaultLocation(pool: Pool, organizationId: number) {
  return getId(
    pool,
    `
      insert into locations (organization_id, code, name, location_type)
      values ($1, 'default', 'Default Warehouse', 'warehouse')
      on conflict (organization_id, code)
      do update set name = excluded.name,
                    updated_at = now()
      returning id
    `,
    [organizationId],
  );
}

export async function ensureErpAccountForShop(
  connection: EtsyConnection,
  shop: EtsyShopSummary | null,
  pool: Pool,
): Promise<ErpAccountContext | null> {
  if (!(await erpSchemaReady(pool))) {
    return null;
  }

  const organizationId = await ensureDefaultOrganization(pool);
  const channelId = await ensureSalesChannel(pool);
  const defaultLocationId = await ensureDefaultLocation(pool, organizationId);
  const externalAccountId = String(connection.shopId);
  const displayName = connection.shopName || shop?.shop_name || `Etsy Shop ${connection.shopId}`;
  const connectedAt = connection.connectedAt ? new Date(connection.connectedAt) : null;

  const channelAccountId = await getId(
    pool,
    `
      insert into channel_accounts (
        organization_id,
        channel_id,
        external_account_id,
        display_name,
        status,
        external_data,
        connected_at
      )
      values ($1, $2, $3, $4, 'active', $5, $6)
      on conflict (channel_id, external_account_id)
      do update set organization_id = excluded.organization_id,
                    display_name = excluded.display_name,
                    status = 'active',
                    external_data = excluded.external_data,
                    connected_at = coalesce(excluded.connected_at, channel_accounts.connected_at),
                    updated_at = now(),
                    deleted_at = null
      returning id
    `,
    [
      organizationId,
      channelId,
      externalAccountId,
      displayName,
      JSON.stringify(shop ?? {}),
      connectedAt,
    ],
  );

  await pool.query(
    `
      insert into channel_credentials (
        channel_account_id,
        access_token,
        refresh_token,
        scopes,
        expires_at,
        raw_data
      )
      values ($1, $2, $3, $4, $5, $6)
      on conflict (channel_account_id)
      do update set access_token = excluded.access_token,
                    refresh_token = excluded.refresh_token,
                    scopes = excluded.scopes,
                    expires_at = excluded.expires_at,
                    raw_data = excluded.raw_data,
                    updated_at = now()
    `,
    [
      channelAccountId,
      connection.accessToken,
      connection.refreshToken,
      connection.scopes,
      new Date(connection.expiresAt),
      JSON.stringify(connection),
    ],
  );

  await upsertExternalMapping(
    pool,
    {
      channelAccountId,
      channelId,
      externalEntityId: externalAccountId,
      externalEntityType: "etsy_shop",
      internalEntityId: channelAccountId,
      internalEntityType: "channel_account",
      organizationId,
      rawData: shop ?? connection,
    },
  );

  return {
    channelAccountId,
    channelId,
    defaultLocationId,
    organizationId,
  };
}

async function findExternalMapping(
  pool: Pool,
  context: ErpAccountContext,
  externalEntityType: string,
  externalEntityId: string,
  internalEntityType: string,
) {
  const result = await pool.query<{ internal_entity_id: string }>(
    `
      select internal_entity_id
      from external_entity_mappings
      where channel_id = $1
        and channel_account_id = $2
        and external_entity_type = $3
        and external_entity_id = $4
        and internal_entity_type = $5
      limit 1
    `,
    [
      context.channelId,
      context.channelAccountId,
      externalEntityType,
      externalEntityId,
      internalEntityType,
    ],
  );

  return result.rows[0] ? numericId(result.rows[0].internal_entity_id) : null;
}

async function upsertExternalMapping(
  pool: Pool,
  input: {
    organizationId: number;
    channelId: number;
    channelAccountId: number;
    internalEntityType: string;
    internalEntityId: number;
    externalEntityType: string;
    externalEntityId: string;
    externalParentId?: string | null;
    rawData?: unknown;
  },
) {
  const existing = await pool.query<{ id: string }>(
    `
      select id
      from external_entity_mappings
      where channel_id = $1
        and channel_account_id = $2
        and external_entity_type = $3
        and external_entity_id = $4
        and internal_entity_type = $5
      limit 1
    `,
    [
      input.channelId,
      input.channelAccountId,
      input.externalEntityType,
      input.externalEntityId,
      input.internalEntityType,
    ],
  );

  if (existing.rows[0]) {
    await pool.query(
      `
        update external_entity_mappings
        set organization_id = $2,
            internal_entity_id = $3,
            external_parent_id = $4,
            raw_data = $5,
            updated_at = now()
        where id = $1
      `,
      [
        existing.rows[0].id,
        input.organizationId,
        input.internalEntityId,
        input.externalParentId ?? null,
        JSON.stringify(input.rawData ?? {}),
      ],
    );
    return numericId(existing.rows[0].id);
  }

  return getId(
    pool,
    `
      insert into external_entity_mappings (
        organization_id,
        channel_id,
        channel_account_id,
        internal_entity_type,
        internal_entity_id,
        external_entity_type,
        external_entity_id,
        external_parent_id,
        raw_data
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      returning id
    `,
    [
      input.organizationId,
      input.channelId,
      input.channelAccountId,
      input.internalEntityType,
      input.internalEntityId,
      input.externalEntityType,
      input.externalEntityId,
      input.externalParentId ?? null,
      JSON.stringify(input.rawData ?? {}),
    ],
  );
}

export async function normalizeListingsToErp(
  shopId: number,
  listings: EtsyListingSummary[],
  pool: Pool,
) {
  const ownedListings = listings.filter((listing) => listingBelongsToShop(shopId, listing));
  if (!ownedListings.length || !(await erpSchemaReady(pool))) return;

  const connection = await getEtsyConnection(shopId, pool);
  if (!connection) return;

  const context = await ensureErpAccountForShop(connection, null, pool);
  if (!context) return;

  for (const listing of ownedListings) {
    await normalizeListing(context, shopId, listing, pool);
  }
}

export async function markMissingListingsDeletedForShop(
  shopId: number,
  currentListingIds: Array<number | string>,
  pool: Pool,
) {
  if (!(await erpSchemaReady(pool))) return;

  const connection = await getEtsyConnection(shopId, pool);
  if (!connection) return;

  const context = await ensureErpAccountForShop(connection, null, pool);
  if (!context) return;

  const currentExternalIds = currentListingIds.map((id) => String(id));
  const mappingParams = [
    context.organizationId,
    context.channelId,
    context.channelAccountId,
    currentExternalIds,
  ];

  await pool.query(
    `
      update skus
      set status = 'deleted',
          deleted_at = coalesce(deleted_at, now()),
          updated_at = now()
      where id in (
        select mapping.internal_entity_id
        from external_entity_mappings mapping
        where mapping.organization_id = $1
          and mapping.channel_id = $2
          and mapping.channel_account_id = $3
          and mapping.external_entity_type = 'etsy_listing'
          and mapping.internal_entity_type = 'sku'
          and not (mapping.external_entity_id = any($4::text[]))
      )
    `,
    mappingParams,
  );

  await pool.query(
    `
      update product_variants
      set status = 'deleted',
          deleted_at = coalesce(deleted_at, now()),
          updated_at = now()
      where id in (
        select mapping.internal_entity_id
        from external_entity_mappings mapping
        where mapping.organization_id = $1
          and mapping.channel_id = $2
          and mapping.channel_account_id = $3
          and mapping.external_entity_type = 'etsy_listing'
          and mapping.internal_entity_type = 'product_variant'
          and not (mapping.external_entity_id = any($4::text[]))
      )
    `,
    mappingParams,
  );

  await pool.query(
    `
      update products
      set status = 'deleted',
          deleted_at = coalesce(deleted_at, now()),
          updated_at = now()
      where id in (
        select mapping.internal_entity_id
        from external_entity_mappings mapping
        where mapping.organization_id = $1
          and mapping.channel_id = $2
          and mapping.channel_account_id = $3
          and mapping.external_entity_type = 'etsy_listing'
          and mapping.internal_entity_type = 'product'
          and not (mapping.external_entity_id = any($4::text[]))
      )
    `,
    mappingParams,
  );
}

async function normalizeListing(
  context: ErpAccountContext,
  shopId: number,
  listing: EtsyListingSummary,
  pool: Pool,
) {
  const externalListingId = String(listing.listing_id);
  const productId =
    (await findExternalMapping(pool, context, "etsy_listing", externalListingId, "product")) ??
    (await getId(
      pool,
      `
        insert into products (
          organization_id,
          title,
          description,
          status,
          source_data
        )
        values ($1, $2, $3, $4, $5)
        returning id
      `,
      [
        context.organizationId,
        listing.title || `Etsy Listing ${listing.listing_id}`,
        listing.description ?? null,
        listing.state || "active",
        JSON.stringify(listing),
      ],
    ));

  await pool.query(
    `
      update products
      set title = $2,
          description = coalesce($3, description),
          status = $4,
          source_data = $5,
          deleted_at = null,
          updated_at = now()
      where id = $1
    `,
    [
      productId,
      listing.title || `Etsy Listing ${listing.listing_id}`,
      listing.description ?? null,
      listing.state || "active",
      JSON.stringify(listing),
    ],
  );

  await upsertExternalMapping(pool, {
    ...context,
    externalEntityId: externalListingId,
    externalEntityType: "etsy_listing",
    internalEntityId: productId,
    internalEntityType: "product",
    rawData: listing,
  });

  const variantId =
    (await findExternalMapping(pool, context, "etsy_listing", externalListingId, "product_variant")) ??
    (await getId(
      pool,
      `
        insert into product_variants (
          organization_id,
          product_id,
          title,
          option_values,
          status,
          source_data
        )
        values ($1, $2, $3, '{}'::jsonb, $4, $5)
        returning id
      `,
      [
        context.organizationId,
        productId,
        listing.title || `Variant ${listing.listing_id}`,
        listing.state || "active",
        JSON.stringify(listing),
      ],
    ));

  await pool.query(
    `
      update product_variants
      set product_id = $2,
          title = $3,
          status = $4,
          source_data = $5,
          deleted_at = null,
          updated_at = now()
      where id = $1
    `,
    [
      variantId,
      productId,
      listing.title || `Variant ${listing.listing_id}`,
      listing.state || "active",
      JSON.stringify(listing),
    ],
  );

  await upsertExternalMapping(pool, {
    ...context,
    externalEntityId: externalListingId,
    externalEntityType: "etsy_listing",
    internalEntityId: variantId,
    internalEntityType: "product_variant",
    rawData: listing,
  });

  const skuCode = safeSkuCode(shopId, listing);
  const skuId =
    (await findExternalMapping(pool, context, "etsy_listing", externalListingId, "sku")) ??
    (await getId(
      pool,
      `
        insert into skus (
          organization_id,
          product_id,
          variant_id,
          sku_code,
          title,
          status,
          source_data
        )
        values ($1, $2, $3, $4, $5, $6, $7)
        on conflict (organization_id, sku_code)
        do update set product_id = excluded.product_id,
                      variant_id = excluded.variant_id,
                      title = excluded.title,
                      status = excluded.status,
                      source_data = excluded.source_data,
                      deleted_at = null,
                      updated_at = now()
        returning id
      `,
      [
        context.organizationId,
        productId,
        variantId,
        skuCode,
        listing.title || skuCode,
        listing.state || "active",
        JSON.stringify(listing),
      ],
    ));

  await pool.query(
    `
      update skus
      set product_id = $2,
          variant_id = $3,
          title = $4,
          status = $5,
          source_data = $6,
          deleted_at = null,
          updated_at = now()
      where id = $1
    `,
    [
      skuId,
      productId,
      variantId,
      listing.title || skuCode,
      listing.state || "active",
      JSON.stringify(listing),
    ],
  );

  await upsertExternalMapping(pool, {
    ...context,
    externalEntityId: externalListingId,
    externalEntityType: "etsy_listing",
    internalEntityId: skuId,
    internalEntityType: "sku",
    rawData: listing,
  });

  if (typeof listing.quantity === "number" && Number.isFinite(listing.quantity)) {
    await upsertInventoryBalance(context, skuId, listing.quantity, listing, pool);
  }
}

async function upsertInventoryBalance(
  context: ErpAccountContext,
  skuId: number,
  quantity: number,
  sourceData: unknown,
  pool: Pool,
) {
  const existing = await pool.query<{ on_hand: string }>(
    `
      select on_hand
      from inventory_balances
      where sku_id = $1
        and location_id = $2
      limit 1
    `,
    [skuId, context.defaultLocationId],
  );
  const previous = existing.rows[0] ? Number(existing.rows[0].on_hand) : 0;

  await pool.query(
    `
      insert into inventory_balances (
        organization_id,
        sku_id,
        location_id,
        on_hand,
        reserved
      )
      values ($1, $2, $3, $4, 0)
      on conflict (sku_id, location_id)
      do update set on_hand = excluded.on_hand,
                    updated_at = now()
    `,
    [context.organizationId, skuId, context.defaultLocationId, quantity],
  );

  if (!existing.rows[0] || previous !== quantity) {
    await pool.query(
      `
        insert into inventory_movements (
          organization_id,
          sku_id,
          location_id,
          movement_type,
          quantity_delta,
          balance_after,
          reference_type,
          source_data
        )
        values ($1, $2, $3, 'sync_adjustment', $4, $5, 'etsy_listing', $6)
      `,
      [
        context.organizationId,
        skuId,
        context.defaultLocationId,
        quantity - previous,
        quantity,
        JSON.stringify(sourceData ?? {}),
      ],
    );
  }
}

export async function normalizeReceiptsToErp(
  shopId: number,
  receipts: EtsyReceiptSummary[],
  pool: Pool,
) {
  if (!receipts.length || !(await erpSchemaReady(pool))) return;

  const connection = await getEtsyConnection(shopId, pool);
  if (!connection) return;

  const context = await ensureErpAccountForShop(connection, null, pool);
  if (!context) return;

  for (const receipt of receipts) {
    await normalizeReceipt(context, receipt, pool);
  }
}

async function normalizeReceipt(
  context: ErpAccountContext,
  receipt: EtsyReceiptSummary,
  pool: Pool,
) {
  const raw = rawObject(receipt);
  const externalReceiptId = String(receipt.receipt_id);
  const total = moneyAmount(receipt.grandtotal);
  const subtotal = moneyAmount(receipt.subtotal);
  const shipping = moneyAmount(receipt.total_shipping_cost);
  const tax = moneyAmount(receipt.total_tax_cost);
  const discount = moneyAmount(receipt.discount_amt);
  const currency = total.currency || subtotal.currency || "USD";
  const isPaid = boolFromRaw(raw.is_paid);
  const isShipped = boolFromRaw(raw.is_shipped);

  const customerId =
    (await findExternalMapping(pool, context, "etsy_receipt_buyer", externalReceiptId, "customer")) ??
    (await getId(
      pool,
      `
        insert into customers (
          organization_id,
          display_name,
          source_data
        )
        values ($1, $2, $3)
        returning id
      `,
      [
        context.organizationId,
        receipt.name || `Etsy buyer ${receipt.receipt_id}`,
        JSON.stringify(receipt),
      ],
    ));

  await pool.query(
    `
      update customers
      set display_name = $2,
          source_data = $3,
          updated_at = now()
      where id = $1
    `,
    [customerId, receipt.name || `Etsy buyer ${receipt.receipt_id}`, JSON.stringify(receipt)],
  );

  await upsertExternalMapping(pool, {
    ...context,
    externalEntityId: externalReceiptId,
    externalEntityType: "etsy_receipt_buyer",
    internalEntityId: customerId,
    internalEntityType: "customer",
    rawData: receipt,
  });

  const orderId =
    (await findExternalMapping(pool, context, "etsy_receipt", externalReceiptId, "order")) ??
    (await getId(
      pool,
      `
        insert into orders (
          organization_id,
          channel_account_id,
          customer_id,
          order_number,
          external_order_id,
          order_status,
          payment_status,
          fulfillment_status,
          currency_code,
          subtotal_amount,
          discount_amount,
          tax_amount,
          shipping_amount,
          total_amount,
          placed_at,
          source_data
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        returning id
      `,
      [
        context.organizationId,
        context.channelAccountId,
        customerId,
        `ETSY-${externalReceiptId}`,
        externalReceiptId,
        receipt.status ?? "open",
        isPaid === true ? "paid" : "unknown",
        isShipped === true ? "shipped" : "unknown",
        currency,
        subtotal.amount,
        discount.amount,
        tax.amount,
        shipping.amount,
        total.amount,
        timestampDate(receipt.create_timestamp),
        JSON.stringify(receipt),
      ],
    ));

  await pool.query(
    `
      update orders
      set channel_account_id = $2,
          customer_id = $3,
          external_order_id = $4,
          order_status = $5,
          payment_status = $6,
          fulfillment_status = $7,
          currency_code = $8,
          subtotal_amount = $9,
          discount_amount = $10,
          tax_amount = $11,
          shipping_amount = $12,
          total_amount = $13,
          placed_at = $14,
          source_data = $15,
          updated_at = now()
      where id = $1
    `,
    [
      orderId,
      context.channelAccountId,
      customerId,
      externalReceiptId,
      receipt.status ?? "open",
      isPaid === true ? "paid" : "unknown",
      isShipped === true ? "shipped" : "unknown",
      currency,
      subtotal.amount,
      discount.amount,
      tax.amount,
      shipping.amount,
      total.amount,
      timestampDate(receipt.create_timestamp),
      JSON.stringify(receipt),
    ],
  );

  await upsertExternalMapping(pool, {
    ...context,
    externalEntityId: externalReceiptId,
    externalEntityType: "etsy_receipt",
    internalEntityId: orderId,
    internalEntityType: "order",
    rawData: receipt,
  });

  await replaceOrderFinancialLines(context.organizationId, orderId, currency, [
    ["item_subtotal", subtotal.amount, receipt.subtotal],
    ["shipping", shipping.amount, receipt.total_shipping_cost],
    ["tax", tax.amount, receipt.total_tax_cost],
    ["discount", -Math.abs(discount.amount), receipt.discount_amt],
    ["grand_total", total.amount, receipt.grandtotal],
  ], pool);
}

async function replaceOrderFinancialLines(
  organizationId: number,
  orderId: number,
  currency: string,
  lines: Array<[string, number, unknown]>,
  pool: Pool,
) {
  await pool.query(
    "delete from order_financial_lines where order_id = $1 and source = 'etsy_receipt'",
    [orderId],
  );

  for (const [lineType, amount, sourceData] of lines) {
    if (!amount && lineType !== "grand_total") continue;

    await pool.query(
      `
        insert into order_financial_lines (
          organization_id,
          order_id,
          line_type,
          amount,
          currency_code,
          source,
          source_data
        )
        values ($1, $2, $3, $4, $5, 'etsy_receipt', $6)
      `,
      [
        organizationId,
        orderId,
        lineType,
        amount,
        currency,
        JSON.stringify(sourceData ?? {}),
      ],
    );
  }
}

export async function normalizeTransactionsToErp(
  shopId: number,
  transactions: EtsyOrderDetail[],
  pool: Pool,
) {
  if (!transactions.length || !(await erpSchemaReady(pool))) return;

  const connection = await getEtsyConnection(shopId, pool);
  if (!connection) return;

  const context = await ensureErpAccountForShop(connection, null, pool);
  if (!context) return;

  for (const transaction of transactions) {
    await normalizeTransaction(context, transaction, pool);
  }
}

async function normalizeTransaction(
  context: ErpAccountContext,
  transaction: EtsyOrderDetail,
  pool: Pool,
) {
  const externalReceiptId = String(transaction.receipt_id);
  const externalTransactionId = String(transaction.transaction_id);
  const orderId = await findExternalMapping(pool, context, "etsy_receipt", externalReceiptId, "order");
  if (!orderId) return;

  const skuId = transaction.listing_id
    ? await findExternalMapping(pool, context, "etsy_listing", String(transaction.listing_id), "sku")
    : null;
  const price = moneyAmount(transaction.price);
  const quantity = transaction.quantity ?? 0;
  const total = price.amount * quantity;

  const orderItemId =
    (await findExternalMapping(pool, context, "etsy_transaction", externalTransactionId, "order_item")) ??
    (await getId(
      pool,
      `
        insert into order_items (
          organization_id,
          order_id,
          sku_id,
          external_line_item_id,
          external_listing_id,
          title,
          quantity,
          unit_price_amount,
          total_amount,
          source_data
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        returning id
      `,
      [
        context.organizationId,
        orderId,
        skuId,
        externalTransactionId,
        transaction.listing_id ? String(transaction.listing_id) : null,
        transaction.title ?? `Transaction ${transaction.transaction_id}`,
        quantity,
        price.amount,
        total,
        JSON.stringify(transaction),
      ],
    ));

  await pool.query(
    `
      update order_items
      set sku_id = $2,
          external_listing_id = $3,
          title = $4,
          quantity = $5,
          unit_price_amount = $6,
          total_amount = $7,
          source_data = $8,
          updated_at = now()
      where id = $1
    `,
    [
      orderItemId,
      skuId,
      transaction.listing_id ? String(transaction.listing_id) : null,
      transaction.title ?? `Transaction ${transaction.transaction_id}`,
      quantity,
      price.amount,
      total,
      JSON.stringify(transaction),
    ],
  );

  await upsertExternalMapping(pool, {
    ...context,
    externalEntityId: externalTransactionId,
    externalEntityType: "etsy_transaction",
    externalParentId: externalReceiptId,
    internalEntityId: orderItemId,
    internalEntityType: "order_item",
    rawData: transaction,
  });
}

async function getEtsyConnection(shopId: number, pool: Pool) {
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

export async function backfillErpFromEtsy(pool: Pool) {
  if (!(await erpSchemaReady(pool))) {
    throw new Error("ERP schema is missing. Run npm run db:migrate first.");
  }

  const shops = await pool.query<{
    shop_id: string;
    connection: EtsyConnection;
    shop_data: EtsyShopSummary | null;
  }>(
    `
      select shop_id, connection, shop_data
      from etsy_shops
      where active = true
      order by shop_name asc
    `,
  );

  for (const shop of shops.rows) {
    const shopId = numericId(shop.shop_id);
    await ensureErpAccountForShop(shop.connection, shop.shop_data, pool);

    const [listings, receipts, transactions] = await Promise.all([
      pool.query<{ data: EtsyListingSummary }>(
        "select data from etsy_listings where shop_id = $1 order by listing_id asc",
        [shopId],
      ),
      pool.query<{ data: EtsyReceiptSummary }>(
        "select data from etsy_receipts where shop_id = $1 order by receipt_id asc",
        [shopId],
      ),
      pool.query<{ data: EtsyOrderDetail }>(
        "select data from etsy_receipt_transactions where shop_id = $1 order by transaction_id asc",
        [shopId],
      ),
    ]);

    await normalizeListingsToErp(shopId, listings.rows.map((row) => row.data), pool);
    await normalizeReceiptsToErp(shopId, receipts.rows.map((row) => row.data), pool);
    await normalizeTransactionsToErp(shopId, transactions.rows.map((row) => row.data), pool);
  }
}

export async function getWorkspaceShell(pool: Pool, organizationId: number, accountId?: number | null) {
  const result = await pool.query<{
    account_id: string;
    display_name: string;
    external_account_id: string;
    channel_code: string;
    channel_name: string;
    status: string;
  }>(
    `
      select
        account.id as account_id,
        account.display_name,
        account.external_account_id,
        channel.code as channel_code,
        channel.name as channel_name,
        account.status
      from channel_accounts account
      join sales_channels channel on channel.id = account.channel_id
      where account.organization_id = $1
        and account.deleted_at is null
        and ($2::bigint is null or account.id = $2)
      order by account.display_name asc
    `,
    [organizationId, accountId ?? null],
  );

  return result.rows.map((row) => ({
    accountId: numericId(row.account_id),
    channelCode: row.channel_code,
    channelName: row.channel_name,
    displayName: row.display_name,
    externalAccountId: row.external_account_id,
    status: row.status,
  }));
}

export async function getEtsyErpAccount(
  pool: Pool,
  shopId: number,
  organizationId: number,
): Promise<ErpChannelAccount | null> {
  if (!(await erpSchemaReady(pool))) {
    return null;
  }

  const result = await pool.query<{
    account_id: string;
    channel_code: string;
    channel_id: string;
    display_name: string;
    external_account_id: string;
    organization_id: string;
    status: string;
  }>(
    `
      select
        account.id as account_id,
        account.organization_id,
        account.channel_id,
        account.external_account_id,
        account.display_name,
        account.status,
        channel.code as channel_code
      from channel_accounts account
      join sales_channels channel on channel.id = account.channel_id
      where account.organization_id = $1
        and account.external_account_id = $2
        and account.deleted_at is null
        and channel.code = 'etsy'
      limit 1
    `,
    [organizationId, String(shopId)],
  );
  const row = result.rows[0];

  if (!row) {
    return null;
  }

  return {
    accountId: numericId(row.account_id),
    channelCode: row.channel_code,
    channelId: numericId(row.channel_id),
    displayName: row.display_name,
    externalAccountId: row.external_account_id,
    organizationId: numericId(row.organization_id),
    status: row.status,
  };
}

export async function getDashboardMetrics(
  pool: Pool,
  organizationId: number,
  accountId?: number | null,
) {
  const result = await pool.query<{
    total_revenue: string;
    order_count: string;
    average_order: string;
    active_products: string;
    total_on_hand: string;
    low_stock_count: string;
  }>(
    `
      select
        coalesce(sum(orders.total_amount), 0)::text as total_revenue,
        count(distinct orders.id)::text as order_count,
        coalesce(avg(orders.total_amount), 0)::text as average_order,
        (
          select count(*)::text
          from products product
          where product.organization_id = $1
            and product.deleted_at is null
            and product.status = 'active'
            and (
              $2::bigint is null
              or not (product.source_data ? 'shop_id')
              or product.source_data->>'shop_id' = (
                select account.external_account_id
                from channel_accounts account
                where account.id = $2
                  and account.organization_id = $1
              )
            )
            and (
              $2::bigint is null
              or exists (
                select 1
                from external_entity_mappings mapping
                where mapping.organization_id = $1
                  and mapping.channel_account_id = $2
                  and mapping.internal_entity_type = 'product'
                  and mapping.internal_entity_id = product.id
              )
            )
        ) as active_products,
        (
          select coalesce(sum(balance.on_hand), 0)::text
          from inventory_balances balance
          join skus sku on sku.id = balance.sku_id
          where balance.organization_id = $1
            and sku.deleted_at is null
            and (
              $2::bigint is null
              or not (sku.source_data ? 'shop_id')
              or sku.source_data->>'shop_id' = (
                select account.external_account_id
                from channel_accounts account
                where account.id = $2
                  and account.organization_id = $1
              )
            )
            and (
              $2::bigint is null
              or exists (
                select 1
                from external_entity_mappings mapping
                where mapping.organization_id = $1
                  and mapping.channel_account_id = $2
                  and mapping.internal_entity_type = 'sku'
                  and mapping.internal_entity_id = sku.id
              )
            )
        ) as total_on_hand,
        (
          select count(*)::text
          from inventory_balances balance
          join skus sku on sku.id = balance.sku_id
          where balance.organization_id = $1
            and sku.deleted_at is null
            and balance.available <= 3
            and (
              $2::bigint is null
              or not (sku.source_data ? 'shop_id')
              or sku.source_data->>'shop_id' = (
                select account.external_account_id
                from channel_accounts account
                where account.id = $2
                  and account.organization_id = $1
              )
            )
            and (
              $2::bigint is null
              or exists (
                select 1
                from external_entity_mappings mapping
                where mapping.organization_id = $1
                  and mapping.channel_account_id = $2
                  and mapping.internal_entity_type = 'sku'
                  and mapping.internal_entity_id = sku.id
              )
            )
        ) as low_stock_count
      from orders
      where orders.organization_id = $1
        and orders.deleted_at is null
        and ($2::bigint is null or orders.channel_account_id = $2)
    `,
    [organizationId, accountId ?? null],
  );

  const row = result.rows[0];
  return {
    activeProducts: Number(row.active_products),
    averageOrder: Number(row.average_order),
    lowStockCount: Number(row.low_stock_count),
    orderCount: Number(row.order_count),
    totalOnHand: Number(row.total_on_hand),
    totalRevenue: Number(row.total_revenue),
  };
}

export async function getProductList(
  pool: Pool,
  organizationId: number,
  options: ProductListOptions = {},
) {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);

  const result = await pool.query<{
    available: string;
    external_listing_id: string | null;
    on_hand: string;
    product_id: string;
    product_source_data: EtsyListingSummary | null;
    product_status: string;
    product_title: string;
    reserved: string;
    sku_code: string;
    sku_id: string;
    sku_title: string;
    updated_at: Date | string | null;
  }>(
    `
      select
        product.id as product_id,
        product.title as product_title,
        product.status as product_status,
        product.source_data as product_source_data,
        product.updated_at,
        product_mapping.external_entity_id as external_listing_id,
        sku.id as sku_id,
        sku.sku_code,
        sku.title as sku_title,
        coalesce(balance.on_hand, 0)::text as on_hand,
        coalesce(balance.reserved, 0)::text as reserved,
        coalesce(balance.available, 0)::text as available
      from products product
      join skus sku on sku.product_id = product.id
      left join inventory_balances balance on balance.sku_id = sku.id
      left join external_entity_mappings product_mapping
        on product_mapping.organization_id = product.organization_id
       and product_mapping.internal_entity_type = 'product'
       and product_mapping.internal_entity_id = product.id
       and product_mapping.channel_account_id = $6
      where product.organization_id = $1
        and product.deleted_at is null
        and ($2::text is null or product.status = $2)
        and ($3::text is null or product.title ilike '%' || $3 || '%' or sku.sku_code ilike '%' || $3 || '%')
        and (
          $6::bigint is null
          or not (product.source_data ? 'shop_id')
          or product.source_data->>'shop_id' = (
            select account.external_account_id
            from channel_accounts account
            where account.id = $6
              and account.organization_id = $1
          )
        )
        and (
          $6::bigint is null
          or exists (
            select 1
            from external_entity_mappings mapping
            where mapping.organization_id = $1
              and mapping.channel_account_id = $6
              and mapping.internal_entity_type = 'product'
              and mapping.internal_entity_id = product.id
          )
        )
      order by product.updated_at desc, product.id desc
      limit $4 offset $5
    `,
    [organizationId, options.status ?? null, options.search ?? null, limit, offset, options.accountId ?? null],
  );

  return result.rows.map((row): ErpProductListRow => ({
    available: Number(row.available),
    externalListingId: row.external_listing_id,
    onHand: Number(row.on_hand),
    productId: numericId(row.product_id),
    productSourceData: row.product_source_data,
    productStatus: row.product_status,
    productTitle: row.product_title,
    reserved: Number(row.reserved),
    skuCode: row.sku_code,
    skuId: numericId(row.sku_id),
    skuTitle: row.sku_title,
    updatedAt: row.updated_at,
  }));
}

export async function getOrderList(
  pool: Pool,
  organizationId: number,
  options: OrderListOptions = {},
) {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);

  const result = await pool.query<{
    currency_code: string;
    customer_name: string | null;
    external_order_id: string | null;
    fulfillment_status: string;
    order_id: string;
    order_number: string;
    order_source_data: EtsyReceiptSummary | null;
    order_status: string;
    payment_status: string;
    placed_at: Date | string | null;
    total_amount: string;
  }>(
    `
      select
        orders.id as order_id,
        orders.order_number,
        orders.external_order_id,
        orders.order_status,
        orders.payment_status,
        orders.fulfillment_status,
        orders.currency_code,
        orders.total_amount::text,
        orders.placed_at,
        orders.source_data as order_source_data,
        customers.display_name as customer_name
      from orders
      left join customers on customers.id = orders.customer_id
      where orders.organization_id = $1
        and orders.deleted_at is null
        and ($2::text is null or orders.order_status = $2)
        and ($5::bigint is null or orders.channel_account_id = $5)
      order by orders.placed_at desc nulls last, orders.id desc
      limit $3 offset $4
    `,
    [organizationId, options.status ?? null, limit, offset, options.accountId ?? null],
  );

  return result.rows.map((row): ErpOrderListRow => ({
    currencyCode: row.currency_code,
    customerName: row.customer_name,
    externalOrderId: row.external_order_id,
    fulfillmentStatus: row.fulfillment_status,
    orderId: numericId(row.order_id),
    orderNumber: row.order_number,
    orderSourceData: row.order_source_data,
    orderStatus: row.order_status,
    paymentStatus: row.payment_status,
    placedAt: row.placed_at,
    totalAmount: Number(row.total_amount),
  }));
}

export async function getOrderItemList(
  pool: Pool,
  organizationId: number,
  options: OrderItemListOptions = {},
) {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const offset = Math.max(options.offset ?? 0, 0);

  const result = await pool.query<{
    currency_code: string;
    external_line_item_id: string | null;
    external_listing_id: string | null;
    external_order_id: string | null;
    item_source_data: EtsyOrderDetail | null;
    order_item_id: string;
    order_source_data: EtsyReceiptSummary | null;
    quantity: string;
    title: string;
    unit_price_amount: string;
  }>(
    `
      select
        item.id as order_item_id,
        item.external_line_item_id,
        item.external_listing_id,
        item.title,
        item.quantity::text,
        item.unit_price_amount::text,
        item.source_data as item_source_data,
        orders.external_order_id,
        orders.currency_code,
        orders.source_data as order_source_data
      from order_items item
      join orders on orders.id = item.order_id
      where item.organization_id = $1
        and item.deleted_at is null
        and orders.deleted_at is null
        and ($2::bigint is null or orders.channel_account_id = $2)
      order by orders.placed_at desc nulls last, item.id desc
      limit $3 offset $4
    `,
    [organizationId, options.accountId ?? null, limit, offset],
  );

  return result.rows.map((row): ErpOrderItemListRow => ({
    currencyCode: row.currency_code,
    externalLineItemId: row.external_line_item_id,
    externalListingId: row.external_listing_id,
    externalOrderId: row.external_order_id,
    itemSourceData: row.item_source_data,
    orderItemId: numericId(row.order_item_id),
    orderSourceData: row.order_source_data,
    quantity: Number(row.quantity),
    title: row.title,
    unitPriceAmount: Number(row.unit_price_amount),
  }));
}

export async function getInventorySummary(
  pool: Pool,
  organizationId: number,
  accountId?: number | null,
) {
  const result = await pool.query<{
    sku_count: string;
    on_hand: string;
    reserved: string;
    available: string;
    low_stock_count: string;
  }>(
    `
      select
        count(distinct sku.id)::text as sku_count,
        coalesce(sum(balance.on_hand), 0)::text as on_hand,
        coalesce(sum(balance.reserved), 0)::text as reserved,
        coalesce(sum(balance.available), 0)::text as available,
        count(*) filter (where balance.available <= 3)::text as low_stock_count
      from inventory_balances balance
      join skus sku on sku.id = balance.sku_id
      where balance.organization_id = $1
        and sku.deleted_at is null
        and (
          $2::bigint is null
          or not (sku.source_data ? 'shop_id')
          or sku.source_data->>'shop_id' = (
            select account.external_account_id
            from channel_accounts account
            where account.id = $2
              and account.organization_id = $1
          )
        )
        and (
          $2::bigint is null
          or exists (
            select 1
            from external_entity_mappings mapping
            where mapping.organization_id = $1
              and mapping.channel_account_id = $2
              and mapping.internal_entity_type = 'sku'
              and mapping.internal_entity_id = sku.id
          )
        )
    `,
    [organizationId, accountId ?? null],
  );

  const row = result.rows[0];
  return {
    available: Number(row.available),
    lowStockCount: Number(row.low_stock_count),
    onHand: Number(row.on_hand),
    reserved: Number(row.reserved),
    skuCount: Number(row.sku_count),
  };
}

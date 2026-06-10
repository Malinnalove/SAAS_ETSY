import { existsSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Pool } from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

function loadLocalEnv() {
  const envPath = path.join(rootDir, "local.env");
  if (!existsSync(envPath)) return;

  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

function money(value) {
  if (!value) return { amount: 0, currency: "USD" };
  return {
    amount: Number(value.amount ?? 0) / Number(value.divisor || 1),
    currency: value.currency_code ?? "USD",
  };
}

function ts(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0 ? new Date(Number(value) * 1000) : null;
}

async function id(pool, sql, params = []) {
  const result = await pool.query(sql, params);
  return Number(result.rows[0].id);
}

async function ready(pool) {
  const result = await pool.query("select to_regclass('public.products') is not null as ready");
  return result.rows[0]?.ready === true;
}

async function ensureContext(pool, shop) {
  const orgId = await id(
    pool,
    `
      insert into organizations (name, slug)
      values ('Default Organization', 'default')
      on conflict (slug) do update set updated_at = now()
      returning id
    `,
  );
  const channelId = await id(
    pool,
    `
      insert into sales_channels (code, name)
      values ('etsy', 'Etsy')
      on conflict (code) do update set name = excluded.name, updated_at = now()
      returning id
    `,
  );
  const locationId = await id(
    pool,
    `
      insert into locations (organization_id, code, name, location_type)
      values ($1, 'default', 'Default Warehouse', 'warehouse')
      on conflict (organization_id, code) do update set updated_at = now()
      returning id
    `,
    [orgId],
  );
  const connection = shop.connection;
  const shopData = shop.shop_data ?? {};
  const accountId = await id(
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
      do update set display_name = excluded.display_name,
                    external_data = excluded.external_data,
                    status = 'active',
                    updated_at = now(),
                    deleted_at = null
      returning id
    `,
    [
      orgId,
      channelId,
      String(connection.shopId),
      connection.shopName ?? shopData.shop_name ?? `Etsy Shop ${shop.shop_id}`,
      JSON.stringify(shopData),
      connection.connectedAt ? new Date(connection.connectedAt) : null,
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
      accountId,
      connection.accessToken,
      connection.refreshToken,
      connection.scopes ?? [],
      connection.expiresAt ? new Date(connection.expiresAt) : null,
      JSON.stringify(connection),
    ],
  );

  await upsertMapping(pool, {
    accountId,
    channelId,
    externalEntityId: String(connection.shopId),
    externalEntityType: "etsy_shop",
    internalEntityId: accountId,
    internalEntityType: "channel_account",
    orgId,
    rawData: shopData,
  });

  return { accountId, channelId, locationId, orgId };
}

async function findMapping(pool, context, externalEntityType, externalEntityId, internalEntityType) {
  const result = await pool.query(
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
    [context.channelId, context.accountId, externalEntityType, externalEntityId, internalEntityType],
  );
  return result.rows[0] ? Number(result.rows[0].internal_entity_id) : null;
}

async function upsertMapping(pool, input) {
  const existing = await pool.query(
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
      input.accountId,
      input.externalEntityType,
      input.externalEntityId,
      input.internalEntityType,
    ],
  );

  if (existing.rows[0]) {
    await pool.query(
      `
        update external_entity_mappings
        set internal_entity_id = $2,
            raw_data = $3,
            updated_at = now()
        where id = $1
      `,
      [existing.rows[0].id, input.internalEntityId, JSON.stringify(input.rawData ?? {})],
    );
    return Number(existing.rows[0].id);
  }

  return id(
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
      input.orgId,
      input.channelId,
      input.accountId,
      input.internalEntityType,
      input.internalEntityId,
      input.externalEntityType,
      input.externalEntityId,
      input.externalParentId ?? null,
      JSON.stringify(input.rawData ?? {}),
    ],
  );
}

async function backfillListing(pool, context, shopId, listing) {
  const externalId = String(listing.listing_id);
  let productId = await findMapping(pool, context, "etsy_listing", externalId, "product");
  if (!productId) {
    productId = await id(
      pool,
      `
        insert into products (organization_id, title, description, status, source_data)
        values ($1, $2, $3, $4, $5)
        returning id
      `,
      [
        context.orgId,
        listing.title || `Etsy Listing ${externalId}`,
        listing.description ?? null,
        listing.state || "active",
        JSON.stringify(listing),
      ],
    );
  }
  await pool.query(
    "update products set title = $2, description = coalesce($3, description), status = $4, source_data = $5, updated_at = now() where id = $1",
    [productId, listing.title || `Etsy Listing ${externalId}`, listing.description ?? null, listing.state || "active", JSON.stringify(listing)],
  );
  await upsertMapping(pool, { ...context, externalEntityId: externalId, externalEntityType: "etsy_listing", internalEntityId: productId, internalEntityType: "product", rawData: listing });

  let variantId = await findMapping(pool, context, "etsy_listing", externalId, "product_variant");
  if (!variantId) {
    variantId = await id(
      pool,
      `
        insert into product_variants (organization_id, product_id, title, status, source_data)
        values ($1, $2, $3, $4, $5)
        returning id
      `,
      [context.orgId, productId, listing.title || `Variant ${externalId}`, listing.state || "active", JSON.stringify(listing)],
    );
  }
  await upsertMapping(pool, { ...context, externalEntityId: externalId, externalEntityType: "etsy_listing", internalEntityId: variantId, internalEntityType: "product_variant", rawData: listing });

  const skuCode = typeof listing.sku === "string" && listing.sku.trim()
    ? listing.sku.trim()
    : `ETSY-${shopId}-${externalId}`;
  let skuId = await findMapping(pool, context, "etsy_listing", externalId, "sku");
  if (!skuId) {
    skuId = await id(
      pool,
      `
        insert into skus (organization_id, product_id, variant_id, sku_code, title, status, source_data)
        values ($1, $2, $3, $4, $5, $6, $7)
        on conflict (organization_id, sku_code)
        do update set product_id = excluded.product_id,
                      variant_id = excluded.variant_id,
                      title = excluded.title,
                      status = excluded.status,
                      source_data = excluded.source_data,
                      updated_at = now()
        returning id
      `,
      [context.orgId, productId, variantId, skuCode, listing.title || skuCode, listing.state || "active", JSON.stringify(listing)],
    );
  }
  await upsertMapping(pool, { ...context, externalEntityId: externalId, externalEntityType: "etsy_listing", internalEntityId: skuId, internalEntityType: "sku", rawData: listing });

  if (Number.isFinite(Number(listing.quantity))) {
    const quantity = Number(listing.quantity);
    const existing = await pool.query(
      "select on_hand from inventory_balances where sku_id = $1 and location_id = $2",
      [skuId, context.locationId],
    );
    const previous = existing.rows[0] ? Number(existing.rows[0].on_hand) : 0;
    await pool.query(
      `
        insert into inventory_balances (organization_id, sku_id, location_id, on_hand, reserved)
        values ($1, $2, $3, $4, 0)
        on conflict (sku_id, location_id)
        do update set on_hand = excluded.on_hand, updated_at = now()
      `,
      [context.orgId, skuId, context.locationId, quantity],
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
            reference_id,
            source_data
          )
          values ($1, $2, $3, 'sync_adjustment', $4, $5, 'etsy_listing', $6, $7)
        `,
        [context.orgId, skuId, context.locationId, quantity - previous, quantity, externalId, JSON.stringify(listing)],
      );
    }
  }
}

async function backfillReceipt(pool, context, receipt) {
  const externalId = String(receipt.receipt_id);
  const total = money(receipt.grandtotal);
  const subtotal = money(receipt.subtotal);
  const shipping = money(receipt.total_shipping_cost);
  const tax = money(receipt.total_tax_cost);
  const discount = money(receipt.discount_amt);
  const raw = receipt ?? {};
  let customerId = await findMapping(pool, context, "etsy_receipt_buyer", externalId, "customer");
  if (!customerId) {
    customerId = await id(
      pool,
      `
        insert into customers (organization_id, display_name, source_data)
        values ($1, $2, $3)
        returning id
      `,
      [context.orgId, receipt.name || `Etsy buyer ${externalId}`, JSON.stringify(receipt)],
    );
  }
  await pool.query(
    "update customers set display_name = $2, source_data = $3, updated_at = now() where id = $1",
    [customerId, receipt.name || `Etsy buyer ${externalId}`, JSON.stringify(receipt)],
  );
  await upsertMapping(pool, { ...context, externalEntityId: externalId, externalEntityType: "etsy_receipt_buyer", internalEntityId: customerId, internalEntityType: "customer", rawData: receipt });

  let orderId = await findMapping(pool, context, "etsy_receipt", externalId, "order");
  if (!orderId) {
    orderId = await id(
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
        context.orgId,
        context.accountId,
        customerId,
        `ETSY-${externalId}`,
        externalId,
        receipt.status ?? "open",
        raw.is_paid === true ? "paid" : "unknown",
        raw.is_shipped === true ? "shipped" : "unknown",
        total.currency,
        subtotal.amount,
        discount.amount,
        tax.amount,
        shipping.amount,
        total.amount,
        ts(receipt.create_timestamp),
        JSON.stringify(receipt),
      ],
    );
  }
  await pool.query(
    `
      update orders
      set customer_id = $2,
          order_status = $3,
          payment_status = $4,
          fulfillment_status = $5,
          total_amount = $6,
          source_data = $7,
          updated_at = now()
      where id = $1
    `,
    [orderId, customerId, receipt.status ?? "open", raw.is_paid === true ? "paid" : "unknown", raw.is_shipped === true ? "shipped" : "unknown", total.amount, JSON.stringify(receipt)],
  );
  await upsertMapping(pool, { ...context, externalEntityId: externalId, externalEntityType: "etsy_receipt", internalEntityId: orderId, internalEntityType: "order", rawData: receipt });

  await pool.query("delete from order_financial_lines where order_id = $1 and source = 'etsy_receipt'", [orderId]);
  for (const [lineType, amount, data] of [
    ["item_subtotal", subtotal.amount, receipt.subtotal],
    ["shipping", shipping.amount, receipt.total_shipping_cost],
    ["tax", tax.amount, receipt.total_tax_cost],
    ["discount", -Math.abs(discount.amount), receipt.discount_amt],
    ["grand_total", total.amount, receipt.grandtotal],
  ]) {
    if (!amount && lineType !== "grand_total") continue;
    await pool.query(
      `
        insert into order_financial_lines (organization_id, order_id, line_type, amount, currency_code, source, source_data)
        values ($1, $2, $3, $4, $5, 'etsy_receipt', $6)
      `,
      [context.orgId, orderId, lineType, amount, total.currency, JSON.stringify(data ?? {})],
    );
  }
}

async function backfillTransaction(pool, context, transaction) {
  const orderId = await findMapping(pool, context, "etsy_receipt", String(transaction.receipt_id), "order");
  if (!orderId) return;

  const externalId = String(transaction.transaction_id);
  const skuId = transaction.listing_id
    ? await findMapping(pool, context, "etsy_listing", String(transaction.listing_id), "sku")
    : null;
  const price = money(transaction.price);
  const quantity = Number(transaction.quantity ?? 0);
  const total = price.amount * quantity;

  let itemId = await findMapping(pool, context, "etsy_transaction", externalId, "order_item");
  if (!itemId) {
    itemId = await id(
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
        context.orgId,
        orderId,
        skuId,
        externalId,
        transaction.listing_id ? String(transaction.listing_id) : null,
        transaction.title ?? `Transaction ${externalId}`,
        quantity,
        price.amount,
        total,
        JSON.stringify(transaction),
      ],
    );
  }
  await upsertMapping(pool, { ...context, externalEntityId: externalId, externalEntityType: "etsy_transaction", externalParentId: String(transaction.receipt_id), internalEntityId: itemId, internalEntityType: "order_item", rawData: transaction });
}

loadLocalEnv();

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required to backfill ERP tables.");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

try {
  if (!(await ready(pool))) {
    throw new Error("ERP schema is missing. Run npm run db:migrate first.");
  }

  const shops = await pool.query(
    "select shop_id, connection, shop_data from etsy_shops where active = true order by shop_name asc",
  );

  for (const shop of shops.rows) {
    const shopId = Number(shop.shop_id);
    const context = await ensureContext(pool, shop);
    const listings = await pool.query("select data from etsy_listings where shop_id = $1 order by listing_id asc", [shopId]);
    const receipts = await pool.query("select data from etsy_receipts where shop_id = $1 order by receipt_id asc", [shopId]);
    const transactions = await pool.query("select data from etsy_receipt_transactions where shop_id = $1 order by transaction_id asc", [shopId]);

    for (const row of listings.rows) await backfillListing(pool, context, shopId, row.data);
    for (const row of receipts.rows) await backfillReceipt(pool, context, row.data);
    for (const row of transactions.rows) await backfillTransaction(pool, context, row.data);

    console.log(`Backfilled shop ${shopId}: ${listings.rowCount} listings, ${receipts.rowCount} receipts, ${transactions.rowCount} transactions`);
  }
} finally {
  await pool.end();
}

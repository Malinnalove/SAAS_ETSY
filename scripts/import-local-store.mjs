import { existsSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Pool } from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const storePath = path.join(rootDir, "data", "app.json");

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

loadLocalEnv();

const databaseUrl =
  process.env.DATABASE_URL ??
  process.env.DATABASE_POSTGRES_URL_NON_POOLING ??
  process.env.DATABASE_POSTGRES_URL ??
  process.env.DATABASE_POSTGRES_PRISMA_URL;

if (!databaseUrl) {
  console.error("DATABASE_URL is required to import data/app.json.");
  process.exit(1);
}

if (!existsSync(storePath)) {
  console.error(`Local store file was not found: ${storePath}`);
  process.exit(1);
}

const store = JSON.parse(readFileSync(storePath, "utf8"));
const shops = store.shops ?? (store.connection ? [{ connection: store.connection }] : []);
const shopCount = shops.length;
const listingCount = store.shops
  ? store.shops.reduce((total, shop) => total + (shop.listings?.length ?? 0), 0)
  : store.listings?.length ?? 0;
const receiptCount = store.shops
  ? store.shops.reduce((total, shop) => total + (shop.receipts?.length ?? 0), 0)
  : store.receipts?.length ?? 0;
const orderDetailCount = store.shops
  ? store.shops.reduce((total, shop) => total + (shop.orderDetails?.length ?? 0), 0)
  : store.orderDetails?.length ?? 0;

const pool = new Pool({ connectionString: databaseUrl });

try {
  await pool.query(`
    create table if not exists app_store (
      key text primary key,
      data jsonb not null,
      updated_at timestamptz not null default now()
    )
  `);

  await pool.query(
    `
      insert into app_store (key, data, updated_at)
      values ($1, $2::jsonb, now())
      on conflict (key)
      do update set data = excluded.data, updated_at = now()
    `,
    ["default", JSON.stringify(store)],
  );

  console.log("Imported data/app.json into app_store.");
  console.log(`Shops: ${shopCount}`);
  console.log(`Listings: ${listingCount}`);
  console.log(`Receipts: ${receiptCount}`);
  console.log(`Order details: ${orderDetailCount}`);
  console.log("Open /api/etsy/status once to let the app normalize the imported store.");
} finally {
  await pool.end();
}

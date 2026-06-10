# EtsyCore Commerce OS

Dashboard-first SaaS starter for connecting an Etsy shop, receiving webhook events, queueing sync jobs, and serving the frontend from your own database.

## Setup

1. Create an Etsy app at https://developer.etsy.com/
2. Add this callback URL in the Etsy app settings:

```text
http://localhost:3000/api/etsy/callback
```

3. Fill `local.env`. This project loads `local.env` automatically during Next startup.

```text
ETSY_CLIENT_ID=your_etsy_keystring
ETSY_REDIRECT_URI=http://localhost:3000/api/etsy/callback
ETSY_SCOPES=address_r address_w billing_r cart_r cart_w email_r favorites_r favorites_w feedback_r listings_d listings_r listings_w profile_r profile_w recommend_r recommend_w shops_r shops_w transactions_r transactions_w
APP_URL=http://localhost:3000
# Required for webhook events, sync jobs, and structured orders:
DATABASE_URL=postgresql://postgres:password@localhost:5432/etsy_saas
# Optional hardening:
ETSY_WEBHOOK_SECRET=your_etsy_webhook_signing_secret
SYNC_CRON_SECRET=your_private_cron_secret
```

If your file uses labels like `Keystring: ...` and `shared secret: ...`, the starter will also recognize those for local development.

4. Install and run:

```bash
npm install
npm run dev
```

On this machine, Node.js is installed in `D:\AAA\node`, so you can also start the app with:

```powershell
.\dev.cmd
```

5. Open http://localhost:3000 and click **Connect Etsy Shop**.

## Sync Architecture

The app now uses a database-backed sync pipeline:

```text
Etsy Webhook / scheduled cron / manual sync
→ etsy_webhook_events and etsy_sync_jobs
→ queued worker processor
→ structured PostgreSQL tables
→ dashboard reads your database
```

The frontend does not poll Etsy. It reads locally stored shop, listing, receipt, transaction, and shipment data.

## ERP Data Model

The project now has a first-phase commerce ERP schema alongside the legacy Etsy raw sync tables.

Run the ERP schema migration and historical Etsy backfill with:

```bash
npm run db:setup:erp
```

Or run the two steps separately:

```bash
npm run db:migrate
npm run db:backfill:erp
```

The migration creates:

- multi-tenant foundations: `organizations`, `users`, `roles`, `organization_memberships`
- channel foundations: `sales_channels`, `channel_accounts`, `channel_credentials`, `external_entity_mappings`
- product master data: `products`, `product_variants`, `skus`, product attributes, and media
- inventory: `locations`, `inventory_balances`, `inventory_movements`, `inventory_reservations`
- orders and reconciliation: `customers`, `orders`, `order_items`, payments, fulfillments, and `order_financial_lines`
- platform-neutral sync tables: `sync_jobs`, `sync_cursors`, `webhook_events`

Current Etsy sync still writes the existing `etsy_*` raw tables first. After those writes, the app attempts to normalize the changed listings, receipts, and transactions into the ERP tables. If the ERP migration has not been applied yet, normalization is skipped and the existing Etsy workflow continues to run.

For the current no-login local app, existing Etsy shops are backfilled into a single `Default Organization`. Future user/team onboarding can split or assign organizations without changing the product, inventory, order, and channel account model.

## Endpoints

- `POST /api/etsy/webhook` receives Etsy webhooks, records the raw event, and queues the right sync job.
- `GET|POST /api/sync/cron` enqueues scheduled order catch-up work for every active shop and processes a small batch.
- `GET /api/sync/jobs` returns queue/webhook status.
- `POST /api/sync/jobs` processes queued jobs.
- `POST /api/etsy/sync?shopId=...` queues a manual incremental sync and processes the queued job(s). Use `forceFull=true` or `mode=full` only when you need a full repair refresh.

If `SYNC_CRON_SECRET` is set, call cron/worker routes with one of:

```text
Authorization: Bearer your_private_cron_secret
x-sync-secret: your_private_cron_secret
?secret=your_private_cron_secret
```

Recommended schedule:

- Run `/api/sync/cron` every 15 minutes for all-shop order catch-up.
- Run `/api/sync/jobs` every 1-5 minutes if your host supports a separate worker/cron.
- Keep Etsy webhooks pointed at `/api/etsy/webhook` for order events such as paid, shipped, canceled, and delivered.

The scheduled cron path checks receipts with a 2-hour lookback from the last receipt cursor, but only queues receipt detail sync for new or changed receipts. Listing/catalog sync is throttled in code to run at most once per shop per day.

## What this starter includes

- Etsy OAuth2 + PKCE connect flow
- Access token exchange and refresh
- Shop lookup after authorization
- Webhook event ingestion with duplicate delivery tracking
- Database-backed sync job queue with retry/backoff
- Manual incremental sync routed through the queue, with an explicit full-refresh escape hatch
- Scheduled incremental receipt sync
- Low-frequency active listing sync
- Etsy listing title and active/inactive status writeback from the Products page with `listings_w`
- Structured PostgreSQL tables for shops, listings, receipts, transactions, shipments, webhook events, jobs, and cursors
- Legacy `app_store` / `data/app.json` migration into structured tables

## Listing writeback

The Products page can push listing title changes and active/inactive status changes back to Etsy.
This uses Etsy's `updateListing` endpoint, so the connected shop token must include `listings_w`.

After changing `ETSY_SCOPES`, reconnect the Etsy shop so Etsy issues a token with the new write
permission. Existing tokens keep their original scopes.

Inventory and price writeback should be implemented through Etsy's `updateListingInventory`
endpoint because Etsy requires complete products, offerings, and property values for those updates.

## Production notes

- Encrypt refresh tokens at rest.
- Add your own user login before allowing multiple sellers.
- Configure hosted cron jobs for `/api/sync/cron` and `/api/sync/jobs`.
- Set `ETSY_WEBHOOK_SECRET` in production and reject unsigned webhook traffic.
- Monitor Etsy API limits and keep orders higher priority than listing/analytics sync.

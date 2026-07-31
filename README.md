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
# Runtime database role (no CREATE / ALTER / DROP privileges):
DATABASE_URL=postgresql://postgres:password@localhost:5432/etsy_saas
# Migration/recovery role; optional locally when DATABASE_URL is privileged:
DATABASE_MIGRATION_URL=postgresql://migration_role:password@localhost:5432/etsy_saas
# Independent authentication secrets (use random 32+ byte values):
AUTH_SESSION_SECRET=base64_encoded_random_value
AUTH_CSRF_SECRET=a_different_base64_encoded_random_value
AUTH_RATE_LIMIT_SECRET=a_different_base64_encoded_random_value
AUTH_MFA_ENCRYPTION_KEY=a_different_base64_encoded_random_value
# Optional hardening:
ETSY_WEBHOOK_SECRET=your_etsy_webhook_signing_secret
SYNC_CRON_SECRET=your_private_cron_secret
```

If your file uses labels like `Keystring: ...` and `shared secret: ...`, the starter will also recognize those for local development.

Run migrations before authentication setup:

```bash
npm run db:migrate
```

Existing installations migrate their current Owner to the single Admin role. On a new database, create the initial Admin exactly once with:

```bash
npm run auth:bootstrap -- AdminUsername "a-long-unique-password"
```

If the only Admin loses access, run the server-side recovery command. It issues a 24-hour temporary password and revokes every existing session:

```bash
npm run auth:reset -- AdminUsername
```

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

Login never creates tables or accounts. The application supports one Admin plus Operator and Viewer members. Admin creates members under **Settings → Members**; temporary passwords must be changed on first login.

Role defaults:

- Admin: members, system security, shops, sync, Listing writes, and all reads.
- Operator: Admin assigns each shop as no access, view, or edit. Edit access enables Listing writes, order operations, and manual sync for that shop.
- Viewer: Admin assigns view access per shop; Viewer can never receive edit access.

Shop access is managed under **Settings → Members**. Unassigned shops are omitted from that member's workspace and rejected independently by APIs and Server Actions.

Sessions are opaque, database-backed, revocable, idle for at most 12 hours, and valid for at most 7 days. The Admin can optionally enable TOTP and recovery codes under **Settings → Security**.

Authentication and member request bodies are capped at 8 KB. All state-changing browser requests require an exact same-origin check plus a per-session CSRF token; OAuth callbacks, signed webhooks, and Bearer-protected cron routes are the only explicit exceptions.

Run expired-session and audit retention cleanup on a daily schedule:

```bash
npm run auth:cleanup
```

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

Existing Etsy shops are assigned to the authenticated organization. Authenticated reads never fall back to the legacy file store.

## Endpoints

- `POST /api/etsy/webhook` receives Etsy webhooks, records the raw event, and queues the right sync job.
- `POST /api/sync/cron` enqueues scheduled order catch-up work for every active shop and processes a small batch.
- `GET /api/sync/jobs` returns queue/webhook status.
- `POST /api/sync/jobs` processes queued jobs.
- `POST /api/etsy/sync?shopId=...` queues a manual incremental sync and processes the queued job(s). Use `forceFull=true` or `mode=full` only when you need a full repair refresh.

Cron and worker routes fail closed unless `SYNC_CRON_SECRET` is set. Call them with one of:

```text
Authorization: Bearer your_private_cron_secret
x-sync-secret: your_private_cron_secret
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
- Configure distinct 32+ character authentication, CSRF, rate-limit, and MFA secrets through the deployment secret manager.
- Enable Admin TOTP before exposing the application publicly.
- The bootstrap password is accepted only as a one-time CLI argument; never place it in production environment variables.
- Use `DATABASE_MIGRATION_URL` for migrations/recovery and a separate `DATABASE_URL` runtime role. After migrations, revoke `CREATE` on the application schema and do not grant `ALTER` or `DROP` ownership to the runtime role.
- Rotating `AUTH_SESSION_SECRET` signs out every device. Rotate other authentication keys through the deployment secret manager; schedule a maintenance window before rotating the MFA encryption key.
- Configure hosted cron jobs for `/api/sync/cron` and `/api/sync/jobs`.
- Set `ETSY_WEBHOOK_SECRET` in production and reject unsigned webhook traffic.
- Monitor Etsy API limits and keep orders higher priority than listing/analytics sync.

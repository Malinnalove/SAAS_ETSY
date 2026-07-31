create table if not exists etsy_shops (
  shop_id bigint primary key,
  organization_id bigint references organizations(id) on delete cascade,
  user_id text not null,
  shop_name text not null,
  connection jsonb not null,
  shop_data jsonb,
  active boolean not null default true,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_sync_at timestamptz,
  listings_sync_at timestamptz,
  receipts_sync_at timestamptz,
  api_quota jsonb
);

create table if not exists etsy_listings (
  shop_id bigint not null references etsy_shops(shop_id) on delete cascade,
  listing_id bigint not null,
  title text not null default '',
  state text not null default '',
  quantity integer,
  price_amount numeric,
  currency_code text,
  views integer,
  num_favorers integer,
  updated_timestamp bigint,
  source_version text,
  data jsonb not null,
  synced_at timestamptz not null default now(),
  primary key (shop_id, listing_id)
);

create table if not exists etsy_receipts (
  shop_id bigint not null references etsy_shops(shop_id) on delete cascade,
  receipt_id bigint not null,
  status text,
  buyer_name text,
  city text,
  state text,
  country_iso text,
  is_paid boolean,
  is_shipped boolean,
  grandtotal_amount numeric,
  currency_code text,
  create_timestamp bigint,
  update_timestamp bigint,
  data jsonb not null,
  synced_at timestamptz not null default now(),
  primary key (shop_id, receipt_id)
);

create table if not exists etsy_receipt_transactions (
  shop_id bigint not null references etsy_shops(shop_id) on delete cascade,
  receipt_id bigint not null,
  transaction_id bigint not null,
  listing_id bigint,
  title text,
  sku text,
  quantity integer,
  price_amount numeric,
  currency_code text,
  paid_timestamp bigint,
  shipped_timestamp bigint,
  data jsonb not null,
  synced_at timestamptz not null default now(),
  primary key (shop_id, transaction_id)
);

create table if not exists etsy_shipments (
  shop_id bigint not null references etsy_shops(shop_id) on delete cascade,
  receipt_id bigint not null,
  shipment_key text not null,
  carrier_name text,
  tracking_code text,
  shipped_timestamp bigint,
  data jsonb not null,
  synced_at timestamptz not null default now(),
  primary key (shop_id, receipt_id, shipment_key)
);

create table if not exists etsy_webhook_events (
  id bigserial primary key,
  webhook_id text unique,
  event_type text not null,
  shop_id bigint,
  resource_url text,
  payload jsonb not null,
  status text not null default 'queued',
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error text,
  delivery_count integer not null default 1
);

create table if not exists etsy_sync_jobs (
  id bigserial primary key,
  shop_id bigint not null references etsy_shops(shop_id) on delete cascade,
  job_type text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued',
  priority integer not null default 100,
  attempts integer not null default 0,
  max_attempts integer not null default 4,
  run_after timestamptz not null default now(),
  locked_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists etsy_sync_cursors (
  shop_id bigint not null references etsy_shops(shop_id) on delete cascade,
  cursor_name text not null,
  cursor_timestamp bigint,
  updated_at timestamptz not null default now(),
  primary key (shop_id, cursor_name)
);

create table if not exists etsy_shop_ui_state (
  shop_id bigint primary key references etsy_shops(shop_id) on delete cascade,
  last_orders_seen_at timestamptz not null default now(),
  new_order_count integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists app_store (
  key text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table etsy_shops
  add column if not exists organization_id bigint references organizations(id) on delete cascade,
  add column if not exists api_quota jsonb;

alter table etsy_listings
  add column if not exists source_version text;

create index if not exists etsy_sync_jobs_queue_idx
  on etsy_sync_jobs (status, run_after, priority, created_at);

create index if not exists etsy_receipts_updated_idx
  on etsy_receipts (shop_id, update_timestamp desc nulls last, create_timestamp desc nulls last);

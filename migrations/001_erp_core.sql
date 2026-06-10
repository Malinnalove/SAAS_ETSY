create table if not exists schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);

create table if not exists organizations (
  id bigserial primary key,
  name text not null,
  slug text not null unique,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists users (
  id bigserial primary key,
  email text not null unique,
  display_name text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists roles (
  id bigserial primary key,
  organization_id bigint references organizations(id) on delete cascade,
  code text not null,
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists roles_scope_code_idx
  on roles (coalesce(organization_id, 0), code);

create table if not exists role_permissions (
  id bigserial primary key,
  role_id bigint not null references roles(id) on delete cascade,
  permission text not null,
  created_at timestamptz not null default now(),
  unique (role_id, permission)
);

create table if not exists organization_memberships (
  id bigserial primary key,
  organization_id bigint not null references organizations(id) on delete cascade,
  user_id bigint not null references users(id) on delete cascade,
  role_id bigint references roles(id) on delete set null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, user_id)
);

create table if not exists sales_channels (
  id bigserial primary key,
  code text not null unique,
  name text not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists channel_accounts (
  id bigserial primary key,
  organization_id bigint not null references organizations(id) on delete cascade,
  channel_id bigint not null references sales_channels(id),
  external_account_id text not null,
  display_name text not null,
  status text not null default 'active',
  external_data jsonb not null default '{}'::jsonb,
  connected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (channel_id, external_account_id)
);

create index if not exists channel_accounts_org_idx
  on channel_accounts (organization_id, status);

create table if not exists channel_credentials (
  id bigserial primary key,
  channel_account_id bigint not null unique references channel_accounts(id) on delete cascade,
  access_token text,
  refresh_token text,
  scopes text[] not null default '{}'::text[],
  expires_at timestamptz,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists products (
  id bigserial primary key,
  organization_id bigint not null references organizations(id) on delete cascade,
  title text not null,
  description text,
  brand text,
  status text not null default 'active',
  default_image_url text,
  source_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists products_org_status_idx
  on products (organization_id, status);

create table if not exists product_variants (
  id bigserial primary key,
  organization_id bigint not null references organizations(id) on delete cascade,
  product_id bigint not null references products(id) on delete cascade,
  title text not null,
  option_values jsonb not null default '{}'::jsonb,
  status text not null default 'active',
  source_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists product_variants_product_idx
  on product_variants (product_id);

create table if not exists skus (
  id bigserial primary key,
  organization_id bigint not null references organizations(id) on delete cascade,
  product_id bigint not null references products(id) on delete cascade,
  variant_id bigint references product_variants(id) on delete set null,
  sku_code text not null,
  title text not null,
  barcode text,
  status text not null default 'active',
  source_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (organization_id, sku_code)
);

create index if not exists skus_product_idx
  on skus (product_id);

create table if not exists product_attributes (
  id bigserial primary key,
  organization_id bigint not null references organizations(id) on delete cascade,
  code text not null,
  name text not null,
  value_type text not null default 'text',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, code)
);

create table if not exists product_attribute_values (
  id bigserial primary key,
  organization_id bigint not null references organizations(id) on delete cascade,
  product_id bigint references products(id) on delete cascade,
  variant_id bigint references product_variants(id) on delete cascade,
  sku_id bigint references skus(id) on delete cascade,
  attribute_id bigint not null references product_attributes(id) on delete cascade,
  value text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists product_media (
  id bigserial primary key,
  organization_id bigint not null references organizations(id) on delete cascade,
  product_id bigint references products(id) on delete cascade,
  variant_id bigint references product_variants(id) on delete cascade,
  media_type text not null default 'image',
  url text not null,
  alt_text text,
  position integer not null default 0,
  source_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists locations (
  id bigserial primary key,
  organization_id bigint not null references organizations(id) on delete cascade,
  code text not null,
  name text not null,
  location_type text not null default 'warehouse',
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (organization_id, code)
);

create table if not exists customers (
  id bigserial primary key,
  organization_id bigint not null references organizations(id) on delete cascade,
  display_name text not null,
  email text,
  phone text,
  source_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists customers_org_email_idx
  on customers (organization_id, email);

create table if not exists customer_addresses (
  id bigserial primary key,
  organization_id bigint not null references organizations(id) on delete cascade,
  customer_id bigint not null references customers(id) on delete cascade,
  address_type text not null default 'shipping',
  name text,
  line1 text,
  line2 text,
  city text,
  state text,
  postal_code text,
  country_code text,
  source_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists orders (
  id bigserial primary key,
  organization_id bigint not null references organizations(id) on delete cascade,
  channel_account_id bigint references channel_accounts(id) on delete set null,
  customer_id bigint references customers(id) on delete set null,
  order_number text not null,
  external_order_id text,
  order_status text not null default 'open',
  payment_status text not null default 'unknown',
  fulfillment_status text not null default 'unknown',
  currency_code text not null default 'USD',
  subtotal_amount numeric(14, 2) not null default 0,
  discount_amount numeric(14, 2) not null default 0,
  tax_amount numeric(14, 2) not null default 0,
  shipping_amount numeric(14, 2) not null default 0,
  total_amount numeric(14, 2) not null default 0,
  placed_at timestamptz,
  source_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (organization_id, order_number)
);

create index if not exists orders_account_placed_idx
  on orders (channel_account_id, placed_at desc nulls last);

create table if not exists order_items (
  id bigserial primary key,
  organization_id bigint not null references organizations(id) on delete cascade,
  order_id bigint not null references orders(id) on delete cascade,
  sku_id bigint references skus(id) on delete set null,
  external_line_item_id text,
  external_listing_id text,
  title text not null,
  quantity numeric(14, 4) not null default 0,
  unit_price_amount numeric(14, 2) not null default 0,
  discount_amount numeric(14, 2) not null default 0,
  tax_amount numeric(14, 2) not null default 0,
  total_amount numeric(14, 2) not null default 0,
  source_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (order_id, external_line_item_id)
);

create index if not exists order_items_sku_idx
  on order_items (sku_id);

create table if not exists order_payments (
  id bigserial primary key,
  organization_id bigint not null references organizations(id) on delete cascade,
  order_id bigint not null references orders(id) on delete cascade,
  provider text,
  external_payment_id text,
  payment_status text not null default 'unknown',
  amount numeric(14, 2) not null default 0,
  currency_code text not null default 'USD',
  paid_at timestamptz,
  source_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (order_id, external_payment_id)
);

create table if not exists order_fulfillments (
  id bigserial primary key,
  organization_id bigint not null references organizations(id) on delete cascade,
  order_id bigint not null references orders(id) on delete cascade,
  fulfillment_status text not null default 'unknown',
  carrier_name text,
  tracking_code text,
  shipped_at timestamptz,
  source_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists order_fulfillment_items (
  id bigserial primary key,
  organization_id bigint not null references organizations(id) on delete cascade,
  fulfillment_id bigint not null references order_fulfillments(id) on delete cascade,
  order_item_id bigint references order_items(id) on delete set null,
  sku_id bigint references skus(id) on delete set null,
  quantity numeric(14, 4) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists order_financial_lines (
  id bigserial primary key,
  organization_id bigint not null references organizations(id) on delete cascade,
  order_id bigint not null references orders(id) on delete cascade,
  order_item_id bigint references order_items(id) on delete cascade,
  line_type text not null,
  description text,
  amount numeric(14, 2) not null default 0,
  currency_code text not null default 'USD',
  source text not null default 'manual',
  source_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists order_financial_lines_order_idx
  on order_financial_lines (order_id, line_type);

create table if not exists inventory_balances (
  id bigserial primary key,
  organization_id bigint not null references organizations(id) on delete cascade,
  sku_id bigint not null references skus(id) on delete cascade,
  location_id bigint not null references locations(id) on delete cascade,
  on_hand numeric(14, 4) not null default 0,
  reserved numeric(14, 4) not null default 0,
  available numeric(14, 4) generated always as (on_hand - reserved) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (sku_id, location_id)
);

create table if not exists inventory_movements (
  id bigserial primary key,
  organization_id bigint not null references organizations(id) on delete cascade,
  sku_id bigint not null references skus(id) on delete cascade,
  location_id bigint not null references locations(id) on delete cascade,
  movement_type text not null,
  quantity_delta numeric(14, 4) not null,
  balance_after numeric(14, 4),
  reference_type text,
  reference_id text,
  note text,
  source_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists inventory_movements_sku_created_idx
  on inventory_movements (sku_id, created_at desc);

create table if not exists inventory_reservations (
  id bigserial primary key,
  organization_id bigint not null references organizations(id) on delete cascade,
  sku_id bigint not null references skus(id) on delete cascade,
  location_id bigint not null references locations(id) on delete cascade,
  order_id bigint references orders(id) on delete cascade,
  order_item_id bigint references order_items(id) on delete cascade,
  quantity numeric(14, 4) not null,
  status text not null default 'active',
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists external_entity_mappings (
  id bigserial primary key,
  organization_id bigint not null references organizations(id) on delete cascade,
  channel_id bigint not null references sales_channels(id),
  channel_account_id bigint references channel_accounts(id) on delete cascade,
  internal_entity_type text not null,
  internal_entity_id bigint not null,
  external_entity_type text not null,
  external_entity_id text not null,
  external_parent_id text,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists external_entity_mappings_unique_idx
  on external_entity_mappings (
    channel_id,
    coalesce(channel_account_id, 0),
    external_entity_type,
    external_entity_id,
    internal_entity_type
  );

create index if not exists external_entity_mappings_internal_idx
  on external_entity_mappings (organization_id, internal_entity_type, internal_entity_id);

create table if not exists sync_jobs (
  id bigserial primary key,
  organization_id bigint references organizations(id) on delete cascade,
  channel_account_id bigint references channel_accounts(id) on delete cascade,
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

create index if not exists sync_jobs_queue_idx
  on sync_jobs (status, run_after, priority, created_at);

create table if not exists sync_cursors (
  id bigserial primary key,
  organization_id bigint not null references organizations(id) on delete cascade,
  channel_account_id bigint references channel_accounts(id) on delete cascade,
  cursor_name text not null,
  cursor_value text,
  cursor_timestamp bigint,
  updated_at timestamptz not null default now(),
  unique (organization_id, channel_account_id, cursor_name)
);

create table if not exists webhook_events (
  id bigserial primary key,
  organization_id bigint references organizations(id) on delete cascade,
  channel_account_id bigint references channel_accounts(id) on delete cascade,
  channel_id bigint references sales_channels(id),
  external_event_id text,
  event_type text not null,
  resource_url text,
  payload jsonb not null,
  status text not null default 'queued',
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error text,
  delivery_count integer not null default 1
);

create unique index if not exists webhook_events_external_idx
  on webhook_events (channel_id, external_event_id)
  where external_event_id is not null;

insert into organizations (name, slug)
values ('Default Organization', 'default')
on conflict (slug) do nothing;

insert into sales_channels (code, name)
values
  ('etsy', 'Etsy'),
  ('ebay', 'eBay'),
  ('shopify', 'Shopify')
on conflict (code) do update
set name = excluded.name,
    updated_at = now();

insert into roles (organization_id, code, name, description)
values
  (null, 'owner', 'Owner', 'Full organization ownership.'),
  (null, 'admin', 'Admin', 'Administration and operations access.'),
  (null, 'operator', 'Operator', 'Daily commerce operations access.'),
  (null, 'viewer', 'Viewer', 'Read-only access.')
on conflict do nothing;

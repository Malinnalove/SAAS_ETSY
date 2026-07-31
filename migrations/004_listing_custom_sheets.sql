create table if not exists listing_custom_sheets (
  id bigserial primary key,
  organization_id bigint not null references organizations(id) on delete cascade,
  shop_id bigint,
  name text not null,
  description text not null default '',
  created_by_user_id bigint references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index if not exists listing_custom_sheets_active_name_idx
  on listing_custom_sheets (organization_id, coalesce(shop_id, 0), lower(name))
  where deleted_at is null;

create index if not exists listing_custom_sheets_active_updated_idx
  on listing_custom_sheets (organization_id, shop_id, deleted_at, updated_at desc);

create table if not exists listing_custom_sheet_columns (
  id bigserial primary key,
  sheet_id bigint not null references listing_custom_sheets(id) on delete cascade,
  column_key text not null,
  title text not null,
  value_type text not null default 'text',
  position integer not null default 0,
  width integer not null default 180,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (sheet_id, column_key)
);

create index if not exists listing_custom_sheet_columns_position_idx
  on listing_custom_sheet_columns (sheet_id, position, id);

create table if not exists listing_custom_sheet_rows (
  id bigserial primary key,
  sheet_id bigint not null references listing_custom_sheets(id) on delete cascade,
  row_key text not null,
  position integer not null default 0,
  values jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (sheet_id, row_key)
);

create index if not exists listing_custom_sheet_rows_position_idx
  on listing_custom_sheet_rows (sheet_id, position, id);

create table if not exists listing_custom_sheet_links (
  id bigserial primary key,
  source_sheet_id bigint not null references listing_custom_sheets(id) on delete cascade,
  source_column_key text not null,
  target_sheet_id bigint not null references listing_custom_sheets(id) on delete cascade,
  target_column_key text not null,
  display_column_keys jsonb not null default '[]'::jsonb,
  mode text not null default 'readonly_lookup',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (source_sheet_id, source_column_key, target_sheet_id, target_column_key)
);

create index if not exists listing_custom_sheet_links_source_idx
  on listing_custom_sheet_links (source_sheet_id, deleted_at, id);

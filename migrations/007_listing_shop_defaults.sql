create table if not exists listing_shop_defaults (
  organization_id bigint not null references organizations(id) on delete cascade,
  shop_id bigint not null,
  values jsonb not null default '{}'::jsonb,
  version integer not null default 1,
  updated_by_user_id bigint references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, shop_id)
);

create index if not exists listing_shop_defaults_shop_idx
  on listing_shop_defaults (shop_id, organization_id);

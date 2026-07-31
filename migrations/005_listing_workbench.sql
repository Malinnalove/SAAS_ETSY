create table if not exists listing_drafts (
  id bigserial primary key,
  organization_id bigint not null references organizations(id) on delete cascade,
  shop_id bigint not null,
  listing_id bigint,
  draft_kind text not null check (draft_kind in ('existing', 'new')),
  status text not null default 'draft',
  base_source_version text,
  base_snapshot jsonb not null default '{}'::jsonb,
  patch jsonb not null default '{}'::jsonb,
  validation_errors jsonb not null default '{}'::jsonb,
  version integer not null default 1,
  migration_key text,
  created_by_user_id bigint references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index if not exists listing_drafts_existing_active_idx
  on listing_drafts (organization_id, shop_id, listing_id)
  where listing_id is not null and deleted_at is null;

create unique index if not exists listing_drafts_migration_key_idx
  on listing_drafts (organization_id, shop_id, migration_key)
  where migration_key is not null and deleted_at is null;

create index if not exists listing_drafts_shop_status_idx
  on listing_drafts (organization_id, shop_id, status, updated_at desc)
  where deleted_at is null;

create table if not exists listing_publish_attempts (
  id bigserial primary key,
  organization_id bigint not null references organizations(id) on delete cascade,
  shop_id bigint not null,
  draft_id bigint not null references listing_drafts(id) on delete restrict,
  draft_version integer not null,
  base_source_version text,
  patch_snapshot jsonb not null,
  status text not null default 'queued',
  job_id bigint,
  result_listing_id bigint,
  error text,
  requested_by_user_id bigint references users(id) on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);

create unique index if not exists listing_publish_attempts_active_draft_idx
  on listing_publish_attempts (draft_id)
  where status in ('queued', 'running');

create index if not exists listing_publish_attempts_shop_idx
  on listing_publish_attempts (organization_id, shop_id, created_at desc);

create table if not exists listing_saved_views (
  id bigserial primary key,
  organization_id bigint not null references organizations(id) on delete cascade,
  shop_id bigint,
  name text not null,
  definition jsonb not null default '{}'::jsonb,
  created_by_user_id bigint references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index if not exists listing_saved_views_active_name_idx
  on listing_saved_views (organization_id, coalesce(shop_id, 0), lower(name))
  where deleted_at is null;

alter table listing_templates
  add column if not exists organization_id bigint references organizations(id) on delete cascade,
  add column if not exists shop_id bigint,
  add column if not exists created_by_user_id bigint references users(id) on delete set null;

drop index if exists listing_templates_active_name_idx;
create unique index if not exists listing_templates_active_tenant_name_idx
  on listing_templates (coalesce(organization_id, 0), coalesce(shop_id, 0), lower(name))
  where deleted_at is null;

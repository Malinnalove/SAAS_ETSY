create table if not exists listing_upload_workspaces (
  id bigserial primary key,
  organization_id bigint not null references organizations(id) on delete cascade,
  shop_id bigint not null,
  minimum_rows integer not null default 50 check (minimum_rows between 1 and 500),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, shop_id)
);

create table if not exists listing_upload_rows (
  id bigserial primary key,
  workspace_id bigint not null references listing_upload_workspaces(id) on delete cascade,
  position integer not null check (position >= 0),
  values jsonb not null default '{}'::jsonb,
  validation_errors jsonb not null default '{}'::jsonb,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, position)
);

create index if not exists listing_upload_rows_workspace_idx
  on listing_upload_rows (workspace_id, position);

create table if not exists listing_upload_commits (
  id bigserial primary key,
  workspace_id bigint not null references listing_upload_workspaces(id) on delete cascade,
  request_key text not null,
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (workspace_id, request_key)
);

create table if not exists listing_delete_attempts (
  id bigserial primary key,
  organization_id bigint not null references organizations(id) on delete cascade,
  shop_id bigint not null,
  listing_id bigint not null,
  draft_id bigint references listing_drafts(id) on delete set null,
  status text not null default 'queued' check (status in ('queued','running','succeeded','failed')),
  job_id bigint,
  error text,
  requested_by_user_id bigint references users(id) on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);

create unique index if not exists listing_delete_attempts_active_listing_idx
  on listing_delete_attempts (organization_id, shop_id, listing_id)
  where status in ('queued','running');

create index if not exists listing_delete_attempts_job_idx
  on listing_delete_attempts (job_id) where job_id is not null;

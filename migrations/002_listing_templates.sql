create table if not exists listing_templates (
  id bigserial primary key,
  name text not null,
  description text,
  header_defaults jsonb not null default '{}'::jsonb,
  visible_fields jsonb not null default '[]'::jsonb,
  row_template jsonb not null default '{}'::jsonb,
  variation_config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index if not exists listing_templates_active_name_idx
  on listing_templates (lower(name))
  where deleted_at is null;

create index if not exists listing_templates_active_updated_idx
  on listing_templates (deleted_at, updated_at desc);

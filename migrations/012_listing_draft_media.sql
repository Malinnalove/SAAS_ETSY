create table if not exists listing_draft_media (
  id bigserial primary key,
  organization_id bigint not null references organizations(id) on delete cascade,
  shop_id bigint not null,
  draft_id bigint not null references listing_drafts(id) on delete cascade,
  filename text not null,
  content_type text not null,
  byte_size integer not null check (byte_size > 0 and byte_size <= 20971520),
  data bytea not null,
  position integer not null default 0,
  uploaded_listing_id bigint,
  uploaded_image_id bigint,
  uploaded_at timestamptz,
  created_by_user_id bigint references users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists listing_draft_media_draft_position_idx
  on listing_draft_media (draft_id, position, id);

create index if not exists listing_draft_media_scope_idx
  on listing_draft_media (organization_id, shop_id, draft_id);

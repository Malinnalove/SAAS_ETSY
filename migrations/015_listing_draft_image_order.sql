alter table listing_drafts
  add column if not exists image_order jsonb not null default '[]'::jsonb;

alter table listing_publish_attempts
  add column if not exists image_order_snapshot jsonb not null default '[]'::jsonb;

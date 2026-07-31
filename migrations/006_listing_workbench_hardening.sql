alter table etsy_shops
  add column if not exists organization_id bigint references organizations(id) on delete cascade;

create index if not exists etsy_shops_organization_active_idx
  on etsy_shops (organization_id, active, shop_id);

alter table etsy_listings
  add column if not exists source_version text;

create index if not exists etsy_listings_shop_updated_idx
  on etsy_listings (shop_id, updated_timestamp desc, listing_id desc);

create index if not exists listing_publish_attempts_job_idx
  on listing_publish_attempts (job_id)
  where job_id is not null;

create index if not exists listing_saved_views_scope_idx
  on listing_saved_views (organization_id, shop_id, updated_at desc)
  where deleted_at is null;

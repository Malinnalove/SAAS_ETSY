alter table listing_draft_media
  add column if not exists alt_text text not null default '';

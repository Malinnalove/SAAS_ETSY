alter table users
  add column if not exists username text,
  add column if not exists password_hash text,
  add column if not exists password_updated_at timestamptz,
  add column if not exists last_login_at timestamptz;

create unique index if not exists users_username_lower_idx
  on users (lower(username))
  where username is not null and deleted_at is null;

update organizations
set name = '成都云杉科技',
    slug = 'chengdu-yunshan',
    updated_at = now()
where slug = 'default'
  and not exists (
    select 1
    from organizations existing
    where existing.slug = 'chengdu-yunshan'
  );

insert into organizations (name, slug, status)
values ('成都云杉科技', 'chengdu-yunshan', 'active')
on conflict (slug)
do update set name = excluded.name,
              status = 'active',
              deleted_at = null,
              updated_at = now();

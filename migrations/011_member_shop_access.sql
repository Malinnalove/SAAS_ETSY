create table if not exists member_shop_access (
  organization_id bigint not null references organizations(id) on delete cascade,
  user_id bigint not null references users(id) on delete cascade,
  shop_id bigint not null references etsy_shops(shop_id) on delete cascade,
  access_level text not null check (access_level in ('view', 'edit')),
  granted_by_user_id bigint references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, user_id, shop_id),
  foreign key (organization_id, user_id)
    references organization_memberships(organization_id, user_id)
    on delete cascade
);

create index if not exists member_shop_access_user_level_idx
  on member_shop_access (organization_id, user_id, access_level, shop_id);

insert into member_shop_access (
  organization_id, user_id, shop_id, access_level, granted_by_user_id
)
select memberships.organization_id,
       memberships.user_id,
       shops.shop_id,
       case roles.code when 'operator' then 'edit' else 'view' end,
       null
from organization_memberships memberships
join roles on roles.id = memberships.role_id
join etsy_shops shops
  on shops.organization_id = memberships.organization_id
 and shops.active = true
where memberships.status = 'active'
  and roles.code in ('operator', 'viewer')
on conflict (organization_id, user_id, shop_id) do nothing;

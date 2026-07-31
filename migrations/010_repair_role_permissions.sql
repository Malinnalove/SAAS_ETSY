delete from role_permissions
where role_id in (
  select id
  from roles
  where organization_id is null
    and code in ('admin', 'operator', 'viewer')
);

insert into role_permissions (role_id, permission)
select roles.id, permissions.permission
from roles
cross join (
  values
    ('dashboard.read'),
    ('products.read'),
    ('listings.read'),
    ('listings.write'),
    ('orders.read'),
    ('orders.operate'),
    ('sync.run'),
    ('shops.manage'),
    ('members.manage'),
    ('system.manage')
) permissions(permission)
where roles.organization_id is null and roles.code = 'admin'
on conflict do nothing;

insert into role_permissions (role_id, permission)
select roles.id, permissions.permission
from roles
cross join (
  values
    ('dashboard.read'),
    ('products.read'),
    ('listings.read'),
    ('listings.write'),
    ('orders.read'),
    ('orders.operate'),
    ('sync.run')
) permissions(permission)
where roles.organization_id is null and roles.code = 'operator'
on conflict do nothing;

insert into role_permissions (role_id, permission)
select roles.id, permissions.permission
from roles
cross join (
  values
    ('dashboard.read'),
    ('products.read'),
    ('listings.read'),
    ('orders.read')
) permissions(permission)
where roles.organization_id is null and roles.code = 'viewer'
on conflict do nothing;

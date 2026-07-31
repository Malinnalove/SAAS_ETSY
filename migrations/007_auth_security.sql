alter table users
  add column if not exists must_change_password boolean not null default false,
  add column if not exists temporary_password_expires_at timestamptz,
  add column if not exists mfa_enabled boolean not null default false,
  add column if not exists disabled_at timestamptz;

insert into roles (organization_id, code, name, description)
values
  (null, 'admin', 'Admin', 'The single highest-privilege administrator.'),
  (null, 'operator', 'Operator', 'Daily operations across all organization shops.'),
  (null, 'viewer', 'Viewer', 'Read-only access across all organization shops.')
on conflict do nothing;

update organization_memberships memberships
set role_id = admin_role.id,
    updated_at = now()
from roles old_role, roles admin_role
where memberships.role_id = old_role.id
  and old_role.organization_id is null
  and old_role.code = 'owner'
  and admin_role.organization_id is null
  and admin_role.code = 'admin';

delete from role_permissions
where role_id in (
  select id from roles where organization_id is null and code in ('admin', 'operator', 'viewer')
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

delete from roles
where organization_id is null
  and code = 'owner'
  and not exists (
    select 1 from organization_memberships where role_id = roles.id
  );

create table if not exists user_sessions (
  id text primary key,
  user_id bigint not null references users(id) on delete cascade,
  organization_id bigint not null references organizations(id) on delete cascade,
  token_hash text not null unique,
  ip_hash text,
  user_agent text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  authenticated_at timestamptz not null default now(),
  idle_expires_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  revoked_at timestamptz,
  revoke_reason text
);

create index if not exists user_sessions_user_active_idx
  on user_sessions (user_id, created_at desc)
  where revoked_at is null;

create index if not exists user_sessions_expiry_idx
  on user_sessions (idle_expires_at, absolute_expires_at)
  where revoked_at is null;

create table if not exists auth_login_attempts (
  id bigserial primary key,
  username_key text not null,
  ip_hash text not null,
  success boolean not null default false,
  failure_reason text,
  created_at timestamptz not null default now()
);

create index if not exists auth_login_attempts_username_idx
  on auth_login_attempts (username_key, created_at desc);

create index if not exists auth_login_attempts_ip_idx
  on auth_login_attempts (ip_hash, created_at desc);

create table if not exists auth_events (
  id bigserial primary key,
  organization_id bigint references organizations(id) on delete set null,
  actor_user_id bigint references users(id) on delete set null,
  subject_user_id bigint references users(id) on delete set null,
  session_id text,
  event_type text not null,
  severity text not null default 'info',
  username_key text,
  ip_hash text,
  request_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists auth_events_org_created_idx
  on auth_events (organization_id, created_at desc);

create index if not exists auth_events_type_created_idx
  on auth_events (event_type, created_at desc);

create table if not exists user_mfa_methods (
  user_id bigint primary key references users(id) on delete cascade,
  secret_ciphertext text not null,
  secret_iv text not null,
  secret_tag text not null,
  key_version integer not null default 1,
  last_used_step bigint,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists user_recovery_codes (
  id bigserial primary key,
  user_id bigint not null references users(id) on delete cascade,
  code_hash text not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, code_hash)
);

create table if not exists mfa_challenges (
  id text primary key,
  user_id bigint not null references users(id) on delete cascade,
  organization_id bigint not null references organizations(id) on delete cascade,
  token_hash text not null unique,
  purpose text not null default 'login',
  attempts integer not null default 0,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists mfa_challenges_expiry_idx
  on mfa_challenges (expires_at)
  where consumed_at is null;

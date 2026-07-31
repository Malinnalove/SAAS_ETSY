create or replace function enforce_single_active_admin_membership()
returns trigger
language plpgsql
as $$
declare
  next_role_code text;
begin
  select code into next_role_code from roles where id = new.role_id;
  if new.status = 'active' and next_role_code = 'admin' and exists (
    select 1
    from organization_memberships existing
    join roles existing_role on existing_role.id = existing.role_id
    join users existing_user on existing_user.id = existing.user_id
    where existing.organization_id = new.organization_id
      and existing.user_id <> new.user_id
      and existing.status = 'active'
      and existing_role.code = 'admin'
      and existing_user.status in ('active', 'pending')
      and existing_user.deleted_at is null
  ) then
    raise exception 'Only one active Admin is allowed per organization.' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists organization_memberships_single_admin on organization_memberships;
create trigger organization_memberships_single_admin
before insert or update of organization_id, role_id, status
on organization_memberships
for each row execute function enforce_single_active_admin_membership();

create or replace function protect_active_admin_user()
returns trigger
language plpgsql
as $$
begin
  if (new.status not in ('active', 'pending') or new.deleted_at is not null) and exists (
    select 1
    from organization_memberships memberships
    join roles on roles.id = memberships.role_id
    where memberships.user_id = old.id
      and memberships.status = 'active'
      and roles.code = 'admin'
  ) then
    raise exception 'The active Admin cannot be disabled or deleted.' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists users_protect_active_admin on users;
create trigger users_protect_active_admin
before update of status, deleted_at
on users
for each row execute function protect_active_admin_user();

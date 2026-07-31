import { randomBytes } from "crypto";
import type { Pool, PoolClient } from "pg";
import { getPool } from "@/server/db";
import {
  assertPasswordPolicy,
  consumeDummyPasswordCheck,
  hashPassword,
  verifyPassword,
  verifyPasswordDetailed,
} from "@/features/auth/password";
import { randomToken, sanitizeAuditText } from "@/features/auth/security";
import {
  isAuthPermission,
  isAuthRole,
  isShopAccessLevel,
  type AuthIdentity,
  type AuthRole,
  type MemberShopAccess,
} from "@/features/auth/types";

export const ENTERPRISE_ORG_NAME = "成都云杉科技";
export const ENTERPRISE_ORG_SLUG = "chengdu-yunshan";
export const DEFAULT_ADMIN_USERNAME = "Colin";

type IdentityRow = {
  display_name: string | null;
  mfa_enabled: boolean;
  must_change_password: boolean;
  organization_id: string;
  organization_name: string;
  organization_slug: string;
  password_hash: string | null;
  permissions: string[] | null;
  role_code: string;
  user_id: string;
  username: string;
};

type SessionRow = IdentityRow & {
  absolute_expires_at: Date;
  authenticated_at: Date;
  idle_expires_at: Date;
  last_seen_at: Date;
  session_id: string;
};

export type SessionIdentity = {
  absoluteExpiresAt: Date;
  authenticatedAt: Date;
  identity: AuthIdentity;
  idleExpiresAt: Date;
  sessionId: string;
};

export type MemberSummary = {
  displayName: string | null;
  lastLoginAt: Date | null;
  mfaEnabled: boolean;
  permissions: AuthIdentity["permissions"];
  role: AuthRole;
  shopAccess: MemberShopAccess[];
  status: string;
  userId: number;
  username: string;
};

export type AuthEventInput = {
  actorUserId?: number | null;
  eventType: string;
  ipHash?: string | null;
  metadata?: Record<string, unknown>;
  organizationId?: number | null;
  requestId?: string | null;
  sessionId?: string | null;
  severity?: "info" | "warning" | "critical";
  subjectUserId?: number | null;
  usernameKey?: string | null;
};

function numericId(value: string | number) {
  return typeof value === "number" ? value : Number(value);
}

export function getAuthPool() {
  const pool = getPool();
  if (!pool) throw new Error("PostgreSQL DATABASE_URL is required for authentication.");
  return pool;
}

export function normalizeUsername(username: string) {
  return username.trim();
}

export function assertUsername(username: string) {
  const normalized = normalizeUsername(username);
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(normalized)) {
    throw new Error("账号只能包含 3–64 位字母、数字、点、下划线或连字符。");
  }
  return normalized;
}

function identityFromRow(row: IdentityRow): AuthIdentity | null {
  if (!isAuthRole(row.role_code)) return null;
  return {
    displayName: row.display_name,
    mfaEnabled: Boolean(row.mfa_enabled),
    mustChangePassword: Boolean(row.must_change_password),
    organizationId: numericId(row.organization_id),
    organizationName: row.organization_name,
    organizationSlug: row.organization_slug,
    permissions: (row.permissions ?? []).filter(isAuthPermission),
    role: row.role_code,
    userId: numericId(row.user_id),
    username: row.username,
  };
}

const IDENTITY_SELECT = `
  select
    users.id as user_id,
    users.username,
    users.display_name,
    users.password_hash,
    users.must_change_password,
    users.mfa_enabled,
    organizations.id as organization_id,
    organizations.name as organization_name,
    organizations.slug as organization_slug,
    roles.code as role_code,
    coalesce(array_agg(distinct role_permissions.permission)
      filter (where role_permissions.permission is not null), '{}'::text[]) as permissions
  from users
  join organization_memberships memberships on memberships.user_id = users.id
  join organizations on organizations.id = memberships.organization_id
  join roles on roles.id = memberships.role_id
  left join role_permissions on role_permissions.role_id = roles.id
`;

const IDENTITY_GROUP = `
  group by users.id, organizations.id, roles.id
`;

export async function recordAuthEvent(input: AuthEventInput, db: Pool | PoolClient = getAuthPool()) {
  const metadata = input.metadata ?? {};
  await db.query(
    `insert into auth_events (
       organization_id, actor_user_id, subject_user_id, session_id, event_type,
       severity, username_key, ip_hash, request_id, metadata
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      input.organizationId ?? null,
      input.actorUserId ?? null,
      input.subjectUserId ?? null,
      input.sessionId ? sanitizeAuditText(input.sessionId, 80) : null,
      sanitizeAuditText(input.eventType, 80),
      input.severity ?? "info",
      input.usernameKey ? sanitizeAuditText(input.usernameKey, 80) : null,
      input.ipHash ?? null,
      input.requestId ?? null,
      JSON.stringify(metadata),
    ],
  );
}

export async function getAuthIdentity(userId: number, organizationId: number, pool: Pool = getAuthPool()) {
  const result = await pool.query<IdentityRow>(
    `${IDENTITY_SELECT}
     where users.id = $1
       and organizations.id = $2
       and memberships.status = 'active'
       and users.status in ('active', 'pending')
       and (users.must_change_password = false or users.temporary_password_expires_at > now())
       and users.deleted_at is null
       and organizations.status = 'active'
       and organizations.deleted_at is null
       and roles.code in ('admin', 'operator', 'viewer')
     ${IDENTITY_GROUP}
     limit 1`,
    [userId, organizationId],
  );
  return result.rows[0] ? identityFromRow(result.rows[0]) : null;
}

async function loginRateLimit(usernameKey: string, ipHash: string, pool: Pool) {
  const result = await pool.query<{
    account_failures: string;
    ip_attempts: string;
    last_failure: Date | null;
  }>(
    `with last_success as (
       select max(created_at) as created_at
       from auth_login_attempts
       where username_key = $1 and success = true
     )
     select
       count(*) filter (
         where username_key = $1
           and success = false
           and created_at > greatest(now() - interval '15 minutes', coalesce((select created_at from last_success), '-infinity'))
       )::text as account_failures,
       count(*) filter (where ip_hash = $2 and created_at > now() - interval '15 minutes')::text as ip_attempts,
       max(created_at) filter (where username_key = $1 and success = false) as last_failure
     from auth_login_attempts
     where created_at > now() - interval '1 day'`,
    [usernameKey, ipHash],
  );
  const row = result.rows[0];
  const failures = Number(row.account_failures);
  const ipAttempts = Number(row.ip_attempts);
  if (ipAttempts >= 20) return 15 * 60;
  if (failures < 5 || !row.last_failure) return 0;

  const blockSeconds = failures >= 7 ? 15 * 60 : failures === 6 ? 5 * 60 : 60;
  const elapsed = Math.floor((Date.now() - new Date(row.last_failure).getTime()) / 1000);
  return Math.max(0, blockSeconds - elapsed);
}

async function recordLoginAttempt(
  usernameKey: string,
  ipHash: string,
  success: boolean,
  failureReason: string | null,
  db: Pool | PoolClient,
) {
  await db.query(
    `insert into auth_login_attempts (username_key, ip_hash, success, failure_reason)
     values ($1,$2,$3,$4)`,
    [usernameKey, ipHash, success, failureReason],
  );
}

export type AuthenticateResult =
  | { status: "invalid" }
  | { retryAfterSeconds: number; status: "rate_limited" }
  | { identity: AuthIdentity; status: "ok" };

export async function authenticateUser(input: {
  ipHash: string;
  password: string;
  requestId: string;
  username: string;
}, pool: Pool = getAuthPool()): Promise<AuthenticateResult> {
  const usernameKey = normalizeUsername(input.username).toLowerCase();
  const retryAfterSeconds = await loginRateLimit(usernameKey, input.ipHash, pool);
  if (retryAfterSeconds > 0) {
    await recordAuthEvent({
      eventType: "login.rate_limited",
      ipHash: input.ipHash,
      requestId: input.requestId,
      severity: "warning",
      usernameKey,
    }, pool);
    return { retryAfterSeconds, status: "rate_limited" };
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await client.query<IdentityRow>(
      `${IDENTITY_SELECT}
       where lower(users.username) = lower($1)
         and memberships.status = 'active'
         and users.status in ('active', 'pending')
         and (users.must_change_password = false or users.temporary_password_expires_at > now())
         and users.deleted_at is null
         and organizations.status = 'active'
         and organizations.deleted_at is null
         and roles.code in ('admin', 'operator', 'viewer')
       ${IDENTITY_GROUP}
       limit 1`,
      [normalizeUsername(input.username)],
    );
    const row = result.rows[0];
    if (!row) {
      await consumeDummyPasswordCheck(input.password);
      await recordLoginAttempt(usernameKey, input.ipHash, false, "invalid_credentials", client);
      await recordAuthEvent({ eventType: "login.failed", ipHash: input.ipHash, requestId: input.requestId, severity: "warning", usernameKey }, client);
      await client.query("commit");
      return { status: "invalid" };
    }

    const verification = await verifyPasswordDetailed(input.password, row.password_hash);
    const identity = identityFromRow(row);
    if (!verification.valid || !identity) {
      await recordLoginAttempt(usernameKey, input.ipHash, false, "invalid_credentials", client);
      await recordAuthEvent({
        eventType: "login.failed",
        ipHash: input.ipHash,
        organizationId: numericId(row.organization_id),
        requestId: input.requestId,
        severity: identity?.role === "admin" ? "critical" : "warning",
        subjectUserId: numericId(row.user_id),
        usernameKey,
      }, client);
      await client.query("commit");
      return { status: "invalid" };
    }

    if (verification.needsRehash) {
      await client.query(
        "update users set password_hash = $2, password_updated_at = now(), updated_at = now() where id = $1",
        [identity.userId, await hashPassword(input.password)],
      );
    }
    await recordLoginAttempt(usernameKey, input.ipHash, true, null, client);
    await recordAuthEvent({
      eventType: "login.password_verified",
      ipHash: input.ipHash,
      organizationId: identity.organizationId,
      requestId: input.requestId,
      subjectUserId: identity.userId,
      usernameKey,
    }, client);
    await client.query("commit");
    return { identity, status: "ok" };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function createSessionRecord(input: {
  identity: AuthIdentity;
  ipHash: string;
  tokenHash: string;
  userAgent: string;
}, pool: Pool = getAuthPool()) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select id from users where id = $1 for update", [input.identity.userId]);
    await client.query(
      `update user_sessions
       set revoked_at = coalesce(revoked_at, now()), revoke_reason = coalesce(revoke_reason, 'expired')
       where user_id = $1 and revoked_at is null
         and (idle_expires_at <= now() or absolute_expires_at <= now())`,
      [input.identity.userId],
    );
    const existing = await client.query<{ id: string }>(
      `select id from user_sessions
       where user_id = $1 and revoked_at is null
       order by created_at desc
       offset 4`,
      [input.identity.userId],
    );
    if (existing.rows.length) {
      await client.query(
        `update user_sessions set revoked_at = now(), revoke_reason = 'session_limit'
         where id = any($1::text[])`,
        [existing.rows.map((row) => row.id)],
      );
    }

    const id = randomToken(18);
    const result = await client.query<{
      absolute_expires_at: Date;
      authenticated_at: Date;
      idle_expires_at: Date;
    }>(
      `insert into user_sessions (
         id, user_id, organization_id, token_hash, ip_hash, user_agent,
         idle_expires_at, absolute_expires_at
       ) values ($1,$2,$3,$4,$5,$6,now() + interval '12 hours',now() + interval '7 days')
       returning authenticated_at, idle_expires_at, absolute_expires_at`,
      [
        id,
        input.identity.userId,
        input.identity.organizationId,
        input.tokenHash,
        input.ipHash,
        sanitizeAuditText(input.userAgent, 320),
      ],
    );
    await client.query("update users set last_login_at = now(), updated_at = now() where id = $1", [input.identity.userId]);
    await recordAuthEvent({
      actorUserId: input.identity.userId,
      eventType: "session.created",
      ipHash: input.ipHash,
      organizationId: input.identity.organizationId,
      sessionId: id,
      subjectUserId: input.identity.userId,
    }, client);
    await client.query("commit");
    return { id, ...result.rows[0] };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function getSessionIdentity(tokenHash: string, pool: Pool = getAuthPool()): Promise<SessionIdentity | null> {
  const result = await pool.query<SessionRow>(
    `select
       users.id as user_id,
       users.username,
       users.display_name,
       users.password_hash,
       users.must_change_password,
       users.mfa_enabled,
       organizations.id as organization_id,
       organizations.name as organization_name,
       organizations.slug as organization_slug,
       roles.code as role_code,
       coalesce(array_agg(distinct role_permissions.permission)
         filter (where role_permissions.permission is not null), '{}'::text[]) as permissions,
       sessions.id as session_id,
       sessions.last_seen_at,
       sessions.authenticated_at,
       sessions.idle_expires_at,
       sessions.absolute_expires_at
     from user_sessions sessions
     join users on users.id = sessions.user_id
     join organization_memberships memberships
       on memberships.user_id = users.id and memberships.organization_id = sessions.organization_id
     join organizations on organizations.id = memberships.organization_id
     join roles on roles.id = memberships.role_id
     left join role_permissions on role_permissions.role_id = roles.id
     where sessions.token_hash = $1
       and sessions.revoked_at is null
       and sessions.idle_expires_at > now()
       and sessions.absolute_expires_at > now()
       and memberships.status = 'active'
       and users.status in ('active', 'pending')
       and (users.must_change_password = false or users.temporary_password_expires_at > now())
       and users.deleted_at is null
       and organizations.status = 'active'
       and organizations.deleted_at is null
       and roles.code in ('admin', 'operator', 'viewer')
     ${IDENTITY_GROUP}, sessions.id
     limit 1`,
    [tokenHash],
  );
  const row = result.rows[0];
  const identity = row ? identityFromRow(row) : null;
  if (!row || !identity) return null;

  if (Date.now() - new Date(row.last_seen_at).getTime() >= 5 * 60 * 1000) {
    await pool.query(
      `update user_sessions
       set last_seen_at = now(),
           idle_expires_at = least(now() + interval '12 hours', absolute_expires_at)
       where id = $1 and revoked_at is null`,
      [row.session_id],
    );
  }
  return {
    absoluteExpiresAt: new Date(row.absolute_expires_at),
    authenticatedAt: new Date(row.authenticated_at),
    identity,
    idleExpiresAt: new Date(row.idle_expires_at),
    sessionId: row.session_id,
  };
}

export async function revokeSession(sessionId: string, reason = "logout", pool: Pool = getAuthPool()) {
  await pool.query(
    `update user_sessions set revoked_at = coalesce(revoked_at, now()), revoke_reason = coalesce(revoke_reason, $2)
     where id = $1`,
    [sessionId, reason],
  );
}

export async function markSessionReauthenticated(sessionId: string, pool: Pool = getAuthPool()) {
  await pool.query(
    "update user_sessions set authenticated_at = now(), last_seen_at = now() where id = $1 and revoked_at is null",
    [sessionId],
  );
}

export async function revokeUserSessions(userId: number, reason: string, exceptSessionId?: string | null, pool: Pool = getAuthPool()) {
  await pool.query(
    `update user_sessions
     set revoked_at = coalesce(revoked_at, now()), revoke_reason = coalesce(revoke_reason, $2)
     where user_id = $1 and revoked_at is null and ($3::text is null or id <> $3)`,
    [userId, reason, exceptSessionId ?? null],
  );
}

export async function listUserSessions(userId: number, pool: Pool = getAuthPool()) {
  const result = await pool.query<{
    absolute_expires_at: Date;
    created_at: Date;
    id: string;
    last_seen_at: Date;
    revoked_at: Date | null;
    user_agent: string | null;
  }>(
    `select id, user_agent, created_at, last_seen_at, absolute_expires_at, revoked_at
     from user_sessions where user_id = $1 order by created_at desc limit 20`,
    [userId],
  );
  return result.rows;
}

export async function listRecentAuthAlerts(organizationId: number, pool: Pool = getAuthPool()) {
  const result = await pool.query<{
    created_at: Date;
    event_type: string;
    id: string;
    metadata: Record<string, unknown>;
    severity: string;
  }>(
    `select id, event_type, severity, metadata, created_at
     from auth_events
     where organization_id = $1 and severity in ('warning','critical')
       and created_at > now() - interval '7 days'
     order by created_at desc limit 20`,
    [organizationId],
  );
  return result.rows;
}

export async function changePassword(input: {
  currentPassword: string;
  newPassword: string;
  sessionId?: string | null;
  userId: number;
  username: string;
}, pool: Pool = getAuthPool()) {
  assertPasswordPolicy(input.newPassword, input.username);
  const result = await pool.query<{ password_hash: string | null }>(
    "select password_hash from users where id = $1 and status in ('active','pending') and deleted_at is null limit 1",
    [input.userId],
  );
  if (!(await verifyPassword(input.currentPassword, result.rows[0]?.password_hash))) {
    throw new Error("当前密码不正确。");
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `update users
       set password_hash = $2, password_updated_at = now(), must_change_password = false,
           temporary_password_expires_at = null, status = 'active', updated_at = now()
       where id = $1`,
      [input.userId, await hashPassword(input.newPassword)],
    );
    await client.query(
      `update user_sessions set revoked_at = now(), revoke_reason = 'password_changed'
       where user_id = $1 and revoked_at is null and ($2::text is null or id <> $2)`,
      [input.userId, input.sessionId ?? null],
    );
    await recordAuthEvent({ actorUserId: input.userId, eventType: "password.changed", sessionId: input.sessionId, subjectUserId: input.userId }, client);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function updateEnterpriseProfile(input: {
  displayName: string;
  organizationId: number;
  organizationName: string;
  userId: number;
  username: string;
}, pool: Pool = getAuthPool()) {
  const organizationName = input.organizationName.trim();
  const username = assertUsername(input.username);
  const displayName = input.displayName.trim() || username;
  if (organizationName.length < 2 || organizationName.length > 80) {
    throw new Error("企业名称必须为 2–80 个字符。");
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select id from organizations where id = $1 for update", [input.organizationId]);
    await client.query("update organizations set name = $2, updated_at = now() where id = $1", [input.organizationId, organizationName]);
    await client.query(
      "update users set username = $2, display_name = $3, updated_at = now() where id = $1",
      [input.userId, username, displayName],
    );
    await recordAuthEvent({ actorUserId: input.userId, eventType: "profile.updated", organizationId: input.organizationId, subjectUserId: input.userId }, client);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    if (error && typeof error === "object" && "code" in error && error.code === "23505") {
      throw new Error("该账号已被使用。");
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function listMembers(organizationId: number, pool: Pool = getAuthPool()): Promise<MemberSummary[]> {
  const result = await pool.query<{
    display_name: string | null;
    last_login_at: Date | null;
    mfa_enabled: boolean;
    permissions: string[] | null;
    role_code: string;
    shop_access: Array<{ accessLevel: string; shopId: string }> | null;
    status: string;
    user_id: string;
    username: string;
  }>(
    `select users.id as user_id, users.username, users.display_name, users.status,
            users.last_login_at, users.mfa_enabled, roles.code as role_code,
            coalesce((
              select array_agg(role_permissions.permission order by role_permissions.permission)
              from role_permissions
              where role_permissions.role_id = roles.id
            ), '{}'::text[]) as permissions,
            coalesce((
              select jsonb_agg(jsonb_build_object(
                'shopId', member_shop_access.shop_id::text,
                'accessLevel', member_shop_access.access_level
              ) order by member_shop_access.shop_id)
              from member_shop_access
              where member_shop_access.organization_id = memberships.organization_id
                and member_shop_access.user_id = users.id
            ), '[]'::jsonb) as shop_access
     from organization_memberships memberships
     join users on users.id = memberships.user_id
     join roles on roles.id = memberships.role_id
     where memberships.organization_id = $1 and users.deleted_at is null
       and roles.code in ('admin','operator','viewer')
     order by case roles.code when 'admin' then 0 when 'operator' then 1 else 2 end, users.username`,
    [organizationId],
  );
  return result.rows.flatMap((row) => isAuthRole(row.role_code) ? [{
    displayName: row.display_name,
    lastLoginAt: row.last_login_at,
    mfaEnabled: row.mfa_enabled,
    permissions: (row.permissions ?? []).filter(isAuthPermission),
    role: row.role_code,
    shopAccess: (row.shop_access ?? []).flatMap((access) => {
      const shopId = numericId(access.shopId);
      return Number.isSafeInteger(shopId) && shopId > 0 && isShopAccessLevel(access.accessLevel)
        ? [{ accessLevel: access.accessLevel, shopId }]
        : [];
    }),
    status: row.status,
    userId: numericId(row.user_id),
    username: row.username,
  }] : []);
}

function temporaryPassword() {
  return randomBytes(15).toString("base64url");
}

async function replaceMemberShopAccess(input: {
  actorUserId: number;
  organizationId: number;
  role: Exclude<AuthRole, "admin">;
  shopAccess: MemberShopAccess[];
  userId: number;
}, client: PoolClient) {
  const accessByShop = new Map<number, MemberShopAccess["accessLevel"]>();
  for (const access of input.shopAccess) {
    if (!Number.isSafeInteger(access.shopId) || access.shopId <= 0 || !isShopAccessLevel(access.accessLevel)) {
      throw new Error("店铺权限不合法。");
    }
    if (input.role === "viewer" && access.accessLevel === "edit") {
      throw new Error("Viewer 不能获得店铺编辑权限。");
    }
    accessByShop.set(access.shopId, access.accessLevel);
  }

  const shopIds = Array.from(accessByShop.keys());
  if (shopIds.length) {
    const shops = await client.query<{ shop_id: string }>(
      `select shop_id::text as shop_id
       from etsy_shops
       where organization_id = $1 and active = true and shop_id = any($2::bigint[])`,
      [input.organizationId, shopIds],
    );
    const validShopIds = new Set(shops.rows.map((row) => numericId(row.shop_id)));
    if (validShopIds.size !== shopIds.length || shopIds.some((shopId) => !validShopIds.has(shopId))) {
      throw new Error("包含不属于当前组织的店铺。");
    }
  }

  await client.query(
    "delete from member_shop_access where organization_id = $1 and user_id = $2",
    [input.organizationId, input.userId],
  );
  for (const [shopId, accessLevel] of accessByShop) {
    await client.query(
      `insert into member_shop_access (
         organization_id, user_id, shop_id, access_level, granted_by_user_id
       ) values ($1,$2,$3,$4,$5)`,
      [input.organizationId, input.userId, shopId, accessLevel, input.actorUserId],
    );
  }
}

export async function createMember(input: {
  actorUserId: number;
  displayName: string;
  organizationId: number;
  password?: string;
  role: Exclude<AuthRole, "admin">;
  shopAccess: MemberShopAccess[];
  username: string;
}, pool: Pool = getAuthPool()) {
  const username = assertUsername(input.username);
  const displayName = input.displayName.trim() || username;
  const usesTemporaryPassword = !input.password;
  const password = input.password ?? temporaryPassword();
  assertPasswordPolicy(password, username);
  const passwordHash = await hashPassword(password);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const organization = await client.query<{ slug: string }>("select slug from organizations where id = $1 for update", [input.organizationId]);
    if (!organization.rows[0]) throw new Error("组织不存在。");
    const role = await client.query<{ id: string }>(
      "select id from roles where organization_id is null and code = $1 limit 1",
      [input.role],
    );
    if (!role.rows[0]) throw new Error("角色未初始化。");
    const user = await client.query<{ id: string }>(
      `insert into users (
         email, username, display_name, password_hash, password_updated_at,
         must_change_password, temporary_password_expires_at, status
       ) values ($1,$2,$3,$4,now(),$5,
         case when $5 then now() + interval '24 hours' else null end,
         case when $5 then 'pending' else 'active' end)
       returning id`,
      [`${username.toLowerCase()}@${organization.rows[0].slug}.local`, username, displayName, passwordHash, usesTemporaryPassword],
    );
    const userId = numericId(user.rows[0].id);
    await client.query(
      `insert into organization_memberships (organization_id, user_id, role_id, status)
       values ($1,$2,$3,'active')`,
      [input.organizationId, userId, numericId(role.rows[0].id)],
    );
    await replaceMemberShopAccess({ ...input, userId }, client);
    await recordAuthEvent({
      actorUserId: input.actorUserId,
      eventType: "member.created",
      metadata: { role: input.role, shopAccessCount: input.shopAccess.length },
      organizationId: input.organizationId,
      subjectUserId: userId,
    }, client);
    await client.query("commit");
    return { password: usesTemporaryPassword ? password : null, userId };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    if (error && typeof error === "object" && "code" in error && error.code === "23505") {
      throw new Error("该账号已存在。");
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function updateMember(input: {
  actorUserId: number;
  organizationId: number;
  role: Exclude<AuthRole, "admin">;
  shopAccess: MemberShopAccess[];
  status: "active" | "disabled";
  userId: number;
}, pool: Pool = getAuthPool()) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select id from organizations where id = $1 for update", [input.organizationId]);
    const target = await client.query<{ role_code: string }>(
      `select roles.code as role_code
       from organization_memberships memberships join roles on roles.id = memberships.role_id
       where memberships.organization_id = $1 and memberships.user_id = $2 for update of memberships`,
      [input.organizationId, input.userId],
    );
    if (!target.rows[0]) throw new Error("成员不存在。");
    if (target.rows[0].role_code === "admin") throw new Error("唯一 Admin 不能被修改。");
    const role = await client.query<{ id: string }>(
      "select id from roles where organization_id is null and code = $1 limit 1",
      [input.role],
    );
    if (!role.rows[0]) throw new Error("角色未初始化。");
    await client.query(
      "update organization_memberships set role_id = $3, status = 'active', updated_at = now() where organization_id = $1 and user_id = $2",
      [input.organizationId, input.userId, numericId(role.rows[0].id)],
    );
    await client.query(
      `update users set status = $2, disabled_at = case when $2 = 'disabled' then now() else null end, updated_at = now()
       where id = $1`,
      [input.userId, input.status],
    );
    await replaceMemberShopAccess(input, client);
    await client.query(
      "update user_sessions set revoked_at = now(), revoke_reason = 'member_changed' where user_id = $1 and revoked_at is null",
      [input.userId],
    );
    await recordAuthEvent({
      actorUserId: input.actorUserId,
      eventType: "member.updated",
      metadata: { role: input.role, shopAccessCount: input.shopAccess.length, status: input.status },
      organizationId: input.organizationId,
      subjectUserId: input.userId,
    }, client);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function setMemberPassword(input: {
  actorUserId: number;
  organizationId: number;
  password: string;
  userId: number;
}, pool: Pool = getAuthPool()) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const target = await client.query<{ role_code: string; username: string }>(
      `select roles.code as role_code, users.username
       from organization_memberships memberships
       join roles on roles.id = memberships.role_id
       join users on users.id = memberships.user_id
       where memberships.organization_id = $1 and users.id = $2 and users.deleted_at is null
       for update of users`,
      [input.organizationId, input.userId],
    );
    if (!target.rows[0]) throw new Error("成员不存在。");
    if (target.rows[0].role_code === "admin") throw new Error("Admin 密码请在账号安全设置中修改。");
    assertPasswordPolicy(input.password, target.rows[0].username);
    await client.query(
      `update users
       set password_hash = $2, password_updated_at = now(), must_change_password = false,
           temporary_password_expires_at = null,
           status = case when status = 'pending' then 'active' else status end,
           updated_at = now()
       where id = $1`,
      [input.userId, await hashPassword(input.password)],
    );
    await client.query(
      "update user_sessions set revoked_at = now(), revoke_reason = 'password_set_by_admin' where user_id = $1 and revoked_at is null",
      [input.userId],
    );
    await recordAuthEvent({
      actorUserId: input.actorUserId,
      eventType: "member.password_set",
      organizationId: input.organizationId,
      severity: "warning",
      subjectUserId: input.userId,
    }, client);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function resetMemberPassword(input: {
  actorUserId: number;
  organizationId: number;
  userId: number;
}, pool: Pool = getAuthPool()) {
  const password = temporaryPassword();
  const client = await pool.connect();
  try {
    await client.query("begin");
    const target = await client.query<{ role_code: string; username: string }>(
      `select roles.code as role_code, users.username
       from organization_memberships memberships
       join roles on roles.id = memberships.role_id join users on users.id = memberships.user_id
       where memberships.organization_id = $1 and users.id = $2 for update of users`,
      [input.organizationId, input.userId],
    );
    if (!target.rows[0]) throw new Error("成员不存在。");
    if (target.rows[0].role_code === "admin") throw new Error("Admin 密码只能通过服务器恢复命令重置。");
    assertPasswordPolicy(password, target.rows[0].username);
    await client.query(
      `update users set password_hash = $2, password_updated_at = now(), must_change_password = true,
         temporary_password_expires_at = now() + interval '24 hours', status = 'pending', disabled_at = null, updated_at = now()
       where id = $1`,
      [input.userId, await hashPassword(password)],
    );
    await client.query(
      "update user_sessions set revoked_at = now(), revoke_reason = 'password_reset' where user_id = $1 and revoked_at is null",
      [input.userId],
    );
    await recordAuthEvent({ actorUserId: input.actorUserId, eventType: "member.password_reset", organizationId: input.organizationId, severity: "warning", subjectUserId: input.userId }, client);
    await client.query("commit");
    return password;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

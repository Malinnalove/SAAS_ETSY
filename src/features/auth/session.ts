import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import {
  createSessionRecord,
  getAuthPool,
  getSessionIdentity,
  recordAuthEvent,
  revokeSession,
  revokeUserSessions,
  type SessionIdentity,
} from "@/features/auth/db";
import {
  csrfTokenForPreAuth,
  csrfTokenForSession,
  assertAuthConfiguration,
  randomToken,
  requestIpHash,
  requestId,
  safeEqual,
  sessionTokenHash,
  validateRequestOrigin,
} from "@/features/auth/security";
import { hasPermission, type AuthContext, type AuthIdentity, type AuthPermission } from "@/features/auth/types";

const DEV_SESSION_COOKIE = "erp_session";
const PROD_SESSION_COOKIE = "__Host-erp_session";
const DEV_PREAUTH_COOKIE = "erp_pre_auth";
const PROD_PREAUTH_COOKIE = "__Host-erp_pre_auth";
const DEV_MFA_COOKIE = "erp_mfa_challenge";
const PROD_MFA_COOKIE = "__Host-erp_mfa_challenge";

function productionCookie() {
  return process.env.NODE_ENV === "production";
}

export function sessionCookieName() {
  return productionCookie() ? PROD_SESSION_COOKIE : DEV_SESSION_COOKIE;
}

export function preAuthCookieName() {
  return productionCookie() ? PROD_PREAUTH_COOKIE : DEV_PREAUTH_COOKIE;
}

export function mfaChallengeCookieName() {
  return productionCookie() ? PROD_MFA_COOKIE : DEV_MFA_COOKIE;
}

function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    maxAge,
    path: "/" as const,
    sameSite: "lax" as const,
    secure: productionCookie(),
  };
}

export function safeReturnPath(value: string | null | undefined) {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return "/dashboard";
  }
  try {
    const parsed = new URL(value, "https://erp.invalid");
    return parsed.origin === "https://erp.invalid" ? `${parsed.pathname}${parsed.search}${parsed.hash}` : "/dashboard";
  } catch {
    return "/dashboard";
  }
}

export function loginPath(next?: string | null) {
  return `/login?${new URLSearchParams({ next: safeReturnPath(next) }).toString()}`;
}

function contextFromSession(session: SessionIdentity, rawToken: string): AuthContext {
  return {
    ...session.identity,
    authenticatedAt: session.authenticatedAt,
    csrfToken: csrfTokenForSession(rawToken),
    sessionId: session.sessionId,
  };
}

export async function createUserSession(identity: AuthIdentity, request?: Request) {
  assertAuthConfiguration();
  const rawToken = randomToken(32);
  const headerStore = request ? request.headers : await headers();
  const ipHash = request
    ? requestIpHash(request)
    : requestIpHash(new Request("http://local", { headers: headerStore }));
  const session = await createSessionRecord({
    identity,
    ipHash,
    tokenHash: sessionTokenHash(rawToken),
    userAgent: headerStore.get("user-agent") ?? "",
  });
  const cookieStore = await cookies();
  cookieStore.set(sessionCookieName(), rawToken, cookieOptions(7 * 24 * 60 * 60));
  return contextFromSession({
    absoluteExpiresAt: new Date(session.absolute_expires_at),
    authenticatedAt: new Date(session.authenticated_at),
    identity,
    idleExpiresAt: new Date(session.idle_expires_at),
    sessionId: session.id,
  }, rawToken);
}

export async function getCurrentUser() {
  assertAuthConfiguration();
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(sessionCookieName())?.value;
  if (!rawToken) return null;
  const session = await getSessionIdentity(sessionTokenHash(rawToken)).catch(() => null);
  return session ? contextFromSession(session, rawToken) : null;
}

export async function requireUser(next?: string | null, options: { allowPasswordChange?: boolean } = {}) {
  const user = await getCurrentUser();
  if (!user) {
    const headerStore = await headers();
    const rawToken = (await cookies()).get(sessionCookieName())?.value;
    const request = new Request("http://server-render.local", { headers: headerStore });
    await recordAuthEvent({
      eventType: rawToken ? "session.invalid" : "authorization.unauthenticated",
      ipHash: requestIpHash(request),
      metadata: { path: safeReturnPath(next) },
      requestId: requestId(request),
      severity: rawToken ? "warning" : "info",
    }).catch(() => undefined);
    redirect(loginPath(next));
  }
  if (user.mustChangePassword && !options.allowPasswordChange) redirect("/account/activate");
  return user;
}

export async function requirePermission(permission: AuthPermission, next?: string | null) {
  const headerStore = await headers();
  if (headerStore.get("next-action")) {
    const actionRequest = new Request("http://server-action.local", { headers: headerStore, method: "POST" });
    if (!validateRequestOrigin(actionRequest)) throw new Error("Forbidden");
  }
  const user = await requireUser(next);
  if (!hasPermission(user, permission)) {
    await recordAuthEvent({
      actorUserId: user.userId,
      eventType: "authorization.denied",
      metadata: { permission },
      organizationId: user.organizationId,
      sessionId: user.sessionId,
      severity: "warning",
      subjectUserId: user.userId,
    }).catch(() => undefined);
    redirect("/dashboard?authError=forbidden");
  }
  return user;
}

export function isRecentlyAuthenticated(user: Pick<AuthContext, "authenticatedAt">, minutes = 10) {
  return Date.now() - new Date(user.authenticatedAt).getTime() <= minutes * 60 * 1000;
}

export async function requireRecentAuthentication(user: AuthContext, next: string) {
  if (!isRecentlyAuthenticated(user)) {
    redirect(`/settings/security/reauth?next=${encodeURIComponent(safeReturnPath(next))}`);
  }
  return user;
}

function requestAcceptsHtml(request: Request) {
  return (request.headers.get("accept") ?? "").includes("text/html");
}

async function csrfFromRequest(request: Request) {
  const header = request.headers.get("x-csrf-token");
  if (header) return header;
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    return String((await request.clone().formData().catch(() => null))?.get("_csrf") ?? "");
  }
  return "";
}

export async function requireUserApi(request: Request, permission?: AuthPermission) {
  const user = await getCurrentUser();
  if (!user) {
    const rawToken = (await cookies()).get(sessionCookieName())?.value;
    await recordAuthEvent({
      eventType: rawToken ? "session.invalid" : "authorization.unauthenticated",
      ipHash: requestIpHash(request),
      metadata: { method: request.method, path: new URL(request.url).pathname },
      requestId: requestId(request),
      severity: rawToken ? "warning" : "info",
    }).catch(() => undefined);
    const response = requestAcceptsHtml(request)
      ? NextResponse.redirect(new URL(loginPath(`${new URL(request.url).pathname}${new URL(request.url).search}`), request.url))
      : NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    return { admin: null, response, user: null };
  }
  if (user.mustChangePassword) {
    const response = requestAcceptsHtml(request)
      ? NextResponse.redirect(new URL("/account/activate", request.url))
      : NextResponse.json({ error: "Password change required." }, { status: 403 });
    return { admin: null, response, user: null };
  }
  if (permission && !hasPermission(user, permission)) {
    await recordAuthEvent({
      actorUserId: user.userId,
      eventType: "authorization.denied",
      metadata: { path: new URL(request.url).pathname, permission },
      organizationId: user.organizationId,
      sessionId: user.sessionId,
      severity: "warning",
      subjectUserId: user.userId,
    }).catch(() => undefined);
    return { admin: null, response: NextResponse.json({ error: "Forbidden." }, { status: 403 }), user: null };
  }

  if (!["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) {
    const cookieStore = await cookies();
    const rawToken = cookieStore.get(sessionCookieName())?.value;
    const csrf = await csrfFromRequest(request);
    if (!rawToken || !validateRequestOrigin(request) || !safeEqual(csrf, csrfTokenForSession(rawToken))) {
      await recordAuthEvent({
        actorUserId: user.userId,
        eventType: "csrf.rejected",
        metadata: { path: new URL(request.url).pathname },
        organizationId: user.organizationId,
        sessionId: user.sessionId,
        severity: "warning",
        subjectUserId: user.userId,
      }).catch(() => undefined);
      return { admin: null, response: NextResponse.json({ error: "Invalid request verification token." }, { status: 403 }), user: null };
    }
  }
  return { admin: user, response: null, user };
}

export async function authorizeShop(user: AuthContext, shopId: number, permission: AuthPermission) {
  if (await hasShopAccess(user, shopId, permission)) return true;
  await recordAuthEvent({
    actorUserId: user.userId,
    eventType: "authorization.shop_denied",
    metadata: { permission, shopId },
    organizationId: user.organizationId,
    sessionId: user.sessionId,
    severity: "warning",
    subjectUserId: user.userId,
  }).catch(() => undefined);
  return false;
}

function requiredShopAccess(permission: AuthPermission) {
  return permission === "listings.write" || permission === "orders.operate" || permission === "sync.run"
    ? "edit"
    : "view";
}

export async function hasShopAccess(
  user: Pick<AuthIdentity, "organizationId" | "permissions" | "role" | "userId">,
  shopId: number,
  permission: AuthPermission,
) {
  if (!hasPermission(user, permission) || !Number.isSafeInteger(shopId) || shopId <= 0) return false;
  const requiredAccess = requiredShopAccess(permission);
  const result = await getAuthPool().query(
    `select 1
     from etsy_shops shops
     left join member_shop_access access
       on access.organization_id = shops.organization_id
      and access.user_id = $3
      and access.shop_id = shops.shop_id
     where shops.shop_id = $1
       and shops.organization_id = $2
       and shops.active = true
       and (
         $4 = 'admin'
         or access.access_level = 'edit'
         or ($5 = 'view' and access.access_level = 'view')
       )
     limit 1`,
    [shopId, user.organizationId, user.userId, user.role, requiredAccess],
  );
  return Boolean(result.rowCount);
}

export async function listAccessibleShopIds(
  user: Pick<AuthIdentity, "organizationId" | "role" | "userId">,
) {
  const result = user.role === "admin"
    ? await getAuthPool().query<{ shop_id: string }>(
        "select shop_id::text as shop_id from etsy_shops where organization_id = $1 and active = true",
        [user.organizationId],
      )
    : await getAuthPool().query<{ shop_id: string }>(
        `select shops.shop_id::text as shop_id
         from member_shop_access access
         join etsy_shops shops on shops.shop_id = access.shop_id
         where access.organization_id = $1
           and access.user_id = $2
           and shops.organization_id = $1
           and shops.active = true`,
        [user.organizationId, user.userId],
      );
  return result.rows.map((row) => Number(row.shop_id)).filter((shopId) => Number.isSafeInteger(shopId) && shopId > 0);
}

export async function clearCurrentSession(reason = "logout") {
  const user = await getCurrentUser();
  if (user) await revokeSession(user.sessionId, reason).catch(() => undefined);
  const cookieStore = await cookies();
  cookieStore.delete(sessionCookieName());
}

export async function clearAllUserSessions(user: AuthContext, reason = "logout_all") {
  await revokeUserSessions(user.userId, reason);
  const cookieStore = await cookies();
  cookieStore.delete(sessionCookieName());
}

export async function rotateUserSession(user: AuthContext, request?: Request) {
  await revokeSession(user.sessionId, "rotated");
  return createUserSession(user, request);
}

export async function getPreAuthCsrfToken() {
  const raw = (await cookies()).get(preAuthCookieName())?.value;
  return raw ? csrfTokenForPreAuth(raw) : "";
}

function cookieFromRequest(request: Request, name: string) {
  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return null;
}

export function validatePreAuthCsrf(request: Request, supplied: string) {
  const raw = cookieFromRequest(request, preAuthCookieName());
  return Boolean(raw && validateRequestOrigin(request) && safeEqual(supplied, csrfTokenForPreAuth(raw)));
}

export async function setMfaChallengeCookie(token: string) {
  (await cookies()).set(mfaChallengeCookieName(), token, cookieOptions(5 * 60));
}

export async function getMfaChallengeToken() {
  return (await cookies()).get(mfaChallengeCookieName())?.value ?? null;
}

export async function getMfaCsrfToken() {
  const raw = await getMfaChallengeToken();
  return raw ? csrfTokenForPreAuth(`mfa:${raw}`) : "";
}

export function validateMfaCsrf(request: Request, supplied: string) {
  const raw = cookieFromRequest(request, mfaChallengeCookieName());
  return Boolean(raw && validateRequestOrigin(request) && safeEqual(supplied, csrfTokenForPreAuth(`mfa:${raw}`)));
}

export async function clearMfaChallengeCookie() {
  (await cookies()).delete(mfaChallengeCookieName());
}

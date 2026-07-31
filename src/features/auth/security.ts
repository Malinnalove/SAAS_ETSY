import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { getEnv } from "@/lib/env";

const MIN_SECRET_LENGTH = 32;

function configuredSecret(
  name: "AUTH_CSRF_SECRET" | "AUTH_MFA_ENCRYPTION_KEY" | "AUTH_RATE_LIMIT_SECRET" | "AUTH_SESSION_SECRET",
) {
  const env = getEnv();
  const value = env[name];
  if (value && Buffer.byteLength(value, "utf8") >= MIN_SECRET_LENGTH) return value;

  if (process.env.NODE_ENV === "production") {
    throw new Error(`${name} must contain at least ${MIN_SECRET_LENGTH} bytes in production.`);
  }

  if (name !== "AUTH_SESSION_SECRET" && env.AUTH_SESSION_SECRET && env.AUTH_SESSION_SECRET.length >= MIN_SECRET_LENGTH) {
    return createHmac("sha256", env.AUTH_SESSION_SECRET).update(`development:${name}`).digest("base64url");
  }

  throw new Error(`${name} must contain at least ${MIN_SECRET_LENGTH} bytes.`);
}

export function assertAuthConfiguration() {
  const secrets = [
    configuredSecret("AUTH_SESSION_SECRET"),
    configuredSecret("AUTH_CSRF_SECRET"),
    configuredSecret("AUTH_RATE_LIMIT_SECRET"),
  ];
  if (process.env.NODE_ENV === "production") {
    secrets.push(configuredSecret("AUTH_MFA_ENCRYPTION_KEY"));
    if (new Set(secrets).size !== secrets.length) {
      throw new Error("Authentication secrets must be independent values in production.");
    }
  }
}

export function authSecret(
  name: "AUTH_CSRF_SECRET" | "AUTH_MFA_ENCRYPTION_KEY" | "AUTH_RATE_LIMIT_SECRET" | "AUTH_SESSION_SECRET",
) {
  return configuredSecret(name);
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function hmacToken(secretName: Parameters<typeof authSecret>[0], value: string) {
  return createHmac("sha256", authSecret(secretName)).update(value).digest("base64url");
}

export function sessionTokenHash(token: string) {
  return hmacToken("AUTH_SESSION_SECRET", `session:${token}`);
}

export function challengeTokenHash(token: string) {
  return hmacToken("AUTH_SESSION_SECRET", `challenge:${token}`);
}

export function csrfTokenForSession(token: string) {
  return hmacToken("AUTH_CSRF_SECRET", `session:${token}`);
}

export function csrfTokenForPreAuth(token: string) {
  return hmacToken("AUTH_CSRF_SECRET", `preauth:${token}`);
}

export function recoveryCodeHash(userId: number, code: string) {
  return hmacToken("AUTH_MFA_ENCRYPTION_KEY", `recovery:${userId}:${code.replace(/\s|-/g, "").toUpperCase()}`);
}

export function safeEqual(left: string | null | undefined, right: string | null | undefined) {
  if (!left || !right) return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function normalizedUsernameKey(username: string) {
  return username.trim().toLowerCase();
}

function clientIp(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip")?.trim() || "unknown";
}

export function requestIpHash(request: Request) {
  return hmacToken("AUTH_RATE_LIMIT_SECRET", `ip:${clientIp(request)}`);
}

export function requestId(request?: Request) {
  const supplied = request?.headers.get("x-request-id")?.trim();
  return supplied && /^[A-Za-z0-9._:-]{8,128}$/.test(supplied) ? supplied : randomToken(12);
}

export function validateRequestOrigin(request: Request) {
  const method = request.method.toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return true;

  if (request.headers.get("sec-fetch-site") === "cross-site") return false;

  const expected = new URL(getEnv().APP_URL).origin;
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      return new URL(origin).origin === expected;
    } catch {
      return false;
    }
  }

  const referer = request.headers.get("referer");
  if (referer) {
    try {
      return new URL(referer).origin === expected;
    } catch {
      return false;
    }
  }

  return process.env.NODE_ENV !== "production";
}

async function readLimitedAuthBody(request: Request, maxBytes = 8 * 1024) {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return null;
  if (!request.body) return "";

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let bytesRead = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    if (bytesRead > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    body += decoder.decode(value, { stream: true });
  }
  return body + decoder.decode();
}

export async function readAuthForm(request: Request) {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") return null;
  const body = await readLimitedAuthBody(request);
  return body === null ? null : new URLSearchParams(body);
}

export async function readAuthJson(request: Request): Promise<Record<string, unknown> | null> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return null;
  const body = await readLimitedAuthBody(request);
  if (body === null) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function sanitizeAuditText(value: string | null | undefined, maxLength = 240) {
  return (value ?? "").replace(/[\r\n\u0000-\u001f\u007f]/g, " ").slice(0, maxLength);
}

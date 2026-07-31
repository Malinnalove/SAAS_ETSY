import { randomBytes } from "crypto";
import { NextRequest, NextResponse } from "next/server";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const CROSS_SITE_EXCEPTIONS = new Set([
  "/api/etsy/webhook",
  "/api/sync/cron",
  "/api/sync/jobs",
]);

function isProduction() {
  return process.env.NODE_ENV === "production";
}

function preAuthCookieName() {
  return isProduction() ? "__Host-erp_pre_auth" : "erp_pre_auth";
}

function contentSecurityPolicy(nonce: string) {
  const scriptSrc = [`'self'`, `'nonce-${nonce}'`, "'strict-dynamic'"];
  if (!isProduction()) scriptSrc.push("'unsafe-eval'");
  return [
    "default-src 'self'",
    `script-src ${scriptSrc.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://*.etsy.com https://*.etsystatic.com",
    "font-src 'self' data:",
    `connect-src 'self'${isProduction() ? "" : " ws: wss:"}`,
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "worker-src 'self' blob:",
    isProduction() ? "upgrade-insecure-requests" : "",
  ].filter(Boolean).join("; ");
}

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim();
  if (
    isProduction() &&
    (forwardedProto === "http" || (!forwardedProto && request.nextUrl.protocol === "http:"))
  ) {
    const secureUrl = request.nextUrl.clone();
    secureUrl.protocol = "https:";
    return NextResponse.redirect(secureUrl, 308);
  }

  if (
    !SAFE_METHODS.has(request.method) &&
    request.headers.get("sec-fetch-site") === "cross-site" &&
    !CROSS_SITE_EXCEPTIONS.has(pathname)
  ) {
    return NextResponse.json({ error: "Cross-site request rejected." }, { status: 403 });
  }

  const nonce = randomBytes(16).toString("base64");
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", contentSecurityPolicy(nonce));
  const shouldSetPreAuth = pathname === "/login" && request.method === "GET" && !request.cookies.get(preAuthCookieName());
  const preAuthToken = shouldSetPreAuth ? randomBytes(24).toString("base64url") : null;
  if (preAuthToken) {
    const currentCookie = requestHeaders.get("cookie");
    requestHeaders.set("cookie", `${currentCookie ? `${currentCookie}; ` : ""}${preAuthCookieName()}=${preAuthToken}`);
  }
  const response = NextResponse.next({ request: { headers: requestHeaders } });

  response.headers.set("Content-Security-Policy", contentSecurityPolicy(nonce));
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (isProduction()) response.headers.set("Strict-Transport-Security", "max-age=31536000");

  if (!pathname.startsWith("/_next/") && !pathname.startsWith("/images/")) {
    response.headers.set("Cache-Control", "private, no-store");
  }

  if (preAuthToken) {
    response.cookies.set(preAuthCookieName(), preAuthToken, {
      httpOnly: true,
      maxAge: 10 * 60,
      path: "/",
      sameSite: "lax",
      secure: isProduction(),
    });
  }

  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon.ico|icon.png).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};

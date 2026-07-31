import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { authenticateUser } from "@/features/auth/db";
import { createMfaChallenge } from "@/features/auth/mfa";
import {
  createUserSession,
  preAuthCookieName,
  safeReturnPath,
  setMfaChallengeCookie,
  validatePreAuthCsrf,
} from "@/features/auth/session";
import { readAuthForm, requestId, requestIpHash } from "@/features/auth/security";

function relativeRedirect(pathname: string) {
  return new NextResponse(null, {
    headers: { Location: pathname },
    status: 303,
  });
}

function loginRedirect(error: "invalid" | "rate" | "request" | "setup", next: string, id?: string) {
  const params = new URLSearchParams({ error, next });
  if (id) params.set("requestId", id);
  return relativeRedirect(`/login?${params.toString()}`);
}

export async function POST(request: NextRequest) {
  const nextRequestId = requestId(request);
  const next = safeReturnPath(new URL(request.url).searchParams.get("next"));
  const formData = await readAuthForm(request);
  if (!formData) return loginRedirect("request", next);
  const returnTo = safeReturnPath(String(formData.get("next") ?? next));
  if (!validatePreAuthCsrf(request, String(formData.get("_csrf") ?? ""))) {
    return loginRedirect("request", returnTo);
  }

  try {
    const result = await authenticateUser({
      ipHash: requestIpHash(request),
      password: String(formData.get("password") ?? ""),
      requestId: nextRequestId,
      username: String(formData.get("username") ?? ""),
    });
    if (result.status === "invalid") return loginRedirect("invalid", returnTo);
    if (result.status === "rate_limited") {
      const response = loginRedirect("rate", returnTo);
      response.headers.set("Retry-After", String(result.retryAfterSeconds));
      return response;
    }

    (await cookies()).delete(preAuthCookieName());
    if (result.identity.mfaEnabled) {
      await setMfaChallengeCookie(await createMfaChallenge(result.identity));
      return relativeRedirect(`/login/mfa?${new URLSearchParams({ next: returnTo }).toString()}`);
    }

    await createUserSession(result.identity, request);
    return relativeRedirect(result.identity.mustChangePassword ? "/account/activate" : returnTo);
  } catch {
    return loginRedirect("setup", returnTo, nextRequestId);
  }
}

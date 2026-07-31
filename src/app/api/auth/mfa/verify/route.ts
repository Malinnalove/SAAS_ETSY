import { NextRequest, NextResponse } from "next/server";
import { verifyMfaChallenge } from "@/features/auth/mfa";
import {
  clearMfaChallengeCookie,
  createUserSession,
  getMfaChallengeToken,
  safeReturnPath,
  validateMfaCsrf,
} from "@/features/auth/session";
import { readAuthForm, requestId, requestIpHash } from "@/features/auth/security";

export async function POST(request: NextRequest) {
  const form = await readAuthForm(request);
  const next = safeReturnPath(String(form?.get("next") ?? ""));
  const invalid = () => NextResponse.redirect(new URL(`/login/mfa?error=invalid&next=${encodeURIComponent(next)}`, request.url), 303);
  if (!form || !validateMfaCsrf(request, String(form.get("_csrf") ?? ""))) return invalid();
  const rawChallenge = await getMfaChallengeToken();
  if (!rawChallenge) return invalid();

  try {
    const identity = await verifyMfaChallenge({
      audit: { ipHash: requestIpHash(request), requestId: requestId(request) },
      code: String(form.get("code") ?? "").trim(),
      rawChallenge,
    });
    await clearMfaChallengeCookie();
    await createUserSession(identity, request);
    return NextResponse.redirect(new URL(identity.mustChangePassword ? "/account/activate" : next, request.url), 303);
  } catch {
    return invalid();
  }
}

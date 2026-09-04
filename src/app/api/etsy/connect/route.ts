import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { requireUserApi, safeReturnPath as safeAuthReturnPath } from "@/features/auth/session";
import { getEtsyApiConfig, parseEtsyApiSlot } from "@/features/etsy/api-config";
import { createCodeChallenge, createCodeVerifier, createState } from "@/lib/oauth";

function safeReturnPath(value: string | null) {
  return value ? safeAuthReturnPath(value) : null;
}

export async function GET(request: NextRequest) {
  const guard = await requireUserApi(request, "shops.manage");
  if (guard.response) {
    return guard.response;
  }

  const requestedApiSlot = request.nextUrl.searchParams.get("api");
  const apiSlot = requestedApiSlot ? parseEtsyApiSlot(requestedApiSlot) : 1;
  if (!apiSlot) {
    return NextResponse.json({ error: "Unknown Etsy API slot." }, { status: 400 });
  }
  const config = getEtsyApiConfig(apiSlot);
  const state = createState();
  const codeVerifier = createCodeVerifier();
  const codeChallenge = createCodeChallenge(codeVerifier);
  const returnTo = safeReturnPath(request.nextUrl.searchParams.get("returnTo"));

  const cookieStore = await cookies();
  cookieStore.set("etsy_oauth_state", state, {
    httpOnly: true,
    maxAge: 10 * 60,
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
  cookieStore.set("etsy_code_verifier", codeVerifier, {
    httpOnly: true,
    maxAge: 10 * 60,
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
  cookieStore.set("etsy_api_slot", String(apiSlot), {
    httpOnly: true,
    maxAge: 10 * 60,
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
  if (returnTo) {
    cookieStore.set("etsy_oauth_return_to", returnTo, {
      httpOnly: true,
      maxAge: 10 * 60,
      path: "/",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    });
  }

  const params = new URLSearchParams({
    response_type: "code",
    redirect_uri: config.redirectUri,
    scope: config.scopes,
    client_id: config.clientId,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  return NextResponse.redirect(`https://www.etsy.com/oauth/connect?${params.toString()}`);
}

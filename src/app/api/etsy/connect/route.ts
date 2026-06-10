import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { createCodeChallenge, createCodeVerifier, createState } from "@/lib/oauth";

function safeReturnPath(value: string | null) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return null;
  }

  return value;
}

export async function GET(request: NextRequest) {
  const env = getEnv();
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
  });
  cookieStore.set("etsy_code_verifier", codeVerifier, {
    httpOnly: true,
    maxAge: 10 * 60,
    path: "/",
    sameSite: "lax",
  });
  if (returnTo) {
    cookieStore.set("etsy_oauth_return_to", returnTo, {
      httpOnly: true,
      maxAge: 10 * 60,
      path: "/",
      sameSite: "lax",
    });
  }

  const params = new URLSearchParams({
    response_type: "code",
    redirect_uri: env.ETSY_REDIRECT_URI,
    scope: env.ETSY_SCOPES,
    client_id: env.ETSY_CLIENT_ID,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  return NextResponse.redirect(`https://www.etsy.com/oauth/connect?${params.toString()}`);
}

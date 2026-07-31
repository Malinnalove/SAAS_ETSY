import { getEnv } from "@/lib/env";
import type { EtsyConnection } from "@/shared/types/etsy";
import { parseEtsyResponse } from "@/features/etsy/client";

const ETSY_TOKEN_URL = "https://openapi.etsy.com/v3/public/oauth/token";

type EtsyTokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
};

export async function exchangeAuthorizationCode(code: string, codeVerifier: string) {
  const env = getEnv();
  const response = await fetch(ETSY_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: env.ETSY_CLIENT_ID,
      redirect_uri: env.ETSY_REDIRECT_URI,
      code,
      code_verifier: codeVerifier,
    }),
  });

  return parseEtsyResponse<EtsyTokenResponse>(response);
}

export async function refreshAccessToken(connection: EtsyConnection) {
  const env = getEnv();
  const response = await fetch(ETSY_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: env.ETSY_CLIENT_ID,
      refresh_token: connection.refreshToken,
    }),
  });

  const token = await parseEtsyResponse<EtsyTokenResponse>(response);
  return {
    ...connection,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + token.expires_in * 1000,
    updatedAt: new Date().toISOString(),
  };
}

export async function ensureFreshConnection(connection: EtsyConnection) {
  if (connection.expiresAt > Date.now() + 60_000) {
    return connection;
  }

  return refreshAccessToken(connection);
}

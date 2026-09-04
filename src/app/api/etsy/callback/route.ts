import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { requireUserApi } from "@/features/auth/session";
import { EtsyClient } from "@/features/etsy/client";
import { buildEtsyCallbackRedirectUrl } from "@/features/etsy/callback-redirect";
import { exchangeAuthorizationCode } from "@/features/etsy/oauth";
import { getEnv } from "@/lib/env";
import { getUserIdFromAccessToken } from "@/lib/oauth";
import { selectShop, updateStore, upsertShop } from "@/lib/store";
import {
  assertShopOrganizationAvailable,
  assignShopToOrganization,
  enqueueSyncJob,
  getEtsyApiSlotShopCount,
} from "@/features/sync/db";
import { processSyncJobById } from "@/features/sync/processor";
import type { EtsyConnection } from "@/shared/types/etsy";
import { requestId } from "@/features/auth/security";
import {
  getEtsyApiConfig,
  MAX_ETSY_SHOPS_PER_API,
  parseEtsyApiSlot,
} from "@/features/etsy/api-config";

export async function GET(request: NextRequest) {
  try {
    const guard = await requireUserApi(request, "shops.manage");
    if (guard.response || !guard.admin) {
      return guard.response;
    }

    const code = request.nextUrl.searchParams.get("code");
    const state = request.nextUrl.searchParams.get("state");
    const error = request.nextUrl.searchParams.get("error");
    const appUrl = getEnv().APP_URL;

    if (error) {
      return NextResponse.redirect(new URL(`/?error=${encodeURIComponent(error)}`, appUrl));
    }

    if (!code || !state) {
      return NextResponse.json({ error: "Missing Etsy OAuth code or state." }, { status: 400 });
    }

    const cookieStore = await cookies();
    const expectedState = cookieStore.get("etsy_oauth_state")?.value;
    const codeVerifier = cookieStore.get("etsy_code_verifier")?.value;
    const returnTo = cookieStore.get("etsy_oauth_return_to")?.value;
    const apiSlot = parseEtsyApiSlot(cookieStore.get("etsy_api_slot")?.value);

    if (!expectedState || expectedState !== state || !codeVerifier || !apiSlot) {
      return NextResponse.json({ error: "Invalid Etsy OAuth state." }, { status: 400 });
    }

    const token = await exchangeAuthorizationCode(code, codeVerifier, apiSlot);
    const userId = getUserIdFromAccessToken(token.access_token);
    const config = getEtsyApiConfig(apiSlot);

    const temporaryConnection: EtsyConnection = {
      apiSlot,
      userId,
      shopId: 0,
      shopName: "Etsy Shop",
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: Date.now() + token.expires_in * 1000,
      scopes: config.scopes.split(/\s+/).filter(Boolean),
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const client = new EtsyClient(temporaryConnection);
    const shop = await client.getShopByOwnerUserId(userId);

    if (!shop) {
      return NextResponse.json({ error: "No Etsy shop found for this user." }, { status: 404 });
    }

    const connection: EtsyConnection = {
      ...temporaryConnection,
      shopId: shop.shop_id,
      shopName: shop.shop_name,
    };

    let status = "connected";

    const otherShopCount = await getEtsyApiSlotShopCount(apiSlot, connection.shopId);
    if (otherShopCount >= MAX_ETSY_SHOPS_PER_API) {
      return NextResponse.json(
        { error: `Etsy API ${apiSlot} already has ${MAX_ETSY_SHOPS_PER_API} connected shops.` },
        { status: 409 },
      );
    }

    await assertShopOrganizationAvailable(connection.shopId, guard.admin.organizationId);

    await updateStore((store) => {
      const existingShop = selectShop(store, connection.shopId);
      status = existingShop ? "reconnected" : "connected";

      return upsertShop(store, {
        connection,
        shop,
        listings: existingShop?.listings ?? [],
        receipts: existingShop?.receipts ?? [],
        orderDetails: existingShop?.orderDetails ?? [],
        ads: existingShop?.ads ?? [],
        adsSyncNote: existingShop?.adsSyncNote ?? null,
        apiQuota: existingShop?.apiQuota ?? null,
        lastSyncAt: existingShop?.lastSyncAt ?? null,
        newOrderCount: existingShop?.newOrderCount ?? 0,
      });
    });
    await assignShopToOrganization(connection.shopId, guard.admin.organizationId);

    cookieStore.delete("etsy_oauth_state");
    cookieStore.delete("etsy_code_verifier");
    cookieStore.delete("etsy_oauth_return_to");
    cookieStore.delete("etsy_api_slot");

    const jobId = await enqueueSyncJob(
      connection.shopId,
      "sync_shop_full",
      {
        requestedBy: "oauth_callback",
        requestedAt: new Date().toISOString(),
      },
      20,
    );
    if (status === "connected") {
      await processSyncJobById(jobId);
    } else {
      void processSyncJobById(jobId).catch(() => undefined);
    }

    return NextResponse.redirect(buildEtsyCallbackRedirectUrl(appUrl, returnTo, connection.shopId, status));
  } catch (error) {
    const id = requestId(request);
    console.error(`[${id}] Etsy callback failed`, error instanceof Error ? error.name : "Unknown error");
    return NextResponse.json(
      {
        error: "Etsy callback failed.",
        requestId: id,
      },
      { status: 500 },
    );
  }
}

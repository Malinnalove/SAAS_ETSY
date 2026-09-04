import { getEnv } from "@/lib/env";
import type { EtsyApiSlot, EtsyConnection, EtsyShopData } from "@/shared/types/etsy";

export const MAX_ETSY_SHOPS_PER_API = 5;

export function parseEtsyApiSlot(value: unknown): EtsyApiSlot | null {
  if (value === 1 || value === "1") return 1;
  if (value === 2 || value === "2") return 2;
  return null;
}

export function etsyApiSlotForConnection(connection: Pick<EtsyConnection, "apiSlot">): EtsyApiSlot {
  return parseEtsyApiSlot(connection.apiSlot) ?? 1;
}

export function etsyApiShopCount(
  shops: ReadonlyArray<Pick<EtsyShopData, "connection">>,
  apiSlot: EtsyApiSlot,
) {
  return shops.filter((shop) => etsyApiSlotForConnection(shop.connection) === apiSlot).length;
}

export function etsyApiSlotHasCapacity(
  shops: ReadonlyArray<Pick<EtsyShopData, "connection">>,
  apiSlot: EtsyApiSlot,
) {
  return etsyApiShopCount(shops, apiSlot) < MAX_ETSY_SHOPS_PER_API;
}

export function isEtsyApiConfigured(apiSlot: EtsyApiSlot) {
  const env = getEnv();
  return apiSlot === 1 ? Boolean(env.ETSY_CLIENT_ID) : Boolean(env.ETSY_CLIENT_ID_2);
}

export function getEtsyApiConfig(apiSlot: EtsyApiSlot) {
  const env = getEnv();
  const clientId = apiSlot === 1 ? env.ETSY_CLIENT_ID : env.ETSY_CLIENT_ID_2;
  const sharedSecret = apiSlot === 1 ? env.ETSY_SHARED_SECRET : env.ETSY_SHARED_SECRET_2;
  const webhookSecret = apiSlot === 1 ? env.ETSY_WEBHOOK_SECRET : env.ETSY_WEBHOOK_SECRET_2;

  if (!clientId) {
    throw new Error(`Etsy API ${apiSlot} is not configured.`);
  }

  return {
    apiSlot,
    clientId,
    redirectUri: env.ETSY_REDIRECT_URI,
    scopes: env.ETSY_SCOPES,
    sharedSecret,
    webhookSecret,
  };
}

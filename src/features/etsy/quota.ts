import { updateEtsyApiQuota } from "@/features/sync/db";
import { updateStore } from "@/lib/store";
import { getPool } from "@/server/db";
import { etsyApiSlotForConnection } from "@/features/etsy/api-config";
import type { EtsyApiQuota, EtsyApiSlot } from "@/shared/types/etsy";

function numberHeader(headers: Headers, name: string) {
  const raw = headers.get(name);
  if (!raw) return null;

  const value = Number(raw.replace(/,/g, "").trim());
  return Number.isFinite(value) ? value : null;
}

export function etsyApiQuotaFromHeaders(headers: Headers): EtsyApiQuota | null {
  const remainingToday = numberHeader(headers, "x-remaining-today");
  const limitPerDay = numberHeader(headers, "x-limit-per-day");

  if (remainingToday === null && limitPerDay === null) {
    return null;
  }

  return {
    limitPerDay,
    remainingToday,
    updatedAt: new Date().toISOString(),
  };
}

export async function persistEtsyApiQuota(shopId: number, apiSlot: EtsyApiSlot, apiQuota: EtsyApiQuota) {
  if (!Number.isFinite(shopId) || shopId <= 0) return;

  const pool = getPool();

  if (pool) {
    await updateEtsyApiQuota(shopId, apiSlot, apiQuota, pool);
    return;
  }

  await updateStore((store) => ({
    ...store,
    shops: store.shops.map((shopData) => ({
      ...shopData,
      apiQuota: etsyApiSlotForConnection(shopData.connection) === apiSlot ? apiQuota : shopData.apiQuota,
    })),
  }));
}

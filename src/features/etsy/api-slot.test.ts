import { describe, expect, it } from "vitest";
import {
  etsyApiShopCount,
  etsyApiSlotForConnection,
  etsyApiSlotHasCapacity,
  parseEtsyApiSlot,
} from "@/features/etsy/api-config";
import { normalizeStore } from "@/lib/store";
import type { EtsyApiSlot, EtsyShopData } from "@/shared/types/etsy";

function shop(shopId: number, apiSlot: EtsyApiSlot | undefined, remainingToday: number, updatedAt: string): EtsyShopData {
  return {
    connection: {
      ...(apiSlot ? { apiSlot } : {}),
      accessToken: `access-${shopId}`,
      connectedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: 2_000_000_000_000,
      refreshToken: `refresh-${shopId}`,
      scopes: [],
      shopId,
      shopName: `Shop ${shopId}`,
      updatedAt: "2026-01-01T00:00:00.000Z",
      userId: String(shopId),
    },
    shop: null,
    listings: [],
    receipts: [],
    orderDetails: [],
    ads: [],
    adsSyncNote: null,
    apiQuota: { limitPerDay: 10_000, remainingToday, updatedAt },
    lastSyncAt: null,
    newOrderCount: 0,
  };
}

describe("Etsy API slots", () => {
  it("accepts only API slot 1 or 2 and treats legacy connections as API 1", () => {
    expect(parseEtsyApiSlot("1")).toBe(1);
    expect(parseEtsyApiSlot(2)).toBe(2);
    expect(parseEtsyApiSlot("3")).toBeNull();
    expect(etsyApiSlotForConnection({})).toBe(1);
  });

  it("shares quota within one API without leaking it into the other API", () => {
    const normalized = normalizeStore({
      activeShopId: 3,
      shops: [
        shop(1, undefined, 9_000, "2026-01-01T00:00:00.000Z"),
        shop(2, 1, 8_000, "2026-01-02T00:00:00.000Z"),
        shop(3, 2, 4_000, "2026-01-03T00:00:00.000Z"),
      ],
    });

    expect(normalized.shops.find((item) => item.connection.shopId === 1)?.connection.apiSlot).toBe(1);
    expect(normalized.shops.find((item) => item.connection.shopId === 1)?.apiQuota?.remainingToday).toBe(8_000);
    expect(normalized.shops.find((item) => item.connection.shopId === 2)?.apiQuota?.remainingToday).toBe(8_000);
    expect(normalized.shops.find((item) => item.connection.shopId === 3)?.apiQuota?.remainingToday).toBe(4_000);
    expect(normalized.apiQuota?.remainingToday).toBe(4_000);
  });

  it("limits each API slot independently to five shops", () => {
    const shops = [
      ...Array.from({ length: 5 }, (_, index) => shop(index + 1, 1, 9_000, "2026-01-01T00:00:00.000Z")),
      ...Array.from({ length: 4 }, (_, index) => shop(index + 6, 2, 8_000, "2026-01-01T00:00:00.000Z")),
    ];

    expect(etsyApiShopCount(shops, 1)).toBe(5);
    expect(etsyApiShopCount(shops, 2)).toBe(4);
    expect(etsyApiSlotHasCapacity(shops, 1)).toBe(false);
    expect(etsyApiSlotHasCapacity(shops, 2)).toBe(true);
  });
});

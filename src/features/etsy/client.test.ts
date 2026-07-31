import { describe, expect, it, vi } from "vitest";
import { EtsyClient } from "@/features/etsy/client";
import type { EtsyConnection, EtsyReceiptSummary } from "@/shared/types/etsy";

const connection: EtsyConnection = {
  accessToken: "access-token",
  connectedAt: "2026-07-13T00:00:00.000Z",
  expiresAt: 0,
  refreshToken: "refresh-token",
  scopes: [],
  shopId: 1,
  shopName: "Test shop",
  updatedAt: "2026-07-13T00:00:00.000Z",
  userId: "test-user",
};

describe("EtsyClient receipt detail sync", () => {
  it("replaces the recent receipt-list summary with the individual receipt detail", async () => {
    const client = new EtsyClient(connection);
    const older: EtsyReceiptSummary = { create_timestamp: 10, name: "Old recipient", receipt_id: 10 };
    const recent: EtsyReceiptSummary = { create_timestamp: 20, name: "Summary recipient", receipt_id: 20 };
    const detail: EtsyReceiptSummary = {
      city: "Bristol",
      first_line: "28 Otterells Mead",
      name: "Detail recipient",
      receipt_id: 20,
      state: "BS20 0AJ",
    };
    const getReceipt = vi.spyOn(client, "getReceipt").mockResolvedValue(detail);

    await expect(client.getRecentReceiptDetails(1, [older, recent], 1)).resolves.toEqual([older, {
      ...recent,
      ...detail,
    }]);
    expect(getReceipt).toHaveBeenCalledTimes(1);
    expect(getReceipt).toHaveBeenCalledWith(1, 20);
  });
});

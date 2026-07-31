import { describe, expect, it } from "vitest";
import { buildReceiptOrderRows } from "@/features/orders/view-model";

describe("receipt order rows", () => {
  it("keeps each receipt unique and groups all of its item transactions", () => {
    const rows = buildReceiptOrderRows(
      [
        { create_timestamp: 20, is_paid: true, name: "Valeria", receipt_id: 100 },
        { create_timestamp: 10, receipt_id: 200 },
      ],
      [
        { expected_ship_date: 50, receipt_id: 100, sku: "FIRST", transaction_id: 1 },
        { expected_ship_date: 40, receipt_id: 100, sku: "SECOND", transaction_id: 2 },
        { receipt_id: 200, sku: "THIRD", transaction_id: 3 },
      ],
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      expectedShipDate: 40,
      isPaid: true,
      receipt: { receipt_id: 100 },
      transactions: [{ sku: "FIRST" }, { sku: "SECOND" }],
    });
    expect(rows[1]).toMatchObject({
      expectedShipDate: null,
      isPaid: null,
      receipt: { receipt_id: 200 },
      transactions: [{ sku: "THIRD" }],
    });
  });
});

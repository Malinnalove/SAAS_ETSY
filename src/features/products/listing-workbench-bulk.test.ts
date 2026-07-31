import { describe, expect, it } from "vitest";
import { parseListingBulkPaste } from "@/features/products/listing-workbench-bulk";
import { applyListingPatch, blankListingValues } from "@/features/products/listing-workbench-model";

const defaults = applyListingPatch(blankListingValues(), {
  description: "Default description",
  price: { amount: 9.99, currency: "USD" },
  quantity: 5,
  taxonomyId: 2098,
});

describe("Listing Workbench bulk paste", () => {
  it("supports the legacy no-header TDK order", () => {
    const rows = parseListingBulkPaste([
      ["SKU-1", "First title", "First description", "one, two"],
      ["SKU-2", "Second title", "Second description", "three"],
    ], defaults);
    expect(rows).toHaveLength(2);
    expect(rows[0].changes).toMatchObject({ sku: "SKU-1", title: "First title", tags: ["one", "two"] });
    expect(rows[0].errors).toEqual({});
  });

  it("recognizes Chinese headers and typed commerce fields", () => {
    const rows = parseListingBulkPaste([
      ["SKU", "标题", "价格", "库存", "分类ID", "关键词"],
      ["SKU-3", "Third title", "12.50", "8", "3001", "alpha，beta"],
    ], defaults);
    expect(rows[0].changes).toMatchObject({
      price: { amount: 12.5, currency: "USD" },
      quantity: 8,
      sku: "SKU-3",
      tags: ["alpha", "beta"],
      taxonomyId: 3001,
      title: "Third title",
    });
  });

  it("uses shop defaults for fields omitted from pasted rows", () => {
    const rows = parseListingBulkPaste([["SKU", "Title"], ["SKU-4", "Defaults listing"]], defaults);
    expect(rows[0].errors).toEqual({});
    expect(rows[0].changes.description).toBeUndefined();
  });

  it("reports invalid numeric cells without dropping the row", () => {
    const rows = parseListingBulkPaste([["SKU", "Title", "Quantity"], ["SKU-5", "Bad quantity", "many"]], defaults);
    expect(rows).toHaveLength(1);
    expect(rows[0].errors.quantity).toBeTruthy();
  });
});

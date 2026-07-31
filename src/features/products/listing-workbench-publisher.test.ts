import { describe, expect, it } from "vitest";
import { blankListingValues, applyListingPatch } from "@/features/products/listing-workbench-model";
import { buildListingUpdatePatch, inventoryWithMainSku } from "@/features/products/listing-workbench-publisher";

describe("Listing Workbench Etsy patch", () => {
  it("only publishes fields frozen into the draft patch", () => {
    const values = applyListingPatch(blankListingValues("EUR"), {
      description: "New description",
      price: { amount: 19.95, currency: "EUR" },
      quantity: 8,
      shouldAutoRenew: false,
      title: "New title",
    });

    expect(buildListingUpdatePatch({ price: values.price, quantity: 8, shouldAutoRenew: false }, values)).toEqual({
      price: "19.95",
      quantity: 8,
      shouldAutoRenew: false,
    });
  });

  it("preserves explicit empty arrays and false boolean values", () => {
    const values = applyListingPatch(blankListingValues(), { isSupply: false, tags: [] });
    expect(buildListingUpdatePatch({ isSupply: false, tags: [] }, values)).toEqual({
      isSupply: false,
      tags: [],
    });
  });

  it("does not emit unsupported lifecycle states to Etsy", () => {
    const values = applyListingPatch(blankListingValues(), { state: "archived" });
    expect(buildListingUpdatePatch({ state: "archived" }, values)).toEqual({});
  });

  it("writes the main SKU to every variation while individual SKU overrides are off", () => {
    const values = applyListingPatch(blankListingValues(), { sku: "MAIN-SKU" });
    const inventory = inventoryWithMainSku({
      products: [
        { offerings: [{ is_enabled: true, price: 10, quantity: 1 }], property_values: [{ property_id: 200, values: ["Red"] }], sku: "OLD-RED" },
        { offerings: [{ is_enabled: true, price: 10, quantity: 1 }], property_values: [{ property_id: 200, values: ["Blue"] }], sku: "OLD-BLUE" },
      ],
      sku_on_property: [],
    }, values);

    expect(inventory.products.map((product) => product.sku)).toEqual(["MAIN-SKU", "MAIN-SKU"]);
  });

  it("does not overwrite individual SKU values from the main table", () => {
    const values = applyListingPatch(blankListingValues(), { sku: "MAIN-SKU" });
    expect(() => inventoryWithMainSku({
      products: [{ offerings: [{ is_enabled: true, price: 10, quantity: 1 }], property_values: [{ property_id: 200, values: ["Red"] }], sku: "RED-SKU" }],
      sku_on_property: [200],
    }, values)).toThrow(/Variant SKU overrides/);
  });
});

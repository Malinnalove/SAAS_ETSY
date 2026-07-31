import { describe, expect, it } from "vitest";
import { blankListingValues } from "@/features/products/listing-workbench-model";
import {
  MAX_LISTING_VARIATION_GROUPS,
  normalizeVariationGroups,
  rebuildInventoryForVariationGroups,
  variationGroupsFromInventory,
  type ListingVariationGroupDraft,
} from "@/features/products/listing-workbench-variations";

const groups: ListingVariationGroupDraft[] = [
  {
    id: "color",
    name: "Color",
    propertyId: 513,
    scaleId: null,
    values: [{ id: "red", value: "Red" }, { id: "blue", value: "Blue" }],
  },
  {
    id: "size",
    name: "Size",
    propertyId: 514,
    scaleId: null,
    values: [{ id: "small", value: "Small" }, { id: "large", value: "Large" }],
  },
];

describe("Listing Workbench variations", () => {
  it("reads editable variation groups from inventory", () => {
    const inventory = rebuildInventoryForVariationGroups(
      { ...blankListingValues(), price: { amount: 12, currency: "USD" }, quantity: 3, sku: "MAIN" },
      null,
      groups,
    );

    expect(variationGroupsFromInventory(inventory).map((group) => ({ name: group.name, values: group.values.map((value) => value.value) }))).toEqual([
      { name: "Color", values: ["Red", "Blue"] },
      { name: "Size", values: ["Small", "Large"] },
    ]);
  });

  it("limits a listing to two variation groups", () => {
    expect(() => normalizeVariationGroups([...groups, { ...groups[0], id: "third", propertyId: 515 }])).toThrow(/at most two/);
    expect(MAX_LISTING_VARIATION_GROUPS).toBe(2);
  });

  it("regenerates combinations and preserves main-SKU mode", () => {
    const values = { ...blankListingValues(), price: { amount: 12, currency: "USD" }, quantity: 3, sku: "MAIN" };
    const inventory = rebuildInventoryForVariationGroups(values, null, groups);

    expect(inventory.products).toHaveLength(4);
    expect(inventory.products.map((product) => product.sku)).toEqual(["MAIN", "MAIN", "MAIN", "MAIN"]);
    expect(inventory.sku_on_property).toEqual([]);
  });

  it("keeps matching individual SKU values when variables are saved again", () => {
    const values = { ...blankListingValues(), price: { amount: 12, currency: "USD" }, quantity: 3, sku: "MAIN" };
    const current = rebuildInventoryForVariationGroups(values, null, groups);
    current.sku_on_property = [513, 514];
    current.products.forEach((product, index) => {
      product.sku = `VARIANT-${index + 1}`;
    });

    const rebuilt = rebuildInventoryForVariationGroups(values, current, groups);
    expect(rebuilt.sku_on_property).toEqual([513, 514]);
    expect(rebuilt.products.map((product) => product.sku)).toEqual(["VARIANT-1", "VARIANT-2", "VARIANT-3", "VARIANT-4"]);
  });
});

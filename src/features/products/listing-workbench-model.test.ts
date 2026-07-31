import { describe, expect, it } from "vitest";
import {
  applyListingPatch,
  blankListingValues,
  listingDraftPatchSchema,
  listingFieldDefinitions,
  listingSavedViewDefinitionSchema,
  listingValuesFromSource,
  sourceVersionForListing,
  validateListingValues,
} from "@/features/products/listing-workbench-model";
import type { EtsyListingSummary } from "@/shared/types/etsy";

function listing(overrides: Partial<EtsyListingSummary> = {}): EtsyListingSummary {
  return {
    description: "Description",
    inventory: {
      products: [
        {
          offerings: [{ is_enabled: true, price: 12.5, quantity: 4 }],
          property_values: [],
          sku: "SKU-1",
        },
      ],
    },
    is_supply: false,
    listing_id: 100,
    materials: ["Plastic"],
    price: { amount: 1250, currency_code: "USD", divisor: 100 },
    quantity: 4,
    should_auto_renew: true,
    state: "active",
    tags: ["tag"],
    taxonomy_id: 2098,
    title: "Test listing",
    type: "physical",
    when_made: "made_to_order",
    who_made: "i_did",
    ...overrides,
  };
}

describe("Listing Workbench model", () => {
  it("normalizes Etsy money and the single inventory SKU", () => {
    const values = listingValuesFromSource(listing());
    expect(values.price).toEqual({ amount: 12.5, currency: "USD" });
    expect(values.sku).toBe("SKU-1");
    expect(values.quantity).toBe(4);
  });

  it("uses a uniform SKU as the main SKU unless variants explicitly override it", () => {
    const inventory = {
      products: [
        { offerings: [{ is_enabled: true, price: 12.5, quantity: 4 }], property_values: [{ property_id: 200, values: ["Red"] }], sku: "MAIN-SKU" },
        { offerings: [{ is_enabled: true, price: 12.5, quantity: 4 }], property_values: [{ property_id: 200, values: ["Blue"] }], sku: "MAIN-SKU" },
      ],
      sku_on_property: [],
    };
    expect(listingValuesFromSource(listing({ inventory })).sku).toBe("MAIN-SKU");
    expect(listingValuesFromSource(listing({ inventory: { ...inventory, sku_on_property: [200] } })).sku).toBe("");
  });

  it("allows a main SKU for multi-variant listings when per-variant SKU overrides are off", () => {
    const values = applyListingPatch(blankListingValues(), {
      inventory: {
        products: [
          { offerings: [{ is_enabled: true, price: 12.5, quantity: 4 }], property_values: [{ property_id: 200, values: ["Red"] }], sku: "A" },
          { offerings: [{ is_enabled: true, price: 12.5, quantity: 4 }], property_values: [{ property_id: 200, values: ["Blue"] }], sku: "B" },
        ],
        sku_on_property: [],
      },
      sku: "MAIN-SKU",
      title: "Ready listing",
    });
    expect(validateListingValues(values, "existing").sku).toBeUndefined();
  });

  it("creates stable source versions and changes them for writable fields", () => {
    const source = listing();
    expect(sourceVersionForListing(source)).toBe(sourceVersionForListing({ ...source }));
    expect(sourceVersionForListing(source)).not.toBe(sourceVersionForListing({ ...source, title: "Changed" }));
    expect(sourceVersionForListing(source)).toBe(sourceVersionForListing({ ...source, views: 999 }));
  });

  it("applies typed patches without stringifying values", () => {
    const values = blankListingValues("EUR");
    const next = applyListingPatch(values, {
      price: { amount: 19.9, currency: "EUR" },
      quantity: 8,
      tags: ["one", "two"],
    });
    expect(next.price?.amount).toBe(19.9);
    expect(next.quantity).toBe(8);
    expect(next.tags).toEqual(["one", "two"]);
  });

  it("validates the required new-listing fields", () => {
    const errors = validateListingValues(blankListingValues(), "new");
    expect(errors).toMatchObject({ description: expect.any(String), price: expect.any(String), title: expect.any(String) });
    const valid = applyListingPatch(blankListingValues(), {
      description: "Ready",
      price: { amount: 10, currency: "USD" },
      taxonomyId: 2098,
      title: "Ready listing",
    });
    expect(validateListingValues(valid, "new")).toEqual({});
  });

  it("rejects invalid patch shapes at the API boundary", () => {
    expect(() => listingDraftPatchSchema.parse({ quantity: -1 })).toThrow();
    expect(() => listingDraftPatchSchema.parse({ tags: Array.from({ length: 14 }, (_, index) => `tag-${index}`) })).toThrow();
  });

  it("keeps the default table focused on fast-edit fields", () => {
    expect(listingFieldDefinitions.filter((field) => field.defaultVisible).map((field) => field.id)).toEqual([
      "sku",
      "title",
      "price",
      "quantity",
      "state",
    ]);
  });

  it("validates saved view columns and sizing", () => {
    expect(listingSavedViewDefinitionSchema.parse({
      columns: [{ fieldId: "sku", pinned: "left", width: 170 }],
      density: "compact",
      filter: "changed",
      pinnedColumns: ["lifecycle", "image", "sku"],
      sort: "updated_desc",
    }).columns[0].fieldId).toBe("sku");
    expect(() => listingSavedViewDefinitionSchema.parse({
      columns: [{ fieldId: "unknown" }],
      density: "compact",
      filter: "changed",
      pinnedColumns: [],
      sort: "updated_desc",
    })).toThrow();
  });
});

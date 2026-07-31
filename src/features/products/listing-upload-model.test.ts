import { describe, expect, it } from "vitest";
import {
  applyListingUploadCells,
  isListingUploadRowEmpty,
  listingUploadRowErrors,
  LISTING_UPLOAD_FIELDS,
} from "@/features/products/listing-upload-model";
import { blankListingValues } from "@/features/products/listing-workbench-model";

describe("listing upload row model", () => {
  it("keeps split pastes on the same partial row", () => {
    const first = applyListingUploadCells({
      cells: ["SKU-1", "First product"],
      fields: LISTING_UPLOAD_FIELDS,
      startFieldIndex: 0,
      values: {},
    });
    const priceIndex = LISTING_UPLOAD_FIELDS.indexOf("price");
    const second = applyListingUploadCells({
      cells: ["65.44", "6"],
      fields: LISTING_UPLOAD_FIELDS,
      startFieldIndex: priceIndex,
      values: first.values,
    });
    expect(second.values).toMatchObject({
      price: { amount: 65.44, currency: "USD" },
      quantity: 6,
      sku: "SKU-1",
      title: "First product",
    });
    expect(isListingUploadRowEmpty(second.values)).toBe(false);
  });

  it("records cell parsing errors without erasing previous valid values", () => {
    const result = applyListingUploadCells({
      cells: ["not-a-price"],
      fields: ["price"],
      startFieldIndex: 0,
      values: { price: { amount: 10, currency: "USD" } },
    });
    expect(result.values.price?.amount).toBe(10);
    expect(result.errors.price).toMatch(/valid number/i);
  });

  it("uses the current shop defaults instead of stale required-field errors", () => {
    const defaults = {
      ...blankListingValues(),
      description: "Default description",
      price: { amount: 25, currency: "USD" },
      taxonomyId: 6498,
    };
    const errors = listingUploadRowErrors(
      { sku: "SKU-1", title: "Uses defaults" },
      { price: "Price must be greater than 0." },
      defaults,
    );

    expect(errors).toEqual({});
  });

  it("keeps a parsing error when the row explicitly overrides that field", () => {
    const defaults = {
      ...blankListingValues(),
      description: "Default description",
      price: { amount: 25, currency: "USD" },
      taxonomyId: 6498,
    };
    const errors = listingUploadRowErrors(
      { price: { amount: 0, currency: "USD" }, sku: "SKU-2", title: "Invalid override" },
      { price: "Price must be greater than 0." },
      defaults,
    );

    expect(errors.price).toMatch(/greater than 0/i);
  });
});

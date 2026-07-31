import type {
  ListingDraftPatch,
  ListingDraftValues,
  ListingUploadField,
  ListingValidationErrors,
} from "@/shared/types/listing-workbench";
import { applyListingPatch, validateListingValues } from "@/features/products/listing-workbench-model";

export const LISTING_UPLOAD_MINIMUM_ROWS = 50;
export const LISTING_UPLOAD_MAX_NON_EMPTY_ROWS = 100;
export const LISTING_UPLOAD_FIELDS: readonly ListingUploadField[] = [
  "sku",
  "title",
  "price",
  "quantity",
  "state",
  "description",
  "tags",
  "materials",
  "taxonomyId",
  "shippingProfileId",
  "readinessStateId",
  "returnPolicyId",
  "shopSectionId",
  "whoMade",
  "whenMade",
  "type",
  "isSupply",
  "shouldAutoRenew",
];

const positiveIdFields = new Set<ListingUploadField>([
  "taxonomyId",
  "shippingProfileId",
  "readinessStateId",
  "returnPolicyId",
  "shopSectionId",
]);

function listValue(value: string) {
  return value.split(/[,\n]+/g).map((item) => item.trim()).filter(Boolean);
}

function booleanValue(value: string) {
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "y", "是", "启用"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "否", "停用"].includes(normalized)) return false;
  return null;
}

export function listingUploadValueAsText(values: ListingDraftPatch, field: ListingUploadField) {
  const value = values[field];
  if (field === "price") return values.price ? String(values.price.amount) : "";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return String(value);
  return value === null || value === undefined ? "" : String(value);
}

export function isListingUploadRowEmpty(values: ListingDraftPatch) {
  return LISTING_UPLOAD_FIELDS.every((field) => listingUploadValueAsText(values, field).trim() === "");
}

export function listingUploadRowErrors(
  values: ListingDraftPatch,
  storedErrors: ListingValidationErrors,
  defaults: ListingDraftValues,
) {
  if (isListingUploadRowEmpty(values)) return {};

  const cellErrors = Object.fromEntries(
    Object.entries(storedErrors).filter(([field]) => Object.prototype.hasOwnProperty.call(values, field)),
  );

  return {
    ...validateListingValues(applyListingPatch(defaults, values), "new"),
    ...cellErrors,
  };
}

export function setListingUploadCell(
  current: ListingDraftPatch,
  field: ListingUploadField,
  rawValue: string,
  currency = "USD",
): { error: string | null; values: ListingDraftPatch } {
  const value = rawValue.trim();
  const values = { ...current };
  if (!value) {
    delete values[field];
    return { error: null, values };
  }

  if (field === "price") {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return { error: "Price must be a valid number.", values };
    values.price = { amount, currency: current.price?.currency || currency };
    return { error: amount > 0 ? null : "Price must be greater than 0.", values };
  }
  if (field === "quantity") {
    const quantity = Number(value);
    if (!Number.isInteger(quantity) || quantity < 0) {
      return { error: "Quantity must be a non-negative integer.", values };
    }
    values.quantity = quantity;
    return { error: null, values };
  }
  if (positiveIdFields.has(field)) {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) return { error: "ID must be a positive integer.", values };
    Object.assign(values, { [field]: id });
    return { error: null, values };
  }
  if (field === "isSupply" || field === "shouldAutoRenew") {
    const parsed = booleanValue(value);
    if (parsed === null) return { error: "Use true/false, yes/no, or 1/0.", values };
    Object.assign(values, { [field]: parsed });
    return { error: null, values };
  }
  if (field === "tags" || field === "materials") {
    Object.assign(values, { [field]: listValue(value) });
    return { error: null, values };
  }
  if (field === "type") {
    const normalized = value.toLowerCase();
    if (!["physical", "download", "digital"].includes(normalized)) {
      return { error: "Type must be physical or download.", values };
    }
    values.type = normalized === "physical" ? "physical" : "download";
    return { error: null, values };
  }
  if (field === "state") {
    const normalized = value.toLowerCase();
    if (!["draft", "active", "inactive"].includes(normalized)) {
      return { error: "State must be draft, active, or inactive.", values };
    }
    values.state = normalized;
    return { error: null, values };
  }

  Object.assign(values, { [field]: rawValue });
  return { error: null, values };
}

export function applyListingUploadCells(input: {
  cells: string[];
  currency?: string;
  errors?: ListingValidationErrors;
  fields: readonly ListingUploadField[];
  startFieldIndex: number;
  values: ListingDraftPatch;
}) {
  let values = { ...input.values };
  const errors = { ...(input.errors ?? {}) };
  input.cells.forEach((cell, offset) => {
    const field = input.fields[input.startFieldIndex + offset];
    if (!field) return;
    const result = setListingUploadCell(values, field, cell, input.currency);
    values = result.values;
    if (result.error) errors[field] = result.error;
    else delete errors[field];
  });
  return { errors, values };
}

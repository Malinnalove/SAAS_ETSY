import { createHash } from "crypto";
import { z } from "zod";
import type { EtsyListingInventory, EtsyListingSummary } from "@/shared/types/etsy";
import type {
  ListingDraftPatch,
  ListingDraftValues,
  ListingFieldDefinition,
  ListingMoney,
  ListingValidationErrors,
} from "@/shared/types/listing-workbench";

const moneySchema = z.object({
  amount: z.number().finite(),
  currency: z.string().trim().min(3).max(3),
});

const inventorySchema = z.custom<EtsyListingInventory>((value) => {
  if (value === null) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Array.isArray((value as { products?: unknown }).products);
}, "Invalid inventory payload.");

export const listingDraftPatchSchema = z.object({
  description: z.string().max(50000).optional(),
  inventory: inventorySchema.nullable().optional(),
  isSupply: z.boolean().optional(),
  materials: z.array(z.string().trim().max(255)).max(50).optional(),
  price: moneySchema.nullable().optional(),
  quantity: z.number().int().min(0).max(999999).nullable().optional(),
  readinessStateId: z.number().int().positive().nullable().optional(),
  returnPolicyId: z.number().int().positive().nullable().optional(),
  shippingProfileId: z.number().int().positive().nullable().optional(),
  shopSectionId: z.number().int().positive().nullable().optional(),
  shouldAutoRenew: z.boolean().optional(),
  sku: z.string().max(64).optional(),
  state: z.string().max(32).optional(),
  tags: z.array(z.string().trim().max(50)).max(13).optional(),
  taxonomyId: z.number().int().positive().nullable().optional(),
  title: z.string().max(140).optional(),
  type: z.enum(["download", "physical"]).optional(),
  whenMade: z.string().max(64).optional(),
  whoMade: z.string().max(64).optional(),
});

const savedViewFieldSchema = z.enum([
  "description",
  "image",
  "inventory",
  "isSupply",
  "lifecycle",
  "materials",
  "price",
  "quantity",
  "readinessStateId",
  "returnPolicyId",
  "shippingProfileId",
  "shopSectionId",
  "shouldAutoRenew",
  "sku",
  "state",
  "tags",
  "taxonomyId",
  "title",
  "type",
  "updatedAt",
  "whenMade",
  "whoMade",
]);

export const listingSavedViewDefinitionSchema = z.object({
  columns: z.array(z.object({
    fieldId: savedViewFieldSchema,
    hidden: z.boolean().optional(),
    pinned: z.enum(["left", "right"]).optional(),
    width: z.number().int().min(72).max(1200).optional(),
  })).max(32),
  density: z.enum(["comfortable", "compact"]),
  filter: z.enum(["all", "changed", "attention", "failed", "inactive"]),
  pinnedColumns: z.array(z.string().max(64)).max(12),
  sort: z.enum(["updated_desc", "title_asc", "price_desc", "quantity_asc"]),
});

export const listingFieldDefinitions: ListingFieldDefinition[] = [
  { id: "sku", label: { zh: "SKU", en: "SKU" }, group: "inventory", type: "text", editable: true, bulkEditable: true, defaultVisible: true, defaultWidth: 170 },
  { id: "title", label: { zh: "标题", en: "Title" }, group: "basic", type: "text", editable: true, bulkEditable: true, defaultVisible: true, defaultWidth: 300 },
  { id: "price", label: { zh: "价格", en: "Price" }, group: "commerce", type: "money", editable: true, bulkEditable: true, defaultVisible: true, defaultWidth: 130 },
  { id: "quantity", label: { zh: "数量", en: "Quantity" }, group: "inventory", type: "number", editable: true, bulkEditable: true, defaultVisible: true, defaultWidth: 100 },
  { id: "state", label: { zh: "上架状态", en: "State" }, group: "commerce", type: "select", editable: true, bulkEditable: true, defaultVisible: true, defaultWidth: 130 },
  { id: "description", label: { zh: "描述", en: "Description" }, group: "basic", type: "longText", editable: true, bulkEditable: true, defaultVisible: false, defaultWidth: 360 },
  { id: "tags", label: { zh: "标签", en: "Tags" }, group: "basic", type: "tags", editable: true, bulkEditable: true, defaultVisible: false, defaultWidth: 240 },
  { id: "materials", label: { zh: "材料", en: "Materials" }, group: "basic", type: "tags", editable: true, bulkEditable: true, defaultVisible: false, defaultWidth: 220 },
  { id: "taxonomyId", label: { zh: "分类 ID", en: "Taxonomy ID" }, group: "basic", type: "number", editable: true, bulkEditable: true, defaultVisible: false, defaultWidth: 150 },
  { id: "shippingProfileId", label: { zh: "物流模板 ID", en: "Shipping profile ID" }, group: "fulfillment", type: "number", editable: true, bulkEditable: true, defaultVisible: false, defaultWidth: 170 },
  { id: "readinessStateId", label: { zh: "处理模板 ID", en: "Readiness state ID" }, group: "fulfillment", type: "number", editable: true, bulkEditable: true, defaultVisible: false, defaultWidth: 170 },
  { id: "returnPolicyId", label: { zh: "退货政策 ID", en: "Return policy ID" }, group: "fulfillment", type: "number", editable: true, bulkEditable: true, defaultVisible: false, defaultWidth: 160 },
  { id: "shopSectionId", label: { zh: "店铺分组 ID", en: "Shop section ID" }, group: "commerce", type: "number", editable: true, bulkEditable: true, defaultVisible: false, defaultWidth: 160 },
  { id: "whoMade", label: { zh: "制作者", en: "Who made it" }, group: "basic", type: "select", editable: true, bulkEditable: true, defaultVisible: false, defaultWidth: 150 },
  { id: "whenMade", label: { zh: "制作时间", en: "When made" }, group: "basic", type: "select", editable: true, bulkEditable: true, defaultVisible: false, defaultWidth: 150 },
  { id: "type", label: { zh: "商品类型", en: "Type" }, group: "basic", type: "select", editable: true, bulkEditable: true, defaultVisible: false, defaultWidth: 140 },
  { id: "isSupply", label: { zh: "供应品", en: "Supply" }, group: "basic", type: "boolean", editable: true, bulkEditable: true, defaultVisible: false, defaultWidth: 120 },
  { id: "shouldAutoRenew", label: { zh: "自动续期", en: "Auto renew" }, group: "commerce", type: "boolean", editable: true, bulkEditable: true, defaultVisible: false, defaultWidth: 130 },
  { id: "inventory", label: { zh: "变体", en: "Variants" }, group: "inventory", type: "longText", editable: true, bulkEditable: false, defaultVisible: false, defaultWidth: 220 },
];

function moneyFromListing(listing: EtsyListingSummary): ListingMoney | null {
  const price = listing.price;
  if (!price) return null;
  const divisor = Number(price.divisor || 100);
  const amount = Number(price.amount);
  if (!Number.isFinite(amount) || !Number.isFinite(divisor) || divisor <= 0) return null;
  return { amount: amount / divisor, currency: price.currency_code || "USD" };
}

function primarySku(listing: EtsyListingSummary) {
  const inventory = listing.inventory;
  if (inventory?.sku_on_property?.length) return "";

  const explicit = listing.sku?.trim();
  if (explicit) return explicit;
  const skus = Array.from(new Set(
    (inventory?.products ?? []).map((product) => product.sku?.trim() ?? "").filter(Boolean),
  ));
  return skus.length === 1 ? skus[0] : "";
}

export function listingValuesFromSource(listing: EtsyListingSummary): ListingDraftValues {
  return {
    description: listing.description ?? "",
    inventory: listing.inventory ?? null,
    isSupply: listing.is_supply ?? false,
    materials: listing.materials?.filter(Boolean) ?? [],
    price: moneyFromListing(listing),
    quantity: listing.quantity ?? null,
    readinessStateId: listing.readiness_state_id ?? null,
    returnPolicyId: listing.return_policy_id ?? null,
    shippingProfileId: listing.shipping_profile_id ?? null,
    shopSectionId: listing.shop_section_id ?? null,
    shouldAutoRenew: listing.should_auto_renew ?? false,
    sku: primarySku(listing),
    state: listing.state || "inactive",
    tags: listing.tags?.filter(Boolean) ?? [],
    taxonomyId: listing.taxonomy_id ?? null,
    title: listing.title ?? "",
    type: listing.type === "download" ? "download" : "physical",
    whenMade: listing.when_made ?? "made_to_order",
    whoMade: listing.who_made ?? "i_did",
  };
}

export function blankListingValues(currency = "USD"): ListingDraftValues {
  return {
    description: "",
    inventory: null,
    isSupply: false,
    materials: [],
    price: { amount: 0, currency },
    quantity: 1,
    readinessStateId: null,
    returnPolicyId: null,
    shippingProfileId: null,
    shopSectionId: null,
    shouldAutoRenew: true,
    sku: "",
    state: "draft",
    tags: [],
    taxonomyId: null,
    title: "",
    type: "physical",
    whenMade: "made_to_order",
    whoMade: "i_did",
  };
}

export function applyListingPatch(values: ListingDraftValues, patch: ListingDraftPatch): ListingDraftValues {
  return { ...values, ...patch };
}

export function validateListingValues(values: ListingDraftValues, kind: "existing" | "new") {
  const errors: ListingValidationErrors = {};
  if (!values.title.trim()) errors.title = "标题不能为空。";
  if (values.title.trim().length > 140) errors.title = "标题不能超过 140 个字符。";
  if (!values.price || !Number.isFinite(values.price.amount) || values.price.amount <= 0) errors.price = "价格必须大于 0。";
  if (values.quantity === null || !Number.isInteger(values.quantity) || values.quantity < 0) errors.quantity = "数量必须是非负整数。";
  if (values.tags.length > 13) errors.tags = "标签不能超过 13 个。";
  if (kind === "new") {
    if (!values.description.trim()) errors.description = "新 Listing 需要描述。";
    if (!values.taxonomyId) errors.taxonomyId = "新 Listing 需要分类 ID。";
  }
  const products = values.inventory?.products ?? [];
  if (Boolean(values.inventory?.sku_on_property?.length) && products.length > 1 && values.sku.trim()) {
    const distinctSkus = new Set(products.map((product) => product.sku?.trim()).filter(Boolean));
    if (distinctSkus.size > 1) errors.sku = "变体 Listing 请在详情面板中维护各变体 SKU。";
  }
  return errors;
}

function canonicalWritableSource(listing: EtsyListingSummary) {
  return listingValuesFromSource(listing);
}

export function sourceVersionForListing(listing: EtsyListingSummary) {
  return createHash("sha256").update(JSON.stringify(canonicalWritableSource(listing))).digest("hex");
}

export function parseListingPatch(value: unknown) {
  return listingDraftPatchSchema.parse(value) as ListingDraftPatch;
}

export function listingImageUrlFromSource(listing: EtsyListingSummary) {
  return (
    listing.main_image?.url_170x135 ||
    listing.MainImage?.url_170x135 ||
    listing.image?.url_170x135 ||
    listing.images?.[0]?.url_170x135 ||
    listing.main_image?.url_570xN ||
    listing.images?.[0]?.url_570xN ||
    ""
  );
}

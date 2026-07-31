"use server";

import { redirect } from "next/navigation";
import { assertServerActionCsrf } from "@/features/auth/server-action-security";
import { authorizeShop, requirePermission } from "@/features/auth/session";
import {
  EtsyClient,
  type CreateDraftListingInput,
  type EtsyExtraParams,
  type EtsyExtraParamValue,
  type EtsyInventoryUpdateInput,
  type EtsyListingProperty,
  type EtsyTaxonomyProperty,
  type EtsyTaxonomyPropertyValue,
} from "@/features/etsy/client";
import { ensureFreshConnection } from "@/features/etsy/oauth";
import { getDictionary, getLocaleFromParams, type Locale } from "@/shared/i18n";
import { readOrganizationStore, selectShop } from "@/lib/store";
import {
  getShopConnection,
  updateConnection,
  updateListingInventoryData,
  upsertListings,
} from "@/features/sync/db";
import type { EtsyListingInventory, EtsyListingSummary } from "@/shared/types/etsy";

type ListingState = "active" | "inactive";
type BulkVariationValue = {
  id: string;
  value: string;
};
type BulkVariationGroup = {
  id: string;
  name: string;
  propertyId?: number;
  scaleId?: number | null;
  values: BulkVariationValue[];
};
type BulkVariationOverride = {
  enabled?: string;
  price?: string;
  readinessStateId?: string;
  quantity?: string;
  sku?: string;
};
type BulkVariationDetailField = "price" | "quantity" | "readinessStateId" | "sku";
type BulkVariationConfig = {
  detailFields: BulkVariationDetailField[];
  enabled: boolean;
  groups: BulkVariationGroup[];
  overrides: Record<string, BulkVariationOverride>;
};
type BulkVariationCombo = {
  key: string;
  labels: string[];
};

const CUSTOM_VARIATION_PROPERTY_IDS = [513, 514] as const;
const MAX_VARIATION_GROUPS = 2;
const BULK_VARIATION_DETAIL_FIELDS: BulkVariationDetailField[] = ["sku", "price", "quantity", "readinessStateId"];

function listingRedirect(
  shopId: number | null,
  status: "created" | "failed" | "updated",
  detail: string,
  locale: Locale,
  extra: Record<string, string | number | null | undefined> = {},
  pathname = "/products",
): never {
  const params = new URLSearchParams({
    lang: locale,
    listingDetail: detail.slice(0, 320),
    listingStatus: status,
  });

  if (shopId) {
    params.set("shopId", String(shopId));
  }

  for (const [key, value] of Object.entries(extra)) {
    if (value !== null && value !== undefined && value !== "") {
      params.set(key, String(value));
    }
  }

  redirect(`${pathname}?${params.toString()}`);
}

function stringField(formData: FormData, name: string) {
  return String(formData.get(name) ?? "").trim();
}
function numberField(formData: FormData, name: string) {
  const value = Number(stringField(formData, name));
  return Number.isFinite(value) && value > 0 ? value : null;
}

function integerField(formData: FormData, name: string) {
  const value = numberField(formData, name);
  return value ? Math.round(value) : null;
}

function nonNegativeIntegerField(formData: FormData, name: string) {
  const value = Number(stringField(formData, name));
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

function optionalBooleanField(formData: FormData, name: string) {
  const value = stringField(formData, name).toLowerCase();
  if (!value) return null;
  if (["1", "true", "yes", "y", "是", "对"].includes(value)) return true;
  if (["0", "false", "no", "n", "否", "不"].includes(value)) return false;
  return null;
}

function splitList(value: string) {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitNumberList(value: string) {
  return splitList(value)
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item > 0)
    .map((item) => Math.round(item));
}

function positiveNumberTextField(formData: FormData, name: string) {
  const value = stringField(formData, name);
  if (!value) return "";
  return Number.isFinite(Number(value)) && Number(value) > 0 ? value : "";
}

function duplicateListItems(values: string[]) {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const value of values) {
    const key = value.replace(/\s+/g, " ").toLowerCase();

    if (seen.has(key)) {
      duplicates.add(value);
    } else {
      seen.add(key);
    }
  }

  return Array.from(duplicates);
}

function isValidExtraParamValue(value: unknown): value is EtsyExtraParamValue {
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return true;
  }

  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "boolean" || typeof item === "number" || typeof item === "string")
  );
}

function parseAdvancedParams(value: string) {
  if (!value) return null;

  const parsed = JSON.parse(value) as unknown;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Etsy extra params JSON must be an object.");
  }

  const params: EtsyExtraParams = {};

  for (const [key, rawValue] of Object.entries(parsed)) {
    if (!/^[a-z][a-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid Etsy extra param key: ${key}`);
    }

    if (rawValue === null || rawValue === undefined) continue;

    if (!isValidExtraParamValue(rawValue)) {
      throw new Error(`Invalid Etsy extra param value for ${key}.`);
    }

    params[key] = rawValue;
  }

  return Object.keys(params).length ? params : null;
}

function uploadedImages(formData: FormData) {
  return formData
    .getAll("images")
    .filter((value): value is File => value instanceof File && value.size > 0);
}
function parseInventoryJson(value: string): EtsyInventoryUpdateInput | null {
  if (!value) return null;

  const parsed = JSON.parse(value) as EtsyInventoryUpdateInput;
  if (!Array.isArray(parsed.products) || parsed.products.length === 0) {
    throw new Error("Inventory JSON must include at least one product.");
  }

  return {
    ...parsed,
    price_on_property: parsed.price_on_property ?? [],
    quantity_on_property: parsed.quantity_on_property ?? [],
    readiness_state_on_property: parsed.readiness_state_on_property ?? [],
    sku_on_property: parsed.sku_on_property ?? [],
  };
}

function singleSkuInventory(fields: ReturnType<typeof validateCommonListingFields>, sku: string): EtsyInventoryUpdateInput {
  return {
    products: [
      {
        offerings: [
          {
            is_enabled: true,
            price: fields.price,
            quantity: fields.quantity,
            readiness_state_id: fields.readinessStateId,
          },
        ],
        property_values: [],
        sku,
      },
    ],
    price_on_property: [],
    quantity_on_property: [],
    readiness_state_on_property: [],
    sku_on_property: [],
  };
}

function inventorySkusForListing(inventory: EtsyInventoryUpdateInput | EtsyListingInventory | null) {
  return inventory?.products
    .map((product) => (typeof product.sku === "string" ? product.sku.trim() : ""))
    .filter(Boolean) ?? [];
}

function uniqueStringValues(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function enrichCreatedListing(
  listing: EtsyListingSummary,
  fields: ReturnType<typeof validateCommonListingFields>,
  inventory: EtsyListingInventory | EtsyInventoryUpdateInput | null,
  listingProperties: EtsyListingProperty[] | null = null,
  mainSku = "",
) {
  const skus = inventorySkusForListing(inventory);
  const uniqueSkus = uniqueStringValues(skus);
  const inventoryProductCount = inventory?.products.length ?? 0;
  const hasVariations = Boolean(inventory?.products.some((product) => product.property_values.length > 0));
  const hasSkuVariation = Array.isArray(inventory?.sku_on_property) && inventory.sku_on_property.length > 0;
  const materials = materialValuesFromListingProperties(listingProperties ?? listing.listing_properties ?? []);
  const singleProductSku = uniqueSkus[0] ?? mainSku;
  const uniformProductSku = inventoryProductCount > 1 && !hasSkuVariation && uniqueSkus.length === 1 ? uniqueSkus[0] : "";

  return {
    ...listing,
    has_variations: hasVariations || listing.has_variations,
    inventory: inventory ?? listing.inventory,
    listing_properties: listingProperties ?? listing.listing_properties,
    materials: materials.length ? materials : fields.materials,
    sku: inventoryProductCount === 1
      ? singleProductSku || null
      : hasSkuVariation
        ? null
        : mainSku || uniformProductSku || listing.sku || null,
    skus: inventoryProductCount > 1 ? uniqueSkus : listing.skus,
    tags: fields.tags,
  } satisfies EtsyListingSummary;
}

function normalizedListingPropertyText(value: string) {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function listingPropertyName(property: Pick<EtsyListingProperty, "property_name">) {
  return normalizedListingPropertyText(property.property_name ?? "");
}

function materialValuesFromListingProperties(properties: readonly Pick<EtsyListingProperty, "property_name" | "values">[]) {
  return Array.from(
    new Set(
      properties
        .filter((property) => listingPropertyName(property).includes("material"))
        .flatMap((property) => property.values ?? [])
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
}

function taxonomyPropertyName(property: EtsyTaxonomyProperty) {
  return normalizedListingPropertyText(
    property.property_name ?? property.display_name ?? property.name ?? "",
  );
}

function taxonomyValueName(value: EtsyTaxonomyPropertyValue) {
  return (value.name ?? value.value ?? "").trim();
}

function taxonomyPropertyValues(property: EtsyTaxonomyProperty) {
  const values = [
    ...(property.possible_values ?? []),
    ...(property.values ?? []),
    ...(property.scales ?? []).flatMap((scale) =>
      [...(scale.possible_values ?? []), ...(scale.values ?? [])].map((value) => ({
        ...value,
        scale_id: value.scale_id ?? scale.scale_id ?? null,
      })),
    ),
  ];
  const seen = new Set<string>();

  return values.filter((value) => {
    const key = [value.value_id ?? "", value.scale_id ?? "", taxonomyValueName(value).toLowerCase()].join(":");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findMaterialTaxonomyProperty(properties: EtsyTaxonomyProperty[]) {
  const materialProperties = properties.filter((property) => taxonomyPropertyName(property).includes("material"));

  return (
    materialProperties.find((property) => taxonomyPropertyName(property) === "materials") ??
    materialProperties.find((property) => taxonomyPropertyName(property) === "material") ??
    materialProperties[0] ??
    null
  );
}

function findTaxonomyValue(propertyValues: EtsyTaxonomyPropertyValue[], material: string) {
  const materialKey = normalizedListingPropertyText(material);

  return propertyValues.find((value) => normalizedListingPropertyText(taxonomyValueName(value)) === materialKey);
}

async function updateListingMaterialsProperty({
  client,
  materials,
  listingId,
  shopId,
  taxonomyId,
}: {
  client: EtsyClient;
  listingId: number;
  materials: string[];
  shopId: number;
  taxonomyId: number;
}) {
  if (materials.length === 0) return null;

  const taxonomyProperties = await client.getPropertiesByTaxonomyId(taxonomyId);
  const materialProperty = findMaterialTaxonomyProperty(taxonomyProperties.results ?? []);

  if (!materialProperty) {
    throw new Error(`Etsy taxonomy ${taxonomyId} does not expose a Materials property.`);
  }

  const possibleValues = taxonomyPropertyValues(materialProperty);
  const matchedValues = materials.map((material) => findTaxonomyValue(possibleValues, material));

  if (possibleValues.length > 0 && matchedValues.some((value) => !value?.value_id)) {
    const available = possibleValues
      .map(taxonomyValueName)
      .filter(Boolean)
      .slice(0, 10)
      .join(", ");
    const missing = materials.filter((material, index) => !matchedValues[index]?.value_id).join(", ");

    throw new Error(
      `材料不是该 Taxonomy 的 Etsy Materials 可选值：${missing}${available ? `。可用示例：${available}` : ""}`,
    );
  }

  const valueIds = matchedValues
    .map((value) => value?.value_id ?? null)
    .filter((value): value is number => value !== null);
  const scaleIds = new Set(
    matchedValues
      .map((value) => value?.scale_id ?? null)
      .filter((value): value is number => value !== null),
  );
  const scaleId = materialProperty.scale_id ?? (scaleIds.size === 1 ? Array.from(scaleIds)[0] : null);
  const updatedProperty = await client.updateListingProperty(shopId, listingId, materialProperty.property_id, {
    scaleId,
    valueIds,
    values: materials,
  });

  try {
    const listingProperties = await client.getListingProperties(shopId, listingId);
    return listingProperties.results ?? [updatedProperty];
  } catch {
    return [updatedProperty];
  }
}

function listingWithMaterialProperties(
  listing: EtsyListingSummary,
  fields: ReturnType<typeof validateCommonListingFields>,
  listingProperties: EtsyListingProperty[] | null,
) {
  if (!listingProperties) {
    return {
      ...listing,
      materials: fields.materials,
    } satisfies EtsyListingSummary;
  }

  const materials = materialValuesFromListingProperties(listingProperties);

  return {
    ...listing,
    listing_properties: listingProperties,
    materials: materials.length ? materials : fields.materials,
  } satisfies EtsyListingSummary;
}

function sanitizeVariationConfig(value: unknown): BulkVariationConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  const detailFields = Array.isArray(record.detailFields)
    ? record.detailFields.filter((field): field is BulkVariationDetailField =>
        typeof field === "string" && BULK_VARIATION_DETAIL_FIELDS.includes(field as BulkVariationDetailField),
      )
    : [];
  const groups = Array.isArray(record.groups)
    ? record.groups
        .slice(0, MAX_VARIATION_GROUPS)
        .map((rawGroup, groupIndex): BulkVariationGroup => {
          const group = rawGroup && typeof rawGroup === "object" && !Array.isArray(rawGroup)
            ? (rawGroup as Record<string, unknown>)
            : {};
          const values = Array.isArray(group.values)
            ? group.values
                .map((rawValue, valueIndex): BulkVariationValue => {
                  const valueRecord = rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)
                    ? (rawValue as Record<string, unknown>)
                    : {};
                  const valueText = typeof valueRecord.value === "string" ? valueRecord.value.trim() : "";

                  return {
                    id:
                      typeof valueRecord.id === "string" && valueRecord.id.trim()
                        ? valueRecord.id.trim()
                        : `g${groupIndex + 1}v${valueIndex + 1}`,
                    value: valueText,
                  };
                })
                .filter((item) => item.value)
            : [];

          return {
            id: typeof group.id === "string" && group.id.trim() ? group.id.trim() : `g${groupIndex + 1}`,
            name:
              typeof group.name === "string" && group.name.trim()
                ? group.name.trim()
                : groupIndex === 0
                  ? "Model"
                  : "Color",
            propertyId: numberFrom(group.propertyId) ?? undefined,
            scaleId: group.scaleId === null ? null : numberFrom(group.scaleId),
            values,
          };
        })
        .filter((group) => group.values.length > 0)
    : [];
  const rawOverrides = record.overrides && typeof record.overrides === "object" && !Array.isArray(record.overrides)
    ? (record.overrides as Record<string, unknown>)
    : {};
  const overrides: BulkVariationConfig["overrides"] = {};

  for (const [key, rawOverride] of Object.entries(rawOverrides)) {
    const override = rawOverride && typeof rawOverride === "object" && !Array.isArray(rawOverride)
      ? (rawOverride as Record<string, unknown>)
      : {};

    overrides[key] = {
      enabled: typeof override.enabled === "string" ? override.enabled.trim() : "",
      price: typeof override.price === "string" ? override.price.trim() : "",
      readinessStateId: typeof override.readinessStateId === "string" ? override.readinessStateId.trim() : "",
      quantity: typeof override.quantity === "string" ? override.quantity.trim() : "",
      sku: typeof override.sku === "string" ? override.sku.trim() : "",
    };
  }
  const inferredDetailFields = new Set(detailFields);

  for (const override of Object.values(overrides)) {
    if (override.sku) inferredDetailFields.add("sku");
    if (override.price) inferredDetailFields.add("price");
    if (override.quantity) inferredDetailFields.add("quantity");
    if (override.readinessStateId) inferredDetailFields.add("readinessStateId");
  }

  return {
    detailFields: BULK_VARIATION_DETAIL_FIELDS.filter((field) => inferredDetailFields.has(field)),
    enabled: Boolean(record.enabled),
    groups,
    overrides,
  };
}

function parseVariationConfigJson(value: string) {
  if (!value) return null;

  const parsed = JSON.parse(value) as unknown;
  return sanitizeVariationConfig(parsed);
}

function variationCombos(config: BulkVariationConfig): BulkVariationCombo[] {
  if (!config.enabled || config.groups.length === 0) return [];

  return config.groups.reduce<BulkVariationCombo[]>(
    (combos, group) =>
      combos.flatMap((combo) =>
        group.values.map((value) => {
          const valueIds = [...combo.key.split("|").filter(Boolean), value.id];

          return {
            key: valueIds.join("|"),
            labels: [...combo.labels, value.value],
          };
        }),
      ),
    [{ key: "", labels: [] }],
  );
}

function decimalPriceText(value: string, fallback: string) {
  const price = value || fallback;

  if (!/^\d+(\.\d{1,2})?$/.test(price) || Number(price) <= 0) {
    throw new Error("Variation price must be greater than 0 with at most 2 decimals.");
  }

  return price;
}

function variationQuantity(value: string, fallback: number) {
  if (!value) return fallback;

  const quantity = Number(value);

  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new Error("Variation quantity must be 0 or greater.");
  }

  return Math.round(quantity);
}

function variationReadinessStateId(value: string, fallback: number) {
  if (!value) return fallback;

  const readinessStateId = Number(value);

  if (!Number.isInteger(readinessStateId) || readinessStateId <= 0) {
    throw new Error("Variation processing profile must be a valid readiness state ID.");
  }

  return readinessStateId;
}

function variationPropertyIdForGroup(group: BulkVariationGroup, groupIndex: number) {
  return group.propertyId ?? CUSTOM_VARIATION_PROPERTY_IDS[groupIndex];
}

function variationInventoryFromConfig(
  fields: ReturnType<typeof validateCommonListingFields>,
  config: BulkVariationConfig | null,
  mainSku = "",
) {
  if (!config?.enabled) return null;

  if (config.groups.length === 0) {
    throw new Error("Please add at least one variation group and value.");
  }

  const combos = variationCombos(config);

  if (combos.length === 0) {
    throw new Error("Please add at least one variation value.");
  }

  const propertyIds = config.groups.map((group, index) => variationPropertyIdForGroup(group, index)).filter(Boolean);
  const anyPriceOverride = combos.some((combo) => Boolean(config.overrides[combo.key]?.price));
  const anyQuantityOverride = combos.some((combo) => Boolean(config.overrides[combo.key]?.quantity));
  const anyReadinessOverride = combos.some((combo) => Boolean(config.overrides[combo.key]?.readinessStateId));
  const skuVariesByProperty = config.detailFields.includes("sku");
  const products = combos.map((combo) => {
    const override = config.overrides[combo.key] ?? {};
    const isEnabled = override.enabled === "false" ? false : true;
    const sku = skuVariesByProperty ? override.sku?.trim() ?? "" : mainSku.trim();

    return {
      offerings: [
        {
          is_enabled: isEnabled,
          price: decimalPriceText(override.price ?? "", fields.price),
          quantity: variationQuantity(override.quantity ?? "", fields.quantity),
          readiness_state_id: variationReadinessStateId(override.readinessStateId ?? "", fields.readinessStateId),
        },
      ],
      property_values: config.groups.map((group, groupIndex) => ({
        property_id: variationPropertyIdForGroup(group, groupIndex),
        property_name: group.name,
        scale_id: null,
        value_ids: [],
        values: [combo.labels[groupIndex] ?? ""],
      })),
      ...(sku ? { sku } : {}),
    };
  });

  return {
    products,
    price_on_property: anyPriceOverride ? propertyIds : [],
    quantity_on_property: anyQuantityOverride ? propertyIds : [],
    readiness_state_on_property: anyReadinessOverride ? propertyIds : [],
    sku_on_property: skuVariesByProperty ? propertyIds : [],
  } satisfies EtsyInventoryUpdateInput;
}

function validateCommonListingFields(
  formData: FormData,
  locale: Locale,
  options: { allowZeroQuantity?: boolean } = {},
) {
  const t = getDictionary(locale);
  const title = stringField(formData, "title");
  const description = stringField(formData, "description");
  const price = stringField(formData, "price");
  const quantity = options.allowZeroQuantity
    ? nonNegativeIntegerField(formData, "quantity")
    : integerField(formData, "quantity");
  const taxonomyId = integerField(formData, "taxonomyId");
  const shippingProfileId = integerField(formData, "shippingProfileId");
  const readinessStateId = integerField(formData, "readinessStateId");
  const shopSectionId = integerField(formData, "shopSectionId");
  const whoMade = stringField(formData, "whoMade");
  const whenMade = stringField(formData, "whenMade");
  const listingType = stringField(formData, "whatIsIt");
  const tags = splitList(stringField(formData, "tags")).slice(0, 13);
  const duplicateTags = duplicateListItems(tags);

  if (!title || title.length > 140) {
    throw new Error(t.products.notice.invalidTitle);
  }

  if (!description) {
    throw new Error(t.products.notice.invalidDescription);
  }

  if (!price || !/^\d+(\.\d{1,2})?$/.test(price) || Number(price) <= 0) {
    throw new Error(t.products.notice.invalidPrice);
  }

  if (quantity === null || (!options.allowZeroQuantity && quantity < 1)) {
    throw new Error(t.products.notice.invalidQuantity);
  }

  if (!taxonomyId) {
    throw new Error(t.products.notice.invalidTaxonomy);
  }

  if (!shippingProfileId) {
    throw new Error(t.products.notice.invalidShippingProfile);
  }

  if (!readinessStateId) {
    throw new Error(t.products.notice.invalidReadinessState);
  }

  if (!whoMade || !whenMade) {
    throw new Error(t.products.notice.invalidMaker);
  }

  if (duplicateTags.length > 0) {
    throw new Error(`请修改重复标签：${duplicateTags.slice(0, 3).join(", ")}`);
  }

  return {
    advancedParams: parseAdvancedParams(stringField(formData, "advancedParamsJson")),
    description,
    imageIds: splitNumberList(stringField(formData, "imageIds")),
    isCustomizable: optionalBooleanField(formData, "isCustomizable"),
    isPersonalizable: optionalBooleanField(formData, "isPersonalizable"),
    isSupply: stringField(formData, "isSupply") === "true",
    isTaxable: optionalBooleanField(formData, "isTaxable"),
    itemDimensionsUnit: stringField(formData, "itemDimensionsUnit"),
    itemHeight: positiveNumberTextField(formData, "itemHeight"),
    itemLength: positiveNumberTextField(formData, "itemLength"),
    itemWeight: positiveNumberTextField(formData, "itemWeight"),
    itemWeightUnit: stringField(formData, "itemWeightUnit"),
    itemWidth: positiveNumberTextField(formData, "itemWidth"),
    materials: splitList(stringField(formData, "materials")),
    personalizationCharCountMax: integerField(formData, "personalizationCharCountMax"),
    personalizationInstructions: stringField(formData, "personalizationInstructions"),
    personalizationIsRequired: optionalBooleanField(formData, "personalizationIsRequired"),
    price,
    processingMax: integerField(formData, "processingMax"),
    processingMin: integerField(formData, "processingMin"),
    productionPartnerIds: splitNumberList(stringField(formData, "productionPartnerIds")),
    quantity,
    readinessStateId,
    returnPolicyId: integerField(formData, "returnPolicyId"),
    shippingProfileId,
    shopSectionId,
    shouldAutoRenew: stringField(formData, "shouldAutoRenew") === "true",
    styles: splitList(stringField(formData, "styles")),
    tags,
    taxonomyId,
    title,
    type: listingType === "download" ? "download" as const : "physical" as const,
    whenMade,
    whoMade,
  };
}

function numberFrom(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

async function requireWritableShop(shopId: number, locale: Locale) {
  const user = await requirePermission("listings.write", "/listing-sheet");

  const t = getDictionary(locale);
  if (!(await authorizeShop(user, shopId, "listings.write"))) {
    throw new Error(t.products.notice.failedMissingShop);
  }
  const store = await readOrganizationStore(user.organizationId);
  const selectedShop = selectShop(store, shopId);

  if (!selectedShop) {
    throw new Error(t.products.notice.failedMissingShop);
  }

  const currentConnection = await getShopConnection(shopId);
  if (!currentConnection) {
    throw new Error(t.products.notice.missingConnection);
  }

  if (!currentConnection.scopes.includes("listings_w")) {
    throw new Error(t.products.notice.missingScope);
  }

  const connection = await ensureFreshConnection(currentConnection);

  if (connection.accessToken !== currentConnection.accessToken) {
    await updateConnection(connection);
  }

  return {
    client: new EtsyClient(connection),
    selectedShop,
  };
}

async function createEtsyListingFromFormData({
  client,
  formData,
  locale,
  shopId,
}: {
  client: EtsyClient;
  formData: FormData;
  locale: Locale;
  shopId: number;
}): Promise<EtsyListingSummary> {
  const t = getDictionary(locale);
  const fields = validateCommonListingFields(formData, locale);
  const images = uploadedImages(formData);
  const publishNow = stringField(formData, "publishState") === "active";
  const variationConfig = parseVariationConfigJson(stringField(formData, "variationConfigJson"));
  const inventoryFromJson = parseInventoryJson(stringField(formData, "inventoryJson"));
  const sku = stringField(formData, "sku");

  const inventory =
    inventoryFromJson ??
    variationInventoryFromConfig(fields, variationConfig, sku) ??
    (sku ? singleSkuInventory(fields, sku) : null);

  if (publishNow && images.length === 0 && fields.imageIds.length === 0) {
    throw new Error(t.products.notice.imageRequiredForPublish);
  }

  const draftInput: CreateDraftListingInput = {
    ...fields,
    inventory,
    type: fields.type,
  };
  const draftListing = await client.createDraftListing(shopId, draftInput);
  const listingId = draftListing.listing_id;
  let syncedInventory: EtsyListingInventory | null = null;

  for (const image of images.slice(0, 10)) {
    await client.uploadListingImage(shopId, listingId, image);
  }

  const listFieldsPatch = {
    styles: fields.styles,
    tags: fields.tags,
  };
  const shouldConfirmListFields = fields.styles.length > 0 || fields.tags.length > 0;
  const resolvedListing =
    publishNow || shouldConfirmListFields
      ? await client.updateListing(shopId, listingId, {
          ...listFieldsPatch,
          state: publishNow ? "active" : undefined,
        })
      : draftListing;
  const listingProperties = await updateListingMaterialsProperty({
    client,
    listingId,
    materials: fields.materials,
    shopId,
    taxonomyId: fields.taxonomyId,
  });

  if (inventory) {
    await client.updateListingInventory(listingId, inventory);
    syncedInventory = await client.getListingInventory(listingId).catch(() => inventory as EtsyListingInventory);
  }

  return enrichCreatedListing(resolvedListing, fields, syncedInventory, listingProperties, sku);
}
export async function createEtsyListingAction(formData: FormData) {
  const user = await requirePermission("listings.write", "/products");
  await assertServerActionCsrf(user, formData);

  const locale = getLocaleFromParams({ lang: stringField(formData, "lang") });
  const t = getDictionary(locale);
  const shopId = Number(formData.get("shopId"));
  const returnExtra = { listingPanel: "add" };
  const returnPath = "/products";
  let createdListingId: number | null = null;

  if (!Number.isFinite(shopId) || shopId <= 0) {
    listingRedirect(null, "failed", t.products.notice.failedMissingShop, locale, {}, returnPath);
  }

  try {
    const { client } = await requireWritableShop(shopId, locale);
    const finalListing = await createEtsyListingFromFormData({ client, formData, locale, shopId });

    await upsertListings(shopId, [finalListing]);
    createdListingId = finalListing.listing_id;
  } catch (error) {
    listingRedirect(
      shopId,
      "failed",
      error instanceof Error ? error.message : t.products.notice.unknownWrite,
      locale,
      returnExtra,
      returnPath,
    );
  }

  if (!createdListingId) {
    listingRedirect(shopId, "failed", t.products.notice.unknownWrite, locale, returnExtra, returnPath);
  }

  listingRedirect(
    shopId,
    "created",
    t.products.notice.created(createdListingId),
    locale,
    {},
    returnPath,
  );
}

export async function updateEtsyListingAction(formData: FormData) {
  const user = await requirePermission("listings.write", "/products");
  await assertServerActionCsrf(user, formData);

  const locale = getLocaleFromParams({ lang: stringField(formData, "lang") });
  const t = getDictionary(locale);
  const shopId = Number(formData.get("shopId"));
  const listingId = Number(formData.get("listingId"));

  if (!Number.isFinite(shopId) || shopId <= 0) {
    listingRedirect(null, "failed", t.products.notice.failedMissingShop, locale);
  }

  if (!Number.isFinite(listingId) || listingId <= 0) {
    listingRedirect(shopId, "failed", t.products.notice.invalidListing, locale);
  }

  try {
    const fields = validateCommonListingFields(formData, locale);
    const state = stringField(formData, "state");
    const nextState = state === "active" || state === "inactive" ? (state as ListingState) : undefined;
    const images = uploadedImages(formData);
    const inventory = parseInventoryJson(stringField(formData, "inventoryJson"));
    const { client, selectedShop } = await requireWritableShop(shopId, locale);
    const listing = selectedShop.listings.find((row) => row.listing_id === listingId);

    if (!listing) {
      throw new Error(t.products.notice.notOwned);
    }

    const updatedListing = await client.updateListing(shopId, listingId, {
      description: fields.description,
      advancedParams: fields.advancedParams,
      imageIds: fields.imageIds,
      isSupply: fields.isSupply,
      isTaxable: fields.isTaxable,
      itemDimensionsUnit: fields.itemDimensionsUnit,
      itemHeight: fields.itemHeight,
      itemLength: fields.itemLength,
      itemWeight: fields.itemWeight,
      itemWeightUnit: fields.itemWeightUnit,
      itemWidth: fields.itemWidth,
      price: fields.price,
      productionPartnerIds: fields.productionPartnerIds,
      quantity: fields.quantity,
      readinessStateId: fields.readinessStateId,
      returnPolicyId: fields.returnPolicyId,
      state: nextState,
      shippingProfileId: fields.shippingProfileId,
      shopSectionId: fields.shopSectionId,
      shouldAutoRenew: fields.shouldAutoRenew,
      tags: fields.tags,
      taxonomyId: fields.taxonomyId,
      title: fields.title,
      type: fields.type,
      whenMade: fields.whenMade,
      whoMade: fields.whoMade,
    });
    const listingProperties = await updateListingMaterialsProperty({
      client,
      listingId,
      materials: fields.materials,
      shopId,
      taxonomyId: fields.taxonomyId,
    });

    for (const image of images.slice(0, 10)) {
      await client.uploadListingImage(shopId, listingId, image);
    }

    if (inventory) {
      await client.updateListingInventory(listingId, inventory);
      await updateListingInventoryData(shopId, listingId, await client.getListingInventory(listingId));
    }

    await upsertListings(shopId, [listingWithMaterialProperties(updatedListing, fields, listingProperties)]);
  } catch (error) {
    listingRedirect(
      shopId,
      "failed",
      error instanceof Error ? error.message : t.products.notice.unknownWrite,
      locale,
      { listingId, listingPanel: "edit" },
    );
  }

  listingRedirect(shopId, "updated", t.products.notice.updated(listingId), locale, {
    listingId,
    listingPanel: "edit",
  });
}

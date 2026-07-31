import type { EtsyInventoryProduct, EtsyListingInventory } from "@/shared/types/etsy";
import type { ListingDraftValues } from "@/shared/types/listing-workbench";

export const MAX_LISTING_VARIATION_GROUPS = 2;

export type ListingVariationValueDraft = {
  id: string;
  value: string;
};

export type ListingVariationGroupDraft = {
  id: string;
  name: string;
  propertyId: number;
  scaleId: number | null;
  values: ListingVariationValueDraft[];
};

type VariationCombination = {
  labels: string[];
  signature: string;
};

function propertySignature(propertyId: number, values: string[]) {
  return `${propertyId}:${values.map((value) => value.trim()).filter(Boolean).join("\u0001")}`;
}

function productSignature(product: EtsyInventoryProduct) {
  return product.property_values
    .map((property) => propertySignature(property.property_id, property.values))
    .sort()
    .join("|");
}

function nextCustomPropertyId(usedPropertyIds: Set<number>) {
  return [513, 514].find((propertyId) => !usedPropertyIds.has(propertyId)) ?? 514;
}

function withResolvedPropertyIds(groups: ListingVariationGroupDraft[]) {
  const usedPropertyIds = new Set<number>();

  return groups.map((group) => {
    const requestedPropertyId = Number(group.propertyId);
    const propertyId = Number.isInteger(requestedPropertyId) && requestedPropertyId > 0 && !usedPropertyIds.has(requestedPropertyId)
      ? requestedPropertyId
      : nextCustomPropertyId(usedPropertyIds);
    usedPropertyIds.add(propertyId);
    return { ...group, propertyId };
  });
}

function combinations(groups: ListingVariationGroupDraft[]): VariationCombination[] {
  return groups.reduce<VariationCombination[]>(
    (current, group) => current.flatMap((combination) => group.values.map((value) => {
      const labels = [...combination.labels, value.value];
      return {
        labels,
        signature: [...combination.signature.split("|").filter(Boolean), propertySignature(group.propertyId, [value.value])]
          .sort()
          .join("|"),
      };
    })),
    [{ labels: [], signature: "" }],
  );
}

export function variationGroupsFromInventory(inventory: EtsyListingInventory | null | undefined): ListingVariationGroupDraft[] {
  if (!inventory) return [];
  const groups = new Map<number, ListingVariationGroupDraft>();

  inventory.products.forEach((product) => {
    product.property_values.forEach((property) => {
      const propertyId = Number(property.property_id);
      if (!Number.isInteger(propertyId) || propertyId <= 0) return;
      const group = groups.get(propertyId) ?? {
        id: `property-${propertyId}`,
        name: property.property_name?.trim() || `Option ${groups.size + 1}`,
        propertyId,
        scaleId: property.scale_id ?? null,
        values: [],
      };
      property.values.forEach((value) => {
        const text = value.trim();
        if (!text || group.values.some((item) => item.value === text)) return;
        group.values.push({ id: `property-${propertyId}-value-${group.values.length + 1}`, value: text });
      });
      groups.set(propertyId, group);
    });
  });

  return Array.from(groups.values()).slice(0, MAX_LISTING_VARIATION_GROUPS);
}

export function normalizeVariationGroups(groups: ListingVariationGroupDraft[]) {
  if (!groups.length) throw new Error("Add at least one variation group.");
  if (groups.length > MAX_LISTING_VARIATION_GROUPS) throw new Error("A listing can have at most two variation groups.");

  const normalized = groups.map((group, index) => {
    const name = group.name.trim();
    const values = Array.from(new Set(group.values.map((value) => value.value.trim()).filter(Boolean)))
      .map((value, valueIndex) => ({ id: group.values[valueIndex]?.id || `group-${index + 1}-value-${valueIndex + 1}`, value }));
    if (!name) throw new Error(`Variation ${index + 1} needs a name.`);
    if (!values.length) throw new Error(`Variation ${index + 1} needs at least one value.`);
    return { ...group, name, values };
  });

  return withResolvedPropertyIds(normalized);
}

export function rebuildInventoryForVariationGroups(
  values: ListingDraftValues,
  currentInventory: EtsyListingInventory | null | undefined,
  groups: ListingVariationGroupDraft[],
): EtsyListingInventory {
  const normalizedGroups = normalizeVariationGroups(groups);
  const matchingProducts = new Map((currentInventory?.products ?? []).map((product) => [productSignature(product), product]));
  const fallbackProduct = currentInventory?.products[0];
  const propertyIds = normalizedGroups.map((group) => group.propertyId);
  const usesIndividualSkus = Boolean(currentInventory?.sku_on_property?.length);
  const hasIndividualPrices = Boolean(currentInventory?.price_on_property?.length);
  const hasIndividualQuantities = Boolean(currentInventory?.quantity_on_property?.length);
  const hasIndividualReadiness = Boolean(currentInventory?.readiness_state_on_property?.length);
  const defaultOffering = {
    is_enabled: true,
    price: values.price?.amount ?? 0,
    quantity: values.quantity ?? 0,
    readiness_state_id: values.readinessStateId,
  };

  return {
    price_on_property: hasIndividualPrices ? propertyIds : [],
    products: combinations(normalizedGroups).map((combination) => {
      const existing = matchingProducts.get(combination.signature) ?? fallbackProduct;
      const offering = existing?.offerings[0] ?? defaultOffering;
      return {
        offerings: [{ ...offering }],
        property_values: normalizedGroups.map((group, groupIndex) => ({
          property_id: group.propertyId,
          property_name: group.name,
          scale_id: group.scaleId,
          value_ids: [],
          values: [combination.labels[groupIndex] ?? ""],
        })),
        sku: usesIndividualSkus ? existing?.sku?.trim() ?? "" : values.sku.trim(),
      };
    }),
    quantity_on_property: hasIndividualQuantities ? propertyIds : [],
    readiness_state_on_property: hasIndividualReadiness ? propertyIds : [],
    sku_on_property: usesIndividualSkus ? propertyIds : [],
  };
}

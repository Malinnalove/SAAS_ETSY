import {
  type EtsyClient,
  type EtsyListingProperty,
  type EtsyTaxonomyProperty,
  type EtsyTaxonomyPropertyValue,
} from "@/features/etsy/client";

function normalize(value: string) {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function propertyName(property: EtsyTaxonomyProperty) {
  return normalize(property.property_name ?? property.display_name ?? property.name ?? "");
}

function valueName(value: EtsyTaxonomyPropertyValue) {
  return (value.name ?? value.value ?? "").trim();
}

function propertyValues(property: EtsyTaxonomyProperty) {
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
    const key = [value.value_id ?? "", value.scale_id ?? "", valueName(value).toLowerCase()].join(":");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function materialProperty(properties: EtsyTaxonomyProperty[]) {
  const matches = properties.filter((property) => propertyName(property).includes("material"));
  return matches.find((property) => propertyName(property) === "materials") ??
    matches.find((property) => propertyName(property) === "material") ?? matches[0] ?? null;
}

export async function updateListingMaterialsProperty({
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
}): Promise<EtsyListingProperty[] | null> {
  if (!materials.length) return null;
  if (!taxonomyId) throw new Error("Taxonomy ID is required before publishing materials.");
  const taxonomy = await client.getPropertiesByTaxonomyId(taxonomyId);
  const property = materialProperty(taxonomy.results ?? []);
  if (!property) throw new Error(`Etsy taxonomy ${taxonomyId} does not expose a Materials property.`);
  const possible = propertyValues(property);
  const matched = materials.map((material) => possible.find((value) => normalize(valueName(value)) === normalize(material)));
  if (possible.length && matched.some((value) => !value?.value_id)) {
    const missing = materials.filter((_, index) => !matched[index]?.value_id).join(", ");
    throw new Error(`These materials are not valid Etsy taxonomy values: ${missing}`);
  }
  const valueIds = matched.map((value) => value?.value_id ?? null).filter((value): value is number => value !== null);
  const scaleIds = new Set(matched.map((value) => value?.scale_id ?? null).filter((value): value is number => value !== null));
  const scaleId = property.scale_id ?? (scaleIds.size === 1 ? Array.from(scaleIds)[0] : null);
  const updated = await client.updateListingProperty(shopId, listingId, property.property_id, {
    scaleId,
    valueIds,
    values: materials,
  });
  try {
    const listingProperties = await client.getListingProperties(shopId, listingId);
    return listingProperties.results ?? [updated];
  } catch {
    return [updated];
  }
}

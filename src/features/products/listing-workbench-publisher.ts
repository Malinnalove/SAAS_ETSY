import type { EtsyClient, EtsyInventoryUpdateInput, UpdateListingInput } from "@/features/etsy/client";
import { updateListingMaterialsProperty } from "@/features/products/listing-materials";
import {
  assertPublishSourceVersion,
  completeListingPublish,
  failListingPublish,
  listPendingListingDraftMedia,
  ListingWorkbenchError,
  markListingDraftMediaUploaded,
  rememberListingPublishResult,
  startListingPublishAttempt,
  type ListingPublishWork,
} from "@/features/products/listing-workbench-db";
import { updateListingInventoryData, upsertListings } from "@/features/sync/db";
import type { EtsyListingSummary } from "@/shared/types/etsy";
import type { ListingDraftPatch, ListingDraftValues } from "@/shared/types/listing-workbench";

function hasOwn<T extends object>(value: T, key: PropertyKey): key is keyof T {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function uploadedImageId(result: Record<string, unknown>) {
  for (const key of ["listing_image_id", "image_id", "id"] as const) {
    const value = Number(result[key]);
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return null;
}

async function uploadStagedImages(work: ListingPublishWork, client: EtsyClient, listingId: number) {
  const media = await listPendingListingDraftMedia(work.draftId);
  for (const item of media) {
    if (item.uploadedAt && item.uploadedListingId === listingId) continue;
    const file = new File([new Uint8Array(item.data)], item.filename || "listing-image", {
      type: item.contentType,
    });
    const result = item.altText
      ? await client.uploadListingImage(work.shopId, listingId, file, { altText: item.altText })
      : await client.uploadListingImage(work.shopId, listingId, file);
    await markListingDraftMediaUploaded({
      draftId: work.draftId,
      listingId,
      mediaId: item.id,
      uploadedImageId: uploadedImageId(result),
    });
  }
}

export function buildListingUpdatePatch(patch: ListingDraftPatch, values: ListingDraftValues): UpdateListingInput {
  const update: UpdateListingInput = {};
  if (hasOwn(patch, "title")) update.title = values.title.trim();
  if (hasOwn(patch, "description")) update.description = values.description;
  if (hasOwn(patch, "price") && values.price) update.price = String(values.price.amount);
  if (hasOwn(patch, "quantity") && values.quantity !== null) update.quantity = values.quantity;
  if (hasOwn(patch, "taxonomyId") && values.taxonomyId) update.taxonomyId = values.taxonomyId;
  if (hasOwn(patch, "shippingProfileId")) update.shippingProfileId = values.shippingProfileId;
  if (hasOwn(patch, "readinessStateId")) update.readinessStateId = values.readinessStateId;
  if (hasOwn(patch, "returnPolicyId")) update.returnPolicyId = values.returnPolicyId;
  if (hasOwn(patch, "shopSectionId")) update.shopSectionId = values.shopSectionId;
  if (hasOwn(patch, "shouldAutoRenew")) update.shouldAutoRenew = values.shouldAutoRenew;
  if (hasOwn(patch, "isSupply")) update.isSupply = values.isSupply;
  if (hasOwn(patch, "tags")) update.tags = values.tags;
  if (hasOwn(patch, "type")) update.type = values.type;
  if (hasOwn(patch, "whenMade")) update.whenMade = values.whenMade;
  if (hasOwn(patch, "whoMade")) update.whoMade = values.whoMade;
  if (hasOwn(patch, "state") && (values.state === "active" || values.state === "inactive")) {
    update.state = values.state;
  }
  return update;
}

export function inventoryWithMainSku(
  inventory: EtsyInventoryUpdateInput,
  values: ListingDraftValues,
): EtsyInventoryUpdateInput {
  if (inventory.sku_on_property?.length) {
    throw new Error("Variant SKU overrides are enabled; edit SKU values in the variant combinations panel.");
  }
  if (inventory.products.length) {
    return {
      ...inventory,
      products: inventory.products.map((product) => ({ ...product, sku: values.sku.trim() })),
    };
  }
  if (!values.price || values.quantity === null) {
    throw new Error("Price and quantity are required before setting SKU.");
  }
  return {
    products: [
      {
        offerings: [
          {
            is_enabled: true,
            price: values.price.amount,
            quantity: values.quantity,
            readiness_state_id: values.readinessStateId,
          },
        ],
        property_values: [],
        sku: values.sku.trim(),
      },
    ],
  };
}

function inventoryForUpdate(inventory: NonNullable<ListingDraftValues["inventory"]>): EtsyInventoryUpdateInput {
  return {
    price_on_property: inventory.price_on_property,
    products: inventory.products.map((product) => ({
      offerings: product.offerings.map((offering) => {
        const rawPrice = offering.price;
        const price = typeof rawPrice === "object"
          ? Number(rawPrice.amount) / Math.max(1, Number(rawPrice.divisor || 100))
          : rawPrice;
        return { ...offering, price };
      }),
      property_values: product.property_values,
      sku: product.sku,
    })),
    quantity_on_property: inventory.quantity_on_property,
    readiness_state_on_property: inventory.readiness_state_on_property,
    sku_on_property: inventory.sku_on_property,
  };
}

async function publishExisting(work: ListingPublishWork, client: EtsyClient) {
  if (!work.listingId) throw new Error("Existing Listing draft is missing a Listing ID.");
  await assertPublishSourceVersion(work);
  const update = buildListingUpdatePatch(work.patch, work.values);
  if (Object.keys(update).length) {
    await client.updateListing(work.shopId, work.listingId, update);
  }
  if (hasOwn(work.patch, "materials")) {
    await updateListingMaterialsProperty({
      client,
      listingId: work.listingId,
      materials: work.values.materials,
      shopId: work.shopId,
      taxonomyId: work.values.taxonomyId ?? 0,
    });
  }
  let inventory: EtsyInventoryUpdateInput | null = hasOwn(work.patch, "inventory") && work.values.inventory
    ? inventoryForUpdate(work.values.inventory)
    : null;
  if (!inventory && hasOwn(work.patch, "sku")) {
    inventory = inventoryWithMainSku(await client.getListingInventory(work.listingId), work.values);
  }
  if (inventory) {
    await client.updateListingInventory(work.listingId, inventory);
    await updateListingInventoryData(work.shopId, work.listingId, await client.getListingInventory(work.listingId));
  }
  for (const [index, image] of work.imageOrder.entries()) {
    await client.updateListingImageAltText(
      work.shopId,
      work.listingId,
      image.id,
      image.altText,
      index + 1,
    );
  }
  const listing = await client.getListing(work.listingId);
  const inventoryResult = inventory ? await client.getListingInventory(work.listingId) : undefined;
  const finalListing: EtsyListingSummary = inventoryResult ? { ...listing, inventory: inventoryResult } : listing;
  await upsertListings(work.shopId, [finalListing]);
  return finalListing;
}

async function publishNew(work: ListingPublishWork, client: EtsyClient) {
  const values = work.values;
  if (!values.price || values.quantity === null || !values.taxonomyId) {
    throw new Error("New Listing requires price, quantity, and taxonomy ID.");
  }
  let listing = work.resultListingId
    ? await client.getListing(work.resultListingId)
    : await client.createDraftListing(work.shopId, {
        description: values.description,
        isSupply: values.isSupply,
        price: String(values.price.amount),
        quantity: values.quantity,
        readinessStateId: values.readinessStateId,
        returnPolicyId: values.returnPolicyId,
        shippingProfileId: values.shippingProfileId,
        shouldAutoRenew: values.shouldAutoRenew,
        shopSectionId: values.shopSectionId,
        tags: values.tags,
        taxonomyId: values.taxonomyId,
        title: values.title,
        type: values.type,
        whenMade: values.whenMade,
        whoMade: values.whoMade,
      });
  const listingId = listing.listing_id;
  if (!work.resultListingId) {
    await rememberListingPublishResult(work.attemptId, work.draftId, listingId);
  }
  if (values.materials.length) {
    await updateListingMaterialsProperty({
      client,
      listingId,
      materials: values.materials,
      shopId: work.shopId,
      taxonomyId: values.taxonomyId,
    });
  }
  let inventory: EtsyInventoryUpdateInput | null = values.inventory ? inventoryForUpdate(values.inventory) : null;
  if (!inventory && values.sku.trim()) {
    inventory = inventoryWithMainSku(await client.getListingInventory(listingId), values);
  }
  if (inventory) {
    await client.updateListingInventory(listingId, inventory);
    await updateListingInventoryData(work.shopId, listingId, await client.getListingInventory(listingId)).catch(() => undefined);
  }
  await uploadStagedImages(work, client, listingId);
  if (values.state === "active" || values.state === "inactive") {
    listing = await client.updateListing(work.shopId, listingId, { state: values.state });
  }
  const refreshed = await client.getListing(listingId);
  const refreshedInventory = inventory ? await client.getListingInventory(listingId) : undefined;
  const finalListing: EtsyListingSummary = refreshedInventory ? { ...refreshed, inventory: refreshedInventory } : refreshed;
  await upsertListings(work.shopId, [finalListing]);
  return finalListing;
}

export async function processListingDraftPublish(attemptId: number, client: EtsyClient) {
  const work = await startListingPublishAttempt(attemptId);
  try {
    const listing = work.draftKind === "new" ? await publishNew(work, client) : await publishExisting(work, client);
    await completeListingPublish(work, listing.listing_id);
    return listing.listing_id;
  } catch (error) {
    // assertPublishSourceVersion already persists the conflict state. Do not
    // downgrade it to a generic failure when the worker reports the 409.
    if (error instanceof ListingWorkbenchError && error.status === 409) throw error;
    await failListingPublish(work.attemptId, work.draftId, error);
    throw error;
  }
}

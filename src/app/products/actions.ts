"use server";

import { redirect } from "next/navigation";
import {
  ensureFreshConnection,
  EtsyClient,
  type CreateDraftListingInput,
  type EtsyInventoryUpdateInput,
} from "@/lib/etsy";
import { getDictionary, getLocaleFromParams, type Locale } from "@/lib/i18n";
import { readStore, selectShop } from "@/lib/store";
import { getShopConnection, updateConnection, upsertListings } from "@/lib/sync-db";

type ListingState = "active" | "inactive";

function listingRedirect(
  shopId: number | null,
  status: "created" | "failed" | "updated",
  detail: string,
  locale: Locale,
  extra: Record<string, string | number | null | undefined> = {},
) {
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

  redirect(`/products?${params.toString()}`);
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

function splitList(value: string) {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
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

function validateCommonListingFields(formData: FormData, locale: Locale) {
  const t = getDictionary(locale);
  const title = stringField(formData, "title");
  const description = stringField(formData, "description");
  const price = stringField(formData, "price");
  const quantity = integerField(formData, "quantity");
  const taxonomyId = integerField(formData, "taxonomyId");
  const shippingProfileId = integerField(formData, "shippingProfileId");
  const readinessStateId = integerField(formData, "readinessStateId");
  const shopSectionId = integerField(formData, "shopSectionId");
  const whoMade = stringField(formData, "whoMade");
  const whenMade = stringField(formData, "whenMade");

  if (!title || title.length > 140) {
    throw new Error(t.products.notice.invalidTitle);
  }

  if (!description) {
    throw new Error(t.products.notice.invalidDescription);
  }

  if (!price || !/^\d+(\.\d{1,2})?$/.test(price) || Number(price) <= 0) {
    throw new Error(t.products.notice.invalidPrice);
  }

  if (!quantity || quantity < 1) {
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

  return {
    description,
    isSupply: stringField(formData, "isSupply") === "true",
    materials: splitList(stringField(formData, "materials")),
    price,
    quantity,
    readinessStateId,
    shippingProfileId,
    shopSectionId,
    shouldAutoRenew: stringField(formData, "shouldAutoRenew") === "true",
    tags: splitList(stringField(formData, "tags")).slice(0, 13),
    taxonomyId,
    title,
    whenMade,
    whoMade,
  };
}

async function requireWritableShop(shopId: number, locale: Locale) {
  const t = getDictionary(locale);
  const store = await readStore();
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

export async function createEtsyListingAction(formData: FormData) {
  const locale = getLocaleFromParams({ lang: stringField(formData, "lang") });
  const t = getDictionary(locale);
  const shopId = Number(formData.get("shopId"));

  if (!Number.isFinite(shopId) || shopId <= 0) {
    listingRedirect(null, "failed", t.products.notice.failedMissingShop, locale);
  }

  try {
    const fields = validateCommonListingFields(formData, locale);
    const images = uploadedImages(formData);
    const publishNow = stringField(formData, "publishState") === "active";
    const inventory = parseInventoryJson(stringField(formData, "inventoryJson"));

    if (publishNow && images.length === 0) {
      throw new Error(t.products.notice.imageRequiredForPublish);
    }

    const { client } = await requireWritableShop(shopId, locale);
    const draftInput: CreateDraftListingInput = {
      ...fields,
      inventory,
      type: "physical",
    };
    const draftListing = await client.createDraftListing(shopId, draftInput);
    const listingId = draftListing.listing_id;

    for (const image of images.slice(0, 10)) {
      await client.uploadListingImage(shopId, listingId, image);
    }

    if (inventory) {
      await client.updateListingInventory(listingId, inventory);
    }

    const finalListing = publishNow
      ? await client.updateListing(shopId, listingId, { state: "active" })
      : draftListing;

    await upsertListings(shopId, [finalListing]);
    listingRedirect(shopId, "created", t.products.notice.created(listingId), locale);
  } catch (error) {
    listingRedirect(
      shopId,
      "failed",
      error instanceof Error ? error.message : t.products.notice.unknownWrite,
      locale,
      { listingPanel: "add" },
    );
  }
}

export async function updateEtsyListingAction(formData: FormData) {
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
      isSupply: fields.isSupply,
      materials: fields.materials,
      price: fields.price,
      quantity: fields.quantity,
      readinessStateId: fields.readinessStateId,
      state: nextState,
      shippingProfileId: fields.shippingProfileId,
      shopSectionId: fields.shopSectionId,
      shouldAutoRenew: fields.shouldAutoRenew,
      tags: fields.tags,
      taxonomyId: fields.taxonomyId,
      title: fields.title,
      type: "physical",
      whenMade: fields.whenMade,
      whoMade: fields.whoMade,
    });

    for (const image of images.slice(0, 10)) {
      await client.uploadListingImage(shopId, listingId, image);
    }

    if (inventory) {
      await client.updateListingInventory(listingId, inventory);
    }

    await upsertListings(shopId, [updatedListing]);
    listingRedirect(shopId, "updated", t.products.notice.updated(listingId), locale, {
      listingId,
      listingPanel: "edit",
    });
  } catch (error) {
    listingRedirect(
      shopId,
      "failed",
      error instanceof Error ? error.message : t.products.notice.unknownWrite,
      locale,
      { listingId, listingPanel: "edit" },
    );
  }
}

import { getEnv } from "@/lib/env";
import { etsyApiQuotaFromHeaders, persistEtsyApiQuota } from "@/features/etsy/quota";
import type {
  EtsyConnection,
  EtsyListingSummary,
  EtsyListingVideo,
  EtsyOrderDetail,
  EtsyReceiptSummary,
  EtsyShopSummary,
} from "@/shared/types/etsy";

const ETSY_API_BASE = "https://openapi.etsy.com/v3/application";
const MIN_ETSY_REQUEST_INTERVAL_MS = 260;
const LISTING_STATES = ["active", "draft", "expired", "inactive", "sold_out"] as const;

type EtsyListResponse<T> = {
  count: number;
  results: T[];
};

type EtsyRequestOptions = {
  body?: BodyInit;
  contentType?: string;
  method?: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
};

export type UpdateListingInput = {
  advancedParams?: EtsyExtraParams | null;
  description?: string;
  imageIds?: number[];
  isCustomizable?: boolean | null;
  isPersonalizable?: boolean | null;
  isSupply?: boolean;
  isTaxable?: boolean | null;
  itemDimensionsUnit?: string;
  itemHeight?: string;
  itemLength?: string;
  itemWeight?: string;
  itemWeightUnit?: string;
  itemWidth?: string;
  personalizationCharCountMax?: number | null;
  personalizationInstructions?: string;
  personalizationIsRequired?: boolean | null;
  price?: string;
  processingMax?: number | null;
  processingMin?: number | null;
  productionPartnerIds?: number[];
  quantity?: number;
  readinessStateId?: number | null;
  returnPolicyId?: number | null;
  state?: "active" | "inactive";
  shippingProfileId?: number | null;
  shopSectionId?: number | null;
  shouldAutoRenew?: boolean;
  styles?: string[];
  tags?: string[];
  taxonomyId?: number;
  title?: string;
  type?: "download" | "physical";
  whenMade?: string;
  whoMade?: string;
};

type ListingStateFilter = (typeof LISTING_STATES)[number];

export type EtsyListingProperty = {
  property_id: number;
  property_name?: string | null;
  scale_id?: number | null;
  scale_name?: string | null;
  value_ids?: number[] | null;
  values?: string[] | null;
};

export type EtsyTaxonomyPropertyValue = {
  equal_to?: number[] | null;
  name?: string | null;
  scale_id?: number | null;
  value?: string | null;
  value_id?: number | null;
};

export type EtsyTaxonomyProperty = {
  display_name?: string | null;
  name?: string | null;
  possible_values?: EtsyTaxonomyPropertyValue[] | null;
  property_id: number;
  property_name?: string | null;
  scale_id?: number | null;
  scales?: Array<{
    display_name?: string | null;
    name?: string | null;
    possible_values?: EtsyTaxonomyPropertyValue[] | null;
    scale_id?: number | null;
    values?: EtsyTaxonomyPropertyValue[] | null;
  }> | null;
  supports_variations?: boolean | null;
  values?: EtsyTaxonomyPropertyValue[] | null;
};

export type UpdateListingPropertyInput = {
  scaleId?: number | null;
  valueIds?: number[];
  values: string[];
};

export type CreateDraftListingInput = {
  advancedParams?: EtsyExtraParams | null;
  description: string;
  imageIds?: number[];
  inventory?: EtsyInventoryUpdateInput | null;
  isCustomizable?: boolean | null;
  isPersonalizable?: boolean | null;
  isSupply: boolean;
  isTaxable?: boolean | null;
  itemDimensionsUnit?: string;
  itemHeight?: string;
  itemLength?: string;
  itemWeight?: string;
  itemWeightUnit?: string;
  itemWidth?: string;
  personalizationCharCountMax?: number | null;
  personalizationInstructions?: string;
  personalizationIsRequired?: boolean | null;
  price: string;
  processingMax?: number | null;
  processingMin?: number | null;
  productionPartnerIds?: number[];
  quantity: number;
  readinessStateId?: number | null;
  returnPolicyId?: number | null;
  shippingProfileId?: number | null;
  shouldAutoRenew?: boolean;
  shopSectionId?: number | null;
  styles?: string[];
  tags?: string[];
  taxonomyId: number;
  title: string;
  type: "download" | "physical";
  whenMade: string;
  whoMade: string;
};

export type EtsyExtraParamValue = boolean | number | string | Array<boolean | number | string>;
export type EtsyExtraParams = Record<string, EtsyExtraParamValue>;

export type EtsyInventoryUpdateInput = {
  products: Array<{
    offerings: Array<{
      is_enabled: boolean;
      price: number | string;
      quantity: number;
      readiness_state_id?: number | null;
    }>;
    property_values: Array<{
      property_id: number;
      property_name?: string;
      scale_id?: number | null;
      value_ids?: number[];
      values: string[];
    }>;
    sku?: string;
  }>;
  price_on_property?: number[];
  quantity_on_property?: number[];
  readiness_state_on_property?: number[];
  sku_on_property?: number[];
};

export type EtsyListingInventory = Omit<EtsyInventoryUpdateInput, "products"> & {
  products: Array<
    EtsyInventoryUpdateInput["products"][number] & {
      is_deleted?: boolean | null;
      product_id?: number | null;
    }
  >;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let nextEtsyRequestAt = 0;
let etsyRequestQueue: Promise<void> = Promise.resolve();

async function waitForEtsyRateSlot() {
  let release: () => void = () => {};
  const previous = etsyRequestQueue;

  etsyRequestQueue = new Promise((resolve) => {
    release = resolve;
  });

  await previous;

  try {
    const waitMs = Math.max(0, nextEtsyRequestAt - Date.now());
    if (waitMs > 0) {
      await sleep(waitMs);
    }

    nextEtsyRequestAt = Date.now() + MIN_ETSY_REQUEST_INTERVAL_MS;
  } finally {
    release();
  }
}

function setOptionalBodyParam(body: URLSearchParams, key: string, value?: boolean | number | string | null) {
  if (value === null || value === undefined || value === "") return;
  body.set(key, String(value));
}

function setOptionalNumberListParam(body: URLSearchParams, key: string, value?: number[]) {
  if (!value?.length) return;
  body.set(key, value.join(","));
}

function setAdvancedBodyParams(body: URLSearchParams, params?: EtsyExtraParams | null) {
  if (!params) return;

  for (const [key, value] of Object.entries(params)) {
    if (body.has(key) || value === null || value === undefined) continue;
    body.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
}

function inventoryVariationPropertyCount(inventory: EtsyInventoryUpdateInput) {
  const properties = new Set<string>();

  for (const product of inventory.products) {
    for (const property of product.property_values) {
      properties.add(
        [
          property.property_id,
          property.scale_id ?? "",
          property.property_name ?? "",
        ].join(":"),
      );
    }
  }

  return properties.size;
}

export async function parseEtsyResponse<T>(response: Response): Promise<T> {
  const body = await response.text();

  if (!response.ok) {
    throw new Error(`Etsy API error ${response.status}: ${body}`);
  }

  return body ? (JSON.parse(body) as T) : ({} as T);
}

export class EtsyClient {
  constructor(private readonly connection: EtsyConnection) {}

  private getApiKeyHeader() {
    const env = getEnv();
    return env.ETSY_SHARED_SECRET
      ? `${env.ETSY_CLIENT_ID}:${env.ETSY_SHARED_SECRET}`
      : env.ETSY_CLIENT_ID;
  }

  private async request<T>(path: string, options: EtsyRequestOptions = {}) {
    let response: Response | null = null;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.connection.accessToken}`,
      "x-api-key": this.getApiKeyHeader(),
    };

    if (options.contentType) {
      headers["Content-Type"] = options.contentType;
    }

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await waitForEtsyRateSlot();

      response = await fetch(`${ETSY_API_BASE}${path}`, {
        body: options.body,
        cache: "no-store",
        headers,
        method: options.method ?? "GET",
      });
      const apiQuota = etsyApiQuotaFromHeaders(response.headers);

      if (apiQuota) {
        await persistEtsyApiQuota(this.connection.shopId, apiQuota).catch((error) => {
          console.error(`Failed to persist Etsy API quota for shop ${this.connection.shopId}:`, error);
        });
      }

      if (response.status !== 429 || attempt === 3) {
        break;
      }

      const retryAfter = Number(response.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : (attempt + 1) * 1000);
    }

    if (!response) {
      throw new Error("Etsy API request did not return a response.");
    }

    return parseEtsyResponse<T>(response);
  }

  async updateListing(shopId: number, listingId: number, input: UpdateListingInput) {
    const body = new URLSearchParams();

    if (input.title) {
      body.set("title", input.title);
    }

    if (input.description) {
      body.set("description", input.description);
    }

    if (input.price) {
      body.set("price", input.price);
    }

    if (input.quantity) {
      body.set("quantity", String(input.quantity));
    }

    if (input.taxonomyId) {
      body.set("taxonomy_id", String(input.taxonomyId));
    }

    if (input.shippingProfileId) {
      body.set("shipping_profile_id", String(input.shippingProfileId));
    }

    if (input.returnPolicyId) {
      body.set("return_policy_id", String(input.returnPolicyId));
    }

    if (input.readinessStateId) {
      body.set("readiness_state_id", String(input.readinessStateId));
    }

    if (input.shopSectionId) {
      body.set("shop_section_id", String(input.shopSectionId));
    }

    if (typeof input.shouldAutoRenew === "boolean") {
      body.set("should_auto_renew", String(input.shouldAutoRenew));
    }

    if (typeof input.isTaxable === "boolean") {
      body.set("is_taxable", String(input.isTaxable));
    }

    setOptionalBodyParam(body, "processing_min", input.processingMin);
    setOptionalBodyParam(body, "processing_max", input.processingMax);
    setOptionalBodyParam(body, "item_weight", input.itemWeight);
    setOptionalBodyParam(body, "item_weight_unit", input.itemWeightUnit);
    setOptionalBodyParam(body, "item_length", input.itemLength);
    setOptionalBodyParam(body, "item_width", input.itemWidth);
    setOptionalBodyParam(body, "item_height", input.itemHeight);
    setOptionalBodyParam(body, "item_dimensions_unit", input.itemDimensionsUnit);
    setOptionalBodyParam(body, "is_personalizable", input.isPersonalizable);
    setOptionalBodyParam(body, "personalization_is_required", input.personalizationIsRequired);
    setOptionalBodyParam(body, "personalization_char_count_max", input.personalizationCharCountMax);
    setOptionalBodyParam(body, "personalization_instructions", input.personalizationInstructions);
    setOptionalBodyParam(body, "is_customizable", input.isCustomizable);
    setOptionalNumberListParam(body, "image_ids", input.imageIds);
    setOptionalNumberListParam(body, "production_partner_ids", input.productionPartnerIds);

    if (input.whoMade) {
      body.set("who_made", input.whoMade);
    }

    if (input.whenMade) {
      body.set("when_made", input.whenMade);
    }

    if (typeof input.isSupply === "boolean") {
      body.set("is_supply", String(input.isSupply));
    }

    if (input.type) {
      body.set("type", input.type);
    }

    if (input.tags?.length) {
      body.set("tags", input.tags.join(","));
    }

    if (input.styles?.length) {
      body.set("styles", input.styles.join(","));
    }

    if (input.state) {
      body.set("state", input.state);
    }

    setAdvancedBodyParams(body, input.advancedParams);

    return this.request<EtsyListingSummary>(`/shops/${shopId}/listings/${listingId}`, {
      body,
      contentType: "application/x-www-form-urlencoded",
      method: "PATCH",
    });
  }

  async deleteListing(listingId: number) {
    await this.request<unknown>(`/listings/${listingId}`, {
      method: "DELETE",
    });
  }

  async createDraftListing(shopId: number, input: CreateDraftListingInput) {
    const body = new URLSearchParams({
      description: input.description,
      is_supply: String(input.isSupply),
      price: input.price,
      quantity: String(input.quantity),
      taxonomy_id: String(input.taxonomyId),
      title: input.title,
      type: input.type,
      when_made: input.whenMade,
      who_made: input.whoMade,
    });

    if (input.shippingProfileId) {
      body.set("shipping_profile_id", String(input.shippingProfileId));
    }

    if (input.returnPolicyId) {
      body.set("return_policy_id", String(input.returnPolicyId));
    }

    if (input.readinessStateId) {
      body.set("readiness_state_id", String(input.readinessStateId));
    }

    if (input.shopSectionId) {
      body.set("shop_section_id", String(input.shopSectionId));
    }

    if (typeof input.shouldAutoRenew === "boolean") {
      body.set("should_auto_renew", String(input.shouldAutoRenew));
    }

    if (typeof input.isTaxable === "boolean") {
      body.set("is_taxable", String(input.isTaxable));
    }

    setOptionalBodyParam(body, "processing_min", input.processingMin);
    setOptionalBodyParam(body, "processing_max", input.processingMax);
    setOptionalBodyParam(body, "item_weight", input.itemWeight);
    setOptionalBodyParam(body, "item_weight_unit", input.itemWeightUnit);
    setOptionalBodyParam(body, "item_length", input.itemLength);
    setOptionalBodyParam(body, "item_width", input.itemWidth);
    setOptionalBodyParam(body, "item_height", input.itemHeight);
    setOptionalBodyParam(body, "item_dimensions_unit", input.itemDimensionsUnit);
    setOptionalBodyParam(body, "is_personalizable", input.isPersonalizable);
    setOptionalBodyParam(body, "personalization_is_required", input.personalizationIsRequired);
    setOptionalBodyParam(body, "personalization_char_count_max", input.personalizationCharCountMax);
    setOptionalBodyParam(body, "personalization_instructions", input.personalizationInstructions);
    setOptionalBodyParam(body, "is_customizable", input.isCustomizable);
    setOptionalNumberListParam(body, "image_ids", input.imageIds);
    setOptionalNumberListParam(body, "production_partner_ids", input.productionPartnerIds);

    if (input.tags?.length) {
      body.set("tags", input.tags.join(","));
    }

    if (input.styles?.length) {
      body.set("styles", input.styles.join(","));
    }

    setAdvancedBodyParams(body, input.advancedParams);

    return this.request<EtsyListingSummary>(`/shops/${shopId}/listings`, {
      body,
      contentType: "application/x-www-form-urlencoded",
      method: "POST",
    });
  }

  async uploadListingImage(shopId: number, listingId: number, image: File, options: { altText?: string } = {}) {
    const body = new FormData();
    body.set("image", image, image.name || "listing-image.jpg");
    if (options.altText) body.set("alt_text", options.altText.slice(0, 500));

    return this.request<Record<string, unknown>>(`/shops/${shopId}/listings/${listingId}/images`, {
      body,
      method: "POST",
    });
  }

  async updateListingImageAltText(shopId: number, listingId: number, listingImageId: number, altText: string, rank?: number) {
    const body = new FormData();
    body.set("listing_image_id", String(listingImageId));
    body.set("alt_text", altText.slice(0, 500));
    if (rank && Number.isSafeInteger(rank) && rank > 0) body.set("rank", String(rank));

    return this.request<Record<string, unknown>>(`/shops/${shopId}/listings/${listingId}/images`, {
      body,
      method: "POST",
    });
  }

  async deleteListingImage(shopId: number, listingId: number, listingImageId: number) {
    await this.request<unknown>(`/shops/${shopId}/listings/${listingId}/images/${listingImageId}`, {
      method: "DELETE",
    });
  }

  async uploadListingVideo(shopId: number, listingId: number, video: File) {
    const body = new FormData();
    const name = video.name || "listing-video.mp4";

    body.set("video", video, name);
    body.set("name", name);

    return this.request<EtsyListingVideo>(`/shops/${shopId}/listings/${listingId}/videos`, {
      body,
      method: "POST",
    });
  }

  async deleteListingVideo(shopId: number, listingId: number, videoId: number) {
    await this.request<unknown>(`/shops/${shopId}/listings/${listingId}/videos/${videoId}`, {
      method: "DELETE",
    });
  }

  async updateListingInventory(listingId: number, inventory: EtsyInventoryUpdateInput) {
    const params = new URLSearchParams();

    if (inventoryVariationPropertyCount(inventory) > 2) {
      params.set("max_variations_supported", "3");
    }

    const query = params.toString();

    return this.request<Record<string, unknown>>(`/listings/${listingId}/inventory${query ? `?${query}` : ""}`, {
      body: JSON.stringify(inventory),
      contentType: "application/json",
      method: "PUT",
    });
  }

  async getListing(listingId: number) {
    return this.request<EtsyListingSummary>(`/listings/${listingId}?includes=Images,Videos`);
  }

  async getListingInventory(listingId: number) {
    return this.request<EtsyListingInventory>(`/listings/${listingId}/inventory?max_variations_supported=3`);
  }

  async getListingProperties(shopId: number, listingId: number) {
    return this.request<EtsyListResponse<EtsyListingProperty>>(
      `/shops/${shopId}/listings/${listingId}/properties`,
    );
  }

  async getPropertiesByTaxonomyId(taxonomyId: number) {
    return this.request<EtsyListResponse<EtsyTaxonomyProperty>>(
      `/seller-taxonomy/nodes/${taxonomyId}/properties`,
    );
  }

  async updateListingProperty(
    shopId: number,
    listingId: number,
    propertyId: number,
    input: UpdateListingPropertyInput,
  ) {
    const body = new URLSearchParams();

    body.set("value_ids", input.valueIds?.length ? input.valueIds.join(",") : "");
    body.set("values", input.values.join(","));

    if (input.scaleId) {
      body.set("scale_id", String(input.scaleId));
    }

    return this.request<EtsyListingProperty>(
      `/shops/${shopId}/listings/${listingId}/properties/${propertyId}`,
      {
        body,
        contentType: "application/x-www-form-urlencoded",
        method: "PUT",
      },
    );
  }

  async getShopByOwnerUserId(userId: string) {
    return this.request<EtsyShopSummary>(`/users/${userId}/shops`);
  }

  async getShop(shopId: number) {
    return this.request<EtsyShopSummary>(`/shops/${shopId}`);
  }

  async getListingsByState(shopId: number, state: ListingStateFilter, limit = 100) {
    const listings: EtsyListingSummary[] = [];
    let offset = 0;

    while (true) {
      const params = new URLSearchParams({
        includes: "Images,Videos",
        limit: String(limit),
        offset: String(offset),
        state,
      });

      const page = await this.request<EtsyListResponse<EtsyListingSummary>>(
        `/shops/${shopId}/listings?${params.toString()}`,
      );

      listings.push(...page.results);

      if (listings.length >= page.count || page.results.length === 0) {
        return listings;
      }

      offset += limit;
    }
  }

  async getShopListings(shopId: number, states: readonly ListingStateFilter[] = LISTING_STATES, limit = 100) {
    const listingsById = new Map<number, EtsyListingSummary>();

    for (const state of states) {
      const listings = await this.getListingsByState(shopId, state, limit);

      for (const listing of listings) {
        listingsById.set(listing.listing_id, listing);
      }
    }

    return Array.from(listingsById.values()).sort((left, right) => left.listing_id - right.listing_id);
  }

  async getActiveListings(shopId: number, limit = 100) {
    return this.getListingsByState(shopId, "active", limit);
  }

  async getReceipt(shopId: number, receiptId: number) {
    return this.request<EtsyReceiptSummary>(`/shops/${shopId}/receipts/${receiptId}?legacy=true`);
  }

  async getReceipts(
    shopId: number,
    limit = 100,
    options: {
      maxPages?: number;
      minLastModified?: number;
    } = {},
  ) {
    const receipts: EtsyReceiptSummary[] = [];
    let offset = 0;
    let pageCount = 0;

    while (true) {
      const params = new URLSearchParams({
        limit: String(limit),
        offset: String(offset),
        legacy: "true",
      });

      if (options.minLastModified) {
        params.set("min_last_modified", String(options.minLastModified));
      }

      const page = await this.request<EtsyListResponse<EtsyReceiptSummary>>(
        `/shops/${shopId}/receipts?${params.toString()}`,
      );

      receipts.push(...page.results);
      pageCount += 1;

      if (
        receipts.length >= page.count ||
        page.results.length === 0 ||
        (options.maxPages && pageCount >= options.maxPages)
      ) {
        return receipts;
      }

      offset += limit;
    }
  }

  async getReceiptTransactions(shopId: number, receiptId: number, limit = 100) {
    const transactions: EtsyOrderDetail[] = [];
    let offset = 0;

    while (true) {
      const page = await this.request<EtsyListResponse<EtsyOrderDetail>>(
        `/shops/${shopId}/receipts/${receiptId}/transactions?limit=${limit}&offset=${offset}&legacy=true`,
      );

      transactions.push(...page.results);

      if (transactions.length >= page.count || page.results.length === 0) {
        return transactions;
      }

      offset += limit;
    }
  }

  /**
   * The receipt-list endpoint is useful for discovering orders, but it can
   * omit delivery fields. Fetch the individual Receipt resource for the
   * orders that appear in the recent-orders UI and merge that detail back
   * into the complete receipt list before it is persisted.
   */
  async getRecentReceiptDetails(shopId: number, receipts: EtsyReceiptSummary[], maxReceipts = 25) {
    const recentReceipts = receipts
      .slice()
      .sort((left, right) => (right.create_timestamp ?? 0) - (left.create_timestamp ?? 0))
      .slice(0, maxReceipts);
    const receiptsById = new Map(receipts.map((receipt) => [receipt.receipt_id, receipt]));

    for (const receipt of recentReceipts) {
      const detail = await this.getReceipt(shopId, receipt.receipt_id);
      receiptsById.set(receipt.receipt_id, { ...receipt, ...detail });
      await sleep(250);
    }

    return receipts.map((receipt) => receiptsById.get(receipt.receipt_id) ?? receipt);
  }

  async getRecentOrderDetails(shopId: number, receipts: EtsyReceiptSummary[], maxReceipts = 25) {
    const recentReceipts = receipts
      .slice()
      .sort((left, right) => (right.create_timestamp ?? 0) - (left.create_timestamp ?? 0))
      .slice(0, maxReceipts);

    const details: EtsyOrderDetail[] = [];

    for (const receipt of recentReceipts) {
      details.push(...(await this.getReceiptTransactions(shopId, receipt.receipt_id)));
      await sleep(250);
    }

    return details;
  }
}

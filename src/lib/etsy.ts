import { getEnv } from "@/lib/env";
import type {
  EtsyConnection,
  EtsyListingSummary,
  EtsyOrderDetail,
  EtsyReceiptSummary,
  EtsyShopSummary,
} from "@/lib/types";

const ETSY_API_BASE = "https://openapi.etsy.com/v3/application";
const ETSY_TOKEN_URL = "https://openapi.etsy.com/v3/public/oauth/token";

type EtsyTokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
};

type EtsyListResponse<T> = {
  count: number;
  results: T[];
};

type EtsyRequestOptions = {
  body?: BodyInit;
  contentType?: string;
  method?: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
};

type UpdateListingInput = {
  description?: string;
  isSupply?: boolean;
  materials?: string[];
  price?: string;
  quantity?: number;
  readinessStateId?: number | null;
  state?: "active" | "inactive";
  shippingProfileId?: number | null;
  shopSectionId?: number | null;
  shouldAutoRenew?: boolean;
  tags?: string[];
  taxonomyId?: number;
  title?: string;
  type?: "download" | "physical";
  whenMade?: string;
  whoMade?: string;
};

export type CreateDraftListingInput = {
  description: string;
  inventory?: EtsyInventoryUpdateInput | null;
  isSupply: boolean;
  materials?: string[];
  price: string;
  quantity: number;
  readinessStateId?: number | null;
  shippingProfileId?: number | null;
  shouldAutoRenew?: boolean;
  shopSectionId?: number | null;
  tags?: string[];
  taxonomyId: number;
  title: string;
  type: "physical";
  whenMade: string;
  whoMade: string;
};

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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function parseEtsyResponse<T>(response: Response): Promise<T> {
  const body = await response.text();

  if (!response.ok) {
    throw new Error(`Etsy API error ${response.status}: ${body}`);
  }

  return body ? (JSON.parse(body) as T) : ({} as T);
}

export async function exchangeAuthorizationCode(code: string, codeVerifier: string) {
  const env = getEnv();
  const response = await fetch(ETSY_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: env.ETSY_CLIENT_ID,
      redirect_uri: env.ETSY_REDIRECT_URI,
      code,
      code_verifier: codeVerifier,
    }),
  });

  return parseEtsyResponse<EtsyTokenResponse>(response);
}

export async function refreshAccessToken(connection: EtsyConnection) {
  const env = getEnv();
  const response = await fetch(ETSY_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: env.ETSY_CLIENT_ID,
      refresh_token: connection.refreshToken,
    }),
  });

  const token = await parseEtsyResponse<EtsyTokenResponse>(response);
  return {
    ...connection,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + token.expires_in * 1000,
    updatedAt: new Date().toISOString(),
  };
}

export async function ensureFreshConnection(connection: EtsyConnection) {
  if (connection.expiresAt > Date.now() + 60_000) {
    return connection;
  }

  return refreshAccessToken(connection);
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
      response = await fetch(`${ETSY_API_BASE}${path}`, {
        body: options.body,
        cache: "no-store",
        headers,
        method: options.method ?? "GET",
      });

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

    if (input.readinessStateId) {
      body.set("readiness_state_id", String(input.readinessStateId));
    }

    if (input.shopSectionId) {
      body.set("shop_section_id", String(input.shopSectionId));
    }

    if (typeof input.shouldAutoRenew === "boolean") {
      body.set("should_auto_renew", String(input.shouldAutoRenew));
    }

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

    if (input.materials?.length) {
      body.set("materials", input.materials.join(","));
    }

    if (input.state) {
      body.set("state", input.state);
    }

    return this.request<EtsyListingSummary>(`/shops/${shopId}/listings/${listingId}`, {
      body,
      contentType: "application/x-www-form-urlencoded",
      method: "PATCH",
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

    if (input.readinessStateId) {
      body.set("readiness_state_id", String(input.readinessStateId));
    }

    if (input.shopSectionId) {
      body.set("shop_section_id", String(input.shopSectionId));
    }

    if (typeof input.shouldAutoRenew === "boolean") {
      body.set("should_auto_renew", String(input.shouldAutoRenew));
    }

    if (input.tags?.length) {
      body.set("tags", input.tags.join(","));
    }

    if (input.materials?.length) {
      body.set("materials", input.materials.join(","));
    }

    return this.request<EtsyListingSummary>(`/shops/${shopId}/listings`, {
      body,
      contentType: "application/x-www-form-urlencoded",
      method: "POST",
    });
  }

  async uploadListingImage(shopId: number, listingId: number, image: File) {
    const body = new FormData();
    body.set("image", image, image.name || "listing-image.jpg");

    return this.request<Record<string, unknown>>(`/shops/${shopId}/listings/${listingId}/images`, {
      body,
      method: "POST",
    });
  }

  async updateListingInventory(listingId: number, inventory: EtsyInventoryUpdateInput) {
    return this.request<Record<string, unknown>>(`/listings/${listingId}/inventory`, {
      body: JSON.stringify(inventory),
      contentType: "application/json",
      method: "PUT",
    });
  }

  async getListing(listingId: number) {
    return this.request<EtsyListingSummary>(`/listings/${listingId}?includes=Images`);
  }

  async getShopListing(shopId: number, listingId: number) {
    return this.request<EtsyListingSummary>(`/shops/${shopId}/listings/${listingId}?includes=Images`);
  }

  async getListingInventory(listingId: number) {
    return this.request<Record<string, unknown>>(`/listings/${listingId}/inventory`);
  }

  async getShopByOwnerUserId(userId: string) {
    return this.request<EtsyShopSummary>(`/users/${userId}/shops`);
  }

  async getShop(shopId: number) {
    return this.request<EtsyShopSummary>(`/shops/${shopId}`);
  }

  async getActiveListings(shopId: number, limit = 100) {
    const listings: EtsyListingSummary[] = [];
    let offset = 0;

    while (true) {
      const params = new URLSearchParams({
        includes: "Images",
        limit: String(limit),
        offset: String(offset),
        state: "active",
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

  async getReceipt(shopId: number, receiptId: number) {
    return this.request<EtsyReceiptSummary>(`/shops/${shopId}/receipts/${receiptId}`);
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
        `/shops/${shopId}/receipts/${receiptId}/transactions?limit=${limit}&offset=${offset}`,
      );

      transactions.push(...page.results);

      if (transactions.length >= page.count || page.results.length === 0) {
        return transactions;
      }

      offset += limit;
    }
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

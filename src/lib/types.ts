export type EtsyConnection = {
  userId: string;
  shopId: number;
  shopName: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  connectedAt: string;
  updatedAt: string;
};

export type EtsyMoney = {
  amount: number;
  divisor: number;
  currency_code: string;
};

export type EtsyListingImage = {
  alt_text?: string | null;
  image_url?: string | null;
  url_75x75?: string | null;
  url_170x135?: string | null;
  url_570xN?: string | null;
  url_fullxfull?: string | null;
};

export type EtsyShopSummary = {
  shop_id: number;
  shop_name: string;
  title?: string | null;
  currency_code?: string | null;
  transaction_sold_count?: number | null;
  review_count?: number | null;
  updated_timestamp?: number | null;
};

export type EtsyListingSummary = {
  listing_id: number;
  title: string;
  description?: string | null;
  state: string;
  quantity?: number | null;
  price?: EtsyMoney | null;
  url?: string | null;
  num_favorers?: number | null;
  views?: number | null;
  created_timestamp?: number | null;
  updated_timestamp?: number | null;
  has_variations?: boolean | null;
  image?: EtsyListingImage | null;
  image_ids?: number[] | null;
  images?: EtsyListingImage[] | null;
  is_supply?: boolean | null;
  main_image?: EtsyListingImage | null;
  MainImage?: EtsyListingImage | null;
  materials?: string[] | null;
  processing_max?: number | null;
  processing_min?: number | null;
  readiness_state_id?: number | null;
  shipping_profile_id?: number | null;
  shop_section_id?: number | null;
  should_auto_renew?: boolean | null;
  tags?: string[] | null;
  taxonomy_id?: number | null;
  type?: string | null;
  when_made?: string | null;
  who_made?: string | null;
};

export type EtsyReceiptSummary = {
  receipt_id: number;
  status?: string | null;
  name?: string | null;
  first_line?: string | null;
  city?: string | null;
  country_iso?: string | null;
  grandtotal?: EtsyMoney | null;
  subtotal?: EtsyMoney | null;
  total_shipping_cost?: EtsyMoney | null;
  total_tax_cost?: EtsyMoney | null;
  discount_amt?: EtsyMoney | null;
  create_timestamp?: number | null;
  update_timestamp?: number | null;
};

export type EtsyOrderDetail = {
  transaction_id: number;
  receipt_id: number;
  listing_id?: number | null;
  title?: string | null;
  product_id?: number | null;
  sku?: string | null;
  quantity?: number | null;
  price?: EtsyMoney | null;
  paid_timestamp?: number | null;
  shipped_timestamp?: number | null;
  variations?: Array<{
    property_name?: string | null;
    value?: string | null;
  }>;
};

export type EtsyAdSummary = {
  id: string;
  listing_id?: number | null;
  listing_title?: string | null;
  channel?: string | null;
  clicks?: number | null;
  impressions?: number | null;
  spend?: EtsyMoney | null;
  orders?: number | null;
  revenue?: EtsyMoney | null;
  updated_at?: string | null;
};

export type EtsyShopData = {
  connection: EtsyConnection;
  shop: EtsyShopSummary | null;
  listings: EtsyListingSummary[];
  receipts: EtsyReceiptSummary[];
  orderDetails: EtsyOrderDetail[];
  ads: EtsyAdSummary[];
  adsSyncNote: string | null;
  lastSyncAt: string | null;
  newOrderCount: number;
};

export type AppStore = {
  connection: EtsyConnection | null;
  shop: EtsyShopSummary | null;
  listings: EtsyListingSummary[];
  receipts: EtsyReceiptSummary[];
  orderDetails: EtsyOrderDetail[];
  ads: EtsyAdSummary[];
  adsSyncNote: string | null;
  lastSyncAt: string | null;
  activeShopId: number | null;
  shops: EtsyShopData[];
};

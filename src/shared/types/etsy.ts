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

export type EtsyApiQuota = {
  limitPerDay: number | null;
  remainingToday: number | null;
  updatedAt: string;
};

export type EtsyMoney = {
  amount: number;
  divisor: number;
  currency_code: string;
};

export type EtsyListingImage = {
  alt_text?: string | null;
  image_id?: number | null;
  image_url?: string | null;
  listing_image_id?: number | null;
  rank?: number | null;
  url_75x75?: string | null;
  url_170x135?: string | null;
  url_570xN?: string | null;
  url_fullxfull?: string | null;
};

export type EtsyListingVideo = {
  height?: number | null;
  thumbnail_url?: string | null;
  video_id?: number | null;
  video_state?: string | number | null;
  video_url?: string | null;
  width?: number | null;
};

export type EtsyInventoryProduct = {
  is_deleted?: boolean | null;
  offerings: Array<{
    is_enabled: boolean;
    price: number | string | EtsyMoney;
    quantity: number;
    readiness_state_id?: number | null;
  }>;
  product_id?: number | null;
  property_values: Array<{
    property_id: number;
    property_name?: string;
    scale_id?: number | null;
    value_ids?: number[];
    values: string[];
  }>;
  sku?: string;
};

export type EtsyListingInventory = {
  price_on_property?: number[];
  products: EtsyInventoryProduct[];
  quantity_on_property?: number[];
  readiness_state_on_property?: number[];
  sku_on_property?: number[];
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
  inventory?: EtsyListingInventory | null;
  is_supply?: boolean | null;
  listing_properties?: Array<{
    property_id: number;
    property_name?: string | null;
    scale_id?: number | null;
    scale_name?: string | null;
    value_ids?: number[] | null;
    values?: string[] | null;
  }> | null;
  main_image?: EtsyListingImage | null;
  MainImage?: EtsyListingImage | null;
  materials?: string[] | null;
  videos?: EtsyListingVideo[] | null;
  processing_max?: number | null;
  processing_min?: number | null;
  readiness_state_id?: number | null;
  return_policy_id?: number | null;
  shipping_profile_id?: number | null;
  shop_section_id?: number | null;
  should_auto_renew?: boolean | null;
  sku?: string | null;
  skus?: string[] | null;
  tags?: string[] | null;
  taxonomy_id?: number | null;
  type?: string | null;
  when_made?: string | null;
  who_made?: string | null;
};

export type EtsyReceiptSummary = {
  receipt_id: number;
  buyer_email?: string | null;
  buyer_user_id?: number | null;
  buyer_user_name?: string | null;
  status?: string | null;
  name?: string | null;
  first_line?: string | null;
  second_line?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country_iso?: string | null;
  country_name?: string | null;
  formatted_address?: string | null;
  phone?: string | null;
  payment_method?: string | null;
  payment_email?: string | null;
  message_from_buyer?: string | null;
  message_from_seller?: string | null;
  gift_message?: string | null;
  is_gift?: boolean | null;
  is_paid?: boolean | null;
  is_shipped?: boolean | null;
  grandtotal?: EtsyMoney | null;
  subtotal?: EtsyMoney | null;
  total_shipping_cost?: EtsyMoney | null;
  total_tax_cost?: EtsyMoney | null;
  discount_amt?: EtsyMoney | null;
  shipments?: Array<{
    carrier_name?: string | null;
    mailed_timestamp?: number | null;
    mail_class?: string | null;
    tracking_code?: string | null;
  }> | null;
  create_timestamp?: number | null;
  update_timestamp?: number | null;
};

export type EtsyOrderDetail = {
  transaction_id: number;
  receipt_id: number;
  create_timestamp?: number | null;
  expected_ship_date?: number | null;
  listing_id?: number | null;
  title?: string | null;
  product_id?: number | null;
  sku?: string | null;
  quantity?: number | null;
  price?: EtsyMoney | null;
  max_processing_days?: number | null;
  min_processing_days?: number | null;
  paid_timestamp?: number | null;
  shipped_timestamp?: number | null;
  shipping_method?: string | null;
  shipping_upgrade?: string | null;
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
  apiQuota: EtsyApiQuota | null;
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
  apiQuota: EtsyApiQuota | null;
  lastSyncAt: string | null;
  activeShopId: number | null;
  shops: EtsyShopData[];
};

import type { EtsyListingInventory } from "@/shared/types/etsy";

export type ListingLifecycle =
  | "live"
  | "draft"
  | "changed"
  | "invalid"
  | "queued"
  | "publishing"
  | "deleting"
  | "failed"
  | "conflict"
  | "archived";

export type ListingMoney = {
  amount: number;
  currency: string;
};

export type ListingDraftValues = {
  description: string;
  inventory: EtsyListingInventory | null;
  isSupply: boolean;
  materials: string[];
  price: ListingMoney | null;
  quantity: number | null;
  readinessStateId: number | null;
  returnPolicyId: number | null;
  shippingProfileId: number | null;
  shopSectionId: number | null;
  shouldAutoRenew: boolean;
  sku: string;
  state: string;
  tags: string[];
  taxonomyId: number | null;
  title: string;
  type: "download" | "physical";
  whenMade: string;
  whoMade: string;
};

export type ListingDraftPatch = Partial<ListingDraftValues>;

export type ListingValidationErrors = Record<string, string>;

export type ListingPublishState = {
  attemptId: number;
  error: string | null;
  jobId: number | null;
  status: "queued" | "running" | "succeeded" | "failed" | "conflict";
} | null;

export type ListingWorkspaceImage = {
  altText: string;
  id: number | null;
  rank: number | null;
  source: "draft" | "etsy";
  url: string;
};

export type ListingImageOrderItem = {
  altText: string;
  id: number;
};

export type ListingWorkspaceRow = {
  dirtyFields: Array<keyof ListingDraftValues>;
  draftId: number | null;
  draftVersion: number | null;
  hasVariations: boolean;
  imageUrl: string;
  images: ListingWorkspaceImage[];
  kind: "existing" | "new";
  lifecycle: ListingLifecycle;
  listingId: number | null;
  publish: ListingPublishState;
  rowId: string;
  skuSummary: string;
  sourceVersion: string | null;
  updatedAt: string;
  validationErrors: ListingValidationErrors;
  values: ListingDraftValues;
  variantCount: number;
};

export type ListingFieldType = "boolean" | "longText" | "money" | "number" | "select" | "tags" | "text";

export type ListingFieldGroup = "basic" | "commerce" | "fulfillment" | "inventory";

export type ListingFieldDefinition = {
  bulkEditable: boolean;
  defaultVisible: boolean;
  defaultWidth: number;
  editable: boolean;
  group: ListingFieldGroup;
  id: keyof ListingDraftValues;
  label: { en: string; zh: string };
  type: ListingFieldType;
};

export type ListingViewFilter = "all" | "changed" | "attention" | "failed" | "inactive";

export type ListingSort = "updated_desc" | "title_asc" | "price_desc" | "quantity_asc";

export type ListingSavedViewDefinition = {
  columns: Array<{
    fieldId: keyof ListingDraftValues | "image" | "lifecycle" | "updatedAt";
    hidden?: boolean;
    pinned?: "left" | "right";
    width?: number;
  }>;
  density: "comfortable" | "compact";
  filter: ListingViewFilter;
  pinnedColumns: string[];
  sort: ListingSort;
};

export type ListingSavedView = {
  definition: ListingSavedViewDefinition;
  id: number | null;
  name: string;
  systemKey: ListingViewFilter | null;
};

export type ListingRowsPage = {
  hasMore: boolean;
  nextCursor: string | null;
  rows: ListingWorkspaceRow[];
  states: string[];
};

export type ListingShopDefaults = {
  values: ListingDraftValues;
  version: number;
};

export type ListingBulkPasteRow = {
  changes: ListingDraftPatch;
  errors: ListingValidationErrors;
  rowNumber: number;
};

export type ListingUploadField = Exclude<keyof ListingDraftValues, "inventory">;

export type ListingUploadRow = {
  id: number;
  position: number;
  updatedAt: string;
  validationErrors: ListingValidationErrors;
  values: ListingDraftPatch;
  version: number;
};

export type ListingUploadWorkspace = {
  id: number;
  minimumRows: number;
  rows: ListingUploadRow[];
  shopId: number;
  version: number;
};

export type ListingDeleteAttempt = {
  attemptId: number;
  draftId: number | null;
  error: string | null;
  jobId: number | null;
  listingId: number;
  status: "queued" | "running" | "succeeded" | "failed";
};

import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyListingPatch, blankListingValues } from "@/features/products/listing-workbench-model";
import type { ListingPublishWork } from "@/features/products/listing-workbench-db";

const mocks = vi.hoisted(() => ({
  complete: vi.fn(),
  createDraft: vi.fn(),
  fail: vi.fn(),
  getListing: vi.fn(),
  listMedia: vi.fn(),
  markMedia: vi.fn(),
  remember: vi.fn(),
  start: vi.fn(),
  updateListing: vi.fn(),
  updateImage: vi.fn(),
  uploadImage: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("@/features/products/listing-workbench-db", () => ({
  assertPublishSourceVersion: vi.fn(),
  completeListingPublish: mocks.complete,
  failListingPublish: mocks.fail,
  listPendingListingDraftMedia: mocks.listMedia,
  ListingWorkbenchError: class ListingWorkbenchError extends Error {
    status: number;
    constructor(message: string, status = 400) {
      super(message);
      this.status = status;
    }
  },
  markListingDraftMediaUploaded: mocks.markMedia,
  rememberListingPublishResult: mocks.remember,
  startListingPublishAttempt: mocks.start,
}));

vi.mock("@/features/products/listing-materials", () => ({ updateListingMaterialsProperty: vi.fn() }));
vi.mock("@/features/sync/db", () => ({
  updateListingInventoryData: vi.fn(),
  upsertListings: mocks.upsert,
}));

import { processListingDraftPublish } from "@/features/products/listing-workbench-publisher";

function newListingWork(resultListingId: number | null): ListingPublishWork {
  const values = applyListingPatch(blankListingValues(), {
    description: "Description",
    price: { amount: 12.5, currency: "USD" },
    quantity: 2,
    taxonomyId: 2098,
    title: "Retry-safe listing",
  });
  return {
    attemptId: 10,
    baseSourceVersion: null,
    baseValues: blankListingValues(),
    draftId: 20,
    draftKind: "new",
    draftVersion: 1,
    imageOrder: [],
    listingId: resultListingId,
    organizationId: 1,
    patch: values,
    resultListingId,
    shopId: 30,
    values,
  };
}

function existingListingWork(): ListingPublishWork {
  const values = applyListingPatch(blankListingValues(), {
    description: "Existing description",
    price: { amount: 12.5, currency: "USD" },
    quantity: 2,
    taxonomyId: 2098,
    title: "Existing listing",
  });
  return {
    attemptId: 11,
    baseSourceVersion: "source-version",
    baseValues: values,
    draftId: 21,
    draftKind: "existing",
    draftVersion: 2,
    imageOrder: [
      { altText: "Second image", id: 202 },
      { altText: "First image", id: 101 },
    ],
    listingId: 654,
    organizationId: 1,
    patch: {},
    resultListingId: null,
    shopId: 30,
    values,
  };
}

function client() {
  const listing = { listing_id: 321, state: "draft", title: "Retry-safe listing" };
  mocks.createDraft.mockResolvedValue(listing);
  mocks.getListing.mockResolvedValue(listing);
  mocks.updateListing.mockResolvedValue(listing);
  return {
    createDraftListing: mocks.createDraft,
    getListingInventory: vi.fn(),
    getListing: mocks.getListing,
    updateListing: mocks.updateListing,
    updateListingImageAltText: mocks.updateImage,
    updateListingInventory: vi.fn(),
    uploadListingImage: mocks.uploadImage,
  };
}

describe("Listing publish retry safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listMedia.mockResolvedValue([]);
  });

  it("reuses a remote Etsy draft recorded by an earlier failed attempt", async () => {
    mocks.start.mockResolvedValue(newListingWork(321));
    const etsy = client();

    await expect(processListingDraftPublish(10, etsy as never)).resolves.toBe(321);

    expect(mocks.createDraft).not.toHaveBeenCalled();
    expect(mocks.remember).not.toHaveBeenCalled();
    expect(mocks.getListing).toHaveBeenCalledWith(321);
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ attemptId: 10 }), 321);
  });

  it("records a new remote Etsy ID before continuing the publish steps", async () => {
    mocks.start.mockResolvedValue(newListingWork(null));
    const etsy = client();

    await expect(processListingDraftPublish(10, etsy as never)).resolves.toBe(321);

    expect(mocks.createDraft).toHaveBeenCalledTimes(1);
    expect(mocks.remember).toHaveBeenCalledWith(10, 20, 321);
    expect(mocks.fail).not.toHaveBeenCalled();
  });

  it("uploads staged images after recording the remote Etsy draft ID", async () => {
    mocks.start.mockResolvedValue(newListingWork(null));
    mocks.listMedia.mockResolvedValue([{
      contentType: "image/png",
      data: Buffer.from("image"),
      filename: "draft.png",
      id: 77,
      uploadedAt: null,
      uploadedImageId: null,
      uploadedListingId: null,
    }]);
    mocks.uploadImage.mockResolvedValue({ listing_image_id: 88 });
    const etsy = client();

    await expect(processListingDraftPublish(10, etsy as never)).resolves.toBe(321);

    expect(mocks.remember).toHaveBeenCalledWith(10, 20, 321);
    expect(mocks.uploadImage).toHaveBeenCalledWith(30, 321, expect.any(File));
    expect(mocks.markMedia).toHaveBeenCalledWith({
      draftId: 20,
      listingId: 321,
      mediaId: 77,
      uploadedImageId: 88,
    });
  });

  it("sends staged image alt text with the Etsy image upload", async () => {
    mocks.start.mockResolvedValue(newListingWork(null));
    mocks.listMedia.mockResolvedValue([{
      altText: "Yellow handmade cookie stamp with a cartoon design",
      contentType: "image/png",
      data: Buffer.from("image"),
      filename: "draft.png",
      id: 77,
      uploadedAt: null,
      uploadedImageId: null,
      uploadedListingId: null,
    }]);
    mocks.uploadImage.mockResolvedValue({ listing_image_id: 88 });
    const etsy = client();

    await expect(processListingDraftPublish(10, etsy as never)).resolves.toBe(321);

    expect(mocks.uploadImage).toHaveBeenCalledWith(
      30,
      321,
      expect.any(File),
      { altText: "Yellow handmade cookie stamp with a cartoon design" },
    );
  });

  it("does not upload an image again after a retry recorded it", async () => {
    mocks.start.mockResolvedValue(newListingWork(321));
    mocks.listMedia.mockResolvedValue([{
      contentType: "image/png",
      data: Buffer.from("image"),
      filename: "draft.png",
      id: 77,
      uploadedAt: new Date().toISOString(),
      uploadedImageId: 88,
      uploadedListingId: 321,
    }]);
    const etsy = client();

    await expect(processListingDraftPublish(10, etsy as never)).resolves.toBe(321);

    expect(mocks.uploadImage).not.toHaveBeenCalled();
    expect(mocks.markMedia).not.toHaveBeenCalled();
  });

  it("syncs a locally staged image order only when the existing Listing is published", async () => {
    mocks.start.mockResolvedValue(existingListingWork());
    const etsy = client();
    mocks.getListing.mockResolvedValue({ listing_id: 654, state: "active", title: "Existing listing" });

    expect(mocks.updateImage).not.toHaveBeenCalled();
    await expect(processListingDraftPublish(11, etsy as never)).resolves.toBe(654);

    expect(mocks.updateImage.mock.calls).toEqual([
      [30, 654, 202, "Second image", 1],
      [30, 654, 101, "First image", 2],
    ]);
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ draftId: 21 }), 654);
  });
});

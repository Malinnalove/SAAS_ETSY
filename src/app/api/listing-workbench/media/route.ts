import { NextResponse } from "next/server";
import { authorizeShop, requireUserApi } from "@/features/auth/session";
import { EtsyClient } from "@/features/etsy/client";
import { ensureFreshConnection } from "@/features/etsy/oauth";
import {
  assertListingSourceAccess,
  createListingDraftMedia,
  deleteListingDraftMedia,
  getListingDraftMedia,
  getListingDraftShopId,
  ListingWorkbenchError,
  reorderListingDraftMedia,
  saveListingImageOrderDraft,
  updateListingDraftMediaAltText,
} from "@/features/products/listing-workbench-db";
import { jsonBody, workbenchErrorResponse } from "@/features/products/listing-workbench-api";
import { getShopConnection, updateConnection, upsertListings } from "@/features/sync/db";

async function writableClient(organizationId: number, shopId: number, listingId: number) {
  await assertListingSourceAccess(organizationId, shopId, listingId);
  const current = await getShopConnection(shopId);
  if (!current) throw new ListingWorkbenchError("Etsy connection not found.", 409);
  if (!current.scopes.includes("listings_w")) {
    throw new ListingWorkbenchError("Etsy listings_w permission is required.", 403);
  }
  const connection = await ensureFreshConnection(current);
  if (connection.accessToken !== current.accessToken) await updateConnection(connection);
  return new EtsyClient(connection);
}

function validId(value: number) {
  return Number.isSafeInteger(value) && value > 0;
}

export async function GET(request: Request) {
  const { admin, response } = await requireUserApi(request, "listings.read");
  if (response || !admin) return response;
  try {
    const params = new URL(request.url).searchParams;
    const draftId = Number(params.get("draftId"));
    const mediaId = Number(params.get("mediaId"));
    if (!validId(draftId) || !validId(mediaId)) {
      throw new ListingWorkbenchError("Valid draft and media IDs are required.");
    }
    const shopId = await getListingDraftShopId(draftId, admin.organizationId);
    if (!(await authorizeShop(admin, shopId, "listings.read"))) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    const media = await getListingDraftMedia({ draftId, mediaId, organizationId: admin.organizationId });
    return new Response(new Uint8Array(media.data), {
      headers: {
        "Cache-Control": "private, max-age=300",
        "Content-Length": String(media.size),
        "Content-Type": media.contentType,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return workbenchErrorResponse(error);
  }
}

export async function POST(request: Request) {
  const { admin, response } = await requireUserApi(request, "listings.write");
  if (response || !admin) return response;
  try {
    const form = await request.formData();
    const shopId = Number(form.get("shopId"));
    const listingId = Number(form.get("listingId"));
    const draftId = Number(form.get("draftId"));
    const confirmation = String(form.get("confirmation") ?? "");
    const altText = String(form.get("altText") ?? "").trim();
    const image = form.get("image");
    if (!validId(shopId) || (!validId(listingId) && !validId(draftId))) {
      throw new ListingWorkbenchError("Valid shop and Listing or draft IDs are required.");
    }
    if (!(await authorizeShop(admin, shopId, "listings.write"))) return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    if (!(image instanceof File) || image.size === 0) throw new ListingWorkbenchError("Choose an image to upload.");
    if (altText.length > 500) throw new ListingWorkbenchError("Image alt text must be 500 characters or fewer.");
    if (!image.type.startsWith("image/")) throw new ListingWorkbenchError("Only image files are supported.", 415);
    if (image.size > 20 * 1024 * 1024) throw new ListingWorkbenchError("Image files must be 20 MB or smaller.", 413);
    if (validId(draftId) && !validId(listingId)) {
      const media = await createListingDraftMedia({
        altText,
        contentType: image.type,
        data: Buffer.from(await image.arrayBuffer()),
        draftId,
        filename: image.name || "listing-image",
        organizationId: admin.organizationId,
        shopId,
        userId: admin.userId,
      });
      return NextResponse.json({ media, staged: true }, { status: 201 });
    }
    if (confirmation !== "CONFIRM") throw new ListingWorkbenchError("Confirm before changing Etsy Listing images.");
    const client = await writableClient(admin.organizationId, shopId, listingId);
    await client.uploadListingImage(shopId, listingId, image, { altText });
    const listing = await client.getListing(listingId);
    await upsertListings(shopId, [listing]);
    return NextResponse.json({ listing });
  } catch (error) {
    return workbenchErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  const { admin, response } = await requireUserApi(request, "listings.write");
  if (response || !admin) return response;
  try {
    const body = await jsonBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ListingWorkbenchError("Invalid image alt text request.");
    }
    const record = body as Record<string, unknown>;
    const operation = String(record.operation ?? "alt_text");
    const shopId = Number(record.shopId);
    const listingId = Number(record.listingId);
    const imageId = Number(record.imageId);
    const draftId = Number(record.draftId);
    const mediaId = Number(record.mediaId);
    const rank = Number(record.rank);
    const altText = String(record.altText ?? "").trim();
    if (!validId(shopId)) throw new ListingWorkbenchError("Valid shop ID is required.");
    if (!(await authorizeShop(admin, shopId, "listings.write"))) return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    if (operation === "reorder") {
      if (validId(draftId)) {
        const mediaIds = Array.isArray(record.mediaIds) ? record.mediaIds.map(Number) : [];
        const images = await reorderListingDraftMedia({
          draftId,
          mediaIds,
          organizationId: admin.organizationId,
          shopId,
        });
        return NextResponse.json({ images, staged: true });
      }
      if (!validId(listingId) || !Array.isArray(record.images) || !record.images.length || record.images.length > 20) {
        throw new ListingWorkbenchError("A valid Listing image order is required.");
      }
      const images = record.images.map((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new ListingWorkbenchError("Invalid Listing image order.");
        }
        const item = value as Record<string, unknown>;
        const id = Number(item.id);
        const itemAltText = String(item.altText ?? "").trim();
        if (!validId(id) || itemAltText.length > 500) throw new ListingWorkbenchError("Invalid Listing image order.");
        return { altText: itemAltText, id: Math.round(id) };
      });
      if (new Set(images.map((image) => image.id)).size !== images.length) {
        throw new ListingWorkbenchError("Listing image order must contain unique images.");
      }
      const row = await saveListingImageOrderDraft({
        images,
        listingId,
        organizationId: admin.organizationId,
        shopId,
        userId: admin.userId,
      });
      return NextResponse.json({ row, staged: true });
    }
    if (altText.length > 500) throw new ListingWorkbenchError("Image alt text must be 500 characters or fewer.");
    if (validId(draftId) && validId(mediaId)) {
      const media = await updateListingDraftMediaAltText({
        altText,
        draftId,
        mediaId,
        organizationId: admin.organizationId,
        shopId,
      });
      return NextResponse.json({ media, staged: true });
    }
    if (!validId(listingId) || !validId(imageId)) {
      throw new ListingWorkbenchError("Valid Listing and image IDs are required.");
    }
    if (record.confirmation !== "CONFIRM") throw new ListingWorkbenchError("Confirm before changing Etsy image alt text.");
    const client = await writableClient(admin.organizationId, shopId, listingId);
    await client.updateListingImageAltText(
      shopId,
      listingId,
      Math.round(imageId),
      altText,
      Number.isSafeInteger(rank) && rank > 0 ? Math.round(rank) : undefined,
    );
    const listing = await client.getListing(listingId);
    await upsertListings(shopId, [listing]);
    return NextResponse.json({ listing });
  } catch (error) {
    return workbenchErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  const { admin, response } = await requireUserApi(request, "listings.write");
  if (response || !admin) return response;
  try {
    const body = await jsonBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ListingWorkbenchError("Invalid media request.");
    }
    const record = body as Record<string, unknown>;
    const shopId = Number(record.shopId);
    const listingId = Number(record.listingId);
    const imageId = Number(record.imageId);
    const draftId = Number(record.draftId);
    const mediaId = Number(record.mediaId);
    if (!validId(shopId)) throw new ListingWorkbenchError("Valid shop ID is required.");
    if (!(await authorizeShop(admin, shopId, "listings.write"))) return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    if (validId(draftId) && validId(mediaId)) {
      await deleteListingDraftMedia({
        draftId,
        mediaId,
        organizationId: admin.organizationId,
        shopId,
      });
      return NextResponse.json({ deleted: true, staged: true });
    }
    if (!validId(listingId) || !validId(imageId)) {
      throw new ListingWorkbenchError("Valid Listing and image IDs are required.");
    }
    if (record.confirmation !== "CONFIRM") throw new ListingWorkbenchError("Confirm before changing Etsy Listing images.");
    const client = await writableClient(admin.organizationId, shopId, listingId);
    await client.deleteListingImage(shopId, listingId, Math.round(imageId));
    const listing = await client.getListing(listingId);
    await upsertListings(shopId, [listing]);
    return NextResponse.json({ listing });
  } catch (error) {
    return workbenchErrorResponse(error);
  }
}

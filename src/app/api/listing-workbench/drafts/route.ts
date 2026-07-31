import { NextResponse } from "next/server";
import { authorizeShop, requireUserApi } from "@/features/auth/session";
import { createListingDraft, ListingWorkbenchError } from "@/features/products/listing-workbench-db";
import { jsonBody, workbenchErrorResponse } from "@/features/products/listing-workbench-api";

export async function POST(request: Request) {
  const { admin, response } = await requireUserApi(request, "listings.write");
  if (response || !admin) return response;
  try {
    const body = await jsonBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ListingWorkbenchError("Invalid draft request.");
    const record = body as Record<string, unknown>;
    const shopId = Number(record.shopId);
    const listingId = record.listingId === null || record.listingId === undefined ? null : Number(record.listingId);
    if (!Number.isFinite(shopId) || shopId <= 0) throw new ListingWorkbenchError("Valid shopId is required.");
    if (listingId !== null && (!Number.isFinite(listingId) || listingId <= 0)) throw new ListingWorkbenchError("Invalid Listing ID.");
    if (!(await authorizeShop(admin, shopId, "listings.write"))) return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    const row = await createListingDraft({
      changes: record.changes,
      listingId,
      migrationKey: typeof record.migrationKey === "string" ? record.migrationKey : null,
      organizationId: admin.organizationId,
      shopId,
      userId: admin.userId,
    });
    return NextResponse.json({ row }, { status: 201 });
  } catch (error) {
    return workbenchErrorResponse(error);
  }
}

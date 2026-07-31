import { NextResponse } from "next/server";
import { authorizeShop, requireUserApi } from "@/features/auth/session";
import { getListingDraftShopId, ListingWorkbenchError, updateListingDraft } from "@/features/products/listing-workbench-db";
import { jsonBody, workbenchErrorResponse } from "@/features/products/listing-workbench-api";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { admin, response } = await requireUserApi(request, "listings.write");
  if (response || !admin) return response;
  try {
    const { id } = await context.params;
    const draftId = Number(id);
    if (!Number.isFinite(draftId) || draftId <= 0) throw new ListingWorkbenchError("Invalid draft ID.");
    const shopId = await getListingDraftShopId(draftId, admin.organizationId);
    if (!(await authorizeShop(admin, shopId, "listings.write"))) return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    const body = await jsonBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ListingWorkbenchError("Invalid draft request.");
    const record = body as Record<string, unknown>;
    const expectedVersion = Number(record.expectedVersion);
    if (!Number.isFinite(expectedVersion) || expectedVersion <= 0) throw new ListingWorkbenchError("expectedVersion is required.");
    const row = await updateListingDraft({
      changes: record.changes,
      draftId,
      expectedVersion,
      organizationId: admin.organizationId,
    });
    return NextResponse.json({ row });
  } catch (error) {
    return workbenchErrorResponse(error);
  }
}

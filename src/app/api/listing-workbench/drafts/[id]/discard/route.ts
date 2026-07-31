import { NextResponse } from "next/server";
import { authorizeShop, requireUserApi } from "@/features/auth/session";
import { discardListingDraft, getListingDraftShopId, ListingWorkbenchError } from "@/features/products/listing-workbench-db";
import { workbenchErrorResponse } from "@/features/products/listing-workbench-api";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { admin, response } = await requireUserApi(request, "listings.write");
  if (response || !admin) return response;
  try {
    const { id } = await context.params;
    const draftId = Number(id);
    if (!Number.isFinite(draftId) || draftId <= 0) throw new ListingWorkbenchError("Invalid draft ID.");
    const shopId = await getListingDraftShopId(draftId, admin.organizationId);
    if (!(await authorizeShop(admin, shopId, "listings.write"))) return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    const result = await discardListingDraft({ draftId, organizationId: admin.organizationId });
    return NextResponse.json(result);
  } catch (error) {
    return workbenchErrorResponse(error);
  }
}

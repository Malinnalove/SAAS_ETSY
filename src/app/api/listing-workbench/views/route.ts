import { NextResponse } from "next/server";
import { authorizeShop, requireUserApi } from "@/features/auth/session";
import {
  ListingWorkbenchError,
  deleteListingView,
  listListingSavedViews,
  saveListingView,
} from "@/features/products/listing-workbench-db";
import { jsonBody, workbenchErrorResponse } from "@/features/products/listing-workbench-api";
import { listingSavedViewDefinitionSchema } from "@/features/products/listing-workbench-model";

export async function GET(request: Request) {
  const { admin, response } = await requireUserApi(request, "listings.read");
  if (response || !admin) return response;
  try {
    const shopId = Number(new URL(request.url).searchParams.get("shopId"));
    if (!Number.isFinite(shopId) || shopId <= 0) throw new ListingWorkbenchError("Valid shopId is required.");
    if (!(await authorizeShop(admin, shopId, "listings.read"))) return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    return NextResponse.json({ views: await listListingSavedViews({ organizationId: admin.organizationId, shopId }) });
  } catch (error) {
    return workbenchErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  const { admin, response } = await requireUserApi(request, "listings.write");
  if (response || !admin) return response;
  try {
    const url = new URL(request.url);
    const id = Number(url.searchParams.get("id"));
    const shopId = Number(url.searchParams.get("shopId"));
    if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(shopId) || shopId <= 0) {
      throw new ListingWorkbenchError("Valid view and shop IDs are required.");
    }
    if (!(await authorizeShop(admin, shopId, "listings.write"))) return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    await deleteListingView({ id, organizationId: admin.organizationId, shopId });
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return workbenchErrorResponse(error);
  }
}

export async function POST(request: Request) {
  const { admin, response } = await requireUserApi(request, "listings.write");
  if (response || !admin) return response;
  try {
    const body = await jsonBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ListingWorkbenchError("Invalid saved view request.");
    const record = body as Record<string, unknown>;
    const shopId = Number(record.shopId);
    if (!Number.isFinite(shopId) || shopId <= 0) throw new ListingWorkbenchError("Valid shopId is required.");
    if (!(await authorizeShop(admin, shopId, "listings.write"))) return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    const result = await saveListingView({
      definition: listingSavedViewDefinitionSchema.parse(record.definition),
      name: String(record.name ?? ""),
      organizationId: admin.organizationId,
      shopId,
      userId: admin.userId,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return workbenchErrorResponse(error);
  }
}

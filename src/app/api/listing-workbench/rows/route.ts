import { NextResponse } from "next/server";
import { authorizeShop, requireUserApi } from "@/features/auth/session";
import { listListingWorkspaceRows } from "@/features/products/listing-workbench-db";
import { workbenchErrorResponse } from "@/features/products/listing-workbench-api";

export async function GET(request: Request) {
  const { admin, response } = await requireUserApi(request, "listings.read");
  if (response || !admin) return response;
  try {
    const url = new URL(request.url);
    const shopId = Number(url.searchParams.get("shopId"));
    if (!Number.isFinite(shopId) || shopId <= 0) {
      return NextResponse.json({ error: "Valid shopId is required." }, { status: 400 });
    }
    if (!(await authorizeShop(admin, shopId, "listings.read"))) return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    const page = await listListingWorkspaceRows({
      cursor: url.searchParams.get("cursor"),
      limit: Number(url.searchParams.get("limit")) || 100,
      organizationId: admin.organizationId,
      search: url.searchParams.get("search"),
      shopId,
      sort: url.searchParams.get("sort"),
      state: url.searchParams.get("state"),
      view: url.searchParams.get("view"),
    });
    return NextResponse.json(page);
  } catch (error) {
    return workbenchErrorResponse(error);
  }
}

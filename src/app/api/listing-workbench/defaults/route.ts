import { NextResponse } from "next/server";
import { authorizeShop, requireUserApi } from "@/features/auth/session";
import {
  getListingShopDefaults,
  ListingWorkbenchError,
  saveListingShopDefaults,
} from "@/features/products/listing-workbench-db";
import { jsonBody, workbenchErrorResponse } from "@/features/products/listing-workbench-api";

export async function GET(request: Request) {
  const { admin, response } = await requireUserApi(request, "listings.read");
  if (response || !admin) return response;
  try {
    const shopId = Number(new URL(request.url).searchParams.get("shopId"));
    if (!Number.isFinite(shopId) || shopId <= 0) throw new ListingWorkbenchError("Valid shopId is required.");
    if (!(await authorizeShop(admin, shopId, "listings.read"))) return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    return NextResponse.json(await getListingShopDefaults({ organizationId: admin.organizationId, shopId }));
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
      throw new ListingWorkbenchError("Invalid shop defaults request.");
    }
    const record = body as Record<string, unknown>;
    const shopId = Number(record.shopId);
    const expectedVersion = Number(record.expectedVersion);
    if (!Number.isFinite(shopId) || shopId <= 0 || !Number.isInteger(expectedVersion) || expectedVersion < 0) {
      throw new ListingWorkbenchError("Valid shopId and expectedVersion are required.");
    }
    if (!(await authorizeShop(admin, shopId, "listings.write"))) return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    const defaults = await saveListingShopDefaults({
      expectedVersion,
      organizationId: admin.organizationId,
      shopId,
      userId: admin.userId,
      values: record.values,
    });
    return NextResponse.json(defaults);
  } catch (error) {
    return workbenchErrorResponse(error);
  }
}

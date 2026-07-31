import { NextResponse } from "next/server";
import { authorizeShop, requireUserApi } from "@/features/auth/session";
import { ListingWorkbenchError } from "@/features/products/listing-workbench-db";
import {
  getListingUploadWorkspace,
  updateListingUploadCell,
} from "@/features/products/listing-upload-db";
import { jsonBody, workbenchErrorResponse } from "@/features/products/listing-workbench-api";
import type { ListingUploadField } from "@/shared/types/listing-workbench";

export async function GET(request: Request) {
  const { admin, response } = await requireUserApi(request, "listings.read");
  if (response || !admin) return response;
  try {
    const shopId = Number(new URL(request.url).searchParams.get("shopId"));
    if (!Number.isSafeInteger(shopId) || shopId <= 0) throw new ListingWorkbenchError("Valid shopId is required.");
    if (!(await authorizeShop(admin, shopId, "listings.read"))) return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    return NextResponse.json(await getListingUploadWorkspace({ organizationId: admin.organizationId, shopId }));
  } catch (error) {
    return workbenchErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  const { admin, response } = await requireUserApi(request, "listings.write");
  if (response || !admin) return response;
  try {
    const body = await jsonBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ListingWorkbenchError("Invalid upload row request.");
    const record = body as Record<string, unknown>;
    const shopId = Number(record.shopId);
    if (!Number.isSafeInteger(shopId) || shopId <= 0) throw new ListingWorkbenchError("Valid shopId is required.");
    if (!(await authorizeShop(admin, shopId, "listings.write"))) return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    const row = await updateListingUploadCell({
      expectedVersion: Number(record.expectedVersion),
      field: String(record.field) as ListingUploadField,
      organizationId: admin.organizationId,
      rowId: Number(record.rowId),
      shopId,
      value: String(record.value ?? ""),
    });
    return NextResponse.json({ row });
  } catch (error) {
    return workbenchErrorResponse(error);
  }
}

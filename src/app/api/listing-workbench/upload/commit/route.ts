import { NextResponse } from "next/server";
import { authorizeShop, requireUserApi } from "@/features/auth/session";
import { ListingWorkbenchError } from "@/features/products/listing-workbench-db";
import {
  commitListingUploadRows,
  ListingUploadValidationError,
} from "@/features/products/listing-upload-db";
import { jsonBody, workbenchErrorResponse } from "@/features/products/listing-workbench-api";

export async function POST(request: Request) {
  const { admin, response } = await requireUserApi(request, "listings.write");
  if (response || !admin) return response;
  try {
    const body = await jsonBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ListingWorkbenchError("Invalid convert request.");
    const record = body as Record<string, unknown>;
    const shopId = Number(record.shopId);
    if (!Number.isSafeInteger(shopId) || shopId <= 0) throw new ListingWorkbenchError("Valid shopId is required.");
    if (!(await authorizeShop(admin, shopId, "listings.write"))) return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    const result = await commitListingUploadRows({
      organizationId: admin.organizationId,
      requestKey: String(record.requestKey ?? ""),
      rowIds: Array.isArray(record.rowIds) ? record.rowIds.map(Number) : [],
      shopId,
      userId: admin.userId,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof ListingUploadValidationError) {
      return NextResponse.json({ error: error.message, rowErrors: error.rowErrors }, { status: error.status });
    }
    return workbenchErrorResponse(error);
  }
}

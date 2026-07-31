import { NextResponse } from "next/server";
import { authorizeShop, requireUserApi } from "@/features/auth/session";
import { ListingWorkbenchError } from "@/features/products/listing-workbench-db";
import { pasteListingUploadCells } from "@/features/products/listing-upload-db";
import { jsonBody, workbenchErrorResponse } from "@/features/products/listing-workbench-api";

export async function POST(request: Request) {
  const { admin, response } = await requireUserApi(request, "listings.write");
  if (response || !admin) return response;
  try {
    const body = await jsonBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ListingWorkbenchError("Invalid paste request.");
    const record = body as Record<string, unknown>;
    const shopId = Number(record.shopId);
    if (!Number.isSafeInteger(shopId) || shopId <= 0) throw new ListingWorkbenchError("Valid shopId is required.");
    if (!(await authorizeShop(admin, shopId, "listings.write"))) return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    const rows = await pasteListingUploadCells({
      fields: record.fields,
      matrix: record.matrix,
      organizationId: admin.organizationId,
      shopId,
      startField: String(record.startField ?? ""),
      startRowId: Number(record.startRowId),
    });
    return NextResponse.json({ rows });
  } catch (error) {
    return workbenchErrorResponse(error);
  }
}

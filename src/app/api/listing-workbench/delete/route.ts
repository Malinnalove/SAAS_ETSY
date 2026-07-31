import { after, NextResponse } from "next/server";
import { authorizeShop, requireUserApi } from "@/features/auth/session";
import {
  listListingDeleteAttempts,
  queueListingDeletes,
} from "@/features/products/listing-delete-db";
import { ListingWorkbenchError } from "@/features/products/listing-workbench-db";
import { jsonBody, workbenchErrorResponse } from "@/features/products/listing-workbench-api";
import { processSyncJobById } from "@/features/sync/processor";

export async function GET(request: Request) {
  const { admin, response } = await requireUserApi(request, "listings.read");
  if (response || !admin) return response;
  try {
    const attemptIds = new URL(request.url).searchParams.get("attemptIds")?.split(",").map(Number)
      .filter((value) => Number.isSafeInteger(value) && value > 0).slice(0, 100) ?? [];
    const attempts = await listListingDeleteAttempts({ attemptIds, organizationId: admin.organizationId });
    for (const attempt of attempts) {
      if (!(await authorizeShop(admin, attempt.shopId, "listings.read"))) {
        return NextResponse.json({ error: "Forbidden." }, { status: 403 });
      }
    }
    return NextResponse.json({ attempts });
  } catch (error) {
    return workbenchErrorResponse(error);
  }
}

export async function POST(request: Request) {
  const { admin, response } = await requireUserApi(request, "listings.write");
  if (response || !admin) return response;
  try {
    const body = await jsonBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ListingWorkbenchError("Invalid delete request.");
    const record = body as Record<string, unknown>;
    const shopId = Number(record.shopId);
    const mode = record.mode === "all" ? "all" : record.mode === "changed" ? "changed" : null;
    if (!Number.isSafeInteger(shopId) || shopId <= 0 || !mode) throw new ListingWorkbenchError("Valid shopId and delete mode are required.");
    if (mode === "all" && record.confirmation !== "DELETE") throw new ListingWorkbenchError("Type DELETE to confirm remote deletion.");
    if (!(await authorizeShop(admin, shopId, "listings.write"))) return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    if (!Array.isArray(record.items) || !record.items.length || record.items.length > 100) {
      throw new ListingWorkbenchError("Select between 1 and 100 Listings.");
    }
    const items = record.items.map((item) => {
      const value = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
      const draftId = value.draftId === null || value.draftId === undefined ? null : Number(value.draftId);
      const listingId = value.listingId === null || value.listingId === undefined ? null : Number(value.listingId);
      return {
        draftId: Number.isSafeInteger(draftId) && Number(draftId) > 0 ? draftId : null,
        listingId: Number.isSafeInteger(listingId) && Number(listingId) > 0 ? listingId : null,
      };
    });
    const results = await queueListingDeletes({
      items,
      mode,
      organizationId: admin.organizationId,
      shopId,
      userId: admin.userId,
    });
    const jobIds = results.flatMap((result) => result.status === "queued" && result.jobId ? [result.jobId] : []);
    if (jobIds.length) {
      after(async () => {
        for (const jobId of jobIds) await processSyncJobById(jobId);
      });
    }
    return NextResponse.json({ results }, { status: jobIds.length ? 202 : 200 });
  } catch (error) {
    return workbenchErrorResponse(error);
  }
}

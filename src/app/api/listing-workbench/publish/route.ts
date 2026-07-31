import { after, NextResponse } from "next/server";
import { authorizeShop, requireUserApi } from "@/features/auth/session";
import { processSyncJobById } from "@/features/sync/processor";
import {
  ListingWorkbenchError,
  listListingPublishAttempts,
  queueListingPublishAttempts,
} from "@/features/products/listing-workbench-db";
import { jsonBody, workbenchErrorResponse } from "@/features/products/listing-workbench-api";

export async function GET(request: Request) {
  const { admin, response } = await requireUserApi(request, "listings.read");
  if (response || !admin) return response;
  try {
    const ids = new URL(request.url).searchParams.get("attemptIds")?.split(",").map(Number)
      .filter((value) => Number.isFinite(value) && value > 0).slice(0, 100) ?? [];
    const attempts = await listListingPublishAttempts({ attemptIds: ids, organizationId: admin.organizationId });
    for (const attempt of attempts) {
      if (!(await authorizeShop(admin, attempt.shopId, "listings.read"))) {
        return NextResponse.json({ error: "Forbidden." }, { status: 403 });
      }
    }
    return NextResponse.json({ attempts: attempts.map((attempt) => ({
      attemptId: attempt.attemptId,
      draftId: attempt.draftId,
      error: attempt.error,
      jobId: attempt.jobId,
      status: attempt.status,
    })) });
  } catch (error) {
    return workbenchErrorResponse(error);
  }
}

export async function POST(request: Request) {
  const { admin, response } = await requireUserApi(request, "listings.write");
  if (response || !admin) return response;
  try {
    const body = await jsonBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ListingWorkbenchError("Invalid publish request.");
    const record = body as Record<string, unknown>;
    const shopId = Number(record.shopId);
    if (!Number.isFinite(shopId) || shopId <= 0) throw new ListingWorkbenchError("Valid shopId is required.");
    if (record.confirmation !== "CONFIRM") throw new ListingWorkbenchError("Confirm before changing Etsy Listings.");
    if (!(await authorizeShop(admin, shopId, "listings.write"))) return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    if (!Array.isArray(record.items) || record.items.length === 0) throw new ListingWorkbenchError("Select at least one draft.");
    if (record.items.length > 100) throw new ListingWorkbenchError("Publish at most 100 drafts at a time.");
    const items = record.items.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new ListingWorkbenchError("Invalid publish item.");
      return { draftId: Number((item as Record<string, unknown>).draftId), version: Number((item as Record<string, unknown>).version) };
    });
    if (items.some((item) => !Number.isFinite(item.draftId) || item.draftId <= 0 || !Number.isFinite(item.version) || item.version <= 0)) {
      throw new ListingWorkbenchError("Invalid publish item.");
    }
    const attempts = await queueListingPublishAttempts({
      items,
      organizationId: admin.organizationId,
      shopId,
      userId: admin.userId,
    });
    const jobIds = attempts.flatMap((attempt) => attempt.status === "queued" && attempt.jobId ? [attempt.jobId] : []);
    if (jobIds.length) {
      after(async () => {
        for (const jobId of jobIds) {
          await processSyncJobById(jobId);
        }
      });
    }
    return NextResponse.json({ attempts }, { status: 202 });
  } catch (error) {
    return workbenchErrorResponse(error);
  }
}

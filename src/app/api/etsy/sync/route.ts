import { NextResponse } from "next/server";
import { readStore, selectShop } from "@/lib/store";
import { getSyncStatus } from "@/lib/sync-db";
import { enqueueManualSyncJobs, processSyncJobById, processSyncJobs } from "@/lib/sync-processor";

function flagEnabled(value: FormDataEntryValue | string | null) {
  if (typeof value !== "string") return false;
  return ["1", "true", "yes", "full"].includes(value.toLowerCase());
}

async function getManualSyncRequest(request: Request) {
  const url = new URL(request.url);
  const shopIdFromUrl = Number(url.searchParams.get("shopId"));
  const urlMode = url.searchParams.get("mode");
  let shopId = Number.isFinite(shopIdFromUrl) && shopIdFromUrl > 0 ? shopIdFromUrl : null;
  let forceFull =
    flagEnabled(url.searchParams.get("forceFull")) ||
    flagEnabled(url.searchParams.get("full")) ||
    urlMode?.toLowerCase() === "full";

  const contentType = request.headers.get("content-type") ?? "";
  if (request.method === "POST" && contentType.includes("application/x-www-form-urlencoded")) {
    const formData = await request.formData();
    const shopIdFromForm = Number(formData.get("shopId"));

    if (Number.isFinite(shopIdFromForm) && shopIdFromForm > 0) {
      shopId = shopIdFromForm;
    }

    forceFull =
      forceFull ||
      flagEnabled(formData.get("forceFull")) ||
      flagEnabled(formData.get("full")) ||
      String(formData.get("mode") ?? "").toLowerCase() === "full";
  }

  return {
    shopId,
    forceFull,
  };
}

export async function POST(request: Request) {
  const store = await readStore();
  const syncRequest = await getManualSyncRequest(request);
  const selectedShop = selectShop(store, syncRequest.shopId);

  if (!selectedShop) {
    return NextResponse.json({ error: "Connect an Etsy shop first." }, { status: 400 });
  }

  const shopId = selectedShop.connection.shopId;
  const jobs = await enqueueManualSyncJobs(shopId, { forceFull: syncRequest.forceFull });
  const jobId = jobs.find((job) => job.jobId)?.jobId ?? null;
  const processed = [];

  for (const job of jobs) {
    if (!job.jobId) continue;
    processed.push({
      jobId: job.jobId,
      jobType: job.jobType,
      ...(await processSyncJobById(job.jobId)),
    });
  }
  const followUp = await processSyncJobs(8);

  const accept = request.headers.get("accept") ?? "";
  if (accept.includes("application/json")) {
    return NextResponse.json({
      ok: true,
      jobId,
      jobs,
      processed,
      followUp,
      status: await getSyncStatus(),
      shopId,
    });
  }

  const referer = request.headers.get("referer");
  return NextResponse.redirect(referer ?? new URL(`/dashboard?shopId=${shopId}`, request.url), 303);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  return POST(
    new Request(`http://localhost/api/etsy/sync${url.search}`, {
      method: "POST",
      headers: { accept: "application/json" },
    }),
  );
}

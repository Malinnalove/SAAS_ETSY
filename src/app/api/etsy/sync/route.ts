import { NextResponse } from "next/server";
import { authorizeShop, requireUserApi } from "@/features/auth/session";
import { readOrganizationStore, selectShop } from "@/lib/store";
import type { AuthContext } from "@/features/auth/types";
import { getSyncStatus, rescheduleSyncJobNow } from "@/features/sync/db";
import { enqueueManualSyncJobs, processSyncJobById } from "@/features/sync/processor";

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

function syncMessage(
  lang: string | null,
  input: {
    failedErrors: string[];
    processedCount: number;
    queuedCount: number;
  },
) {
  const isEn = lang === "en";

  if (input.failedErrors.length > 0) {
    const firstError = input.failedErrors[0].slice(0, 360);
    return {
      detail: isEn ? `Sync failed: ${firstError}` : `同步失败：${firstError}`,
      status: "sync_failed",
    };
  }

  if (input.processedCount > 0) {
    return {
      detail: isEn
        ? `Processed ${input.processedCount} sync job${input.processedCount === 1 ? "" : "s"}.`
        : `已处理 ${input.processedCount} 个同步任务。`,
      status: "sync_completed",
    };
  }

  if (input.queuedCount > 0) {
    return {
      detail: isEn
        ? `${input.queuedCount} sync job${input.queuedCount === 1 ? " is" : "s are"} still queued.`
        : `还有 ${input.queuedCount} 个同步任务在队列中。`,
      status: "sync_queued",
    };
  }

  return {
    detail: isEn ? "No sync job needed right now." : "当前没有需要执行的同步任务。",
    status: "sync_idle",
  };
}

function redirectWithSyncNotice(
  request: Request,
  shopId: number,
  status: string,
  detail: string,
) {
  const referer = request.headers.get("referer");
  const redirectUrl = new URL(referer ?? `/settings?shopId=${shopId}`, request.url);

  redirectUrl.searchParams.set("shopId", String(shopId));
  redirectUrl.searchParams.set("settingsStatus", status);
  redirectUrl.searchParams.set("settingsDetail", detail);

  return NextResponse.redirect(redirectUrl, 303);
}

async function handleManualSync(request: Request, user: AuthContext) {
  const store = await readOrganizationStore(user.organizationId);
  const syncRequest = await getManualSyncRequest(request);
  const selectedShop = syncRequest.shopId
    ? store.shops.find((shop) => shop.connection.shopId === syncRequest.shopId) ?? null
    : selectShop(store, null);

  if (!selectedShop) {
    return NextResponse.json({ error: "Connect an Etsy shop first." }, { status: 400 });
  }

  const shopId = selectedShop.connection.shopId;
  if (!(await authorizeShop(user, shopId, "sync.run"))) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }
  const jobs = await enqueueManualSyncJobs(shopId, { forceFull: syncRequest.forceFull });
  const jobId = jobs.find((job) => job.jobId)?.jobId ?? null;
  const processed = [];

  for (const job of jobs) {
    if (!job.jobId) continue;
    await rescheduleSyncJobNow(job.jobId);
    processed.push({
      jobId: job.jobId,
      jobType: job.jobType,
      ...(await processSyncJobById(job.jobId)),
    });
  }
  const accept = request.headers.get("accept") ?? "";
  const status = await getSyncStatus(undefined, [shopId]);
  if (accept.includes("application/json")) {
    return NextResponse.json({
      ok: true,
      jobId,
      jobs,
      processed,
      status,
      shopId,
    });
  }

  const failedErrors = processed
    .flatMap((item) => item.results)
    .filter((item) => item.status === "failed" && item.error)
    .map((item) => item.error as string);
  const processedCount = processed.reduce((total, item) => total + item.processed, 0);
  const notice = syncMessage(new URL(request.url).searchParams.get("lang"), {
    failedErrors,
    processedCount,
    queuedCount: status.jobs.queued ?? 0,
  });

  return redirectWithSyncNotice(request, shopId, notice.status, notice.detail);
}

export async function GET() {
  return NextResponse.json({ error: "Use POST for manual sync." }, { status: 405, headers: { Allow: "POST" } });
}

export async function POST(request: Request) {
  const guard = await requireUserApi(request, "sync.run");
  if (guard.response) {
    return guard.response;
  }

  return handleManualSync(request, guard.user!);
}

import { NextRequest, NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { getSyncStatus } from "@/features/sync/db";
import { enqueueScheduledSyncJobs, processSyncJobs } from "@/features/sync/processor";
import { safeEqual } from "@/features/auth/security";

export const runtime = "nodejs";

function isAuthorized(request: NextRequest) {
  const secret = getEnv().SYNC_CRON_SECRET;

  if (!secret) return false;

  const authorization = request.headers.get("authorization");
  const headerSecret = request.headers.get("x-sync-secret");
  return safeEqual(authorization, `Bearer ${secret}`) || safeEqual(headerSecret, secret);
}

async function handleCron(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const limit = Number(request.nextUrl.searchParams.get("limit") ?? 8);
  const enqueued = await enqueueScheduledSyncJobs();
  const processed = await processSyncJobs(Number.isFinite(limit) && limit > 0 ? limit : 8);
  const status = await getSyncStatus();

  return NextResponse.json({
    ok: true,
    enqueued,
    processed,
    status,
  });
}

export async function GET() {
  return NextResponse.json({ error: "Use POST for scheduled sync." }, { status: 405, headers: { Allow: "POST" } });
}

export async function POST(request: NextRequest) {
  return handleCron(request);
}

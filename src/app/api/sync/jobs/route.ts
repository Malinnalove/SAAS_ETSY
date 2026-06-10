import { NextRequest, NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { getSyncStatus } from "@/lib/sync-db";
import { processSyncJobs } from "@/lib/sync-processor";

export const runtime = "nodejs";

function isAuthorized(request: NextRequest) {
  const secret = getEnv().SYNC_CRON_SECRET;

  if (!secret) {
    return true;
  }

  const authorization = request.headers.get("authorization");
  const headerSecret = request.headers.get("x-sync-secret");
  const querySecret = request.nextUrl.searchParams.get("secret");

  return (
    authorization === `Bearer ${secret}` ||
    headerSecret === secret ||
    querySecret === secret
  );
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  return NextResponse.json({
    ok: true,
    status: await getSyncStatus(),
  });
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const limit = Number(request.nextUrl.searchParams.get("limit") ?? 8);
  const processed = await processSyncJobs(Number.isFinite(limit) && limit > 0 ? limit : 8);

  return NextResponse.json({
    ok: true,
    processed,
    status: await getSyncStatus(),
  });
}

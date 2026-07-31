import { NextResponse } from "next/server";
import { requireUserApi } from "@/features/auth/session";

/**
 * Kept as an explicit compatibility boundary. Direct paste-to-draft creation was
 * retired; callers must use the database-backed upload workspace and commit step.
 */
export async function POST(request: Request) {
  const { admin, response } = await requireUserApi(request, "listings.write");
  if (response || !admin) return response;
  return NextResponse.json(
    { error: "Direct bulk draft creation is no longer available. Use Batch Upload, then convert selected rows to drafts." },
    { status: 410 },
  );
}

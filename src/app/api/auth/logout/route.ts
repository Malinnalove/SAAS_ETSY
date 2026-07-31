import { NextResponse } from "next/server";
import { clearCurrentSession, requireUserApi } from "@/features/auth/session";

export async function POST(request: Request) {
  const guard = await requireUserApi(request);
  if (guard.response) return guard.response;
  await clearCurrentSession();
  if ((request.headers.get("accept") ?? "").includes("application/json")) {
    return NextResponse.json({ ok: true });
  }
  return NextResponse.redirect(new URL("/login", request.url), 303);
}

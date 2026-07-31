import { NextResponse } from "next/server";
import { authorizeShop, requireUserApi } from "@/features/auth/session";
import { deactivateShop } from "@/features/sync/db";

export async function POST(request: Request) {
  const guard = await requireUserApi(request, "shops.manage");
  if (guard.response) {
    return guard.response;
  }

  const url = new URL(request.url);
  const shopId = Number(url.searchParams.get("shopId"));

  if (Number.isFinite(shopId) && shopId > 0) {
    if (!guard.user || !(await authorizeShop(guard.user, shopId, "shops.manage"))) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    await deactivateShop(shopId);
  } else {
    return NextResponse.json({ error: "Valid shopId is required." }, { status: 400 });
  }

  const accept = request.headers.get("accept") ?? "";
  if (accept.includes("application/json")) {
    return NextResponse.json({ ok: true });
  }

  const referer = request.headers.get("referer");
  return NextResponse.redirect(referer ?? new URL("/settings", request.url), 303);
}

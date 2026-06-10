import { NextResponse } from "next/server";
import { removeShop, updateStore, writeStore } from "@/lib/store";

export async function POST(request: Request) {
  const url = new URL(request.url);
  const shopId = Number(url.searchParams.get("shopId"));

  if (Number.isFinite(shopId) && shopId > 0) {
    await updateStore((store) => removeShop(store, shopId));
  } else {
    await writeStore({
      connection: null,
      shop: null,
      listings: [],
      receipts: [],
      orderDetails: [],
      ads: [],
      adsSyncNote: null,
      lastSyncAt: null,
      activeShopId: null,
      shops: [],
    });
  }

  const accept = request.headers.get("accept") ?? "";
  if (accept.includes("application/json")) {
    return NextResponse.json({ ok: true });
  }

  const referer = request.headers.get("referer");
  return NextResponse.redirect(referer ?? new URL("/settings", request.url), 303);
}

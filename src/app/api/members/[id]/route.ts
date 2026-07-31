import { NextResponse } from "next/server";
import { updateMember } from "@/features/auth/db";
import { readAuthJson } from "@/features/auth/security";
import { isRecentlyAuthenticated, requireUserApi } from "@/features/auth/session";
import { parseMemberShopAccess } from "@/features/auth/types";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await requireUserApi(request, "members.manage");
  if (guard.response) return guard.response;
  if (!isRecentlyAuthenticated(guard.user!)) return NextResponse.json({ error: "Recent authentication required." }, { status: 403 });
  const { id } = await context.params;
  const body = await readAuthJson(request);
  const role = String(body?.role ?? "");
  const status = String(body?.status ?? "");
  if ((role !== "operator" && role !== "viewer") || (status !== "active" && status !== "disabled")) {
    return NextResponse.json({ error: "Invalid role or status." }, { status: 400 });
  }
  try {
    await updateMember({
      actorUserId: guard.user!.userId,
      organizationId: guard.user!.organizationId,
      role,
      shopAccess: parseMemberShopAccess(body?.shopAccess),
      status,
      userId: Number(id),
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to update member." }, { status: 400 });
  }
}

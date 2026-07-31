import { NextResponse } from "next/server";
import { createMember, listMembers } from "@/features/auth/db";
import { readAuthJson } from "@/features/auth/security";
import { isRecentlyAuthenticated, requireUserApi } from "@/features/auth/session";
import { parseMemberShopAccess } from "@/features/auth/types";

export async function GET(request: Request) {
  const guard = await requireUserApi(request, "members.manage");
  if (guard.response) return guard.response;
  if (!isRecentlyAuthenticated(guard.user!)) return NextResponse.json({ error: "Recent authentication required." }, { status: 403 });
  return NextResponse.json({ members: await listMembers(guard.user!.organizationId) });
}

export async function POST(request: Request) {
  const guard = await requireUserApi(request, "members.manage");
  if (guard.response) return guard.response;
  if (!isRecentlyAuthenticated(guard.user!)) return NextResponse.json({ error: "Recent authentication required." }, { status: 403 });
  const body = await readAuthJson(request);
  const role = String(body?.role ?? "");
  if (role !== "operator" && role !== "viewer") {
    return NextResponse.json({ error: "Role must be operator or viewer." }, { status: 400 });
  }
  try {
    const result = await createMember({
      actorUserId: guard.user!.userId,
      displayName: String(body?.displayName ?? ""),
      organizationId: guard.user!.organizationId,
      password: typeof body?.password === "string" && body.password ? body.password : undefined,
      role,
      shopAccess: parseMemberShopAccess(body?.shopAccess),
      username: String(body?.username ?? ""),
    });
    return NextResponse.json({ ...(result.password ? { temporaryPassword: result.password } : {}), userId: result.userId }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to create member." }, { status: 400 });
  }
}

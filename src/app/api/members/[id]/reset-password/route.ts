import { NextResponse } from "next/server";
import { resetMemberPassword, setMemberPassword } from "@/features/auth/db";
import { readAuthJson } from "@/features/auth/security";
import { isRecentlyAuthenticated, requireUserApi } from "@/features/auth/session";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await requireUserApi(request, "members.manage");
  if (guard.response) return guard.response;
  if (!isRecentlyAuthenticated(guard.user!)) return NextResponse.json({ error: "Recent authentication required." }, { status: 403 });
  const { id } = await context.params;
  try {
    const body = await readAuthJson(request);
    const password = typeof body?.password === "string" ? body.password : "";
    if (password) {
      await setMemberPassword({
        actorUserId: guard.user!.userId,
        organizationId: guard.user!.organizationId,
        password,
        userId: Number(id),
      });
      return NextResponse.json({ passwordSet: true });
    }
    const temporaryPassword = await resetMemberPassword({
      actorUserId: guard.user!.userId,
      organizationId: guard.user!.organizationId,
      userId: Number(id),
    });
    return NextResponse.json({ temporaryPassword });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to reset password." }, { status: 400 });
  }
}

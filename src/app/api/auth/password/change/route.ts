import { NextResponse } from "next/server";
import { changePassword } from "@/features/auth/db";
import { readAuthJson } from "@/features/auth/security";
import { requireUserApi, rotateUserSession } from "@/features/auth/session";

export async function POST(request: Request) {
  const guard = await requireUserApi(request);
  if (guard.response) return guard.response;
  const body = await readAuthJson(request);
  try {
    await changePassword({
      currentPassword: String(body?.currentPassword ?? ""),
      newPassword: String(body?.newPassword ?? ""),
      sessionId: guard.user!.sessionId,
      userId: guard.user!.userId,
      username: guard.user!.username,
    });
    await rotateUserSession(guard.user!, request);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to change password." }, { status: 400 });
  }
}

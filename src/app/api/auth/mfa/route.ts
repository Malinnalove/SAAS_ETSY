import { NextResponse } from "next/server";
import { disableMfa } from "@/features/auth/mfa";
import { readAuthJson } from "@/features/auth/security";
import { requireUserApi } from "@/features/auth/session";

export async function DELETE(request: Request) {
  const guard = await requireUserApi(request, "system.manage");
  if (guard.response) return guard.response;
  const body = await readAuthJson(request);
  try {
    await disableMfa(guard.user!, String(body?.password ?? ""), String(body?.token ?? ""));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to disable MFA." }, { status: 400 });
  }
}

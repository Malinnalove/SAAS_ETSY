import { NextResponse } from "next/server";
import { beginMfaSetup, verifyCurrentPassword } from "@/features/auth/mfa";
import { readAuthJson } from "@/features/auth/security";
import { requireUserApi } from "@/features/auth/session";

export async function POST(request: Request) {
  const guard = await requireUserApi(request, "system.manage");
  if (guard.response) return guard.response;
  const body = await readAuthJson(request);
  if (!(await verifyCurrentPassword(guard.user!.userId, String(body?.password ?? "")))) {
    return NextResponse.json({ error: "Current password is incorrect." }, { status: 400 });
  }
  return NextResponse.json(await beginMfaSetup(guard.user!));
}

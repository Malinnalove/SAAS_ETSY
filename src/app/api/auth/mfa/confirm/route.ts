import { NextResponse } from "next/server";
import { confirmMfaSetup } from "@/features/auth/mfa";
import { readAuthJson } from "@/features/auth/security";
import { requireUserApi } from "@/features/auth/session";

export async function POST(request: Request) {
  const guard = await requireUserApi(request, "system.manage");
  if (guard.response) return guard.response;
  const body = await readAuthJson(request);
  try {
    return NextResponse.json({ recoveryCodes: await confirmMfaSetup(guard.user!, String(body?.token ?? "")) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to enable MFA." }, { status: 400 });
  }
}

import { NextResponse } from "next/server";
import { regenerateRecoveryCodes } from "@/features/auth/mfa";
import { readAuthJson } from "@/features/auth/security";
import { requireUserApi } from "@/features/auth/session";

export async function POST(request: Request) {
  const guard = await requireUserApi(request, "system.manage");
  if (guard.response) return guard.response;
  const body = await readAuthJson(request);
  try {
    const recoveryCodes = await regenerateRecoveryCodes(
      guard.user!,
      String(body?.password ?? ""),
      String(body?.token ?? ""),
    );
    return NextResponse.json({ recoveryCodes });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to regenerate recovery codes." }, { status: 400 });
  }
}

import { NextResponse } from "next/server";
import { clearAllUserSessions, requireUserApi } from "@/features/auth/session";

export async function POST(request: Request) {
  const guard = await requireUserApi(request);
  if (guard.response) return guard.response;
  await clearAllUserSessions(guard.user!);
  return NextResponse.json({ ok: true });
}

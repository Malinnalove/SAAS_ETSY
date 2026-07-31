"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { assertServerActionCsrf } from "@/features/auth/server-action-security";
import { beginMfaSetup, confirmMfaSetup, disableMfa, regenerateRecoveryCodes, verifyCurrentPassword } from "@/features/auth/mfa";
import { requirePermission } from "@/features/auth/session";

export type MfaActionState = { error?: string; message?: string; recoveryCodes?: string[] };

export async function startMfaSetupAction(formData: FormData) {
  const admin = await requirePermission("system.manage", "/settings/security");
  await assertServerActionCsrf(admin, formData);
  if (admin.role !== "admin" || !(await verifyCurrentPassword(admin.userId, String(formData.get("password") ?? "")))) {
    redirect("/settings/security?mfaError=password");
  }
  await beginMfaSetup(admin);
  redirect("/settings/security/mfa/setup");
}

export async function confirmMfaSetupAction(
  _state: MfaActionState,
  formData: FormData,
): Promise<MfaActionState> {
  try {
    const admin = await requirePermission("system.manage", "/settings/security/mfa/setup");
    await assertServerActionCsrf(admin, formData);
    const recoveryCodes = await confirmMfaSetup(admin, String(formData.get("token") ?? "").trim());
    revalidatePath("/settings/security");
    return { message: "两步验证已启用。请立即保存恢复码。", recoveryCodes };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "启用失败。" };
  }
}

export async function disableMfaAction(
  _state: MfaActionState,
  formData: FormData,
): Promise<MfaActionState> {
  try {
    const admin = await requirePermission("system.manage", "/settings/security");
    await assertServerActionCsrf(admin, formData);
    await disableMfa(admin, String(formData.get("password") ?? ""), String(formData.get("token") ?? ""));
    revalidatePath("/settings/security");
    return { message: "两步验证已关闭。" };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "关闭失败。" };
  }
}

export async function regenerateRecoveryCodesAction(
  _state: MfaActionState,
  formData: FormData,
): Promise<MfaActionState> {
  try {
    const admin = await requirePermission("system.manage", "/settings/security");
    await assertServerActionCsrf(admin, formData);
    const recoveryCodes = await regenerateRecoveryCodes(
      admin,
      String(formData.get("password") ?? ""),
      String(formData.get("token") ?? ""),
    );
    return { message: "新的恢复码已生成，旧恢复码已经失效。", recoveryCodes };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "生成失败。" };
  }
}

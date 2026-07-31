"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { changePassword, markSessionReauthenticated, updateEnterpriseProfile } from "@/features/auth/db";
import { verifyCurrentPassword, verifyMfaForStepUp } from "@/features/auth/mfa";
import { assertServerActionCsrf } from "@/features/auth/server-action-security";
import {
  clearAllUserSessions,
  requirePermission,
  requireUser,
  rotateUserSession,
  safeReturnPath,
} from "@/features/auth/session";

function stringField(formData: FormData, name: string) {
  return String(formData.get(name) ?? "").trim();
}

function settingsRedirect(formData: FormData, status: "failed" | "updated", detail: string): never {
  const params = new URLSearchParams({ settingsDetail: detail.slice(0, 240), settingsStatus: status });
  const lang = stringField(formData, "lang");
  const shopId = stringField(formData, "shopId");
  if (lang) params.set("lang", lang);
  if (shopId) params.set("shopId", shopId);
  const returnTo = stringField(formData, "returnTo");
  const pathname = returnTo === "/settings/security" ? returnTo : "/settings";
  redirect(`${pathname}?${params.toString()}`);
}

export async function updateEnterpriseProfileAction(formData: FormData) {
  const user = await requirePermission("system.manage", "/settings");
  await assertServerActionCsrf(user, formData);
  try {
    await updateEnterpriseProfile({
      displayName: stringField(formData, "displayName"),
      organizationId: user.organizationId,
      organizationName: stringField(formData, "organizationName"),
      userId: user.userId,
      username: stringField(formData, "username"),
    });
    revalidatePath("/settings");
  } catch (error) {
    settingsRedirect(formData, "failed", error instanceof Error ? error.message : "企业信息保存失败。");
  }
  settingsRedirect(formData, "updated", "企业与管理员信息已保存。");
}

export async function changeAdminPasswordAction(formData: FormData) {
  const user = await requireUser("/settings");
  await assertServerActionCsrf(user, formData);
  const newPassword = String(formData.get("newPassword") ?? "");
  if (newPassword !== String(formData.get("confirmPassword") ?? "")) {
    settingsRedirect(formData, "failed", "两次输入的新密码不一致。");
  }
  try {
    await changePassword({
      currentPassword: String(formData.get("currentPassword") ?? ""),
      newPassword,
      sessionId: user.sessionId,
      userId: user.userId,
      username: user.username,
    });
    await rotateUserSession(user);
  } catch (error) {
    settingsRedirect(formData, "failed", error instanceof Error ? error.message : "密码修改失败。");
  }
  settingsRedirect(formData, "updated", "密码已修改，其他设备会话已退出。");
}

export async function activatePasswordAction(formData: FormData) {
  const user = await requireUser("/account/activate", { allowPasswordChange: true });
  await assertServerActionCsrf(user, formData);
  const newPassword = String(formData.get("newPassword") ?? "");
  if (newPassword !== String(formData.get("confirmPassword") ?? "")) {
    redirect("/account/activate?error=mismatch");
  }
  try {
    await changePassword({
      currentPassword: String(formData.get("currentPassword") ?? ""),
      newPassword,
      sessionId: user.sessionId,
      userId: user.userId,
      username: user.username,
    });
    await rotateUserSession({ ...user, mustChangePassword: false });
  } catch {
    redirect("/account/activate?error=invalid");
  }
  redirect("/dashboard");
}

export async function logoutAllAction(formData: FormData) {
  const user = await requireUser("/settings/security");
  await assertServerActionCsrf(user, formData);
  await clearAllUserSessions(user);
  redirect("/login");
}

export async function reauthenticateAction(formData: FormData) {
  const user = await requireUser("/settings/security/reauth");
  await assertServerActionCsrf(user, formData);
  const next = safeReturnPath(String(formData.get("next") ?? "/settings/security"));
  const passwordValid = await verifyCurrentPassword(user.userId, String(formData.get("password") ?? ""));
  const mfaValid = !user.mfaEnabled || await verifyMfaForStepUp(user, String(formData.get("token") ?? ""));
  if (!passwordValid || !mfaValid) {
    redirect(`/settings/security/reauth?error=invalid&next=${encodeURIComponent(next)}`);
  }
  await markSessionReauthenticated(user.sessionId);
  redirect(next);
}

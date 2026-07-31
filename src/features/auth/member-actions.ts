"use server";

import { revalidatePath } from "next/cache";
import { createMember, setMemberPassword, updateMember } from "@/features/auth/db";
import { assertServerActionCsrf } from "@/features/auth/server-action-security";
import { requirePermission, requireRecentAuthentication } from "@/features/auth/session";
import { isShopAccessLevel, type MemberShopAccess } from "@/features/auth/types";

export type MemberActionState = {
  error?: string;
  message?: string;
  temporaryPassword?: string;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "操作失败，请稍后重试。";
}

function shopAccessFromFormData(formData: FormData): MemberShopAccess[] {
  const accessByShop = new Map<number, MemberShopAccess["accessLevel"]>();
  for (const [name, value] of formData.entries()) {
    if (!name.startsWith("shopAccess.")) continue;
    const shopId = Number(name.slice("shopAccess.".length));
    const accessLevel = String(value);
    if (Number.isSafeInteger(shopId) && shopId > 0 && isShopAccessLevel(accessLevel)) {
      accessByShop.set(shopId, accessLevel);
    }
  }
  return Array.from(accessByShop, ([shopId, accessLevel]) => ({ accessLevel, shopId }));
}

export async function createMemberAction(
  _state: MemberActionState,
  formData: FormData,
): Promise<MemberActionState> {
  const admin = await requirePermission("members.manage", "/settings/members");
  await assertServerActionCsrf(admin, formData);
  await requireRecentAuthentication(admin, "/settings/members");
  try {
    const role = String(formData.get("role") ?? "");
    const password = String(formData.get("password") ?? "");
    const confirmPassword = String(formData.get("confirmPassword") ?? "");
    if (role !== "operator" && role !== "viewer") throw new Error("只能创建 Operator 或 Viewer。");
    if (!password) throw new Error("请为成员设置登录密码。");
    if (password !== confirmPassword) throw new Error("两次输入的密码不一致。");
    await createMember({
      actorUserId: admin.userId,
      displayName: String(formData.get("displayName") ?? ""),
      organizationId: admin.organizationId,
      password,
      role,
      shopAccess: shopAccessFromFormData(formData),
      username: String(formData.get("username") ?? ""),
    });
    revalidatePath("/settings/members");
    return { message: "成员已创建，可直接使用 Admin 设置的密码登录。" };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

export async function updateMemberAction(
  _state: MemberActionState,
  formData: FormData,
): Promise<MemberActionState> {
  const admin = await requirePermission("members.manage", "/settings/members");
  await assertServerActionCsrf(admin, formData);
  await requireRecentAuthentication(admin, "/settings/members");
  try {
    const role = String(formData.get("role") ?? "");
    const status = String(formData.get("status") ?? "");
    if (role !== "operator" && role !== "viewer") throw new Error("角色不合法。");
    if (status !== "active" && status !== "disabled") throw new Error("状态不合法。");
    await updateMember({
      actorUserId: admin.userId,
      organizationId: admin.organizationId,
      role,
      shopAccess: shopAccessFromFormData(formData),
      status,
      userId: Number(formData.get("userId")),
    });
    revalidatePath("/settings/members");
    return { message: "成员已更新，旧会话已撤销。" };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

export async function setMemberPasswordAction(
  _state: MemberActionState,
  formData: FormData,
): Promise<MemberActionState> {
  const admin = await requirePermission("members.manage", "/settings/members");
  await assertServerActionCsrf(admin, formData);
  await requireRecentAuthentication(admin, "/settings/members");
  try {
    const password = String(formData.get("password") ?? "");
    const confirmPassword = String(formData.get("confirmPassword") ?? "");
    if (password !== confirmPassword) throw new Error("两次输入的密码不一致。");
    await setMemberPassword({
      actorUserId: admin.userId,
      organizationId: admin.organizationId,
      password,
      userId: Number(formData.get("userId")),
    });
    revalidatePath("/settings/members");
    return { message: "密码已由 Admin 更新，成员的旧会话已撤销。" };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

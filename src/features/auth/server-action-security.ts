import "server-only";

import { headers } from "next/headers";
import { safeEqual, validateRequestOrigin } from "@/features/auth/security";
import type { AuthContext } from "@/features/auth/types";

async function assertServerActionOrigin() {
  const headerStore = await headers();
  const request = new Request("http://server-action.local", { headers: headerStore, method: "POST" });
  if (!validateRequestOrigin(request)) throw new Error("请求来源验证失败。");
}

export async function assertServerActionCsrf(
  user: Pick<AuthContext, "csrfToken">,
  formData: FormData,
) {
  await assertServerActionOrigin();
  if (!safeEqual(String(formData.get("_csrf") ?? ""), user.csrfToken)) {
    throw new Error("请求验证失败。");
  }
}

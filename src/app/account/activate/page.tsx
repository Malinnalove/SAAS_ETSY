import Image from "next/image";
import { redirect } from "next/navigation";
import { activatePasswordAction } from "@/features/auth/actions";
import { requireUser } from "@/features/auth/session";

export const dynamic = "force-dynamic";

export default async function ActivateAccountPage({ searchParams }: {
  searchParams?: Promise<{ error?: string }>;
}) {
  const user = await requireUser("/account/activate", { allowPasswordChange: true });
  if (!user.mustChangePassword) redirect("/dashboard");
  const params = await searchParams;
  return (
    <main className="loginShell">
      <section className="loginPanel" aria-labelledby="activate-title">
        <div className="loginBrand">
          <span className="loginLogo" aria-hidden="true">
            <Image alt="" height={44} priority src="/icon.png" unoptimized width={44} />
          </span>
          <div><span className="tinyLabel">首次登录</span><h1 id="activate-title">设置正式密码</h1></div>
        </div>
        {params?.error ? <div className="notice errorNotice" role="alert">
          {params.error === "mismatch" ? "两次输入的新密码不一致。" : "当前密码不正确或新密码不符合要求。"}
        </div> : null}
        <p className="emptyText">临时密码只能使用一次。新密码需要 12–128 个字符。</p>
        <form action={activatePasswordAction} className="loginForm">
          <input name="_csrf" type="hidden" value={user.csrfToken} />
          <label className="formField"><span>当前临时密码</span><input autoComplete="current-password" maxLength={128} name="currentPassword" required type="password" /></label>
          <label className="formField"><span>新密码</span><input autoComplete="new-password" maxLength={128} minLength={12} name="newPassword" required type="password" /></label>
          <label className="formField"><span>确认新密码</span><input autoComplete="new-password" maxLength={128} minLength={12} name="confirmPassword" required type="password" /></label>
          <button type="submit">保存并进入后台</button>
        </form>
      </section>
    </main>
  );
}

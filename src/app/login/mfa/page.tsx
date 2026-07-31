import Image from "next/image";
import { redirect } from "next/navigation";
import {
  getCurrentUser,
  getMfaChallengeToken,
  getMfaCsrfToken,
  safeReturnPath,
} from "@/features/auth/session";

export const dynamic = "force-dynamic";

export default async function MfaLoginPage({ searchParams }: {
  searchParams?: Promise<{ error?: string; next?: string }>;
}) {
  const params = await searchParams;
  const next = safeReturnPath(params?.next);
  const user = await getCurrentUser();
  if (user) redirect(user.mustChangePassword ? "/account/activate" : next);
  if (!(await getMfaChallengeToken())) redirect(`/login?next=${encodeURIComponent(next)}`);
  const csrf = await getMfaCsrfToken();

  return (
    <main className="loginShell">
      <section className="loginPanel" aria-labelledby="mfa-title">
        <div className="loginBrand">
          <span className="loginLogo" aria-hidden="true">
            <Image alt="" height={44} priority src="/icon.png" unoptimized width={44} />
          </span>
          <div>
            <span className="tinyLabel">安全验证</span>
            <h1 id="mfa-title">输入动态码</h1>
          </div>
        </div>
        {params?.error ? <div className="notice errorNotice" role="alert">动态码、恢复码不正确或已过期。</div> : null}
        <form action="/api/auth/mfa/verify" className="loginForm" method="post">
          <input name="_csrf" type="hidden" value={csrf} />
          <input name="next" type="hidden" value={next} />
          <label className="formField">
            <span>6 位动态码或恢复码</span>
            <input autoComplete="one-time-code" autoFocus maxLength={32} name="code" required />
          </label>
          <button type="submit">继续登录</button>
        </form>
      </section>
    </main>
  );
}

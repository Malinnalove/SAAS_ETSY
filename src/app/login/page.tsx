import Image from "next/image";
import { redirect } from "next/navigation";
import { getCurrentUser, getPreAuthCsrfToken, safeReturnPath } from "@/features/auth/session";

export const dynamic = "force-dynamic";

type LoginPageProps = {
  searchParams?: Promise<{
    error?: string;
    next?: string;
    requestId?: string;
  }>;
};

function errorMessage(error?: string, requestId?: string) {
  if (error === "invalid") return "账号或密码错误。";
  if (error === "rate") return "登录尝试过多，请稍后再试。";
  if (error === "request") return "请求验证失败，请刷新页面后重试。";
  if (error === "setup") return `登录服务暂时不可用。${requestId ? ` 请求编号：${requestId}` : ""}`;
  return null;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const next = safeReturnPath(params?.next);
  const user = await getCurrentUser();
  if (user) redirect(user.mustChangePassword ? "/account/activate" : next);
  const csrfToken = await getPreAuthCsrfToken();
  const error = errorMessage(params?.error, params?.requestId);

  return (
    <main className="loginShell">
      <section className="loginPanel" aria-labelledby="login-title">
        <div className="loginBrand">
          <span className="loginLogo" aria-hidden="true">
            <Image alt="" height={44} priority src="/icon.png" unoptimized width={44} />
          </span>
          <div>
            <span className="tinyLabel">成都云杉科技</span>
            <h1 id="login-title">登录管理后台</h1>
          </div>
        </div>

        {error ? <div className="notice errorNotice" role="alert">{error}</div> : null}

        <form action="/api/auth/login" className="loginForm" method="post">
          <input name="_csrf" type="hidden" value={csrfToken} />
          <input name="next" type="hidden" value={next} />
          <label className="formField">
            <span>账号</span>
            <input autoComplete="username" autoFocus name="username" required />
          </label>
          <label className="formField">
            <span>密码</span>
            <input autoComplete="current-password" maxLength={128} name="password" required type="password" />
          </label>
          <button type="submit">登录</button>
        </form>
      </section>
    </main>
  );
}

import { AppShell } from "@/components/app-shell";
import { reauthenticateAction } from "@/features/auth/actions";
import { requireUser, safeReturnPath } from "@/features/auth/session";
import { getWorkspace, type WorkspacePageProps } from "@/features/workspace/workspace";

export const dynamic = "force-dynamic";

export default async function ReauthenticatePage({ searchParams }: WorkspacePageProps) {
  const workspace = await getWorkspace(searchParams, "/settings/security/reauth");
  const user = await requireUser("/settings/security/reauth");
  const next = safeReturnPath(workspace.params?.next ?? "/settings/members");
  const error = workspace.params?.error;
  return <AppShell activePath="/settings" kicker="敏感操作保护" locale={workspace.locale} selectedShop={workspace.selectedShop} selectedShopId={workspace.selectedShopId} store={workspace.store} title="再次确认身份">
    <section className="settingsGrid"><div className="panel settingsPanel">
      {error ? <div className="notice errorNotice">密码或动态码不正确。</div> : null}
      <form action={reauthenticateAction} className="enterpriseForm">
        <input name="_csrf" type="hidden" value={user.csrfToken} />
        <input name="next" type="hidden" value={next} />
        <label className="formField"><span>当前密码</span><input autoComplete="current-password" name="password" required type="password" /></label>
        {user.mfaEnabled ? <label className="formField"><span>当前动态码</span><input autoComplete="one-time-code" maxLength={6} name="token" pattern="[0-9]{6}" required /></label> : null}
        <button type="submit">确认并继续</button>
      </form>
    </div></section>
  </AppShell>;
}

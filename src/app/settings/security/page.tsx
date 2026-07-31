import Link from "next/link";
import { AppShell, StatusBadge } from "@/components/app-shell";
import { DisableMfaForm } from "@/components/settings/mfa-controls";
import { changeAdminPasswordAction, logoutAllAction } from "@/features/auth/actions";
import { listRecentAuthAlerts, listUserSessions } from "@/features/auth/db";
import { startMfaSetupAction } from "@/features/auth/mfa-actions";
import { requireUser } from "@/features/auth/session";
import { getWorkspace, type WorkspacePageProps } from "@/features/workspace/workspace";

export const dynamic = "force-dynamic";

export default async function SecurityPage({ searchParams }: WorkspacePageProps) {
  const workspace = await getWorkspace(searchParams, "/settings/security");
  const user = await requireUser("/settings/security");
  const sessions = await listUserSessions(user.userId);
  const alerts = user.role === "admin" ? await listRecentAuthAlerts(user.organizationId) : [];
  return <AppShell activePath="/settings" kicker="账号安全" locale={workspace.locale} selectedShop={workspace.selectedShop} selectedShopId={workspace.selectedShopId} store={workspace.store} title="安全与会话">
    <section className="settingsGrid">
      {workspace.params?.settingsDetail ? <div className={workspace.params.settingsStatus === "updated" ? "notice successNotice" : "notice errorNotice"}>{workspace.params.settingsDetail}</div> : null}
      <div className="panel settingsPanel">
        <div className="panelHeader"><div><span className="tinyLabel">当前账号</span><h2>{user.displayName ?? user.username}</h2></div><StatusBadge tone="info">{user.role}</StatusBadge></div>
        <form action={changeAdminPasswordAction} className="enterpriseForm">
          <input name="_csrf" type="hidden" value={user.csrfToken} />
          <input name="returnTo" type="hidden" value="/settings/security" />
          <label className="formField"><span>当前密码</span><input autoComplete="current-password" name="currentPassword" required type="password" /></label>
          <label className="formField"><span>新密码</span><input autoComplete="new-password" maxLength={128} minLength={12} name="newPassword" required type="password" /></label>
          <label className="formField"><span>确认新密码</span><input autoComplete="new-password" maxLength={128} minLength={12} name="confirmPassword" required type="password" /></label>
          <button type="submit">修改密码</button>
        </form>
      </div>
      {user.role === "admin" ? <div className="panel settingsPanel">
        <div className="panelHeader"><div><span className="tinyLabel">最近 7 天</span><h2>安全告警</h2></div><StatusBadge tone={alerts.length ? "warning" : "success"}>{alerts.length ? `${alerts.length} 条` : "正常"}</StatusBadge></div>
        <div className="settingsRows">{alerts.length ? alerts.map((alert) => <div className="settingsRow" key={alert.id}><div><strong>{alert.event_type}</strong><small>{new Date(alert.created_at).toLocaleString()}</small></div><StatusBadge tone={alert.severity === "critical" ? "danger" : "warning"}>{alert.severity}</StatusBadge></div>) : <p className="emptyText">没有需要处理的认证或权限异常。</p>}</div>
      </div> : null}
      {user.role === "admin" ? <div className="panel settingsPanel">
        <div className="panelHeader"><div><span className="tinyLabel">Admin 保护</span><h2>两步验证</h2></div><StatusBadge tone={user.mfaEnabled ? "success" : "warning"}>{user.mfaEnabled ? "已启用" : "建议启用"}</StatusBadge></div>
        {user.mfaEnabled ? <DisableMfaForm csrfToken={user.csrfToken} /> : <form action={startMfaSetupAction} className="enterpriseForm">
          <input name="_csrf" type="hidden" value={user.csrfToken} />
          <p className="emptyText">启用后，登录还需要验证器生成的动态码。</p>
          <label className="formField"><span>先确认当前密码</span><input autoComplete="current-password" name="password" required type="password" /></label>
          <button type="submit">开始设置</button>
        </form>}
      </div> : null}
      <div className="panel settingsPanel">
        <div className="panelHeader"><div><span className="tinyLabel">登录设备</span><h2>最近会话</h2></div></div>
        <div className="settingsRows">{sessions.map((session) => <div className="settingsRow" key={session.id}><div><strong>{session.id === user.sessionId ? "当前会话" : "其他会话"}</strong><small>{session.user_agent || "未知浏览器"} · {new Date(session.last_seen_at).toLocaleString()}</small></div><StatusBadge tone={session.revoked_at ? "neutral" : "success"}>{session.revoked_at ? "已结束" : "有效"}</StatusBadge></div>)}</div>
        <form action={logoutAllAction}><input name="_csrf" type="hidden" value={user.csrfToken} /><button className="secondary" type="submit">退出所有设备</button></form>
      </div>
      {user.role === "admin" ? <div className="panel settingsPanel"><div className="panelHeader"><div><span className="tinyLabel">Admin</span><h2>成员账号</h2></div><Link className="button" href="/settings/members">打开成员管理</Link></div></div> : null}
    </section>
  </AppShell>;
}

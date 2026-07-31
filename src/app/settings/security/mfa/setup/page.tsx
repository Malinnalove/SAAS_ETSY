import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ConfirmMfaForm } from "@/components/settings/mfa-controls";
import { getPendingMfaSetup } from "@/features/auth/mfa";
import { requirePermission } from "@/features/auth/session";
import { getWorkspace, type WorkspacePageProps } from "@/features/workspace/workspace";

export default async function MfaSetupPage({ searchParams }: WorkspacePageProps) {
  const workspace = await getWorkspace(searchParams, "/settings/security/mfa/setup");
  const admin = await requirePermission("system.manage", "/settings/security/mfa/setup");
  const setup = await getPendingMfaSetup(admin);
  if (!setup) redirect("/settings/security");
  return <AppShell activePath="/settings" kicker="Admin 保护" locale={workspace.locale} selectedShop={workspace.selectedShop} selectedShopId={workspace.selectedShopId} store={workspace.store} title="设置两步验证">
    <section className="settingsGrid"><div className="panel settingsPanel">
      <div className="panelHeader"><div><span className="tinyLabel">步骤 1</span><h2>扫描二维码</h2></div></div>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img alt="TOTP 设置二维码" height={240} src={setup.qrDataUrl} width={240} />
      <p>无法扫码时输入密钥：<code>{setup.secret}</code></p>
      <div className="panelHeader"><div><span className="tinyLabel">步骤 2</span><h2>确认动态码</h2></div></div>
      <ConfirmMfaForm csrfToken={admin.csrfToken} />
    </div></section>
  </AppShell>;
}

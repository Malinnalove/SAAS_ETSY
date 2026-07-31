import { AppShell } from "@/components/app-shell";
import { MemberManagement } from "@/components/settings/member-management";
import { listMembers } from "@/features/auth/db";
import { requirePermission, requireRecentAuthentication } from "@/features/auth/session";
import { getWorkspace, type WorkspacePageProps } from "@/features/workspace/workspace";

export default async function MembersPage({ searchParams }: WorkspacePageProps) {
  const workspace = await getWorkspace(searchParams, "/settings/members");
  const admin = await requirePermission("members.manage", "/settings/members");
  await requireRecentAuthentication(admin, "/settings/members");
  const members = await listMembers(admin.organizationId);
  const shops = workspace.store.shops.map((shop) => ({
    shopId: shop.connection.shopId,
    shopName: shop.connection.shopName,
  }));
  return (
    <AppShell activePath="/settings" kicker="安全设置" locale={workspace.locale} selectedShop={workspace.selectedShop} selectedShopId={workspace.selectedShopId} store={workspace.store} title="成员管理">
      <section className="settingsGrid"><MemberManagement csrfToken={admin.csrfToken} members={members} shops={shops} /></section>
    </AppShell>
  );
}

import Link from "next/link";
import Image from "next/image";
import type { ReactNode } from "react";
import {
  BarChart3,
  Boxes,
  ChevronDown,
  ChevronRight,
  Globe2,
  Languages,
  LayoutDashboard,
  LogOut,
  Package,
  Plus,
  Settings,
  ShoppingBag,
  Table2,
  type LucideIcon,
} from "lucide-react";
import { EtsyApiQuotaWidget as DraggableEtsyApiQuotaWidget } from "@/components/etsy-api-quota-widget";
import { compactNumber, dateFromString } from "@/shared/format/commerce";
import { getDictionary, type Locale } from "@/shared/i18n";
import type { AppStore, EtsyShopData } from "@/shared/types/etsy";
import { hrefWithShop, type WorkspaceLinkParams } from "@/features/workspace/workspace";
import { getCurrentUser, hasShopAccess } from "@/features/auth/session";
import { hasPermission, type AuthPermission } from "@/features/auth/types";

type AppShellProps = {
  activePath: string;
  actions?: ReactNode;
  children: ReactNode;
  headerTabs?: ReactNode;
  kicker: string;
  locale: Locale;
  preserveParams?: WorkspaceLinkParams;
  selectedShop: EtsyShopData | null;
  selectedShopId: number | null;
  store: AppStore;
  title: string;
};

type NavKey = "dashboard" | "products" | "listingSheet" | "orders" | "settings";

type MetricTone = "amber" | "blue" | "coral" | "honey" | "slate" | "teal";
type BadgeTone = "danger" | "info" | "neutral" | "success" | "warning";

const navItems: Array<{ href: string; icon: LucideIcon; key: NavKey; permission: AuthPermission }> = [
  { href: "/dashboard", icon: LayoutDashboard, key: "dashboard", permission: "dashboard.read" },
  { href: "/products", icon: Package, key: "products", permission: "products.read" },
  { href: "/listing-sheet", icon: Table2, key: "listingSheet", permission: "listings.read" },
  { href: "/orders", icon: ShoppingBag, key: "orders", permission: "orders.read" },
  { href: "/settings", icon: Settings, key: "settings", permission: "system.manage" },
];

export async function AppShell({
  activePath,
  actions,
  children,
  headerTabs,
  kicker,
  locale,
  preserveParams,
  selectedShop,
  selectedShopId,
  store,
  title,
}: AppShellProps) {
  const auth = await getCurrentUser();
  const t = getDictionary(locale);
  const totalNewOrders = store.shops.reduce((total, shop) => total + (shop.newOrderCount ?? 0), 0);
  const canAddShop = Boolean(
    auth && hasPermission(auth, "shops.manage") && (activePath === "/dashboard" || activePath === "/settings"),
  );
  const connectReturnTo = hrefWithShop(activePath, selectedShopId, { lang: locale });
  const connectHref = `/api/etsy/connect?returnTo=${encodeURIComponent(connectReturnTo)}`;
  const localeHref = (nextLocale: Locale) =>
    hrefWithShop(activePath, selectedShopId, {
      ...preserveParams,
      lang: nextLocale,
    });
  const sharedApiQuota =
    selectedShop?.apiQuota ?? store.apiQuota ?? store.shops.find((shopData) => shopData.apiQuota)?.apiQuota ?? null;
  const quotaShop = selectedShop ? { ...selectedShop, apiQuota: sharedApiQuota } : null;
  const canSyncSelectedShop = Boolean(
    auth && selectedShopId && await hasShopAccess(auth, selectedShopId, "sync.run"),
  );

  return (
    <main className="appShell" lang={locale === "zh" ? "zh-CN" : "en"}>
      <input id="app-csrf-token" type="hidden" value={auth?.csrfToken ?? ""} />
      <aside className="sidebar" aria-label="Primary">
        <Link className="brandLockup" href={hrefWithShop("/dashboard", selectedShopId, { lang: locale })}>
          <span className="brandMark" aria-hidden="true">
            <Image
              alt=""
              className="brandLogoImage"
              height={42}
              priority
              src="/icon.png"
              unoptimized
              width={42}
            />
          </span>
          <span>
            {t.app.brand}
            <small>{t.app.subtitle}</small>
          </span>
        </Link>

        <nav className="sideNav" aria-label="Workspace">
          {navItems.filter((item) => auth && hasPermission(auth, item.permission)).map((item) => {
            const Icon = item.icon;

            return (
              <Link
                className={item.href === activePath ? "navItem active" : "navItem"}
                href={hrefWithShop(item.href, selectedShopId, { lang: locale })}
                key={item.href}
              >
                <span className="navItemLabel">
                  <Icon aria-hidden="true" size={17} strokeWidth={2.2} />
                  <span>{t.nav[item.key]}</span>
                </span>
                {item.href === "/orders" && totalNewOrders > 0 ? (
                  <span className="countBadge">{compactNumber(totalNewOrders, locale)}</span>
                ) : null}
              </Link>
            );
          })}
        </nav>

        <section className="shopList" aria-label="Marketplace accounts">
          <div className="sectionLabel">
            <span className="tinyLabel">{t.app.platforms}</span>
            <strong>{compactNumber(2, locale)}</strong>
          </div>
          <div className="platformTree">
            <div className="platformNode">
              <div className="platformHeader">
                <ChevronDown className="treeIcon" aria-hidden="true" size={16} />
                <span>
                  <strong>Etsy</strong>
                  <small>{t.app.shopCount(compactNumber(store.shops.length, locale))}</small>
                </span>
                <span className="platformStatus">{t.app.connected}</span>
              </div>
              <div className="shopListRows">
                {store.shops.map((shopData) => (
                  <Link
                    className={
                      shopData.connection.shopId === selectedShopId ? "shopListRow active" : "shopListRow"
                    }
                    href={hrefWithShop(activePath, shopData.connection.shopId, { lang: locale })}
                    key={shopData.connection.shopId}
                  >
                    <span>
                      <strong>{shopData.connection.shopName}</strong>
                      <small>{dateFromString(shopData.lastSyncAt, locale)}</small>
                    </span>
                    {shopData.newOrderCount > 0 ? (
                      <span className="countBadge">{compactNumber(shopData.newOrderCount, locale)}</span>
                    ) : null}
                  </Link>
                ))}
                {store.shops.length === 0 ? <p className="emptyText">{t.settings.emptyShops}</p> : null}
              </div>
            </div>

            <div className="platformNode muted">
              <div className="platformHeader">
                <ChevronRight className="treeIcon" aria-hidden="true" size={16} />
                <span>
                  <strong>eBay</strong>
                  <small>{t.app.shopCount(compactNumber(0, locale))}</small>
                </span>
                <span className="platformStatus">{t.actions.comingSoon}</span>
              </div>
            </div>

          </div>
        </section>

        <div className="sidebarFooter">
          <span className="tinyLabel">{t.app.lastSync}</span>
          <strong>{selectedShop ? t.app.live : t.app.idle}</strong>
          <p>{selectedShop ? dateFromString(selectedShop.lastSyncAt, locale) : t.dashboard.hero.fallbackDetail}</p>
        </div>
      </aside>

      <section className="workspace">
        <header className={headerTabs ? "workspaceTopbar hasHeaderTabs" : "workspaceTopbar"}>
          <div className="workspaceTitle">
            <p className="eyebrow">{kicker}</p>
            <h1>{title}</h1>
            {headerTabs ? <div className="workspaceHeaderTabs">{headerTabs}</div> : null}
          </div>

          <div className="toolbar">
            <div className="languageSwitch" aria-label="Language">
              <Languages aria-hidden="true" size={16} />
              <Link className={locale === "zh" ? "active" : ""} href={localeHref("zh")}>
                中
              </Link>
              <Link className={locale === "en" ? "active" : ""} href={localeHref("en")}>
                EN
              </Link>
            </div>

            {canAddShop ? (
              <Link className={selectedShopId ? "button secondary" : "button"} href={connectHref}>
                {selectedShopId ? <Plus aria-hidden="true" size={16} /> : <Globe2 aria-hidden="true" size={16} />}
                {selectedShopId ? t.actions.addShop : t.actions.connectEtsy}
              </Link>
            ) : null}
            {auth && selectedShopId && canSyncSelectedShop && activePath !== "/settings" ? (
              <form action={`/api/etsy/sync?shopId=${selectedShopId}&lang=${locale}`} method="post">
                <input name="_csrf" type="hidden" value={auth.csrfToken} />
                <button className="button secondary" type="submit">同步</button>
              </form>
            ) : null}
            {auth ? (
              <Link className="button quiet" href="/settings/security">
                {auth.displayName ?? auth.username} · {auth.role}
              </Link>
            ) : null}
            <form action="/api/auth/logout" className="logoutForm" method="post">
              <input name="_csrf" type="hidden" value={auth?.csrfToken ?? ""} />
              <button className="button quiet" type="submit">
                <LogOut aria-hidden="true" size={16} />
                {t.actions.logout}
              </button>
            </form>
            {actions}
          </div>
        </header>

        {children}
      </section>
      <DraggableEtsyApiQuotaWidget locale={locale} selectedShop={quotaShop} />
    </main>
  );
}

export function MetricCard({
  icon: Icon,
  label,
  meta,
  tone = "honey",
  value,
}: {
  icon?: LucideIcon;
  label: string;
  meta: string;
  tone?: MetricTone;
  value: string;
}) {
  return (
    <div className={`metricCard tone-${tone}`}>
      <div className="metricCardTop">
        <span>{label}</span>
        {Icon ? <Icon aria-hidden="true" size={18} strokeWidth={2.3} /> : <BarChart3 aria-hidden="true" size={18} />}
      </div>
      <strong>{value}</strong>
      <small>{meta}</small>
    </div>
  );
}

export function StatusBadge({ children, tone = "neutral" }: { children: ReactNode; tone?: BadgeTone }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <p className="emptyState">
      <Boxes aria-hidden="true" size={16} />
      <span>{children}</span>
    </p>
  );
}

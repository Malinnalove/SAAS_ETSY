import Link from "next/link";
import type { ReactNode } from "react";
import {
  BarChart3,
  Boxes,
  ChevronDown,
  ChevronRight,
  Globe2,
  Languages,
  LayoutDashboard,
  Package,
  Plus,
  Settings,
  ShoppingBag,
  type LucideIcon,
} from "lucide-react";
import { compactNumber, dateFromString } from "@/lib/commerce-metrics";
import { getDictionary, type Locale } from "@/lib/i18n";
import type { AppStore, EtsyShopData } from "@/lib/types";
import { hrefWithShop, type WorkspaceLinkParams } from "@/lib/workspace";

type AppShellProps = {
  activePath: string;
  actions?: ReactNode;
  children: ReactNode;
  kicker: string;
  locale: Locale;
  preserveParams?: WorkspaceLinkParams;
  selectedShop: EtsyShopData | null;
  selectedShopId: number | null;
  store: AppStore;
  title: string;
};

type NavKey = "dashboard" | "products" | "orders" | "settings";

type MetricTone = "amber" | "blue" | "coral" | "honey" | "slate" | "teal";
type BadgeTone = "danger" | "info" | "neutral" | "success" | "warning";

const navItems: Array<{ href: string; icon: LucideIcon; key: NavKey }> = [
  { href: "/dashboard", icon: LayoutDashboard, key: "dashboard" },
  { href: "/products", icon: Package, key: "products" },
  { href: "/orders", icon: ShoppingBag, key: "orders" },
  { href: "/settings", icon: Settings, key: "settings" },
];

export function AppShell({
  activePath,
  actions,
  children,
  kicker,
  locale,
  preserveParams,
  selectedShop,
  selectedShopId,
  store,
  title,
}: AppShellProps) {
  const t = getDictionary(locale);
  const totalNewOrders = store.shops.reduce((total, shop) => total + (shop.newOrderCount ?? 0), 0);
  const connectReturnTo = hrefWithShop(activePath, selectedShopId, { lang: locale });
  const connectHref = `/api/etsy/connect?returnTo=${encodeURIComponent(connectReturnTo)}`;
  const localeHref = (nextLocale: Locale) =>
    hrefWithShop(activePath, selectedShopId, {
      ...preserveParams,
      lang: nextLocale,
    });

  return (
    <main className="appShell" lang={locale === "zh" ? "zh-CN" : "en"}>
      <aside className="sidebar" aria-label="Primary">
        <Link className="brandLockup" href={hrefWithShop("/dashboard", selectedShopId, { lang: locale })}>
          <span className="brandMark" aria-hidden="true">
            HW
          </span>
          <span>
            {t.app.brand}
            <small>{t.app.subtitle}</small>
          </span>
        </Link>

        <nav className="sideNav" aria-label="Workspace">
          {navItems.map((item) => {
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
        <header className="workspaceTopbar">
          <div className="workspaceTitle">
            <p className="eyebrow">{kicker}</p>
            <h1>{title}</h1>
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

            <Link className={selectedShopId ? "button secondary" : "button"} href={connectHref}>
              {selectedShopId ? <Plus aria-hidden="true" size={16} /> : <Globe2 aria-hidden="true" size={16} />}
              {selectedShopId ? t.actions.addShop : t.actions.connectEtsy}
            </Link>
            {actions}
          </div>
        </header>

        {children}
      </section>
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

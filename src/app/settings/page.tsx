import Link from "next/link";
import { AlertTriangle, CheckCircle2, Clock3 } from "lucide-react";
import { AppShell, EmptyState, MetricCard, StatusBadge } from "@/components/app-shell";
import { compactNumber, dateFromString } from "@/lib/commerce-metrics";
import { getDatabaseUrl } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { getDictionary } from "@/lib/i18n";
import { getSyncStatus } from "@/lib/sync-db";
import { getWorkspace, hrefWithShop, type WorkspacePageProps } from "@/lib/workspace";

function statusCount(status: Record<string, number> | undefined, key: string) {
  return status?.[key] ?? 0;
}

export default async function SettingsPage({ searchParams }: WorkspacePageProps) {
  const { locale, params, selectedShop, selectedShopId, store } = await getWorkspace(searchParams);
  const t = getDictionary(locale);
  const env = getEnv();
  const syncStatus = await getSyncStatus().catch(() => null);
  const baseUrl = env.APP_URL.replace(/\/$/, "");
  const databaseConfigured = Boolean(getDatabaseUrl());
  const settingsStatus = params?.settingsStatus;
  const settingsDetail = params?.settingsDetail;
  const noticeText =
    settingsStatus === "reconnected"
      ? t.settings.notices.reconnected
      : settingsStatus === "connected"
        ? t.settings.notices.connected
        : settingsDetail;
  const settingsReturnTo = hrefWithShop("/settings", selectedShopId, { lang: locale });

  return (
    <AppShell
      activePath="/settings"
      kicker={t.settings.kicker}
      locale={locale}
      preserveParams={settingsStatus && settingsDetail ? { settingsDetail, settingsStatus } : undefined}
      selectedShop={selectedShop}
      selectedShopId={selectedShopId}
      store={store}
      title={t.settings.title}
    >
      <section className="settingsGrid">
        <div className="panel settingsPanel">
          <div className="panelHeader">
            <div>
              <span className="tinyLabel">{t.settings.panels.platforms}</span>
              <h2>{t.settings.marketplaceConnections}</h2>
            </div>
            <Link className="button" href={`/api/etsy/connect?returnTo=${encodeURIComponent(settingsReturnTo)}`}>
              {t.actions.connectEtsy}
            </Link>
          </div>
          {settingsStatus && noticeText ? (
            <div
              className={
                settingsStatus === "reconnected" || settingsStatus === "connected"
                  ? "notice successNotice"
                  : "notice errorNotice"
              }
            >
              {noticeText}
            </div>
          ) : null}
          <div className="marketplaceGroups">
            <section className="marketplaceGroup">
              <div className="marketplaceHeader">
                <div>
                  <strong>Etsy</strong>
                  <small>{t.app.shopCount(compactNumber(store.shops.length, locale))}</small>
                </div>
                <StatusBadge tone="success">{t.status.active}</StatusBadge>
              </div>
              <div className="settingsRows">
                {store.shops.map((shopData) => (
                  <div className="settingsRow" key={shopData.connection.shopId}>
                    <div>
                      <strong>{shopData.connection.shopName}</strong>
                      <small>
                        {t.settings.shop.idAndSync(
                          shopData.connection.shopId,
                          dateFromString(shopData.lastSyncAt, locale),
                        )}
                      </small>
                    </div>
                    <div className="rowActions">
                      {shopData.newOrderCount > 0 ? (
                        <StatusBadge tone="warning">
                          {t.settings.shop.newOrders(compactNumber(shopData.newOrderCount, locale))}
                        </StatusBadge>
                      ) : shopData.connection.scopes.includes("listings_w") ? (
                        <StatusBadge tone="success">{t.settings.shop.writeEnabled}</StatusBadge>
                      ) : (
                        <StatusBadge tone="info">{t.settings.shop.readOnly}</StatusBadge>
                      )}
                      <Link
                        className="button quiet"
                        href={`/api/etsy/connect?returnTo=${encodeURIComponent(
                          hrefWithShop("/settings", shopData.connection.shopId, { lang: locale }),
                        )}`}
                      >
                        {t.actions.reconnect}
                      </Link>
                      <Link
                        className="button quiet"
                        href={hrefWithShop("/dashboard", shopData.connection.shopId, { lang: locale })}
                      >
                        {t.actions.open}
                      </Link>
                    </div>
                  </div>
                ))}
                {store.shops.length === 0 ? <EmptyState>{t.settings.emptyShops}</EmptyState> : null}
              </div>
            </section>

            <section className="marketplaceGroup">
              <div className="marketplaceHeader">
                <div>
                  <strong>eBay</strong>
                  <small>{t.app.shopCount(compactNumber(0, locale))}</small>
                </div>
                <StatusBadge tone="info">{t.status.planned}</StatusBadge>
              </div>
              <div className="settingsRows">
                <div className="settingsRow mutedRow">
                  <div>
                    <strong>eBay</strong>
                    <small>{t.settings.eBayDescription}</small>
                  </div>
                  <span className="button quiet disabledButton" aria-disabled="true">
                    {t.actions.comingSoon}
                  </span>
                </div>
              </div>
            </section>
          </div>
        </div>

        <div className="panel settingsPanel">
          <div className="panelHeader">
            <div>
              <span className="tinyLabel">{t.settings.panels.sync}</span>
              <h2>{t.settings.panels.queue}</h2>
            </div>
            {selectedShopId ? (
              <form action={`/api/etsy/sync?shopId=${selectedShopId}&lang=${locale}`} method="post">
                <button type="submit">{t.actions.syncNow}</button>
              </form>
            ) : null}
          </div>
          <div className="metricGrid threeUp compactMetrics">
            <MetricCard
              icon={Clock3}
              label={t.settings.syncMetrics.queued}
              meta={t.settings.syncMetrics.waitingJobs}
              tone="amber"
              value={compactNumber(statusCount(syncStatus?.jobs, "queued"), locale)}
            />
            <MetricCard
              icon={CheckCircle2}
              label={t.settings.syncMetrics.completed}
              meta={t.settings.syncMetrics.finishedJobs}
              tone="teal"
              value={compactNumber(statusCount(syncStatus?.jobs, "completed"), locale)}
            />
            <MetricCard
              icon={AlertTriangle}
              label={t.settings.syncMetrics.failed}
              meta={t.settings.syncMetrics.needsAttention}
              tone="coral"
              value={compactNumber(statusCount(syncStatus?.jobs, "failed"), locale)}
            />
          </div>
          <div className="settingsRows">
            <div className="settingsRow">
              <div>
                <strong>{t.settings.rows.webhook}</strong>
                <small>{`${baseUrl}/api/etsy/webhook`}</small>
              </div>
              <StatusBadge tone="info">
                {t.settings.rows.events(
                  compactNumber(Object.values(syncStatus?.webhooks ?? {}).reduce((a, b) => a + b, 0), locale),
                )}
              </StatusBadge>
            </div>
            <div className="settingsRow">
              <div>
                <strong>{t.settings.rows.cron}</strong>
                <small>{`${baseUrl}/api/sync/cron`}</small>
              </div>
              <StatusBadge tone={env.SYNC_CRON_SECRET ? "warning" : "info"}>
                {env.SYNC_CRON_SECRET ? t.settings.rows.cronSecret : t.settings.rows.cronOpen}
              </StatusBadge>
            </div>
            <div className="settingsRow">
              <div>
                <strong>{t.settings.rows.worker}</strong>
                <small>{`${baseUrl}/api/sync/jobs`}</small>
              </div>
              <StatusBadge tone="neutral">{t.settings.rows.workerBadge}</StatusBadge>
            </div>
          </div>
        </div>

        <div className="panel settingsPanel">
          <div className="panelHeader">
            <div>
              <span className="tinyLabel">{t.settings.panels.system}</span>
              <h2>{t.settings.panels.runtime}</h2>
            </div>
          </div>
          <div className="settingsRows">
            <div className="settingsRow">
              <div>
                <strong>{t.settings.rows.database}</strong>
                <small>{t.settings.rows.databaseDescription}</small>
              </div>
              <StatusBadge tone={databaseConfigured ? "success" : "danger"}>
                {databaseConfigured ? t.status.configured : t.status.missing}
              </StatusBadge>
            </div>
            <div className="settingsRow">
              <div>
                <strong>{t.settings.rows.etsyApp}</strong>
                <small>{t.settings.rows.oauthRedirect}: {env.ETSY_REDIRECT_URI}</small>
              </div>
              <StatusBadge tone={env.ETSY_CLIENT_ID ? "success" : "danger"}>
                {env.ETSY_CLIENT_ID ? t.status.configured : t.status.missing}
              </StatusBadge>
            </div>
            <div className="settingsRow">
              <div>
                <strong>{t.settings.rows.webhookSigning}</strong>
                <small>{t.settings.rows.webhookSigningDescription}</small>
              </div>
              <StatusBadge tone={env.ETSY_WEBHOOK_SECRET ? "success" : "neutral"}>
                {env.ETSY_WEBHOOK_SECRET ? t.status.enabled : t.status.notSet}
              </StatusBadge>
            </div>
          </div>
        </div>

        <div className="panel settingsPanel dangerPanel">
          <div className="panelHeader">
            <div>
              <span className="tinyLabel">{t.settings.panels.danger}</span>
              <h2>{t.settings.danger.title}</h2>
            </div>
          </div>
          {selectedShopId ? (
            <div className="settingsRow">
              <div>
                <strong>{selectedShop?.connection.shopName}</strong>
                <small>{t.settings.danger.description}</small>
              </div>
              <form action={`/api/etsy/disconnect?shopId=${selectedShopId}&lang=${locale}`} method="post">
                <button className="button danger" type="submit">
                  {t.actions.disconnect}
                </button>
              </form>
            </div>
          ) : (
            <EmptyState>{t.settings.emptyShops}</EmptyState>
          )}
        </div>
      </section>
    </AppShell>
  );
}

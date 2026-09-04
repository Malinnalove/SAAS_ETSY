import { getDictionary, getLocaleFromParams } from "@/shared/i18n";

export function buildEtsyCallbackRedirectUrl(
  appUrl: string,
  returnTo: string | undefined,
  shopId: number,
  status: string,
) {
  if (!returnTo) {
    return new URL(`/dashboard?shopId=${shopId}`, appUrl);
  }

  const redirectUrl = new URL(returnTo, appUrl);
  const locale = getLocaleFromParams({ lang: redirectUrl.searchParams.get("lang") });
  const t = getDictionary(locale);
  redirectUrl.searchParams.set("shopId", String(shopId));
  redirectUrl.searchParams.set("settingsStatus", status);
  redirectUrl.searchParams.set(
    "settingsDetail",
    status === "reconnected" ? t.settings.notices.reconnected : t.settings.notices.connected,
  );

  return redirectUrl;
}

import { redirect } from "next/navigation";
import { getLocaleFromParams } from "@/lib/i18n";
import { hrefWithShop, selectedShopIdFromParams } from "@/lib/workspace";

type HomeProps = {
  searchParams?: Promise<{
    lang?: string;
    shopId?: string;
  }>;
};

export default async function Home({ searchParams }: HomeProps) {
  const params = await searchParams;
  const locale = getLocaleFromParams(params);
  redirect(hrefWithShop("/dashboard", selectedShopIdFromParams(params), { lang: locale }));
}

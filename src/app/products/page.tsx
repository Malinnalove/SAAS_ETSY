import Link from "next/link";
import { Archive, Edit3, Eye, Heart, Package, Plus, Save, X } from "lucide-react";
import { AppShell, EmptyState, MetricCard, StatusBadge } from "@/components/app-shell";
import { ensureFreshConnection, EtsyClient } from "@/lib/etsy";
import {
  compactNumber,
  currencyForShop,
  dateFromTimestamp,
  lowStockListings,
  money,
  moneyValue,
  productRows,
  shortText,
  topListings,
} from "@/lib/commerce-metrics";
import { getDictionary, statusLabel, type Locale } from "@/lib/i18n";
import { updateConnection } from "@/lib/sync-db";
import type { EtsyListingSummary } from "@/lib/types";
import { getWorkspace, hrefWithShop, type WorkspacePageProps } from "@/lib/workspace";
import { createEtsyListingAction, updateEtsyListingAction } from "./actions";

function listingTone(state?: string | null) {
  if (state === "active") return "success" as const;
  if (state === "inactive") return "neutral" as const;
  return "warning" as const;
}

function priceText(listing?: EtsyListingSummary | null) {
  const value = moneyValue(listing?.price);
  return value > 0 ? String(value.toFixed(value % 1 === 0 ? 0 : 2)) : "";
}

function imageUrlFromObject(image?: EtsyListingSummary["MainImage"]) {
  return image?.url_170x135 ?? image?.url_75x75 ?? image?.url_570xN ?? image?.url_fullxfull ?? image?.image_url ?? null;
}

function listingImageUrl(listing: EtsyListingSummary) {
  return (
    imageUrlFromObject(listing.MainImage) ??
    imageUrlFromObject(listing.main_image) ??
    imageUrlFromObject(listing.image) ??
    imageUrlFromObject(listing.images?.[0]) ??
    null
  );
}

function ListingThumbnail({ listing }: { listing: EtsyListingSummary }) {
  const imageUrl = listingImageUrl(listing);

  if (!imageUrl) {
    return (
      <span className="listingThumb placeholderThumb" aria-hidden="true">
        <Package size={17} />
      </span>
    );
  }

  return (
    <span
      className="listingThumb"
      aria-label={listing.title}
      role="img"
      style={{ backgroundImage: `url(${imageUrl})` }}
    />
  );
}

function uniqueNumbers(values: Array<number | null | undefined>) {
  return Array.from(
    new Set(values.filter((value): value is number => typeof value === "number" && Number.isFinite(value))),
  ).sort((left, right) => left - right);
}

function InventoryExample({
  price,
  quantity,
  readinessStateId,
}: {
  price: string;
  quantity: number;
  readinessStateId?: number | null;
}) {
  return JSON.stringify(
    {
      products: [
        {
          sku: "SKU-RED-S",
          offerings: [
            {
              price: Number(price || 1),
              quantity,
              is_enabled: true,
              readiness_state_id: readinessStateId ?? 0,
            },
          ],
          property_values: [
            {
              property_id: 513,
              property_name: "Size",
              scale_id: null,
              value_ids: [],
              values: ["S"],
            },
            {
              property_id: 514,
              property_name: "Color",
              scale_id: null,
              value_ids: [],
              values: ["Red"],
            },
          ],
        },
      ],
      price_on_property: [514],
      quantity_on_property: [513, 514],
      sku_on_property: [513, 514],
      readiness_state_on_property: [],
    },
    null,
    2,
  );
}

function ListingForm({
  currency,
  defaultListing,
  hrefBase,
  listing,
  inventoryJson,
  locale,
  mode,
  readinessStateIds,
  selectedShopId,
  shippingProfileIds,
  shopSectionIds,
  taxonomyIds,
}: {
  currency: string;
  defaultListing?: EtsyListingSummary | null;
  hrefBase: string;
  listing?: EtsyListingSummary | null;
  inventoryJson?: string;
  locale: Locale;
  mode: "add" | "edit";
  readinessStateIds: number[];
  selectedShopId: number | null;
  shippingProfileIds: number[];
  shopSectionIds: number[];
  taxonomyIds: number[];
}) {
  const t = getDictionary(locale);
  const isEdit = mode === "edit";
  const source = listing ?? defaultListing ?? null;
  const defaultPrice = priceText(source);
  const defaultQuantity = source?.quantity && source.quantity > 0 ? source.quantity : 1;
  const defaultTaxonomy = source?.taxonomy_id ?? taxonomyIds[0] ?? "";
  const defaultShipping = source?.shipping_profile_id ?? shippingProfileIds[0] ?? "";
  const defaultReadiness = source?.readiness_state_id ?? readinessStateIds[0] ?? "";
  const defaultSection = source?.shop_section_id ?? shopSectionIds[0] ?? "";
  const title = isEdit ? t.products.sections.editListing : t.products.sections.addListing;

  return (
    <section className="panel listingEditorPanel" id={isEdit ? "edit-listing" : "add-listing"}>
      <div className="panelHeader">
        <div>
          <span className="tinyLabel">{t.products.form.basic}</span>
          <h2>{title}</h2>
        </div>
        <Link className="button quiet" href={hrefBase}>
          <X aria-hidden="true" size={15} />
          {t.actions.cancel}
        </Link>
      </div>

      <form
        action={isEdit ? updateEtsyListingAction : createEtsyListingAction}
        className="listingEditorForm"
      >
        <input name="lang" type="hidden" value={locale} />
        <input name="shopId" type="hidden" value={selectedShopId ?? ""} />
        {isEdit ? <input name="listingId" type="hidden" value={listing?.listing_id ?? ""} /> : null}

        <div className="formGrid">
          <label className="formField wideField">
            <span>{t.products.form.title}</span>
            <input
              className="tableInput"
              defaultValue={listing?.title ?? ""}
              maxLength={140}
              name="title"
              required
              type="text"
            />
          </label>

          <label className="formField wideField">
            <span>{t.products.form.description}</span>
            <textarea
              className="tableInput textAreaInput"
              defaultValue={listing?.description ?? ""}
              name="description"
              required
              rows={7}
            />
            <small>{t.products.form.descriptionHelp}</small>
          </label>

          <label className="formField">
            <span>{t.products.form.price} ({currency})</span>
            <input className="tableInput" defaultValue={defaultPrice} min="0.01" name="price" required step="0.01" type="number" />
          </label>

          <label className="formField">
            <span>{t.products.form.quantity}</span>
            <input className="tableInput" defaultValue={defaultQuantity} min="1" name="quantity" required step="1" type="number" />
          </label>

          <label className="formField">
            <span>{t.products.form.taxonomyId}</span>
            <input className="tableInput" defaultValue={defaultTaxonomy} list="taxonomy-options" name="taxonomyId" required type="number" />
          </label>

          <label className="formField">
            <span>{t.products.form.shippingProfileId}</span>
            <input className="tableInput" defaultValue={defaultShipping} list="shipping-profile-options" name="shippingProfileId" required type="number" />
          </label>

          <label className="formField">
            <span>{t.products.form.readinessStateId}</span>
            <input className="tableInput" defaultValue={defaultReadiness} list="readiness-state-options" name="readinessStateId" required type="number" />
          </label>

          <label className="formField">
            <span>{t.products.form.shopSectionId}</span>
            <input className="tableInput" defaultValue={defaultSection} list="shop-section-options" name="shopSectionId" type="number" />
          </label>

          <label className="formField">
            <span>{t.products.form.whoMade}</span>
            <select className="tableInput" defaultValue={listing?.who_made ?? "i_did"} name="whoMade" required>
              <option value="i_did">{t.products.options.iDid}</option>
              <option value="someone_else">{t.products.options.someoneElse}</option>
              <option value="collective">Collective</option>
            </select>
          </label>

          <label className="formField">
            <span>{t.products.form.whenMade}</span>
            <select className="tableInput" defaultValue={listing?.when_made ?? "2020_2026"} name="whenMade" required>
              <option value="made_to_order">{t.products.options.madeToOrder}</option>
              <option value="2020_2026">{t.products.options.twentyToTwentySix}</option>
              <option value="2010_2019">2010-2019</option>
              <option value="2006_2009">2006-2009</option>
              <option value="2000_2005">2000-2005</option>
              <option value="1990s">1990s</option>
              <option value="1980s">1980s</option>
              <option value="1970s">1970s</option>
            </select>
          </label>

          <label className="formField">
            <span>{t.products.form.isSupply}</span>
            <select className="tableInput" defaultValue={listing?.is_supply ? "true" : "false"} name="isSupply">
              <option value="false">No</option>
              <option value="true">Yes</option>
            </select>
          </label>

          <label className="formField">
            <span>{t.products.form.shouldAutoRenew}</span>
            <select className="tableInput" defaultValue={listing?.should_auto_renew ? "true" : "false"} name="shouldAutoRenew">
              <option value="false">No</option>
              <option value="true">Yes</option>
            </select>
          </label>

          {isEdit ? (
            <label className="formField">
              <span>{t.products.form.listingState}</span>
              <select className="tableInput" defaultValue={listing?.state ?? "active"} name="state">
                <option value="active">{t.products.options.active}</option>
                <option value="inactive">{t.products.options.inactive}</option>
              </select>
            </label>
          ) : (
            <label className="formField">
              <span>{t.products.form.publishMode}</span>
              <select className="tableInput" defaultValue="draft" name="publishState">
                <option value="draft">{t.products.options.draft}</option>
                <option value="active">{t.products.options.active}</option>
              </select>
            </label>
          )}

          <label className="formField wideField">
            <span>{t.products.form.tags}</span>
            <textarea className="tableInput compactTextArea" defaultValue={(listing?.tags ?? []).join(", ")} name="tags" rows={3} />
            <small>{t.products.form.tagsHelp}</small>
          </label>

          <label className="formField wideField">
            <span>{t.products.form.materials}</span>
            <textarea className="tableInput compactTextArea" defaultValue={(listing?.materials ?? []).join(", ")} name="materials" rows={3} />
            <small>{t.products.form.materialsHelp}</small>
          </label>

          <label className="formField wideField">
            <span>{t.products.form.images}</span>
            <input className="tableInput fileInput" multiple name="images" accept="image/*" type="file" />
            <small>{t.products.form.imagesHelp}</small>
          </label>

          <label className="formField wideField">
            <span>{t.products.form.inventoryJson}</span>
            <textarea
              className="tableInput textAreaInput codeInput"
              defaultValue={inventoryJson ?? ""}
              name="inventoryJson"
              placeholder={InventoryExample({
                price: defaultPrice || "1",
                quantity: defaultQuantity,
                readinessStateId: typeof defaultReadiness === "number" ? defaultReadiness : null,
              })}
              rows={12}
            />
            <small>{t.products.form.inventoryJsonHelp} {t.products.form.noInventoryJson}</small>
          </label>
        </div>

        <datalist id="taxonomy-options">
          {taxonomyIds.map((value) => (
            <option key={value} value={value} />
          ))}
        </datalist>
        <datalist id="shipping-profile-options">
          {shippingProfileIds.map((value) => (
            <option key={value} value={value} />
          ))}
        </datalist>
        <datalist id="readiness-state-options">
          {readinessStateIds.map((value) => (
            <option key={value} value={value} />
          ))}
        </datalist>
        <datalist id="shop-section-options">
          {shopSectionIds.map((value) => (
            <option key={value} value={value} />
          ))}
        </datalist>

        <div className="formActions">
          <button type="submit">
            {isEdit ? <Save aria-hidden="true" size={16} /> : <Plus aria-hidden="true" size={16} />}
            {isEdit ? t.actions.saveChanges : t.actions.createDraft}
          </button>
        </div>
      </form>
    </section>
  );
}

export default async function ProductsPage({ searchParams }: WorkspacePageProps) {
  const { locale, params, selectedShop, selectedShopId, store } = await getWorkspace(searchParams);
  const t = getDictionary(locale);
  const listings = selectedShop?.listings ?? [];
  const currency = currencyForShop(selectedShop);
  const rows = productRows(listings, 80);
  const activeListings = listings.filter((listing) => listing.state === "active").length;
  const inventory = listings.reduce((total, listing) => total + (listing.quantity ?? 0), 0);
  const views = listings.reduce((total, listing) => total + (listing.views ?? 0), 0);
  const favorites = listings.reduce((total, listing) => total + (listing.num_favorers ?? 0), 0);
  const lowStock = lowStockListings(listings, 20);
  const topProducts = topListings(listings, 6);
  const listingStatus = params?.listingStatus;
  const listingDetail = params?.listingDetail;
  const listingPanel = params?.listingPanel;
  const listingId = Number(params?.listingId);
  const storedSelectedListing = Number.isFinite(listingId)
    ? listings.find((listing) => listing.listing_id === listingId)
    : null;
  let selectedListing = storedSelectedListing;
  let selectedListingInventoryJson = "";

  if (listingPanel === "edit" && storedSelectedListing && selectedShop) {
    try {
      const connection = await ensureFreshConnection(selectedShop.connection);

      if (connection.accessToken !== selectedShop.connection.accessToken) {
        await updateConnection(connection);
      }

      const client = new EtsyClient(connection);
      selectedListing = await client.getShopListing(selectedShop.connection.shopId, storedSelectedListing.listing_id);
      const inventory = await client.getListingInventory(storedSelectedListing.listing_id).catch(() => null);
      selectedListingInventoryJson = inventory ? JSON.stringify(inventory, null, 2) : "";
    } catch {
      selectedListing = storedSelectedListing;
    }
  }
  const hrefBase = hrefWithShop("/products", selectedShopId, { lang: locale });
  const taxonomyIds = uniqueNumbers(listings.map((listing) => listing.taxonomy_id));
  const shippingProfileIds = uniqueNumbers(listings.map((listing) => listing.shipping_profile_id));
  const readinessStateIds = uniqueNumbers(listings.map((listing) => listing.readiness_state_id));
  const shopSectionIds = uniqueNumbers(listings.map((listing) => listing.shop_section_id));
  const defaultListing = listings.find((listing) => listing.shipping_profile_id && listing.readiness_state_id) ?? listings[0] ?? null;

  return (
    <AppShell
      actions={
        <Link className="button" href={hrefWithShop("/products", selectedShopId, { lang: locale, listingPanel: "add" })}>
          <Plus aria-hidden="true" size={16} />
          {t.actions.addListing}
        </Link>
      }
      activePath="/products"
      kicker={t.products.kicker}
      locale={locale}
      preserveParams={
        listingStatus && listingDetail
          ? { listingDetail, listingId: params?.listingId, listingPanel, listingStatus }
          : listingPanel
            ? { listingId: params?.listingId, listingPanel }
            : undefined
      }
      selectedShop={selectedShop}
      selectedShopId={selectedShopId}
      store={store}
      title={t.products.title}
    >
      <section className="metricGrid fourUp" aria-label="Product metrics">
        <MetricCard
          icon={Package}
          label={t.products.metrics.listings}
          meta={t.products.metrics.active(activeListings)}
          tone="blue"
          value={compactNumber(listings.length, locale)}
        />
        <MetricCard
          icon={Archive}
          label={t.products.metrics.inventory}
          meta={t.products.metrics.syncedUnits}
          tone="teal"
          value={compactNumber(inventory, locale)}
        />
        <MetricCard
          icon={Eye}
          label={t.products.metrics.views}
          meta={t.products.metrics.listingTraffic}
          tone="amber"
          value={compactNumber(views, locale)}
        />
        <MetricCard
          icon={Heart}
          label={t.products.metrics.favorites}
          meta={t.products.metrics.lowStockAlerts(lowStock.length)}
          tone="coral"
          value={compactNumber(favorites, locale)}
        />
      </section>

      {listingStatus && listingDetail ? (
        <div className={listingStatus === "failed" ? "notice errorNotice" : "notice successNotice"}>
          {listingDetail}
        </div>
      ) : null}

      {listingPanel === "add" ? (
        <ListingForm
          currency={currency}
          defaultListing={defaultListing}
          hrefBase={hrefBase}
          locale={locale}
          mode="add"
          readinessStateIds={readinessStateIds}
          selectedShopId={selectedShopId}
          shippingProfileIds={shippingProfileIds}
          shopSectionIds={shopSectionIds}
          taxonomyIds={taxonomyIds}
        />
      ) : null}

      {listingPanel === "edit" ? (
        selectedListing ? (
          <ListingForm
            currency={currency}
            hrefBase={hrefBase}
            inventoryJson={selectedListingInventoryJson}
            listing={selectedListing}
            locale={locale}
            mode="edit"
            readinessStateIds={readinessStateIds}
            selectedShopId={selectedShopId}
            shippingProfileIds={shippingProfileIds}
            shopSectionIds={shopSectionIds}
            taxonomyIds={taxonomyIds}
          />
        ) : (
          <div className="notice errorNotice">{t.products.notice.notOwned}</div>
        )
      ) : null}

      <section className="insightGrid">
        <div className="panel">
          <div className="panelHeader">
            <div>
              <span className="tinyLabel">{t.products.sections.inventory}</span>
              <h2>{t.products.sections.lowStock}</h2>
            </div>
            <span className="panelMeta">{compactNumber(lowStock.length, locale)}</span>
          </div>
          <div className="rankList">
            {lowStock.map((listing) => (
              <a
                className="rankRow thumbRankRow"
                href={listing.url ?? "#"}
                key={listing.listing_id}
                rel="noreferrer"
                target={listing.url ? "_blank" : undefined}
              >
                <ListingThumbnail listing={listing} />
                <span className="rankBadge">{listing.quantity ?? 0}</span>
                <strong>{shortText(listing.title, 52)}</strong>
                <small>{money(listing.price, currency, locale)}</small>
              </a>
            ))}
            {lowStock.length === 0 ? <EmptyState>{t.products.emptyLowStock}</EmptyState> : null}
          </div>
        </div>

        <div className="panel">
          <div className="panelHeader">
            <div>
              <span className="tinyLabel">{t.products.sections.demand}</span>
              <h2>{t.products.sections.mostFavorited}</h2>
            </div>
          </div>
          <div className="rankList">
            {topProducts.map((listing, index) => (
              <a
                className="rankRow thumbRankRow"
                href={listing.url ?? "#"}
                key={listing.listing_id}
                rel="noreferrer"
                target={listing.url ? "_blank" : undefined}
              >
                <ListingThumbnail listing={listing} />
                <span className="rankBadge">{String(index + 1).padStart(2, "0")}</span>
                <strong>{shortText(listing.title, 52)}</strong>
                <small>{compactNumber(listing.num_favorers ?? 0, locale)} {t.products.metrics.favorites}</small>
              </a>
            ))}
            {topProducts.length === 0 ? <EmptyState>{t.products.emptySignals}</EmptyState> : null}
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panelHeader">
          <div>
            <span className="tinyLabel">{t.products.sections.products}</span>
            <h2>{t.products.sections.syncedCatalog}</h2>
          </div>
          <span className="panelMeta">{compactNumber(listings.length, locale)}</span>
        </div>
        <div className="tableWrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t.products.table.product}</th>
                <th>{t.products.table.status}</th>
                <th>{t.products.table.stock}</th>
                <th>{t.products.table.price}</th>
                <th>{t.products.table.views}</th>
                <th>{t.products.table.favorites}</th>
                <th>{t.products.table.updated}</th>
                <th>{t.products.table.actions}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((listing) => (
                <tr key={listing.listing_id}>
                  <td>
                    <div className="listingProductCell">
                      <ListingThumbnail listing={listing} />
                      <div>
                        {listing.url ? (
                          <a className="textLink" href={listing.url} target="_blank" rel="noreferrer">
                            {shortText(listing.title, 76)}
                          </a>
                        ) : (
                          shortText(listing.title, 76)
                        )}
                        <small className="tableSub">ID {listing.listing_id}</small>
                      </div>
                    </div>
                  </td>
                  <td>
                    <StatusBadge tone={listingTone(listing.state)}>{statusLabel(listing.state, locale)}</StatusBadge>
                  </td>
                  <td>{listing.quantity ?? "-"}</td>
                  <td>{money(listing.price, currency, locale)}</td>
                  <td>{compactNumber(listing.views ?? 0, locale)}</td>
                  <td>{compactNumber(listing.num_favorers ?? 0, locale)}</td>
                  <td>{dateFromTimestamp(listing.updated_timestamp, locale)}</td>
                  <td>
                    <Link
                      className="button quiet compactButton"
                      href={hrefWithShop("/products", selectedShopId, {
                        lang: locale,
                        listingId: listing.listing_id,
                        listingPanel: "edit",
                      })}
                    >
                      <Edit3 aria-hidden="true" size={15} />
                      {t.actions.edit}
                    </Link>
                  </td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="mutedCell">
                    {t.products.emptyProducts}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </AppShell>
  );
}

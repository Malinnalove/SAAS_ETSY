import Link from "next/link";
import { Plus, Save, X } from "lucide-react";
import { createEtsyListingAction, updateEtsyListingAction } from "@/features/products/listing-actions";
import { moneyValue } from "@/shared/format/commerce";
import { getDictionary, type Locale } from "@/shared/i18n";
import type { EtsyListingSummary } from "@/shared/types/etsy";

function priceText(listing?: EtsyListingSummary | null) {
  const value = moneyValue(listing?.price);
  return value > 0 ? String(value.toFixed(value % 1 === 0 ? 0 : 2)) : "";
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

export function ListingForm({
  csrfToken,
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
  csrfToken: string;
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
        <input name="_csrf" type="hidden" value={csrfToken} />
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
              <select className="tableInput" defaultValue="active" name="publishState">
                <option value="active">{t.products.options.active}</option>
                <option value="draft">{t.products.options.draft}</option>
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

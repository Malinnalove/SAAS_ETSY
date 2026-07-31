import { Package } from "lucide-react";
import type { EtsyListingSummary } from "@/shared/types/etsy";

function imageUrlFromObject(image?: EtsyListingSummary["MainImage"]) {
  return image?.url_170x135 ?? image?.url_75x75 ?? image?.url_570xN ?? image?.url_fullxfull ?? image?.image_url ?? null;
}

export function listingImageUrl(listing: EtsyListingSummary) {
  return (
    imageUrlFromObject(listing.MainImage) ??
    imageUrlFromObject(listing.main_image) ??
    imageUrlFromObject(listing.image) ??
    imageUrlFromObject(listing.images?.[0]) ??
    null
  );
}

export function ListingThumbnail({ listing }: { listing: EtsyListingSummary }) {
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

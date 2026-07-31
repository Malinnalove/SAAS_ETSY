import { describe, expect, it } from "vitest";
import { buildReceiptDetail } from "@/features/orders/receipt-detail";

describe("receipt detail view", () => {
  it("extracts buyer, recipient, delivery, messages, and shipment details", () => {
    const detail = buildReceiptDetail({
      buyer_email: "buyer@example.com",
      buyer_user_id: 123,
      buyer_user_name: "Buyer Name",
      city: "Portland",
      country_iso: "US",
      first_line: "123 Main St",
      gift_message: "Happy birthday",
      is_gift: true,
      is_paid: true,
      is_shipped: false,
      message_from_buyer: "Please leave at the door.",
      name: "Recipient Name",
      phone: "+1 555 0100",
      receipt_id: 100,
      shipments: [{ carrier_name: "USPS", mail_class: "Ground", tracking_code: "TRACK-1" }],
      state: "OR",
      zip: "97201",
    }, [{ receipt_id: 100, transaction_id: 200, title: "Nail set" }]);

    expect(detail).toMatchObject({
      addressLines: ["123 Main St", "Portland, OR, 97201, US"],
      buyerEmail: "buyer@example.com",
      buyerId: "123",
      buyerName: "Buyer Name",
      giftMessage: "Happy birthday",
      isGift: true,
      isPaid: true,
      isShipped: false,
      messageFromBuyer: "Please leave at the door.",
      phone: "+1 555 0100",
      recipientName: "Recipient Name",
      shipments: [{ carrier: "USPS", mailedTimestamp: null, service: "Ground", trackingCode: "TRACK-1" }],
    });
    expect(detail.transactions).toHaveLength(1);
  });

  it("uses formatted address when Etsy supplies one", () => {
    const detail = buildReceiptDetail({ formatted_address: "Recipient\n1 High Street\nLondon", receipt_id: 101 }, []);
    expect(detail.addressLines).toEqual(["Recipient", "1 High Street", "London"]);
  });
});

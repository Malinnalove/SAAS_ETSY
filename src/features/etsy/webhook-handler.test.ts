import { createHmac } from "crypto";
import { describe, expect, it } from "vitest";
import { webhookSignatureMatches } from "@/features/etsy/webhook-handler";

const rawBody = '{"event_type":"order.paid","shop_id":123}';
const webhookId = "msg_test";
const timestamp = "1,800,000,000".replaceAll(",", "");
const now = Number(timestamp) * 1000;
const secretBytes = Buffer.from("etsy-test-secret");
const secret = `whsec_${secretBytes.toString("base64")}`;
const signature = createHmac("sha256", secretBytes)
  .update(`${webhookId}.${timestamp}.${rawBody}`)
  .digest("base64");

describe("Etsy webhook signatures", () => {
  it("accepts Etsy's v1 comma signature format with the exact raw body", () => {
    expect(webhookSignatureMatches({
      now,
      rawBody,
      secret,
      signatureHeader: `v1,${signature}`,
      timestamp,
      webhookId,
    })).toBe(true);
  });

  it("accepts any matching entry when Etsy sends multiple signatures", () => {
    expect(webhookSignatureMatches({
      now,
      rawBody,
      secret,
      signatureHeader: `v1,not-the-right-signature v1,${signature}`,
      timestamp,
      webhookId,
    })).toBe(true);
  });

  it("rejects a changed body, wrong secret, and a stale timestamp", () => {
    const input = { now, rawBody, secret, signatureHeader: `v1,${signature}`, timestamp, webhookId };
    expect(webhookSignatureMatches({ ...input, rawBody: `${rawBody} ` })).toBe(false);
    expect(webhookSignatureMatches({ ...input, secret: `whsec_${Buffer.from("wrong").toString("base64")}` })).toBe(false);
    expect(webhookSignatureMatches({ ...input, now: now + 301_000 })).toBe(false);
  });
});

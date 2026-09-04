import { createHmac, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { etsyApiSlotForConnection, getEtsyApiConfig } from "@/features/etsy/api-config";
import {
  enqueueSyncJob,
  getShopConnection,
  markWebhookFailed,
  markWebhookProcessed,
  recordWebhookEvent,
} from "@/features/sync/db";
import { processSyncJobById } from "@/features/sync/processor";
import type { EtsyApiSlot } from "@/shared/types/etsy";

function payloadNumber(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : null;
}

function receiptIdFromResourceUrl(resourceUrl?: unknown) {
  if (typeof resourceUrl !== "string") return null;
  const match = /\/receipts\/(\d+)/.exec(resourceUrl);
  return match ? payloadNumber(match[1]) : null;
}

function signatureCandidates(signatureHeader: string) {
  return signatureHeader
    .split(/[\s,]+/)
    .map((candidate) => candidate.trim())
    .map((candidate) => candidate.replace(/^v\d+\s*=\s*/, ""))
    .filter((candidate) => Boolean(candidate) && !/^v\d+$/.test(candidate));
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function webhookSignatureMatches({
  now = Date.now(),
  rawBody,
  secret,
  signatureHeader,
  timestamp,
  webhookId,
}: {
  now?: number;
  rawBody: string;
  secret: string;
  signatureHeader: string;
  timestamp: string;
  webhookId: string;
}) {
  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds) || Math.abs(now / 1000 - timestampSeconds) > 5 * 60) return false;

  const signedPayload = `${webhookId}.${timestamp}.${rawBody}`;
  const secretValue = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const expectedSignature = createHmac("sha256", Buffer.from(secretValue, "base64"))
    .update(signedPayload)
    .digest("base64");
  return signatureCandidates(signatureHeader).some((candidate) => safeEqual(candidate, expectedSignature));
}

function verifyWebhookSignature(request: Request, rawBody: string, apiSlot: EtsyApiSlot) {
  const secret = getEtsyApiConfig(apiSlot).webhookSecret;
  if (!secret) return { ok: true, verified: false };

  const webhookId = request.headers.get("webhook-id");
  const timestamp = request.headers.get("webhook-timestamp");
  const signatureHeader = request.headers.get("webhook-signature");
  if (!webhookId || !timestamp || !signatureHeader) return { ok: false, verified: false };

  return {
    ok: webhookSignatureMatches({ rawBody, secret, signatureHeader, timestamp, webhookId }),
    verified: true,
  };
}

async function enqueueWebhookJobs(payload: Record<string, unknown>) {
  const eventType = String(payload.event_type ?? "");
  const shopId = payloadNumber(payload.shop_id);
  const resourceUrl = payload.resource_url;
  if (!shopId) return [];

  if (eventType.startsWith("order.")) {
    const receiptId = receiptIdFromResourceUrl(resourceUrl);
    return [await enqueueSyncJob(
      shopId,
      receiptId ? "sync_receipt_detail" : "sync_receipts_incremental",
      { eventType, receiptId, resourceUrl },
      10,
    )];
  }
  if (eventType.startsWith("listing.")) {
    return [await enqueueSyncJob(shopId, "sync_listings", { eventType, resourceUrl }, 60)];
  }
  return [await enqueueSyncJob(shopId, "sync_receipts_incremental", { eventType, resourceUrl }, 50)];
}

export async function handleEtsyWebhook(request: Request, apiSlot: EtsyApiSlot) {
  const rawBody = await request.text();
  const signature = verifyWebhookSignature(request, rawBody, apiSlot);
  if (!signature.ok) {
    return NextResponse.json({ error: `Invalid Etsy API ${apiSlot} webhook signature.` }, { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid webhook JSON payload." }, { status: 400 });
  }

  const shopId = payloadNumber(payload.shop_id);
  if (shopId) {
    const connection = await getShopConnection(shopId);
    if (!connection || etsyApiSlotForConnection(connection) !== apiSlot) {
      return NextResponse.json(
        { error: `Shop ${shopId} is not connected through Etsy API ${apiSlot}.` },
        { status: 409 },
      );
    }
  }

  const webhookId = request.headers.get("webhook-id");
  const event = await recordWebhookEvent(
    webhookId ? (apiSlot === 1 ? webhookId : `${apiSlot}:${webhookId}`) : null,
    { ...payload, api_slot: apiSlot },
  );
  if (event.duplicate) {
    return NextResponse.json({ apiSlot, ok: true, duplicate: true, verified: signature.verified });
  }

  try {
    const jobIds = await enqueueWebhookJobs(payload);
    if (event.eventId) await markWebhookProcessed(event.eventId);
    for (const jobId of jobIds) void processSyncJobById(jobId).catch(() => undefined);
    return NextResponse.json({ apiSlot, ok: true, jobIds, verified: signature.verified });
  } catch (error) {
    if (event.eventId) {
      await markWebhookFailed(event.eventId, error instanceof Error ? error : new Error("Unknown webhook error."));
    }
    return NextResponse.json(
      {
        error: "Webhook was recorded, but job enqueue failed.",
        detail: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

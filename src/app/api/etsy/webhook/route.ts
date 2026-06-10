import { createHmac, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import {
  enqueueSyncJob,
  markWebhookFailed,
  markWebhookProcessed,
  recordWebhookEvent,
} from "@/lib/sync-db";
import { processSyncJobById } from "@/lib/sync-processor";

export const runtime = "nodejs";

function payloadNumber(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : null;
}

function receiptIdFromResourceUrl(resourceUrl?: unknown) {
  if (typeof resourceUrl !== "string") return null;
  const match = /\/receipts\/(\d+)/.exec(resourceUrl);
  if (!match) return null;
  return payloadNumber(match[1]);
}

function signatureCandidates(signatureHeader: string) {
  return signatureHeader
    .split(",")
    .map((candidate) => candidate.trim())
    .flatMap((candidate) => {
      const value = candidate.replace(/^v\d+\s*=\s*/, "");
      return value === candidate ? [candidate] : [candidate, value];
    })
    .filter(Boolean);
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyWebhookSignature(request: Request, rawBody: string) {
  const secret = getEnv().ETSY_WEBHOOK_SECRET;

  if (!secret) {
    return {
      ok: true,
      verified: false,
    };
  }

  const webhookId = request.headers.get("webhook-id");
  const timestamp = request.headers.get("webhook-timestamp");
  const signatureHeader = request.headers.get("webhook-signature");

  if (!webhookId || !timestamp || !signatureHeader) {
    return {
      ok: false,
      verified: false,
    };
  }

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    return {
      ok: false,
      verified: false,
    };
  }

  const ageSeconds = Math.abs(Date.now() / 1000 - timestampSeconds);
  if (ageSeconds > 5 * 60) {
    return {
      ok: false,
      verified: false,
    };
  }

  const signedPayload = `${webhookId}.${timestamp}.${rawBody}`;
  const secretValue = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const expectedSignatures = [
    Buffer.from(secretValue, "base64"),
    Buffer.from(secretValue, "utf8"),
  ].map((secretBuffer) =>
    createHmac("sha256", secretBuffer).update(signedPayload).digest("base64"),
  );

  return {
    ok: signatureCandidates(signatureHeader).some((candidate) =>
      expectedSignatures.some((expected) => safeEqual(candidate, expected)),
    ),
    verified: true,
  };
}

async function enqueueWebhookJobs(payload: Record<string, unknown>) {
  const eventType = String(payload.event_type ?? "");
  const shopId = payloadNumber(payload.shop_id);
  const resourceUrl = payload.resource_url;

  if (!shopId) {
    return [];
  }

  if (eventType.startsWith("order.")) {
    const receiptId = receiptIdFromResourceUrl(resourceUrl);
    const jobId = await enqueueSyncJob(
      shopId,
      receiptId ? "sync_receipt_detail" : "sync_receipts_incremental",
      {
        eventType,
        receiptId,
        resourceUrl,
      },
      10,
    );

    return [jobId];
  }

  if (eventType.startsWith("listing.")) {
    const jobId = await enqueueSyncJob(
      shopId,
      "sync_listings",
      {
        eventType,
        resourceUrl,
      },
      60,
    );

    return [jobId];
  }

  const jobId = await enqueueSyncJob(
    shopId,
    "sync_receipts_incremental",
    {
      eventType,
      resourceUrl,
    },
    50,
  );

  return [jobId];
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature = verifyWebhookSignature(request, rawBody);

  if (!signature.ok) {
    return NextResponse.json({ error: "Invalid Etsy webhook signature." }, { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid webhook JSON payload." }, { status: 400 });
  }

  const webhookId = request.headers.get("webhook-id");
  const event = await recordWebhookEvent(webhookId, payload);

  if (event.duplicate) {
    return NextResponse.json({
      ok: true,
      duplicate: true,
      verified: signature.verified,
    });
  }

  try {
    const jobIds = await enqueueWebhookJobs(payload);
    if (event.eventId) {
      await markWebhookProcessed(event.eventId);
    }

    for (const jobId of jobIds) {
      void processSyncJobById(jobId).catch(() => undefined);
    }

    return NextResponse.json({
      ok: true,
      jobIds,
      verified: signature.verified,
    });
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

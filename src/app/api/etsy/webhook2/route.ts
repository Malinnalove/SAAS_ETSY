import { handleEtsyWebhook } from "@/features/etsy/webhook-handler";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return handleEtsyWebhook(request, 2);
}

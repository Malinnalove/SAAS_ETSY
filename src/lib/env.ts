import { z } from "zod";

const DEFAULT_ETSY_SCOPES =
  "address_r address_w billing_r cart_r cart_w email_r favorites_r favorites_w feedback_r listings_d listings_r listings_w profile_r profile_w recommend_r recommend_w shops_r shops_w transactions_r transactions_w";

const envSchema = z.object({
  ETSY_CLIENT_ID: z.string().min(1),
  ETSY_SHARED_SECRET: z.string().optional(),
  ETSY_REDIRECT_URI: z.string().url().default("http://localhost:3000/api/etsy/callback"),
  ETSY_SCOPES: z.string().default(DEFAULT_ETSY_SCOPES),
  ETSY_WEBHOOK_SECRET: z.string().optional(),
  APP_URL: z.string().url().default("http://localhost:3000"),
  SYNC_CRON_SECRET: z.string().optional(),
  DATABASE_URL: z.string().url().optional(),
  DATABASE_POSTGRES_URL: z.string().url().optional(),
  DATABASE_POSTGRES_PRISMA_URL: z.string().url().optional(),
});

export function getEnv() {
  const parsed = envSchema.safeParse({
    ETSY_CLIENT_ID: process.env.ETSY_CLIENT_ID,
    ETSY_SHARED_SECRET: process.env.ETSY_SHARED_SECRET,
    ETSY_REDIRECT_URI: process.env.ETSY_REDIRECT_URI,
    ETSY_SCOPES: process.env.ETSY_SCOPES,
    ETSY_WEBHOOK_SECRET: process.env.ETSY_WEBHOOK_SECRET,
    APP_URL: process.env.APP_URL,
    SYNC_CRON_SECRET: process.env.SYNC_CRON_SECRET,
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_POSTGRES_URL: process.env.DATABASE_POSTGRES_URL,
    DATABASE_POSTGRES_PRISMA_URL: process.env.DATABASE_POSTGRES_PRISMA_URL,
  });

  if (!parsed.success) {
    const missing = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`Missing or invalid environment variables: ${missing}`);
  }

  return parsed.data;
}

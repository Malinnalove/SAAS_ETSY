import { Pool } from "pg";
import { getEnv } from "@/lib/env";

let pool: Pool | null = null;

export function getDatabaseUrl() {
  const env = getEnv();
  return env.DATABASE_POSTGRES_URL ?? env.DATABASE_POSTGRES_PRISMA_URL ?? env.DATABASE_URL ?? null;
}

export function getPool() {
  const connectionString = getDatabaseUrl();

  if (!connectionString) {
    return null;
  }

  if (!pool) {
    pool = new Pool({ connectionString });
  }

  return pool;
}

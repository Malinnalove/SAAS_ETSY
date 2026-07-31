import { Pool } from "pg";
import { getEnv } from "@/lib/env";

let pool: Pool | null = null;

function normalizeDatabaseUrl(connectionString: string) {
  if (
    connectionString.includes("sslmode=require") &&
    !connectionString.includes("uselibpqcompat=")
  ) {
    return `${connectionString}${connectionString.includes("?") ? "&" : "?"}uselibpqcompat=true`;
  }

  return connectionString;
}

export function getDatabaseUrl() {
  const env = getEnv();
  const connectionString = env.DATABASE_POSTGRES_URL ?? env.DATABASE_POSTGRES_PRISMA_URL ?? env.DATABASE_URL;
  return connectionString ? normalizeDatabaseUrl(connectionString) : null;
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

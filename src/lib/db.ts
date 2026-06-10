import { Pool } from "pg";
import { getEnv } from "@/lib/env";

let pool: Pool | null = null;

export function getDatabaseUrl() {
  return getEnv().DATABASE_URL ?? null;
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


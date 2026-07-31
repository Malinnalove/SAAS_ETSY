import { readFile } from "fs/promises";
import { existsSync, readdirSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Pool } from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const migrationsDir = path.join(rootDir, "migrations");

function loadLocalEnv() {
  const envPath = path.join(rootDir, "local.env");
  if (!existsSync(envPath)) return;

  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function migrationVersion(fileName) {
  return fileName.replace(/\.sql$/i, "");
}

loadLocalEnv();

const databaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  process.env.DATABASE_URL ??
  process.env.DATABASE_POSTGRES_URL_NON_POOLING ??
  process.env.DATABASE_POSTGRES_URL ??
  process.env.DATABASE_POSTGRES_PRISMA_URL;

function normalizeDatabaseUrl(connectionString) {
  if (
    connectionString.includes("sslmode=require") &&
    !connectionString.includes("uselibpqcompat=")
  ) {
    return `${connectionString}${connectionString.includes("?") ? "&" : "?"}uselibpqcompat=true`;
  }

  return connectionString;
}

if (!databaseUrl) {
  console.error("DATABASE_MIGRATION_URL or DATABASE_URL is required to run migrations.");
  process.exit(1);
}

const pool = new Pool({ connectionString: normalizeDatabaseUrl(databaseUrl) });

try {
  await pool.query(`
    create table if not exists schema_migrations (
      version text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const files = readdirSync(migrationsDir)
    .filter((fileName) => fileName.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));

  for (const fileName of files) {
    const version = migrationVersion(fileName);
    const existing = await pool.query(
      "select version from schema_migrations where version = $1",
      [version],
    );

    if (existing.rowCount) {
      console.log(`Skipping ${version}`);
      continue;
    }

    const sql = await readFile(path.join(migrationsDir, fileName), "utf8");
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query(
        "insert into schema_migrations (version) values ($1) on conflict do nothing",
        [version],
      );
      await client.query("commit");
      console.log(`Applied ${version}`);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
} finally {
  await pool.end();
}

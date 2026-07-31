import { existsSync, readFileSync } from "fs";
import { randomBytes, scrypt } from "crypto";
import { Pool } from "pg";

function loadEnv() {
  if (!existsSync("local.env")) return;
  for (const line of readFileSync("local.env", "utf8").split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    if (key && !process.env[key]) process.env[key] = value;
  }
}

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = randomBytes(16).toString("base64url");
    scrypt(password, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(`scrypt$131072$8$1$${salt}$${key.toString("base64url")}`);
    });
  });
}

loadEnv();
const username = process.argv[2];
const password = process.argv[3];
if (!username || !/^[A-Za-z0-9._-]{3,64}$/.test(username) || !password || password.length < 12 || password.length > 128) {
  console.error("Usage: npm run auth:bootstrap -- <username> <12-128 character password>");
  process.exit(1);
}
const databaseUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_MIGRATION_URL or DATABASE_URL is required.");
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl });
const client = await pool.connect();
try {
  await client.query("begin");
  const organization = await client.query(
    `insert into organizations (name, slug, status)
     values ($1,$2,'active')
     on conflict (slug) do update set status = 'active', deleted_at = null, updated_at = now()
     returning id`,
    ["成都云杉科技", "chengdu-yunshan"],
  );
  const organizationId = organization.rows[0].id;
  await client.query("select id from organizations where id = $1 for update", [organizationId]);
  const existing = await client.query(
    `select 1 from organization_memberships memberships
     join users on users.id = memberships.user_id join roles on roles.id = memberships.role_id
     where memberships.organization_id = $1 and memberships.status = 'active'
       and users.status in ('active','pending') and roles.code = 'admin' limit 1`,
    [organizationId],
  );
  if (existing.rowCount) throw new Error("An Admin already exists. Use auth:reset for recovery.");
  const role = await client.query("select id from roles where organization_id is null and code = 'admin' limit 1");
  if (!role.rows[0]) throw new Error("Run npm run db:migrate before auth:bootstrap.");
  const email = `${username.toLowerCase()}@chengdu-yunshan.local`;
  const user = await client.query(
    `insert into users (email, username, display_name, password_hash, password_updated_at, status)
     values ($1,$2,$3,$4,now(),'active') returning id`,
    [email, username, username, await hashPassword(password)],
  );
  await client.query(
    "insert into organization_memberships (organization_id,user_id,role_id,status) values ($1,$2,$3,'active')",
    [organizationId, user.rows[0].id, role.rows[0].id],
  );
  await client.query(
    "insert into auth_events (organization_id,subject_user_id,event_type,severity,metadata) values ($1,$2,'admin.bootstrapped','critical',$3)",
    [organizationId, user.rows[0].id, JSON.stringify({ source: "cli" })],
  );
  await client.query("commit");
  console.log(`Admin ${username} created.`);
} catch (error) {
  await client.query("rollback");
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}

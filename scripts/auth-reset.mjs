import { existsSync, readFileSync } from "fs";
import { randomBytes, scrypt } from "crypto";
import { Pool } from "pg";

if (existsSync("local.env")) {
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

const username = process.argv[2];
const temporaryPassword = process.argv[3] || randomBytes(15).toString("base64url");
const databaseUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!username || !databaseUrl) {
  console.error("Usage: npm run auth:reset -- <admin-username> [temporary-password]");
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl });
const client = await pool.connect();
try {
  await client.query("begin");
  const admin = await client.query(
    `select users.id, memberships.organization_id
     from users join organization_memberships memberships on memberships.user_id = users.id
     join roles on roles.id = memberships.role_id
     where lower(users.username) = lower($1) and roles.code = 'admin'
     limit 1 for update of users`,
    [username],
  );
  if (!admin.rows[0]) throw new Error("Admin account not found.");
  await client.query(
    `update users set password_hash = $2, password_updated_at = now(), must_change_password = true,
       temporary_password_expires_at = now() + interval '24 hours', mfa_enabled = false,
       status = 'pending', disabled_at = null, updated_at = now() where id = $1`,
    [admin.rows[0].id, await hashPassword(temporaryPassword)],
  );
  await client.query("delete from user_mfa_methods where user_id = $1", [admin.rows[0].id]);
  await client.query("delete from user_recovery_codes where user_id = $1", [admin.rows[0].id]);
  await client.query("update user_sessions set revoked_at = now(), revoke_reason = 'admin_recovery' where user_id = $1 and revoked_at is null", [admin.rows[0].id]);
  await client.query(
    "insert into auth_events (organization_id,subject_user_id,event_type,severity,metadata) values ($1,$2,'admin.recovered','critical',$3)",
    [admin.rows[0].organization_id, admin.rows[0].id, JSON.stringify({ source: "cli" })],
  );
  await client.query("commit");
  console.log(`Temporary password for ${username}: ${temporaryPassword}`);
  console.log("It expires in 24 hours and must be changed at first login.");
} catch (error) {
  await client.query("rollback");
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}

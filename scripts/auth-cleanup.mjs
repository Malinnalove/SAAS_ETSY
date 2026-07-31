import { existsSync, readFileSync } from "fs";
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
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  const attempts = await pool.query("delete from auth_login_attempts where created_at < now() - interval '30 days'");
  const sessions = await pool.query(
    `delete from user_sessions
     where coalesce(revoked_at, absolute_expires_at) < now() - interval '30 days'`,
  );
  const events = await pool.query("delete from auth_events where created_at < now() - interval '180 days'");
  const challenges = await pool.query("delete from mfa_challenges where expires_at < now() - interval '1 day'");
  console.log(JSON.stringify({
    authEvents: events.rowCount,
    loginAttempts: attempts.rowCount,
    mfaChallenges: challenges.rowCount,
    sessions: sessions.rowCount,
  }));
} finally {
  await pool.end();
}

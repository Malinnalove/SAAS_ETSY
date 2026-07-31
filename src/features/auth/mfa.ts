import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import * as OTPAuth from "otpauth";
import QRCode from "qrcode";
import {
  getAuthIdentity,
  getAuthPool,
  recordAuthEvent,
  type AuthEventInput,
} from "@/features/auth/db";
import { verifyPassword } from "@/features/auth/password";
import {
  authSecret,
  challengeTokenHash,
  randomToken,
  recoveryCodeHash,
} from "@/features/auth/security";
import type { AuthIdentity } from "@/features/auth/types";

function encryptionKey() {
  return createHash("sha256").update(authSecret("AUTH_MFA_ENCRYPTION_KEY")).digest();
}

function encryptSecret(secret: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64url"),
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

function decryptSecret(row: { secret_ciphertext: string; secret_iv: string; secret_tag: string }) {
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(row.secret_iv, "base64url"));
  decipher.setAuthTag(Buffer.from(row.secret_tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(row.secret_ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function totpFor(identity: Pick<AuthIdentity, "organizationName" | "username">, secret: string) {
  return new OTPAuth.TOTP({
    algorithm: "SHA1",
    digits: 6,
    issuer: identity.organizationName,
    label: identity.username,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
}

function currentStep() {
  return Math.floor(Date.now() / 30_000);
}

function recoveryCodes() {
  return Array.from({ length: 10 }, () => {
    const raw = randomBytes(9).toString("base64url").replace(/[-_]/g, "A").toUpperCase().slice(0, 12);
    return raw.match(/.{1,4}/g)?.join("-") ?? raw;
  });
}

export async function verifyCurrentPassword(userId: number, password: string) {
  const result = await getAuthPool().query<{ password_hash: string | null }>(
    "select password_hash from users where id = $1 and status in ('active','pending') limit 1",
    [userId],
  );
  return verifyPassword(password, result.rows[0]?.password_hash);
}

export async function beginMfaSetup(identity: AuthIdentity) {
  if (identity.role !== "admin") throw new Error("只有 Admin 可以启用两步验证。");
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const encrypted = encryptSecret(secret);
  await getAuthPool().query(
    `insert into user_mfa_methods (user_id, secret_ciphertext, secret_iv, secret_tag, key_version, verified_at, updated_at)
     values ($1,$2,$3,$4,1,null,now())
     on conflict (user_id) do update set
       secret_ciphertext = excluded.secret_ciphertext,
       secret_iv = excluded.secret_iv,
       secret_tag = excluded.secret_tag,
       key_version = excluded.key_version,
       verified_at = null,
       last_used_step = null,
       updated_at = now()`,
    [identity.userId, encrypted.ciphertext, encrypted.iv, encrypted.tag],
  );
  const uri = totpFor(identity, secret).toString();
  await recordAuthEvent({
    actorUserId: identity.userId,
    eventType: "mfa.setup_started",
    organizationId: identity.organizationId,
    subjectUserId: identity.userId,
  });
  return { qrDataUrl: await QRCode.toDataURL(uri, { errorCorrectionLevel: "M", margin: 1, width: 240 }), secret };
}

export async function getPendingMfaSetup(identity: AuthIdentity) {
  const result = await getAuthPool().query<{
    updated_at: Date;
    secret_ciphertext: string;
    secret_iv: string;
    secret_tag: string;
    verified_at: Date | null;
  }>(
    `select secret_ciphertext, secret_iv, secret_tag, verified_at, updated_at
     from user_mfa_methods where user_id = $1 limit 1`,
    [identity.userId],
  );
  const row = result.rows[0];
  if (!row || row.verified_at || Date.now() - new Date(row.updated_at).getTime() > 10 * 60 * 1000) return null;
  const secret = decryptSecret(row);
  const uri = totpFor(identity, secret).toString();
  return { qrDataUrl: await QRCode.toDataURL(uri, { errorCorrectionLevel: "M", margin: 1, width: 240 }), secret };
}

export async function confirmMfaSetup(identity: AuthIdentity, token: string) {
  if (!/^\d{6}$/.test(token)) throw new Error("请输入 6 位动态码。");
  const client = await getAuthPool().connect();
  try {
    await client.query("begin");
    const result = await client.query<{
      updated_at: Date;
      secret_ciphertext: string;
      secret_iv: string;
      secret_tag: string;
      verified_at: Date | null;
    }>(
      `select secret_ciphertext, secret_iv, secret_tag, verified_at, updated_at
       from user_mfa_methods where user_id = $1 for update`,
      [identity.userId],
    );
    const row = result.rows[0];
    if (!row || row.verified_at || Date.now() - new Date(row.updated_at).getTime() > 10 * 60 * 1000) {
      throw new Error("两步验证设置已过期，请重新开始。");
    }
    const delta = totpFor(identity, decryptSecret(row)).validate({ token, window: 1 });
    if (delta === null) throw new Error("动态码不正确。");
    const step = currentStep() + delta;
    const codes = recoveryCodes();
    await client.query(
      "update user_mfa_methods set verified_at = now(), last_used_step = $2, updated_at = now() where user_id = $1",
      [identity.userId, step],
    );
    await client.query("update users set mfa_enabled = true, updated_at = now() where id = $1", [identity.userId]);
    await client.query("delete from user_recovery_codes where user_id = $1", [identity.userId]);
    for (const code of codes) {
      await client.query(
        "insert into user_recovery_codes (user_id, code_hash) values ($1,$2)",
        [identity.userId, recoveryCodeHash(identity.userId, code)],
      );
    }
    await recordAuthEvent({ actorUserId: identity.userId, eventType: "mfa.enabled", organizationId: identity.organizationId, subjectUserId: identity.userId }, client);
    await client.query("commit");
    return codes;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function createMfaChallenge(identity: AuthIdentity) {
  const token = randomToken(32);
  const id = randomToken(18);
  await getAuthPool().query(
    `insert into mfa_challenges (id, user_id, organization_id, token_hash, expires_at)
     values ($1,$2,$3,$4,now() + interval '5 minutes')`,
    [id, identity.userId, identity.organizationId, challengeTokenHash(token)],
  );
  return token;
}

async function verifyRecoveryCode(userId: number, code: string, client: import("pg").PoolClient) {
  const result = await client.query<{ id: string }>(
    `select id from user_recovery_codes
     where user_id = $1 and code_hash = $2 and used_at is null
     limit 1 for update`,
    [userId, recoveryCodeHash(userId, code)],
  );
  if (!result.rows[0]) return false;
  await client.query("update user_recovery_codes set used_at = now() where id = $1", [result.rows[0].id]);
  return true;
}

export async function verifyMfaChallenge(input: {
  audit: Omit<AuthEventInput, "eventType" | "organizationId" | "subjectUserId">;
  code: string;
  rawChallenge: string;
}) {
  const client = await getAuthPool().connect();
  try {
    await client.query("begin");
    const challenge = await client.query<{
      attempts: number;
      id: string;
      organization_id: string;
      user_id: string;
    }>(
      `select id, user_id, organization_id, attempts
       from mfa_challenges
       where token_hash = $1 and consumed_at is null and expires_at > now() and attempts < 5
       for update`,
      [challengeTokenHash(input.rawChallenge)],
    );
    const row = challenge.rows[0];
    if (!row) throw new Error("验证已过期，请重新登录。");
    await client.query("update mfa_challenges set attempts = attempts + 1 where id = $1", [row.id]);
    const userId = Number(row.user_id);
    const organizationId = Number(row.organization_id);
    const identity = await getAuthIdentity(userId, organizationId, client as unknown as import("pg").Pool);
    if (!identity || !identity.mfaEnabled || identity.role !== "admin") throw new Error("验证已失效。");

    let valid = false;
    if (/^\d{6}$/.test(input.code)) {
      const method = await client.query<{
        last_used_step: string | null;
        secret_ciphertext: string;
        secret_iv: string;
        secret_tag: string;
      }>(
        `select secret_ciphertext, secret_iv, secret_tag, last_used_step
         from user_mfa_methods where user_id = $1 and verified_at is not null for update`,
        [userId],
      );
      if (method.rows[0]) {
        const delta = totpFor(identity, decryptSecret(method.rows[0])).validate({ token: input.code, window: 1 });
        const step = delta === null ? null : currentStep() + delta;
        if (step !== null && step > Number(method.rows[0].last_used_step ?? -1)) {
          await client.query("update user_mfa_methods set last_used_step = $2, updated_at = now() where user_id = $1", [userId, step]);
          valid = true;
        }
      }
    } else {
      valid = await verifyRecoveryCode(userId, input.code, client);
    }

    if (!valid) {
      await recordAuthEvent({ ...input.audit, eventType: "mfa.failed", organizationId, severity: "warning", subjectUserId: userId }, client);
      await client.query("commit");
      throw new Error("动态码或恢复码不正确。");
    }
    await client.query("update mfa_challenges set consumed_at = now() where id = $1", [row.id]);
    await recordAuthEvent({ ...input.audit, eventType: "mfa.verified", organizationId, subjectUserId: userId }, client);
    await client.query("commit");
    return identity;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function disableMfa(identity: AuthIdentity, password: string, token: string) {
  if (!(await verifyCurrentPassword(identity.userId, password))) throw new Error("当前密码不正确。");
  const client = await getAuthPool().connect();
  try {
    await client.query("begin");
    const method = await client.query<{
      last_used_step: string | null;
      secret_ciphertext: string;
      secret_iv: string;
      secret_tag: string;
    }>(
      `select secret_ciphertext, secret_iv, secret_tag, last_used_step
       from user_mfa_methods where user_id = $1 and verified_at is not null for update`,
      [identity.userId],
    );
    const row = method.rows[0];
    if (!row) throw new Error("两步验证尚未启用。");
    const delta = /^\d{6}$/.test(token)
      ? totpFor(identity, decryptSecret(row)).validate({ token, window: 1 })
      : null;
    const step = delta === null ? null : currentStep() + delta;
    if (step === null || step <= Number(row.last_used_step ?? -1)) throw new Error("动态码不正确或已使用。");
    await client.query("delete from user_mfa_methods where user_id = $1", [identity.userId]);
    await client.query("delete from user_recovery_codes where user_id = $1", [identity.userId]);
    await client.query("update users set mfa_enabled = false, updated_at = now() where id = $1", [identity.userId]);
    await recordAuthEvent({ actorUserId: identity.userId, eventType: "mfa.disabled", organizationId: identity.organizationId, severity: "warning", subjectUserId: identity.userId }, client);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function verifyMfaForStepUp(identity: AuthIdentity, token: string) {
  if (!/^\d{6}$/.test(token)) return false;
  const client = await getAuthPool().connect();
  try {
    await client.query("begin");
    const method = await client.query<{
      last_used_step: string | null;
      secret_ciphertext: string;
      secret_iv: string;
      secret_tag: string;
    }>(
      `select secret_ciphertext, secret_iv, secret_tag, last_used_step
       from user_mfa_methods where user_id = $1 and verified_at is not null for update`,
      [identity.userId],
    );
    const row = method.rows[0];
    if (!row) {
      await client.query("rollback");
      return false;
    }
    const delta = totpFor(identity, decryptSecret(row)).validate({ token, window: 1 });
    const step = delta === null ? null : currentStep() + delta;
    if (step === null || step <= Number(row.last_used_step ?? -1)) {
      await client.query("rollback");
      return false;
    }
    await client.query("update user_mfa_methods set last_used_step = $2, updated_at = now() where user_id = $1", [identity.userId, step]);
    await client.query("commit");
    return true;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function regenerateRecoveryCodes(identity: AuthIdentity, password: string, token: string) {
  if (!(await verifyCurrentPassword(identity.userId, password))) throw new Error("当前密码不正确。");
  const client = await getAuthPool().connect();
  try {
    await client.query("begin");
    const method = await client.query<{
      last_used_step: string | null;
      secret_ciphertext: string;
      secret_iv: string;
      secret_tag: string;
    }>(
      `select secret_ciphertext, secret_iv, secret_tag, last_used_step
       from user_mfa_methods where user_id = $1 and verified_at is not null for update`,
      [identity.userId],
    );
    const row = method.rows[0];
    if (!row) throw new Error("两步验证尚未启用。");
    const delta = /^\d{6}$/.test(token)
      ? totpFor(identity, decryptSecret(row)).validate({ token, window: 1 })
      : null;
    const step = delta === null ? null : currentStep() + delta;
    if (step === null || step <= Number(row.last_used_step ?? -1)) throw new Error("动态码不正确或已使用。");
    const codes = recoveryCodes();
    await client.query("update user_mfa_methods set last_used_step = $2, updated_at = now() where user_id = $1", [identity.userId, step]);
    await client.query("delete from user_recovery_codes where user_id = $1", [identity.userId]);
    for (const code of codes) {
      await client.query("insert into user_recovery_codes (user_id, code_hash) values ($1,$2)", [identity.userId, recoveryCodeHash(identity.userId, code)]);
    }
    await recordAuthEvent({ actorUserId: identity.userId, eventType: "mfa.recovery_codes_regenerated", organizationId: identity.organizationId, severity: "warning", subjectUserId: identity.userId }, client);
    await client.query("commit");
    return codes;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

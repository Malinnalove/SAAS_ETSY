import { randomBytes, scrypt, timingSafeEqual } from "crypto";

const KEY_LENGTH = 64;
const CURRENT_SCRYPT_N = 131072;
const CURRENT_SCRYPT_R = 8;
const CURRENT_SCRYPT_P = 1;
const SCRYPT_MAXMEM = 192 * 1024 * 1024;
const DUMMY_PASSWORD_HASH =
  "scrypt$131072$8$1$EO8lZGDgByb5cMlx6Fo4Iw$fDQvcdZ-FUmRht5q8pDXGckWHwv7bygr0sIL3wZVY9fCCwPLF0nX3YHbQRI7fEyhK9CCzmjsiqUyruDv6KaPvg";

const ALLOWED_PARAMETERS = new Set([
  "16384:8:1", // Legacy hashes created by this project.
  `${CURRENT_SCRYPT_N}:${CURRENT_SCRYPT_R}:${CURRENT_SCRYPT_P}`,
]);

const COMMON_PASSWORDS = new Set([
  "123456789012",
  "administrator",
  "password1234",
  "qwertyuiop12",
  "letmein123456",
  "welcome12345",
]);

type ScryptOptions = { N: number; p: number; r: number };

function deriveKey(password: string, salt: string, options: ScryptOptions) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, { ...options, maxmem: SCRYPT_MAXMEM }, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    });
  });
}

function parsePasswordHash(passwordHash: string | null | undefined) {
  if (!passwordHash) return null;
  const parts = passwordHash.split("$");
  if (parts.length !== 6) return null;
  const [algorithm, rawN, rawR, rawP, salt, encodedKey] = parts;
  if (algorithm !== "scrypt" || !salt || !encodedKey) return null;

  const options = { N: Number(rawN), r: Number(rawR), p: Number(rawP) };
  if (!ALLOWED_PARAMETERS.has(`${options.N}:${options.r}:${options.p}`)) return null;

  const expectedKey = Buffer.from(encodedKey, "base64url");
  if (expectedKey.length !== KEY_LENGTH) return null;

  return { expectedKey, options, salt };
}

export function assertPasswordPolicy(password: string, username?: string) {
  if (password.length < 12 || password.length > 128) {
    throw new Error("密码长度必须为 12–128 个字符。");
  }
  if (username && password.toLowerCase() === username.trim().toLowerCase()) {
    throw new Error("密码不能与账号相同。");
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    throw new Error("该密码过于常见，请使用更长且唯一的密码。");
  }
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("base64url");
  const options = { N: CURRENT_SCRYPT_N, r: CURRENT_SCRYPT_R, p: CURRENT_SCRYPT_P };
  const derivedKey = await deriveKey(password, salt, options);
  return ["scrypt", options.N, options.r, options.p, salt, derivedKey.toString("base64url")].join("$");
}

export async function verifyPasswordDetailed(password: string, passwordHash: string | null | undefined) {
  const parsed = parsePasswordHash(passwordHash);
  if (!parsed) return { needsRehash: false, valid: false };

  const actualKey = await deriveKey(password, parsed.salt, parsed.options);
  const valid = timingSafeEqual(parsed.expectedKey, actualKey);
  return {
    needsRehash:
      valid &&
      (parsed.options.N !== CURRENT_SCRYPT_N ||
        parsed.options.r !== CURRENT_SCRYPT_R ||
        parsed.options.p !== CURRENT_SCRYPT_P),
    valid,
  };
}

export async function verifyPassword(password: string, passwordHash: string | null | undefined) {
  return (await verifyPasswordDetailed(password, passwordHash)).valid;
}

export async function consumeDummyPasswordCheck(password: string) {
  await verifyPasswordDetailed(password, DUMMY_PASSWORD_HASH);
}

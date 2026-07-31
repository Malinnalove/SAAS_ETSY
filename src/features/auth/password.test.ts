import { scrypt } from "crypto";
import { describe, expect, it } from "vitest";
import {
  assertPasswordPolicy,
  hashPassword,
  verifyPasswordDetailed,
} from "@/features/auth/password";

function legacyHash(password: string) {
  return new Promise<string>((resolve, reject) => {
    const salt = "legacy-test-salt";
    scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(`scrypt$16384$8$1$${salt}$${key.toString("base64url")}`);
    });
  });
}

describe("authentication password storage", () => {
  it("creates and verifies the current hardened scrypt format", async () => {
    const hash = await hashPassword("A-unique-password-for-tests-2026");
    expect(hash.startsWith("scrypt$131072$8$1$")).toBe(true);
    await expect(verifyPasswordDetailed("A-unique-password-for-tests-2026", hash)).resolves.toEqual({
      needsRehash: false,
      valid: true,
    });
  }, 15_000);

  it("accepts the project legacy hash only long enough to request rehashing", async () => {
    const hash = await legacyHash("Legacy-password-for-tests");
    await expect(verifyPasswordDetailed("Legacy-password-for-tests", hash)).resolves.toEqual({
      needsRehash: true,
      valid: true,
    });
  });

  it("rejects unapproved cost parameters before running scrypt", async () => {
    await expect(verifyPasswordDetailed("anything", "scrypt$1073741824$8$1$salt$bad")).resolves.toEqual({
      needsRehash: false,
      valid: false,
    });
  });

  it("enforces length, username and common-password rules", () => {
    expect(() => assertPasswordPolicy("short", "user")).toThrow();
    expect(() => assertPasswordPolicy("operator-account", "operator-account")).toThrow();
    expect(() => assertPasswordPolicy("password1234", "someone")).toThrow();
    expect(() => assertPasswordPolicy("A-long-and-unique-password-2026", "someone")).not.toThrow();
  });
});

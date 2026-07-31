import { randomBytes, scrypt } from "crypto";

const password = process.argv[2];

if (!password || password.length < 12 || password.length > 128) {
  console.error("Usage: node scripts/hash-admin-password.mjs <password>");
  process.exit(1);
}

const keyLength = 64;
const options = {
  N: 131072,
  p: 1,
  r: 8,
  maxmem: 192 * 1024 * 1024,
};
const salt = randomBytes(16).toString("base64url");

scrypt(password, salt, keyLength, options, (error, derivedKey) => {
  if (error) {
    console.error(error);
    process.exit(1);
  }

  console.log(["scrypt", String(options.N), String(options.r), String(options.p), salt, derivedKey.toString("base64url")].join("$"));
});

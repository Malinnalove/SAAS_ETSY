import crypto from "crypto";

function base64Url(buffer: Buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

export function createState() {
  return crypto.randomBytes(24).toString("hex");
}

export function createCodeVerifier() {
  return base64Url(crypto.randomBytes(64));
}

export function createCodeChallenge(codeVerifier: string) {
  return base64Url(crypto.createHash("sha256").update(codeVerifier).digest());
}

export function getUserIdFromAccessToken(accessToken: string) {
  const [userId] = accessToken.split(".");
  if (!userId) {
    throw new Error("Could not read Etsy user id from access token.");
  }
  return userId;
}

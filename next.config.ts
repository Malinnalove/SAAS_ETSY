import type { NextConfig } from "next";
import { existsSync, readFileSync } from "fs";

function loadLocalEnv() {
  if (!existsSync("local.env")) return;

  const lines = readFileSync("local.env", "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separatorMatch = /[=：:]/.exec(trimmed);
    if (!separatorMatch) continue;

    const separator = separatorMatch.index;
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    const value = rawValue.replace(/^["']|["']$/g, "");

    if (!process.env[key]) {
      process.env[key] = value;
    }

    const normalizedKey = key.toLowerCase().replace(/\s+/g, "_");
    if (normalizedKey === "keystring" && !process.env.ETSY_CLIENT_ID) {
      process.env.ETSY_CLIENT_ID = value;
    }
    if (normalizedKey === "shared_secret" && !process.env.ETSY_SHARED_SECRET) {
      process.env.ETSY_SHARED_SECRET = value;
    }
  }
}

loadLocalEnv();

const nextConfig: NextConfig = {};

export default nextConfig;

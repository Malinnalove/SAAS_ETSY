import { existsSync, readFileSync } from "fs";
import type { NextConfig } from "next";

const envFiles = [".env", ".env.local", "local.env"];

function parseEnvLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const withoutExport = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
  const separator = withoutExport.indexOf("=");
  if (separator <= 0) return null;

  const key = withoutExport.slice(0, separator).trim();
  const rawValue = withoutExport.slice(separator + 1).trim();

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;

  const quote = rawValue[0];
  const value =
    (quote === `"` || quote === `'`) && rawValue.endsWith(quote)
      ? rawValue.slice(1, -1)
      : rawValue;

  return { key, value };
}

function loadEnvFile(path: string) {
  if (!existsSync(path)) return;

  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const entry = parseEnvLine(line);
    if (!entry || entry.value === "") continue;

    process.env[entry.key] = entry.value;

    const normalizedKey = entry.key.toLowerCase().replace(/\s+/g, "_");
    if (normalizedKey === "keystring") {
      process.env.ETSY_CLIENT_ID = entry.value;
    }
    if (normalizedKey === "shared_secret") {
      process.env.ETSY_SHARED_SECRET = entry.value;
    }
  }
}

for (const envFile of envFiles) {
  loadEnvFile(envFile);
}

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
};

export default nextConfig;

import { describe, expect, it } from "vitest";
import {
  csrfTokenForPreAuth,
  csrfTokenForSession,
  readAuthForm,
  readAuthJson,
  safeEqual,
  validateRequestOrigin,
} from "@/features/auth/security";
import { safeReturnPath, validatePreAuthCsrf } from "@/features/auth/session";
import { AUTH_ROLE_PERMISSIONS, hasPermission, parseMemberShopAccess, type AuthIdentity } from "@/features/auth/types";

function identity(role: AuthIdentity["role"], permissions: AuthIdentity["permissions"]): AuthIdentity {
  return {
    displayName: null,
    mfaEnabled: false,
    mustChangePassword: false,
    organizationId: 1,
    organizationName: "Test",
    organizationSlug: "test",
    permissions,
    role,
    userId: 1,
    username: "test-user",
  };
}

describe("authentication request security", () => {
  it("rejects external and backslash redirects", () => {
    expect(safeReturnPath("https://example.com")).toBe("/dashboard");
    expect(safeReturnPath("//example.com/path")).toBe("/dashboard");
    expect(safeReturnPath("/\\example.com")).toBe("/dashboard");
    expect(safeReturnPath("/orders?status=open")).toBe("/orders?status=open");
  });

  it("requires an exact configured origin for unsafe requests", () => {
    expect(validateRequestOrigin(new Request("http://localhost:3000/test", {
      headers: { origin: "http://localhost:3000", "sec-fetch-site": "same-origin" },
      method: "POST",
    }))).toBe(true);
    expect(validateRequestOrigin(new Request("http://localhost:3000/test", {
      headers: { origin: "https://attacker.invalid", "sec-fetch-site": "cross-site" },
      method: "POST",
    }))).toBe(false);
  });

  it("binds the pre-auth csrf value to its http-only cookie", () => {
    const raw = "test-pre-auth-cookie-value";
    const request = new Request("http://localhost:3000/api/auth/login", {
      headers: { cookie: `erp_pre_auth=${raw}`, origin: "http://localhost:3000", "sec-fetch-site": "same-origin" },
      method: "POST",
    });
    expect(validatePreAuthCsrf(request, csrfTokenForPreAuth(raw))).toBe(true);
    expect(validatePreAuthCsrf(request, "wrong")).toBe(false);
  });

  it("binds a synchronizer csrf value to the opaque session token", () => {
    const raw = "opaque-session-token";
    const expected = csrfTokenForSession(raw);
    expect(safeEqual(csrfTokenForSession(raw), expected)).toBe(true);
    expect(safeEqual("wrong", expected)).toBe(false);
  });

  it("rejects auth bodies over 8 KB even without a content-length header", async () => {
    const oversizedForm = new Request("http://localhost:3000/api/auth/login", {
      body: new URLSearchParams({ password: "x".repeat(8 * 1024) }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    const oversizedJson = new Request("http://localhost:3000/api/auth/password/change", {
      body: JSON.stringify({ password: "x".repeat(8 * 1024) }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    await expect(readAuthForm(oversizedForm)).resolves.toBeNull();
    await expect(readAuthJson(oversizedJson)).resolves.toBeNull();
  });

  it("keeps admin omnipotent while operator and viewer use explicit permissions", () => {
    expect(AUTH_ROLE_PERMISSIONS.admin).toHaveLength(10);
    expect(AUTH_ROLE_PERMISSIONS.operator).toEqual([
      "dashboard.read", "products.read", "listings.read", "listings.write",
      "orders.read", "orders.operate", "sync.run",
    ]);
    expect(AUTH_ROLE_PERMISSIONS.viewer).toEqual([
      "dashboard.read", "products.read", "listings.read", "orders.read",
    ]);
    expect(hasPermission(identity("admin", []), "system.manage")).toBe(true);
    expect(hasPermission(identity("operator", ["listings.write"]), "listings.write")).toBe(true);
    expect(hasPermission(identity("operator", ["listings.write"]), "members.manage")).toBe(false);
    expect(hasPermission(identity("viewer", ["listings.read"]), "listings.write")).toBe(false);
  });

  it("normalizes member shop access without trusting malformed or duplicate entries", () => {
    expect(parseMemberShopAccess([
      { accessLevel: "view", shopId: 101 },
      { accessLevel: "edit", shopId: 101 },
      { accessLevel: "edit", shopId: 202 },
      { accessLevel: "owner", shopId: 303 },
      { accessLevel: "view", shopId: "not-a-shop" },
    ])).toEqual([
      { accessLevel: "edit", shopId: 101 },
      { accessLevel: "edit", shopId: 202 },
    ]);
  });
});

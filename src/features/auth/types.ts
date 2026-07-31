export const AUTH_ROLES = ["admin", "operator", "viewer"] as const;
export type AuthRole = (typeof AUTH_ROLES)[number];

export const AUTH_PERMISSIONS = [
  "dashboard.read",
  "products.read",
  "listings.read",
  "listings.write",
  "orders.read",
  "orders.operate",
  "sync.run",
  "shops.manage",
  "members.manage",
  "system.manage",
] as const;

export type AuthPermission = (typeof AUTH_PERMISSIONS)[number];

export const SHOP_ACCESS_LEVELS = ["view", "edit"] as const;
export type ShopAccessLevel = (typeof SHOP_ACCESS_LEVELS)[number];

export type MemberShopAccess = {
  accessLevel: ShopAccessLevel;
  shopId: number;
};

export function isShopAccessLevel(value: string): value is ShopAccessLevel {
  return SHOP_ACCESS_LEVELS.includes(value as ShopAccessLevel);
}

export function parseMemberShopAccess(value: unknown): MemberShopAccess[] {
  if (!Array.isArray(value)) return [];
  const accessByShop = new Map<number, ShopAccessLevel>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const shopId = Number("shopId" in entry ? entry.shopId : 0);
    const accessLevel = String("accessLevel" in entry ? entry.accessLevel : "");
    if (Number.isSafeInteger(shopId) && shopId > 0 && isShopAccessLevel(accessLevel)) {
      accessByShop.set(shopId, accessLevel);
    }
  }
  return Array.from(accessByShop, ([shopId, accessLevel]) => ({ accessLevel, shopId }));
}

export const AUTH_ROLE_PERMISSIONS: Record<AuthRole, readonly AuthPermission[]> = {
  admin: AUTH_PERMISSIONS,
  operator: [
    "dashboard.read",
    "products.read",
    "listings.read",
    "listings.write",
    "orders.read",
    "orders.operate",
    "sync.run",
  ],
  viewer: [
    "dashboard.read",
    "products.read",
    "listings.read",
    "orders.read",
  ],
};

export type AuthIdentity = {
  displayName: string | null;
  mfaEnabled: boolean;
  mustChangePassword: boolean;
  organizationId: number;
  organizationName: string;
  organizationSlug: string;
  permissions: AuthPermission[];
  role: AuthRole;
  userId: number;
  username: string;
};

export type AuthContext = AuthIdentity & {
  authenticatedAt: Date;
  csrfToken: string;
  sessionId: string;
};

export function isAuthRole(value: string): value is AuthRole {
  return AUTH_ROLES.includes(value as AuthRole);
}

export function isAuthPermission(value: string): value is AuthPermission {
  return AUTH_PERMISSIONS.includes(value as AuthPermission);
}

export function hasPermission(
  identity: Pick<AuthIdentity, "permissions" | "role">,
  permission: AuthPermission,
) {
  return identity.role === "admin" || identity.permissions.includes(permission);
}

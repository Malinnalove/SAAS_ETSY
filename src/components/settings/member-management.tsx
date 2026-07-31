"use client";

import { useActionState, useState } from "react";
import {
  createMemberAction,
  setMemberPasswordAction,
  updateMemberAction,
  type MemberActionState,
} from "@/features/auth/member-actions";
import type { MemberSummary } from "@/features/auth/db";
import { AUTH_ROLE_PERMISSIONS, type AuthPermission, type AuthRole, type MemberShopAccess } from "@/features/auth/types";

const initialState: MemberActionState = {};

const permissionLabels: Record<AuthPermission, string> = {
  "dashboard.read": "查看 Dashboard",
  "products.read": "查看商品",
  "listings.read": "查看 Listing",
  "listings.write": "编辑与发布 Listing",
  "orders.read": "查看订单",
  "orders.operate": "订单运营",
  "sync.run": "手动同步",
  "shops.manage": "管理店铺连接",
  "members.manage": "管理成员",
  "system.manage": "系统安全设置",
};

const roleLabels: Record<AuthRole, string> = {
  admin: "Admin",
  operator: "Operator",
  viewer: "Viewer",
};

type ShopOption = { shopId: number; shopName: string };

function PermissionList({ permissions }: { permissions: AuthPermission[] }) {
  return <div className="memberPermissionList" aria-label="已生效权限">
    {permissions.map((permission) => <span className="memberPermissionTag" key={permission}>{permissionLabels[permission]}</span>)}
  </div>;
}

function Result({ state }: { state: MemberActionState }) {
  if (!state.error && !state.message) return null;
  return (
    <div className={state.error ? "notice errorNotice" : "notice successNotice"} role="status">
      {state.error ?? state.message}
      {state.temporaryPassword ? (
        <div><strong>临时密码：</strong><code>{state.temporaryPassword}</code></div>
      ) : null}
    </div>
  );
}

function ShopAccessFields({
  access,
  formId,
  role,
  shops,
}: {
  access: MemberShopAccess[];
  formId?: string;
  role: Exclude<AuthRole, "admin">;
  shops: ShopOption[];
}) {
  const accessByShop = new Map(access.map((entry) => [entry.shopId, entry.accessLevel]));
  return <fieldset className="memberShopAccess">
    <legend>店铺访问权限</legend>
    <p>无权限的店铺不会出现在该账号的工作区；可编辑同时包含查看、Listing 修改、订单运营和手动同步。</p>
    {shops.length ? <div className="memberShopAccessGrid">{shops.map((shop) => {
      const current = accessByShop.get(shop.shopId) ?? "none";
      const defaultValue = role === "viewer" && current === "edit" ? "view" : current;
      return <label className="memberShopAccessRow" key={`${role}-${shop.shopId}`}>
        <span><strong>{shop.shopName}</strong><small>Shop ID {shop.shopId}</small></span>
        <select defaultValue={defaultValue} form={formId} name={`shopAccess.${shop.shopId}`}>
          <option value="none">无权限</option>
          <option value="view">可查看</option>
          {role === "operator" ? <option value="edit">可编辑</option> : null}
        </select>
      </label>;
    })}</div> : <div className="emptyText">尚未连接可分配的店铺。</div>}
  </fieldset>;
}

function MemberRow({ csrfToken, member, shops }: { csrfToken: string; member: MemberSummary; shops: ShopOption[] }) {
  const [updateState, updateAction, updating] = useActionState(updateMemberAction, initialState);
  const [passwordState, passwordAction, settingPassword] = useActionState(setMemberPasswordAction, initialState);
  const [role, setRole] = useState<Exclude<AuthRole, "admin">>(member.role === "viewer" ? "viewer" : "operator");
  const updateFormId = `member-update-${member.userId}`;
  if (member.role === "admin") {
    return (
      <div className="settingsRow memberManagementRow adminMemberRow">
        <div className="memberIdentity"><strong>{member.displayName ?? member.username}</strong><small>{member.username} · 唯一 Admin · 全部权限</small><PermissionList permissions={member.permissions} /></div>
        <span className="statusBadge success">active</span>
      </div>
    );
  }
  return (
    <div className="settingsRow memberManagementRow">
      <div className="memberAccountColumn">
        <div className="memberIdentity"><strong>{member.displayName ?? member.username}</strong><small>{member.username} · {roleLabels[member.role]} · 最近登录 {member.lastLoginAt ? new Date(member.lastLoginAt).toLocaleString() : "从未"}</small><PermissionList permissions={member.permissions} /></div>
        <form action={updateAction} className="memberAccountForm" id={updateFormId}>
          <input name="_csrf" type="hidden" value={csrfToken} />
          <input name="userId" type="hidden" value={member.userId} />
          <label className="formField"><span>角色</span><select name="role" onChange={(event) => setRole(event.target.value as Exclude<AuthRole, "admin">)} value={role}><option value="operator">Operator</option><option value="viewer">Viewer</option></select></label>
          <label className="formField"><span>账号状态</span><select defaultValue={member.status === "disabled" ? "disabled" : "active"} name="status"><option value="active">启用</option><option value="disabled">禁用</option></select></label>
          <button disabled={updating} type="submit">{updating ? "保存中…" : "保存"}</button>
        </form>
        <Result state={updateState} />
        <form action={passwordAction} className="memberPasswordForm">
          <input name="_csrf" type="hidden" value={csrfToken} />
          <input name="userId" type="hidden" value={member.userId} />
          <div className="memberPasswordHeading"><strong>设置登录密码</strong><small>12–128 个字符；保存后旧会话会立即撤销。</small></div>
          <label className="formField"><span>新密码</span><input autoComplete="new-password" maxLength={128} minLength={12} name="password" required type="password" /></label>
          <label className="formField"><span>确认密码</span><input autoComplete="new-password" maxLength={128} minLength={12} name="confirmPassword" required type="password" /></label>
          <button className="secondary" disabled={settingPassword} type="submit">{settingPassword ? "设置中…" : "设置密码"}</button>
        </form>
        <Result state={passwordState} />
      </div>
      <ShopAccessFields access={member.shopAccess} formId={updateFormId} role={role} shops={shops} />
    </div>
  );
}

export function MemberManagement({ csrfToken, members, shops }: { csrfToken: string; members: MemberSummary[]; shops: ShopOption[] }) {
  const [createState, createAction, creating] = useActionState(createMemberAction, initialState);
  const [createRole, setCreateRole] = useState<Exclude<AuthRole, "admin">>("operator");
  return (
    <div className="memberManagement">
      <div className="panel settingsPanel">
        <div className="panelHeader"><div><span className="tinyLabel">固定权限矩阵</span><h2>权限随角色自动生效</h2></div></div>
        <p className="emptyText">功能权限由角色固定；店铺范围由 Admin 为每个账号单独设置为无权限、可查看或可编辑。修改后会立即撤销该成员的旧会话。</p>
        <div className="memberRoleMatrix">
          {(["admin", "operator", "viewer"] as const).map((role) => {
            return <div className="memberRoleCard" key={role}><strong>{roleLabels[role]}</strong><PermissionList permissions={[...AUTH_ROLE_PERMISSIONS[role]]} /></div>;
          })}
        </div>
      </div>
      <div className="panel settingsPanel">
        <div className="panelHeader"><div><span className="tinyLabel">内部账号</span><h2>创建成员</h2></div></div>
        <form action={createAction} className="enterpriseForm memberCreateForm">
          <input name="_csrf" type="hidden" value={csrfToken} />
          <label className="formField"><span>账号</span><input autoComplete="off" name="username" required /></label>
          <label className="formField"><span>显示名</span><input name="displayName" /></label>
          <label className="formField"><span>角色</span><select name="role" onChange={(event) => setCreateRole(event.target.value as Exclude<AuthRole, "admin">)} value={createRole}><option value="operator">Operator</option><option value="viewer">Viewer</option></select></label>
          <label className="formField"><span>登录密码</span><input autoComplete="new-password" maxLength={128} minLength={12} name="password" required type="password" /></label>
          <label className="formField"><span>确认密码</span><input autoComplete="new-password" maxLength={128} minLength={12} name="confirmPassword" required type="password" /></label>
          <ShopAccessFields access={[]} role={createRole} shops={shops} />
          <button disabled={creating} type="submit">{creating ? "创建中…" : "创建成员"}</button>
        </form>
        <Result state={createState} />
      </div>
      <div className="panel settingsPanel">
        <div className="panelHeader"><div><span className="tinyLabel">账号与角色</span><h2>成员列表</h2></div></div>
        <div className="settingsRows">{members.map((member) => <MemberRow csrfToken={csrfToken} key={member.userId} member={member} shops={shops} />)}</div>
      </div>
    </div>
  );
}

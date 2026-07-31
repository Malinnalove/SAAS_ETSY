"use client";

import { useActionState } from "react";
import { confirmMfaSetupAction, disableMfaAction, regenerateRecoveryCodesAction, type MfaActionState } from "@/features/auth/mfa-actions";

const initialState: MfaActionState = {};

function Result({ state }: { state: MfaActionState }) {
  if (!state.error && !state.message) return null;
  return <div className={state.error ? "notice errorNotice" : "notice successNotice"} role="status">
    {state.error ?? state.message}
    {state.recoveryCodes ? <div className="recoveryCodeGrid">{state.recoveryCodes.map((code) => <code key={code}>{code}</code>)}</div> : null}
  </div>;
}

export function ConfirmMfaForm({ csrfToken }: { csrfToken: string }) {
  const [state, action, pending] = useActionState(confirmMfaSetupAction, initialState);
  return <form action={action} className="enterpriseForm">
    <input name="_csrf" type="hidden" value={csrfToken} />
    <label className="formField"><span>验证器中的 6 位动态码</span><input autoComplete="one-time-code" maxLength={6} name="token" pattern="[0-9]{6}" required /></label>
    <button disabled={pending} type="submit">{pending ? "验证中…" : "确认启用"}</button>
    <Result state={state} />
  </form>;
}

export function DisableMfaForm({ csrfToken }: { csrfToken: string }) {
  const [state, action, pending] = useActionState(disableMfaAction, initialState);
  const [recoveryState, recoveryAction, recoveryPending] = useActionState(regenerateRecoveryCodesAction, initialState);
  return <div className="enterpriseForms"><form action={action} className="enterpriseForm">
    <input name="_csrf" type="hidden" value={csrfToken} />
    <label className="formField"><span>当前密码</span><input autoComplete="current-password" name="password" required type="password" /></label>
    <label className="formField"><span>当前动态码</span><input autoComplete="one-time-code" maxLength={6} name="token" pattern="[0-9]{6}" required /></label>
    <button className="secondary" disabled={pending} type="submit">{pending ? "处理中…" : "关闭两步验证"}</button>
    <Result state={state} />
  </form><form action={recoveryAction} className="enterpriseForm">
    <input name="_csrf" type="hidden" value={csrfToken} />
    <label className="formField"><span>当前密码</span><input autoComplete="current-password" name="password" required type="password" /></label>
    <label className="formField"><span>当前动态码</span><input autoComplete="one-time-code" maxLength={6} name="token" pattern="[0-9]{6}" required /></label>
    <button className="secondary" disabled={recoveryPending} type="submit">{recoveryPending ? "处理中…" : "重新生成恢复码"}</button>
    <Result state={recoveryState} />
  </form></div>;
}

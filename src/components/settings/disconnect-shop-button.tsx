"use client";

import { useRef } from "react";
import { Trash2, X } from "lucide-react";

type DisconnectShopButtonProps = {
  actionUrl: string;
  cancelLabel: string;
  confirmDescription: string;
  confirmLabel: string;
  confirmTitle: string;
  disconnectLabel: string;
  csrfToken: string;
  shopName: string;
};

export function DisconnectShopButton({
  actionUrl,
  cancelLabel,
  confirmDescription,
  confirmLabel,
  confirmTitle,
  disconnectLabel,
  csrfToken,
  shopName,
}: DisconnectShopButtonProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  return (
    <>
      <button className="button quiet dangerOutline" type="button" onClick={() => dialogRef.current?.showModal()}>
        <Trash2 aria-hidden="true" size={15} />
        {disconnectLabel}
      </button>

      <dialog className="confirmDialog" ref={dialogRef} aria-label={confirmTitle}>
        <div className="confirmDialogHeader">
          <div>
            <span className="tinyLabel">{disconnectLabel}</span>
            <h2>{confirmTitle}</h2>
          </div>
          <button className="iconButton" type="button" onClick={() => dialogRef.current?.close()} aria-label={cancelLabel}>
            <X aria-hidden="true" size={16} />
          </button>
        </div>

        <p>{confirmDescription}</p>
        <small>{shopName}</small>

        <div className="confirmDialogActions">
          <button className="button quiet" type="button" onClick={() => dialogRef.current?.close()}>
            {cancelLabel}
          </button>
          <form action={actionUrl} method="post">
            <input name="_csrf" type="hidden" value={csrfToken} />
            <button className="button danger" type="submit">
              {confirmLabel}
            </button>
          </form>
        </div>
      </dialog>
    </>
  );
}

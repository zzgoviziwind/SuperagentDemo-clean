import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function Modal({ className, labelledBy, onClose, busy, children }: {
  className: string;
  labelledBy: string;
  onClose: () => void;
  busy?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useLayoutEffect(() => {
    const dialog = ref.current!;
    // Set native autofocus before showModal, which records the invoking focus.
    dialog.querySelector("[data-dialog-autofocus]")?.setAttribute("autofocus", "");
    dialog.showModal();
    return () => dialog.close();
  }, []);

  return createPortal(
    <dialog ref={ref} className={className} aria-labelledby={labelledBy} onCancel={event => {
      event.preventDefault();
      if (!busy) onClose();
    }}>
      {children}
    </dialog>,
    document.body,
  );
}

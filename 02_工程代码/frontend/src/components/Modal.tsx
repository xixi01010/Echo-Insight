import { useEffect, type PropsWithChildren } from "react";
import { createPortal } from "react-dom";
import { AppIcon } from "./AppIcon";

interface ModalProps extends PropsWithChildren {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
}

export function Modal({ children, description, onClose, open, title }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    document.body.classList.add("modal-open");
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.classList.remove("modal-open");
    };
  }, [onClose, open]);

  if (!open) return null;
  return createPortal(
    <div className="modal-layer" role="presentation">
      <button aria-label="关闭弹窗" className="modal-backdrop" onClick={onClose} type="button" />
      <section aria-describedby={description ? "modal-description" : undefined} aria-modal="true" className="modal-card" role="dialog">
        <header className="modal-card__header">
          <div><h2>{title}</h2>{description ? <p id="modal-description">{description}</p> : null}</div>
          <button aria-label="关闭" className="icon-button" onClick={onClose} type="button"><AppIcon name="close" /></button>
        </header>
        {children}
      </section>
    </div>,
    document.body,
  );
}

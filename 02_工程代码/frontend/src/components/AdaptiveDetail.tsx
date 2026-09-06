import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AppIcon } from "./AppIcon";

export function useIsMobileDetail(): boolean {
  const [isMobile, setIsMobile] = useState(() => (
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(max-width: 768px)").matches
      : false
  ));
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(max-width: 768px)");
    const update = () => setIsMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return isMobile;
}

export function AnimatedDisclosure({ children, id, open }: { children: ReactNode; id: string; open: boolean }) {
  return (
    <div aria-hidden={!open} className={`animated-disclosure ${open ? "is-open" : ""}`} id={id} inert={open ? undefined : true}>
      <div className="animated-disclosure__inner">{children}</div>
    </div>
  );
}

export function DetailDrawer({ children, onClose, open, title }: { children: ReactNode; onClose: () => void; open: boolean; title: string }) {
  const panelRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const body = document.body;
    const documentElement = document.documentElement;
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const previousBodyStyle = {
      left: body.style.left,
      overflow: body.style.overflow,
      position: body.style.position,
      right: body.style.right,
      top: body.style.top,
      width: body.style.width,
    };
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    body.style.left = `-${scrollX}px`;
    body.style.overflow = "hidden";
    body.style.position = "fixed";
    body.style.right = "0";
    body.style.top = `-${scrollY}px`;
    body.style.width = "100%";
    const panel = panelRef.current;
    const focusable = getFocusable(panel);
    (focusable[0] ?? panel)?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if ((event.key === "PageDown" || event.key === "PageUp") && panel?.contains(document.activeElement)) {
        const content = contentRef.current;
        if (!content) return;
        event.preventDefault();
        content.scrollBy({
          behavior: "auto",
          top: (event.key === "PageDown" ? 1 : -1) * Math.max(1, content.clientHeight - 32),
        });
        return;
      }
      if (event.key !== "Tab") return;
      const items = getFocusable(panel);
      if (!items.length) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (!panel?.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      body.style.left = previousBodyStyle.left;
      body.style.overflow = previousBodyStyle.overflow;
      body.style.position = previousBodyStyle.position;
      body.style.right = previousBodyStyle.right;
      body.style.top = previousBodyStyle.top;
      body.style.width = previousBodyStyle.width;
      const previousScrollBehavior = documentElement.style.scrollBehavior;
      documentElement.style.scrollBehavior = "auto";
      window.scrollTo(scrollX, scrollY);
      documentElement.style.scrollBehavior = previousScrollBehavior;
      if (previousFocusRef.current?.isConnected) previousFocusRef.current.focus();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div className="detail-drawer-layer">
      <button aria-label="关闭详情" className="detail-drawer-backdrop" onClick={onClose} type="button" />
      <aside aria-label={`${title}详情`} aria-modal="true" className="detail-drawer" ref={panelRef} role="dialog" tabIndex={-1}>
        <header>
          <div><p className="section-kicker">详情</p><h2>{title}</h2></div>
          <button aria-label="关闭详情" className="detail-drawer__close" onClick={onClose} type="button"><AppIcon name="close" /></button>
        </header>
        <div className="detail-drawer__content" ref={contentRef}>{children}</div>
      </aside>
    </div>,
    document.body,
  );
}

function getFocusable(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return [...container.querySelectorAll<HTMLElement>("button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])")];
}

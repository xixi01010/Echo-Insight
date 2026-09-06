import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";

export interface SelectOption<T extends string> {
  value: T;
  label: string;
}

interface CustomSelectProps<T extends string> {
  "aria-label": string;
  onChange: (value: T) => void;
  options: ReadonlyArray<SelectOption<T>>;
  value: T;
}

export function CustomSelect<T extends string>({
  "aria-label": ariaLabel,
  onChange,
  options,
  value,
}: CustomSelectProps<T>) {
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(() => Math.max(0, options.findIndex((option) => option.value === value)));
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});
  const selected = options.find((option) => option.value === value) ?? options[0];

  const positionMenu = useCallback(() => {
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;
    const rect = trigger.getBoundingClientRect();
    const viewportPadding = 12;
    const menuGap = 6;
    const viewportRight = Math.max(viewportPadding, window.innerWidth - viewportPadding);
    const viewportBottom = Math.max(viewportPadding, window.innerHeight - viewportPadding);
    const maxWidth = Math.max(1, viewportRight - viewportPadding);
    const minimumWidth = Math.min(180, maxWidth);
    const width = Math.min(Math.max(rect.width, minimumWidth), maxWidth);
    const left = clamp(rect.left, viewportPadding, Math.max(viewportPadding, viewportRight - width));
    const idealHeight = Math.min(320, Math.max(1, menu.scrollHeight));
    const spaceBelow = Math.max(0, viewportBottom - rect.bottom - menuGap);
    const spaceAbove = Math.max(0, rect.top - viewportPadding - menuGap);
    const openAbove = spaceBelow < idealHeight && spaceAbove > spaceBelow;
    const maxHeight = Math.min(idealHeight, openAbove ? spaceAbove : spaceBelow);
    const desiredTop = openAbove
      ? rect.top - menuGap - maxHeight
      : rect.bottom + menuGap;
    const top = clamp(desiredTop, viewportPadding, Math.max(viewportPadding, viewportBottom - maxHeight));
    setMenuStyle((current) => (
      current.left === left
      && current.top === top
      && current.width === width
      && current.maxHeight === maxHeight
        ? current
        : { left, top, width, maxHeight }
    ));
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    positionMenu();
  }, [open, options.length, positionMenu]);

  useLayoutEffect(() => {
    if (!open) return;
    optionRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  useEffect(() => {
    if (!open) return;
    let animationFrame: number | null = null;
    const schedulePositionMenu = () => {
      if (animationFrame !== null) return;
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = null;
        positionMenu();
      });
    };
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const menu = menuRef.current;
      if (!rootRef.current?.contains(target) && !menu?.contains(target)) setOpen(false);
    };
    const closeOnExternalScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const closeAndRestoreFocus = () => {
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    window.addEventListener("resize", schedulePositionMenu);
    window.addEventListener("scroll", closeOnExternalScroll, true);
    window.addEventListener("blur", closeAndRestoreFocus);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      window.removeEventListener("resize", schedulePositionMenu);
      window.removeEventListener("scroll", closeOnExternalScroll, true);
      window.removeEventListener("blur", closeAndRestoreFocus);
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
    };
  }, [open, positionMenu]);

  const openAtSelected = () => {
    setActiveIndex(Math.max(0, options.findIndex((option) => option.value === value)));
    setOpen(true);
  };

  const choose = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!options.length) return;
      if (!open) {
        openAtSelected();
        return;
      }
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) => (current + direction + options.length) % options.length);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) choose(activeIndex);
      else openAtSelected();
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === "Tab" && open) setOpen(false);
  };

  return (
    <div className="custom-select" ref={rootRef}>
      <button
        aria-controls={listboxId}
        aria-activedescendant={open ? `${listboxId}-option-${activeIndex}` : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        className="custom-select__trigger"
        onClick={() => open ? setOpen(false) : openAtSelected()}
        onKeyDown={handleKeyDown}
        ref={triggerRef}
        type="button"
      >
        <span>{selected?.label ?? "请选择"}</span>
        <span aria-hidden="true" className="custom-select__chevron" />
      </button>
      {open ? createPortal(
        <div
          aria-activedescendant={`${listboxId}-option-${activeIndex}`}
          aria-label={ariaLabel}
          className="custom-select__menu"
          id={listboxId}
          ref={menuRef}
          role="listbox"
          style={menuStyle}
        >
          {options.map((option, index) => (
            <button
              aria-selected={option.value === value}
              className={`custom-select__option ${index === activeIndex ? "is-active" : ""} ${option.value === value ? "is-selected" : ""}`}
              id={`${listboxId}-option-${index}`}
              key={option.value}
              onClick={() => choose(index)}
              onPointerEnter={() => setActiveIndex(index)}
              ref={(optionElement) => { optionRefs.current[index] = optionElement; }}
              role="option"
              tabIndex={-1}
              type="button"
            >
              <span>{option.label}</span><span aria-hidden="true">{option.value === value ? "✓" : ""}</span>
            </button>
          ))}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

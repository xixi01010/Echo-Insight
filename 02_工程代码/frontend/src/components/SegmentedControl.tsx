import { useRef, type KeyboardEvent } from "react";
import type { SelectOption } from "./CustomSelect";

interface SegmentedControlProps<T extends string> {
  "aria-label": string;
  onChange: (value: T) => void;
  options: ReadonlyArray<SelectOption<T>>;
  value: T;
}

export function SegmentedControl<T extends string>({
  "aria-label": ariaLabel,
  onChange,
  options,
  value,
}: SegmentedControlProps<T>) {
  const buttonsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const activeIndex = Math.max(0, options.findIndex((option) => option.value === value));

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"] as string[]).includes(event.key)) return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
    const nextIndex = (index + direction + options.length) % options.length;
    const next = options[nextIndex];
    if (!next) return;
    onChange(next.value);
    buttonsRef.current[nextIndex]?.focus();
  };

  return (
    <div
      aria-label={ariaLabel}
      className="segmented-control"
      role="radiogroup"
      style={{ "--segment-count": options.length, "--active-index": activeIndex } as React.CSSProperties}
    >
      <span aria-hidden="true" className="segmented-control__indicator" />
      {options.map((option, index) => (
        <button
          aria-checked={option.value === value}
          className={option.value === value ? "is-active" : ""}
          key={option.value}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => handleKeyDown(event, index)}
          ref={(button) => { buttonsRef.current[index] = button; }}
          role="radio"
          tabIndex={option.value === value ? 0 : -1}
          type="button"
        >{option.label}</button>
      ))}
    </div>
  );
}
